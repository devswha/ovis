//! `ovis-link selftest machine --config <file>`: one machine session over a carrier on stdin and
//! stdout. Each carrier message is one byte of kind (0 text, 1 binary), its length as a u32
//! big-endian and its bytes. The configuration file (JSON, mode 0600, as it holds the advert's
//! secrets) names everything the agent may reach; nothing the controller sends can add to it:
//!
//! ```json
//! {"controller_key":"<64 hex>","machine_key_file":"<path>","bridge_port":17421,"native_socket":"<path>",
//!  "runtime_id":"rt-1","boot_id":"boot-1","bridge_token":"<64 hex>","native_bearer":"<token>",
//!  "versions":{"server":"0.5.0","agent":"0.5.0","runtime":"0.9.1"}}
//! ```
//!
//! `bridge` is offered when `bridge_token` is given (with `bridge_port`), `native` when
//! `native_bearer` is (at `native_socket`, else where the runtime resolves its socket). The
//! configuration and the machine key are read as crate::private_file reads them.
//!
//! Exit codes: 0 the carrier closed or the session drained after GOAWAY; 2 the configuration or the
//! machine key was refused; 3 the handshake failed; 4 a carrier message was not a valid record; 5 the
//! session ended with SESSION_ERROR (either side). Each failure prints one fixed line on stderr.

use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use ovis_link::agent::{Agent, CarrierSink, Clock, Event};
use ovis_link::carrier::{self, Message};
use ovis_link::channel::{ClientHandshake, MAX_CARRIER_TEXT_BYTES};
use ovis_link::hex;
use ovis_link::json::{self, Json};
use ovis_link::machine_key::MachineKey;
use ovis_link::mux::{Advert, Endpoint, Health, Outgoing, UpDown, Versions};
use ovis_link::private_file::{self, PrivateFileError};
use ovis_link::session::{End, Session, SessionConfig};
use ovis_link::target::{self, Targets};

const CONFIG_EXIT: u8 = ovis_link::exit::USAGE;
const HANDSHAKE_EXIT: u8 = ovis_link::exit::HANDSHAKE;
const RECORD_EXIT: u8 = ovis_link::exit::RECORD;
const SESSION_EXIT: u8 = ovis_link::exit::SESSION;
const MAX_CONFIG_BYTES: u64 = 16 * 1024;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);
const KIND_TEXT: u8 = 0;
const KIND_BINARY: u8 = 1;

fn fail(text: &str, code: u8) -> ExitCode {
    eprintln!("ovis-link: {text}");
    ExitCode::from(code)
}

struct Config {
    controller_key: [u8; 32],
    key_file: PathBuf,
    targets: Targets,
    advert: Advert,
}

fn read_config(path: &Path) -> Result<Zeroizing<Vec<u8>>, &'static str> {
    private_file::read(path, MAX_CONFIG_BYTES).map_err(|error| match error {
        PrivateFileError::Unreadable => "configuration file cannot be read",
        PrivateFileError::Symlink => "configuration path is a symbolic link",
        PrivateFileError::NotAFile => "configuration is not a regular file",
        PrivateFileError::Exposed => "configuration file may be read or written by others (it must be mode 0600)",
        PrivateFileError::TooLarge => "configuration file is too large",
    })
}

fn text(value: &Json, key: &str) -> Option<String> {
    value.get(key).and_then(Json::as_str).map(str::to_owned)
}

fn load(path: &Path) -> Result<Config, &'static str> {
    let bytes = read_config(path)?;
    let value = json::parse(&bytes).filter(Json::is_object).ok_or("configuration is not a JSON object")?;
    let controller_key = text(&value, "controller_key").and_then(|key| hex::decode(&key)).and_then(|key| key.try_into().ok()).ok_or("controller_key takes 64 hex digits")?;
    let key_file = text(&value, "machine_key_file").map(PathBuf::from).ok_or("machine_key_file is missing")?;
    let bridge_token = text(&value, "bridge_token").map(Zeroizing::new);
    let native_bearer = text(&value, "native_bearer").map(Zeroizing::new);
    let bridge_port = match value.get("bridge_port") {
        None => None,
        Some(port) => Some(port.as_integer(1, 65535).ok_or("bridge_port is not a port")? as u16),
    };
    if bridge_token.is_some() != bridge_port.is_some() {
        return Err("bridge_token and bridge_port go together");
    }
    let native_socket = match (&native_bearer, text(&value, "native_socket")) {
        (None, _) => None,
        (Some(_), Some(socket)) => Some(PathBuf::from(socket)),
        (Some(_), None) => Some(target::runtime_socket(|name| std::env::var_os(name)).ok_or("the runtime's socket cannot be resolved")?),
    };
    let versions = value.get("versions").ok_or("versions is missing")?;
    let mut endpoints = Vec::new();
    if bridge_token.is_some() {
        endpoints.push(Endpoint::Bridge);
    }
    if native_bearer.is_some() {
        endpoints.push(Endpoint::Native);
    }
    let up = |endpoint| if endpoints.contains(&endpoint) { UpDown::Up } else { UpDown::Down };
    let advert = Advert {
        health: Health { runtime: up(Endpoint::Native), bridge: up(Endpoint::Bridge) },
        endpoints: endpoints.clone(),
        runtime_id: text(&value, "runtime_id").unwrap_or_default(),
        boot_id: text(&value, "boot_id").unwrap_or_default(),
        bridge_token,
        native_bearer,
        now: SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_secs()),
        versions: Versions {
            server: text(versions, "server").unwrap_or_default(),
            link: env!("CARGO_PKG_VERSION").to_owned(),
            agent: text(versions, "agent").unwrap_or_default(),
            runtime: text(versions, "runtime").unwrap_or_default(),
        },
    };
    // the advert must be one the codec writes: the same checks the controller makes
    Outgoing::PipeAdvert(advert.clone()).encode().map_err(|_| "the advert's fields are not valid (docs/fleet-link.md, Fields)")?;
    Ok(Config { controller_key, key_file, targets: Targets { bridge_port, native_socket }, advert })
}

/// shared/relay-server-proof.ts deriveServerId: the controller's id from its static key.
fn server_id(controller_key: &[u8; 32]) -> String {
    hex::encode(&Sha256::new().chain_update(b"ovis-relay-server-id-v1").chain_update(controller_key).finalize()[..16])
}

struct StdoutCarrier(BufWriter<io::Stdout>);

impl CarrierSink for StdoutCarrier {
    fn send(&mut self, message: Message) -> io::Result<()> {
        let (kind, bytes) = match &message {
            Message::Text(text) => (KIND_TEXT, text.as_bytes()),
            Message::Binary(bytes) => (KIND_BINARY, bytes.as_slice()),
        };
        self.0.write_all(&[kind])?;
        self.0.write_all(&(bytes.len() as u32).to_be_bytes())?;
        self.0.write_all(bytes)?;
        self.0.flush()
    }
}

fn read_carrier(sender: Sender<Event>) {
    let mut input = BufReader::new(io::stdin().lock());
    loop {
        let mut header = [0u8; 5];
        if input.read_exact(&mut header).is_err() {
            break;
        }
        let length = u32::from_be_bytes([header[1], header[2], header[3], header[4]]) as usize;
        // no carrier message of shared/relay-e2ee.ts is larger: the stream is not a carrier
        if length > MAX_CARRIER_TEXT_BYTES {
            break;
        }
        let mut bytes = vec![0u8; length];
        if input.read_exact(&mut bytes).is_err() {
            break;
        }
        let message = match header[0] {
            KIND_TEXT => match String::from_utf8(bytes) {
                Ok(text) => Message::Text(text),
                Err(_) => break,
            },
            KIND_BINARY => Message::Binary(bytes),
            _ => break,
        };
        if sender.send(Event::Carrier(message)).is_err() {
            return;
        }
    }
    let _ = sender.send(Event::CarrierClosed);
}

pub fn run(path: &Path) -> ExitCode {
    let config = match load(path) {
        Ok(config) => config,
        Err(text) => return fail(text, CONFIG_EXIT),
    };
    let key = match MachineKey::load(&config.key_file) {
        Ok(key) => key,
        Err(error) => return fail(&error.to_string(), CONFIG_EXIT),
    };
    let (sender, events) = mpsc::channel();
    let reader = sender.clone();
    thread::spawn(move || read_carrier(reader));
    let mut sink = StdoutCarrier(BufWriter::new(io::stdout()));

    let (handshake, message1) = match ClientHandshake::start(&config.controller_key) {
        Ok(started) => started,
        Err(error) => return fail(&format!("handshake failed: {error}"), HANDSHAKE_EXIT),
    };
    if sink.send(Message::Text(carrier::hello(&message1))).is_err() {
        return fail("the carrier closed", SESSION_EXIT);
    }
    let deadline = Instant::now() + HANDSHAKE_TIMEOUT;
    let message2 = loop {
        match events.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(Event::Carrier(Message::Text(text))) => match carrier::ready(&text) {
                Ok(Some(message2)) => break message2,
                Ok(None) => {}
                Err(error) => return fail(&error.to_string(), HANDSHAKE_EXIT),
            },
            Ok(Event::Carrier(Message::Binary(_))) => {}
            Ok(_) | Err(RecvTimeoutError::Disconnected) => return fail("handshake failed: the carrier closed", HANDSHAKE_EXIT),
            Err(RecvTimeoutError::Timeout) => return fail("handshake failed: no answer", HANDSHAKE_EXIT),
        }
    };
    let channel = match carrier::finish(handshake, &message2) {
        Ok(channel) => channel,
        Err(error) => return fail(&error.to_string(), HANDSHAKE_EXIT),
    };
    let clock = Clock::start();
    let session_config = SessionConfig { key, server_id: server_id(&config.controller_key), advert: Some(config.advert), binary_ciphertext: channel.binary_ciphertext(), enroll: None, seen_state: None };
    let session = Session::new(session_config, channel.binding(), clock.now());
    let agent = Agent::new(session, channel, config.targets, &mut sink, events, sender, clock);
    match agent.run() {
        Ok(end @ (End::CarrierLost | End::Drained | End::Confirmed)) => {
            eprintln!("ovis-link: {end}");
            ExitCode::SUCCESS
        }
        Ok(end) => fail(&end.to_string(), SESSION_EXIT),
        Err(error) => fail(&error.to_string(), RECORD_EXIT),
    }
}
