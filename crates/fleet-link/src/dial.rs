//! A carrier of `ovis-link run`: a WebSocket to the controller's direct carrier (`ws://`, no TLS:
//! docs/relay.md "Same channel, same trust") or to the relay's client socket (`wss://`, verified by
//! rustls against Mozilla's root store from webpki-roots; `ws://` only on loopback). Both answer
//! the upgrade with `{"type":"assigned","connection_id":"<32 hex>"}` first (relay/core.ts,
//! server/relay/direct.ts). Connecting, TLS, the upgrade and `assigned` run blocking under one
//! deadline; then one thread per carrier waits on the socket and on the agent's wake-up at once
//! (mio), so a frame goes out the moment the session has it and an idle carrier costs no CPU.
//! No redirect is followed and no address comes from the wire.

use std::io::{self, ErrorKind, Read, Write};
use std::net::{IpAddr, SocketAddr, TcpStream, ToSocketAddrs};
use std::os::fd::AsRawFd;
use std::sync::atomic::{AtomicU16, AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender, TryRecvError};
use std::sync::{Arc, OnceLock};
use std::thread;
use std::time::Instant;

use rustls::pki_types::ServerName;
use rustls::{ClientConfig, ClientConnection, RootCertStore};
use tungstenite::protocol::frame::coding::CloseCode;
use tungstenite::protocol::WebSocketConfig;
use tungstenite::WebSocket;

use crate::agent::{CarrierSink, Event};
use crate::carrier::Message;
use crate::channel::MAX_CARRIER_TEXT_BYTES;
use crate::fleet::{direct_address, Place};
use crate::json::{self, Json};
use crate::supervisor::Failure;

/// Relay/core.ts TRY_AGAIN: a limit, try again later.
pub const CLOSE_TRY_AGAIN: u16 = 1013;
/// The relay's frames are at most one carrier message (relay/core.ts MAX_MESSAGE_BYTES is larger only by framing).
const MAX_MESSAGE_BYTES: usize = MAX_CARRIER_TEXT_BYTES + 1024;

/// A TCP stream, with TLS over it for a `wss:` relay.
pub struct Io {
    tcp: TcpStream,
    tls: Option<Box<ClientConnection>>,
}

impl Read for Io {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let Some(tls) = self.tls.as_mut() else { return self.tcp.read(buffer) };
        loop {
            while tls.wants_write() {
                match tls.write_tls(&mut self.tcp) {
                    Ok(_) => {}
                    Err(error) if error.kind() == ErrorKind::WouldBlock => break,
                    Err(error) => return Err(error),
                }
            }
            match tls.reader().read(buffer) {
                Ok(read) => return Ok(read),
                Err(error) if error.kind() == ErrorKind::WouldBlock => {}
                Err(error) => return Err(error),
            }
            if tls.read_tls(&mut self.tcp)? == 0 {
                return match tls.reader().read(buffer) {
                    Err(error) if error.kind() == ErrorKind::WouldBlock => Ok(0),
                    other => other,
                };
            }
            tls.process_new_packets().map_err(|error| io::Error::new(ErrorKind::InvalidData, error))?;
        }
    }
}

impl Write for Io {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        match self.tls.as_mut() {
            None => self.tcp.write(buffer),
            Some(tls) => {
                let written = tls.writer().write(buffer)?;
                self.flush_tls()?;
                Ok(written)
            }
        }
    }
    fn flush(&mut self) -> io::Result<()> {
        match self.tls {
            None => self.tcp.flush(),
            Some(_) => self.flush_tls(),
        }
    }
}

impl Io {
    fn flush_tls(&mut self) -> io::Result<()> {
        if let Some(tls) = self.tls.as_mut() {
            while tls.wants_write() {
                tls.write_tls(&mut self.tcp)?;
            }
        }
        Ok(())
    }
}

fn tls_config() -> Arc<ClientConfig> {
    static CONFIG: OnceLock<Arc<ClientConfig>> = OnceLock::new();
    CONFIG
        .get_or_init(|| {
            let roots = RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() };
            let config = ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
                .with_safe_default_protocol_versions()
                .expect("ring offers the default protocol versions")
                .with_root_certificates(roots)
                .with_no_client_auth();
            Arc::new(config)
        })
        .clone()
}

fn ws_config() -> WebSocketConfig {
    WebSocketConfig::default().max_message_size(Some(MAX_MESSAGE_BYTES)).max_frame_size(Some(MAX_MESSAGE_BYTES))
}

/// Why a failed I/O failed: a refused certificate, or the controller out of reach.
fn classify(error: &io::Error) -> Failure {
    let certificate = error.get_ref().and_then(|inner| inner.downcast_ref::<rustls::Error>()).is_some_and(|tls| matches!(tls, rustls::Error::InvalidCertificate(_) | rustls::Error::NoCertificatesPresented));
    if certificate {
        Failure::Certificate
    } else {
        Failure::Unreachable
    }
}

fn classify_ws(error: &tungstenite::Error) -> Failure {
    match error {
        tungstenite::Error::Io(error) => classify(error),
        tungstenite::Error::Tls(_) => Failure::Certificate,
        // the relay's per-address budget, answered before the upgrade (relay/core.ts: 429, retry-after 60)
        tungstenite::Error::Http(response) if response.status().as_u16() == 429 => Failure::RelayLimited,
        _ => Failure::Unreachable,
    }
}

/// Where to dial: the relay (any address its name resolves to) or a direct carrier (only private,
/// Tailscale or loopback IPv4 addresses, the name resolved now).
pub struct Target<'a> {
    pub place: &'a Place,
    pub tls: bool,
    pub direct: bool,
    pub url: String,
}

fn addresses(target: &Target<'_>) -> Vec<SocketAddr> {
    let resolved: Vec<SocketAddr> = match (target.place.host.as_str(), target.place.port).to_socket_addrs() {
        Ok(found) => found.collect(),
        Err(_) => return Vec::new(),
    };
    resolved.into_iter().filter(|address| !target.direct || direct_address(address.ip())).filter(|address| target.direct || !matches!(address.ip(), IpAddr::V6(v6) if v6.is_unspecified())).collect()
}

/// TCP, TLS, the WebSocket upgrade and the `assigned` frame, all before `deadline`.
pub fn connect(target: &Target<'_>, deadline: Instant) -> Result<WebSocket<Io>, Failure> {
    let remaining = || deadline.checked_duration_since(Instant::now()).filter(|left| !left.is_zero());
    let mut tcp = None;
    for address in addresses(target) {
        let Some(left) = remaining() else { break };
        if let Ok(stream) = TcpStream::connect_timeout(&address, left) {
            tcp = Some(stream);
            break;
        }
    }
    let tcp = tcp.ok_or(Failure::Unreachable)?;
    let left = remaining().ok_or(Failure::Unreachable)?;
    tcp.set_nodelay(true).map_err(|error| classify(&error))?;
    tcp.set_read_timeout(Some(left)).map_err(|error| classify(&error))?;
    tcp.set_write_timeout(Some(left)).map_err(|error| classify(&error))?;
    let tls = if target.tls {
        let name = ServerName::try_from(target.place.host.clone()).map_err(|_| Failure::Unreachable)?;
        Some(Box::new(ClientConnection::new(tls_config(), name).map_err(|_| Failure::Certificate)?))
    } else {
        None
    };
    let io = Io { tcp, tls };
    let (mut socket, _) = tungstenite::client::client_with_config(target.url.as_str(), io, Some(ws_config())).map_err(|error| match error {
        tungstenite::HandshakeError::Failure(error) => classify_ws(&error),
        tungstenite::HandshakeError::Interrupted(_) => Failure::Unreachable,
    })?;
    loop {
        if remaining().is_none() {
            return Err(Failure::Unreachable);
        }
        match socket.read() {
            Ok(tungstenite::Message::Text(text)) => {
                let assigned = json::parse(text.as_bytes()).is_some_and(|value| {
                    value.get("type").and_then(Json::as_str) == Some("assigned")
                        && value.get("connection_id").and_then(Json::as_str).is_some_and(|id| id.len() == 32 && id.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')))
                });
                return if assigned { Ok(socket) } else { Err(Failure::Unreachable) };
            }
            Ok(tungstenite::Message::Close(Some(frame))) if u16::from(frame.code) == CLOSE_TRY_AGAIN => return Err(Failure::RelayBusy),
            Ok(tungstenite::Message::Ping(_) | tungstenite::Message::Pong(_)) => {}
            Ok(_) => return Err(Failure::Unreachable),
            Err(error) => return Err(classify_ws(&error)),
        }
    }
}

enum Out {
    Message(Message),
}

/// What the session sends through: queued for the carrier's thread, which is woken at once.
pub struct Sink {
    queue: Option<Sender<Out>>,
    waker: Arc<mio::Waker>,
}

impl CarrierSink for Sink {
    fn send(&mut self, message: Message) -> io::Result<()> {
        let closed = || io::Error::new(ErrorKind::BrokenPipe, "carrier closed");
        self.queue.as_ref().ok_or_else(closed)?.send(Out::Message(message)).map_err(|_| closed())?;
        self.waker.wake()
    }
}

impl Drop for Sink {
    fn drop(&mut self) {
        // the queue closes first: woken, the carrier's thread finds it closed and closes the socket
        drop(self.queue.take());
        let _ = self.waker.wake();
    }
}

/// The close code the peer ended the carrier with (0: none yet, or none given), and the
/// `retry_after_ms` a controller's direct carrier said before closing 1013 (u64::MAX: none).
#[derive(Clone)]
pub struct CloseCodeCell(Arc<AtomicU16>, Arc<AtomicU64>);

impl Default for CloseCodeCell {
    fn default() -> Self {
        CloseCodeCell(Arc::default(), Arc::new(AtomicU64::new(u64::MAX)))
    }
}

impl CloseCodeCell {
    pub fn get(&self) -> u16 {
        self.0.load(Ordering::Relaxed)
    }
    /// The controller's retry hint, when it gave one before the carrier closed.
    pub fn retry_after_ms(&self) -> Option<u64> {
        Some(self.1.load(Ordering::Relaxed)).filter(|hint| *hint != u64::MAX)
    }
}

/// The longest retry hint taken; a larger one is read as this.
pub const MAX_RETRY_AFTER_MS: u64 = 60_000;

/// `{"type":"retry","retry_after_ms":<n>}`: a controller's sign-in queue was full (todo 37). It
/// travels outside the protected channel, so it can only make this machine wait (at most a minute).
pub fn retry_hint(text: &str) -> Option<u64> {
    let value = json::parse(text.as_bytes())?;
    (value.get("type").and_then(Json::as_str) == Some("retry")).then_some(())?;
    value.get("retry_after_ms").and_then(|hint| hint.as_integer(0, u64::MAX >> 11)).map(|hint| hint.min(MAX_RETRY_AFTER_MS))
}

const SOCKET: mio::Token = mio::Token(0);
const WAKE: mio::Token = mio::Token(1);

/// Starts the carrier's thread: each message from the peer goes to `events` as Event::Carrier, and
/// Event::CarrierClosed follows the last. Dropping the returned sink closes the carrier.
pub fn spawn(mut socket: WebSocket<Io>, events: Sender<Event>) -> io::Result<(Sink, CloseCodeCell)> {
    let poll = mio::Poll::new()?;
    let waker = Arc::new(mio::Waker::new(poll.registry(), WAKE)?);
    let (queue, outgoing) = mpsc::channel::<Out>();
    let closed = CloseCodeCell::default();
    let code = closed.clone();
    {
        let tcp = &socket.get_ref().tcp;
        tcp.set_read_timeout(None)?;
        tcp.set_write_timeout(None)?;
        tcp.set_nonblocking(true)?;
    }
    let fd = socket.get_ref().tcp.as_raw_fd();
    poll.registry().register(&mut mio::unix::SourceFd(&fd), SOCKET, mio::Interest::READABLE)?;
    let mut poll = poll;
    thread::spawn(move || {
        let mut ready = mio::Events::with_capacity(8);
        let mut writable = false;
        let mut running = true;
        while running {
            if poll.poll(&mut ready, None).is_err() {
                break;
            }
            loop {
                match socket.read() {
                    Ok(tungstenite::Message::Text(text)) => {
                        if let Some(hint) = retry_hint(text.as_str()) {
                            code.1.store(hint, Ordering::Relaxed);
                            continue;
                        }
                        if events.send(Event::Carrier(Message::Text(text.as_str().to_owned()))).is_err() {
                            running = false;
                            break;
                        }
                    }
                    Ok(tungstenite::Message::Binary(bytes)) => {
                        if events.send(Event::Carrier(Message::Binary(bytes.to_vec()))).is_err() {
                            running = false;
                            break;
                        }
                    }
                    Ok(tungstenite::Message::Close(frame)) => {
                        code.0.store(frame.map_or(0, |frame| u16::from(frame.code)), Ordering::Relaxed);
                    }
                    Ok(_) => {}
                    Err(tungstenite::Error::Io(error)) if error.kind() == ErrorKind::WouldBlock => break,
                    Err(_) => {
                        running = false;
                        break;
                    }
                }
            }
            loop {
                match outgoing.try_recv() {
                    Ok(Out::Message(message)) => {
                        let frame = match message {
                            Message::Text(text) => tungstenite::Message::text(text),
                            Message::Binary(bytes) => tungstenite::Message::binary(bytes),
                        };
                        match socket.write(frame) {
                            Ok(()) => {}
                            Err(tungstenite::Error::Io(error)) if error.kind() == ErrorKind::WouldBlock => {}
                            Err(_) => running = false,
                        }
                    }
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => {
                        let _ = socket.close(Some(tungstenite::protocol::CloseFrame { code: CloseCode::Normal, reason: "".into() }));
                        running = false;
                        break;
                    }
                }
            }
            let flushed = socket.flush();
            let want_write = matches!(&flushed, Err(tungstenite::Error::Io(error)) if error.kind() == ErrorKind::WouldBlock);
            if flushed.is_err() && !want_write {
                running = false;
            }
            if running && want_write != writable {
                writable = want_write;
                let interest = if writable { mio::Interest::READABLE | mio::Interest::WRITABLE } else { mio::Interest::READABLE };
                if poll.registry().reregister(&mut mio::unix::SourceFd(&fd), SOCKET, interest).is_err() {
                    running = false;
                }
            }
        }
        let _ = events.send(Event::CarrierClosed);
    });
    Ok((Sink { queue: Some(queue), waker }, closed))
}
