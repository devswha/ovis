//! The connection loop: connect, follow the watched pane, forward frames, back off, reconnect.

use std::io::ErrorKind;
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::mpsc::{Receiver, RecvTimeoutError, TryRecvError};
use std::time::{Duration, Instant};

use tungstenite::client::IntoClientRequest;
use tungstenite::http::HeaderValue;
use tungstenite::{HandshakeError, Message, WebSocket};

use super::frames::{event, watch_frames};
use super::{Command, LiveEvent};
use crate::api::Server;

const FIRST_DELAY: Duration = Duration::from_millis(250);
const LAST_DELAY: Duration = Duration::from_secs(8);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
/// How long a read waits before the loop looks at its commands again.
const READ_TICK: Duration = Duration::from_millis(250);

type Sink = dyn Fn(LiveEvent) + Send;
type Socket = WebSocket<TcpStream>;

/// What ended a connection.
enum Ended {
    Stopped,
    Dropped(String),
}

struct Session<'a> {
    sink: &'a Sink,
    commands: &'a Receiver<Command>,
    watched: Option<String>,
}

pub(crate) fn run(server: &Server, sink: &Sink, commands: &Receiver<Command>) {
    let mut session = Session {
        sink,
        commands,
        watched: None,
    };
    let authority = match authority(&server.origin) {
        Ok(authority) => authority,
        Err(reason) => {
            sink(LiveEvent::Down(reason));
            while let Ok(Command::Watch(_)) = commands.recv() {}
            return;
        }
    };
    let mut delay = FIRST_DELAY;
    loop {
        match connect(authority, server) {
            Ok(mut socket) => {
                sink(LiveEvent::Up);
                delay = FIRST_DELAY;
                match session.follow(&mut socket) {
                    Ended::Stopped => return,
                    Ended::Dropped(reason) => sink(LiveEvent::Down(reason)),
                }
            }
            Err(reason) => sink(LiveEvent::Down(reason)),
        }
        if session.wait(delay) {
            return;
        }
        delay = delay.saturating_mul(2).min(LAST_DELAY);
    }
}

/// `host:port` of an `http` origin.
fn authority(origin: &str) -> Result<&str, String> {
    if origin.starts_with("https://") {
        return Err("https origins are not supported yet".to_owned());
    }
    let rest = origin
        .strip_prefix("http://")
        .ok_or_else(|| format!("not an http origin: {origin}"))?;
    Ok(rest.split('/').next().unwrap_or(rest))
}

fn connect(authority: &str, server: &Server) -> Result<Socket, String> {
    let addressed = if authority.ends_with(']') || !authority.contains(':') {
        format!("{authority}:80")
    } else {
        authority.to_owned()
    };
    let addresses = addressed
        .to_socket_addrs()
        .map_err(|error| format!("cannot resolve {authority}: {error}"))?;
    let mut failure = format!("no address for {authority}");
    let mut stream = None;
    for address in addresses {
        match TcpStream::connect_timeout(&address, CONNECT_TIMEOUT) {
            Ok(connected) => {
                stream = Some(connected);
                break;
            }
            Err(error) => failure = format!("cannot connect to {authority}: {error}"),
        }
    }
    let stream = stream.ok_or(failure)?;
    stream
        .set_read_timeout(Some(CONNECT_TIMEOUT))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(CONNECT_TIMEOUT))
        .map_err(|error| error.to_string())?;
    let mut request = format!("ws://{authority}/ws")
        .into_client_request()
        .map_err(|error| error.to_string())?;
    if let Some(bearer) = server.bearer() {
        let value = HeaderValue::from_str(&bearer)
            .map_err(|_| "the token is not a valid header value".to_owned())?;
        request.headers_mut().insert("Authorization", value);
    }
    let (socket, _response) =
        tungstenite::client(request, stream).map_err(|error| match error {
            HandshakeError::Failure(failure) => {
                format!("the server refused the connection: {failure}")
            }
            HandshakeError::Interrupted(_) => {
                "the server did not finish the handshake in time".to_owned()
            }
        })?;
    socket
        .get_ref()
        .set_read_timeout(Some(READ_TICK))
        .map_err(|error| error.to_string())?;
    Ok(socket)
}

impl Session<'_> {
    /// Forwards the socket's frames until it drops or a stop comes.
    fn follow(&mut self, socket: &mut Socket) -> Ended {
        if let Some(pane_id) = &self.watched
            && let Err(reason) = send_watch(socket, pane_id, true)
        {
            return Ended::Dropped(reason);
        }
        loop {
            match self.commands.try_recv() {
                Ok(Command::Watch(next)) => {
                    if let Err(reason) = self.rewatch(socket, next) {
                        return Ended::Dropped(reason);
                    }
                    continue;
                }
                Ok(Command::Stop) | Err(TryRecvError::Disconnected) => return Ended::Stopped,
                Err(TryRecvError::Empty) => {}
            }
            match socket.read() {
                Ok(Message::Text(text)) => {
                    if let Some(told) = event(text.as_str()) {
                        (self.sink)(told);
                    }
                }
                Ok(_) => {}
                Err(tungstenite::Error::Io(error))
                    if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
                Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => {
                    return Ended::Dropped("the server closed the connection".to_owned());
                }
                Err(error) => return Ended::Dropped(error.to_string()),
            }
        }
    }

    fn rewatch(&mut self, socket: &mut Socket, next: Option<String>) -> Result<(), String> {
        if next == self.watched {
            return Ok(());
        }
        let previous = std::mem::replace(&mut self.watched, next);
        if let Some(old) = previous {
            send_watch(socket, &old, false)?;
        }
        match &self.watched {
            Some(new) => send_watch(socket, new, true),
            None => Ok(()),
        }
    }

    /// Waits out a reconnect delay, keeping up with watch changes; true when a stop came.
    fn wait(&mut self, delay: Duration) -> bool {
        let deadline = Instant::now() + delay;
        loop {
            match self
                .commands
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            {
                Ok(Command::Watch(next)) => self.watched = next,
                Ok(Command::Stop) | Err(RecvTimeoutError::Disconnected) => return true,
                Err(RecvTimeoutError::Timeout) => return false,
            }
        }
    }
}

fn send_watch(socket: &mut Socket, pane_id: &str, enabled: bool) -> Result<(), String> {
    for frame in watch_frames(pane_id, enabled) {
        socket
            .send(Message::text(frame))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}
