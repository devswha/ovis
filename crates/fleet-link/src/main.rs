#![forbid(unsafe_code)]

//! `ovis-link`: `run --state <dir>` dials the controller of `<dir>/fleet.json` and keeps a machine
//! session up (crate::daemon); `status --state <dir> [--json]` prints what it said of itself;
//! `rejoin --state <dir>` lets it dial again after a refusal. Exit codes are crate::exit's, as
//! docs/fleet-link.md lists them. Two hidden modes remain for the interop tests: `selftest handshake`, which server/fleet/records-interop.test.ts drives against the
//! TypeScript responder, and `selftest machine`, a whole machine session (docs/fleet-link.md
//! sections 1 to 3) over a carrier on stdin and stdout, which server/fleet/link-interop.contract.test.ts
//! runs against a TypeScript controller.
//!
//! The handshake selftest cannot hand out a key: it takes only the responder's public key, makes
//! its own ephemeral key from the OS (a release build has no way to fix it: that constructor exists
//! only in test builds), reads no key file, and prints only message 1, the channel binding (a hash
//! of the public handshake messages) and records. Every failure of either mode prints a fixed text.

mod machine;

use std::io::{self, BufRead, Read, Write};
use std::process::ExitCode;

use ovis_link::channel::{ClientHandshake, MAX_CARRIER_BINARY_BYTES};
use ovis_link::hex;
use ovis_link::records::FrameKind;

const GREETING: &[u8] = b"ovis-link selftest";
const USAGE_EXIT: u8 = ovis_link::exit::USAGE;
const HANDSHAKE_EXIT: u8 = ovis_link::exit::HANDSHAKE;
const RECORD_EXIT: u8 = ovis_link::exit::RECORD;
const USAGE: &str = "usage: ovis-link run --state <dir> | status --state <dir> [--json] | rejoin --state <dir> | join --state <dir> --invite <- | file> | runtime-advert --state <dir> --runtime-version <v> | --version";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["--version"] => {
            println!("ovis-link {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        ["selftest", "handshake", "--responder-key", key] => selftest(key),
        ["selftest", "machine", "--config", path] => machine::run(std::path::Path::new(path)),
        ["run", "--state", dir] => ExitCode::from(ovis_link::daemon::run(std::path::Path::new(dir))),
        ["status", "--state", dir] => ExitCode::from(ovis_link::daemon::print_status(std::path::Path::new(dir), false)),
        ["status", "--state", dir, "--json"] | ["status", "--json", "--state", dir] => ExitCode::from(ovis_link::daemon::print_status(std::path::Path::new(dir), true)),
        ["rejoin", "--state", dir] => ExitCode::from(ovis_link::daemon::rejoin(std::path::Path::new(dir))),
        ["join", "--state", dir, "--invite", invite] => ExitCode::from(ovis_link::join::run(std::path::Path::new(dir), invite)),
        ["runtime-advert", "--state", dir, "--runtime-version", version] => ExitCode::from(ovis_link::runtime_advert::run(std::path::Path::new(dir), version)),
        ["leave", "--state", dir] => ExitCode::from(ovis_link::daemon::leave(std::path::Path::new(dir))),
        _ => {
            eprintln!("{USAGE}");
            ExitCode::from(USAGE_EXIT)
        }
    }
}

fn fail(text: &str, code: u8) -> ExitCode {
    eprintln!("{text}");
    ExitCode::from(code)
}

/// One line of `<word> <hex>`, at most one carrier message long.
fn read_line(input: &mut impl BufRead, word: &str) -> Result<Option<Vec<u8>>, &'static str> {
    let limit = word.len() + 1 + 2 * MAX_CARRIER_BINARY_BYTES + 1;
    let mut line = String::new();
    let read = input.take(limit as u64).read_line(&mut line).map_err(|_| "selftest: cannot read stdin")?;
    if read == 0 {
        return Ok(None);
    }
    let text = line.strip_suffix('\n').ok_or("selftest: line too long or unterminated")?;
    let value = text.strip_prefix(word).and_then(|rest| rest.strip_prefix(' ')).ok_or("selftest: unexpected line")?;
    hex::decode(value).map(Some).ok_or("selftest: not hex")
}

fn selftest(key: &str) -> ExitCode {
    let Some(server_static) = hex::decode(key).and_then(|bytes| <[u8; 32]>::try_from(bytes).ok()) else {
        return fail("selftest: --responder-key takes 64 hex digits", USAGE_EXIT);
    };
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    let (handshake, message1) = match ClientHandshake::start(&server_static) {
        Ok(started) => started,
        Err(error) => return fail(&format!("handshake failed: {error}"), HANDSHAKE_EXIT),
    };
    if writeln!(output, "msg1 {}", hex::encode(&message1)).and_then(|()| output.flush()).is_err() {
        return fail("selftest: cannot write stdout", USAGE_EXIT);
    }
    let message2 = match read_line(&mut input, "msg2") {
        Ok(Some(message2)) => message2,
        Ok(None) => return fail("selftest: no message 2", USAGE_EXIT),
        Err(text) => return fail(text, USAGE_EXIT),
    };
    let mut channel = match handshake.finish(&message2) {
        Ok(channel) => channel,
        Err(error) => return fail(&format!("handshake failed: {error}"), HANDSHAKE_EXIT),
    };
    let greeting = match channel.seal(FrameKind::Binary, GREETING) {
        Ok(record) => record,
        Err(error) => return fail(&format!("record failed: {error}"), RECORD_EXIT),
    };
    let opened = writeln!(output, "binding {}", hex::encode(&channel.binding()))
        .and_then(|()| writeln!(output, "record {}", hex::encode(&greeting)))
        .and_then(|()| output.flush());
    if opened.is_err() {
        return fail("selftest: cannot write stdout", USAGE_EXIT);
    }
    // every record that arrives is answered with one carrying the same frame
    let mut echoed = 0u64;
    loop {
        let record = match read_line(&mut input, "record") {
            Ok(Some(record)) => record,
            Ok(None) => break,
            Err(text) => return fail(text, USAGE_EXIT),
        };
        let reply = match channel.open(&record).and_then(|frame| channel.seal(frame.kind, &frame.data)) {
            Ok(reply) => reply,
            Err(error) => return fail(&format!("record failed: {error}"), RECORD_EXIT),
        };
        if writeln!(output, "record {}", hex::encode(&reply)).and_then(|()| output.flush()).is_err() {
            return fail("selftest: cannot write stdout", USAGE_EXIT);
        }
        echoed += 1;
    }
    if writeln!(output, "done {echoed}").is_err() {
        return fail("selftest: cannot write stdout", USAGE_EXIT);
    }
    ExitCode::SUCCESS
}
