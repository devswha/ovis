//! Where a pipe goes: only the two targets of the agent's own configuration (docs/fleet-link.md
//! section 2). `bridge` is a TCP connection to 127.0.0.1 on the configured port of the machine's
//! Ovis bridge server; `native` is the runtime's Unix socket, at the configured path or where the
//! runtime itself resolves it. A PIPE_OPEN
//! names an endpoint only: no host, port, path or program from the controller reaches a socket,
//! and nothing is ever executed.

use std::ffi::OsString;
use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, Shutdown, SocketAddr, TcpStream};
#[cfg(unix)]
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::Duration;

use crate::mux::Endpoint;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// macOS `sun_path` holds 104 bytes with its NUL, as the runtime limits its own paths.
const MAX_UNIX_SOCKET_PATH: usize = 103;
const MAX_SESSION_BYTES: usize = 32;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Targets {
    pub bridge_port: Option<u16>,
    pub native_socket: Option<PathBuf>,
}

impl Targets {
    pub fn has(&self, endpoint: Endpoint) -> bool {
        match endpoint {
            Endpoint::Bridge => self.bridge_port.is_some(),
            Endpoint::Native => self.native_socket.is_some(),
        }
    }

    pub fn connect(&self, endpoint: Endpoint) -> io::Result<Stream> {
        let missing = || io::Error::new(io::ErrorKind::NotFound, "endpoint not configured");
        match endpoint {
            Endpoint::Bridge => {
                let port = self.bridge_port.ok_or_else(missing)?;
                let stream = TcpStream::connect_timeout(&SocketAddr::from((Ipv4Addr::LOCALHOST, port)), CONNECT_TIMEOUT)?;
                stream.set_nodelay(true)?;
                Ok(Stream::Tcp(stream))
            }
            #[cfg(unix)]
            Endpoint::Native => Ok(Stream::Unix(UnixStream::connect(self.native_socket.as_deref().ok_or_else(missing)?)?)),
            #[cfg(not(unix))]
            Endpoint::Native => Err(missing()),
        }
    }
}

/// The runtime's socket as the runtime resolves it: `OVIS_RUNTIME_SOCKET`, else
/// `<XDG_RUNTIME_DIR | XDG_STATE_HOME | HOME/.local/state>/ovis-runtime/<OVIS_RUNTIME_SESSION or default>.sock`.
/// `None` when no absolute directory or valid session name is given, or the path is too long.
pub fn runtime_socket(var: impl Fn(&str) -> Option<OsString>) -> Option<PathBuf> {
    let var = |name: &str| var(name).filter(|value| !value.is_empty());
    let checked = |path: PathBuf| (path.as_os_str().len() <= MAX_UNIX_SOCKET_PATH).then_some(path);
    if let Some(socket) = var("OVIS_RUNTIME_SOCKET") {
        let path = PathBuf::from(socket);
        return if path.is_absolute() && path.parent().is_some() { checked(path) } else { None };
    }
    let session = match var("OVIS_RUNTIME_SESSION") {
        Some(session) => session.into_string().ok()?,
        None => String::from("default"),
    };
    let valid = |byte: u8| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_';
    if session.is_empty() || session.len() > MAX_SESSION_BYTES || !session.bytes().all(valid) {
        return None;
    }
    let absolute = |name: &str| var(name).map(PathBuf::from).filter(|path| path.is_absolute());
    let base = absolute("XDG_RUNTIME_DIR").or_else(|| absolute("XDG_STATE_HOME")).or_else(|| absolute("HOME").map(|home| home.join(".local").join("state")))?;
    checked(base.join("ovis-runtime").join(format!("{session}.sock")))
}

#[derive(Debug)]
pub enum Stream {
    Tcp(TcpStream),
    #[cfg(unix)]
    Unix(UnixStream),
}

impl Stream {
    pub fn try_clone(&self) -> io::Result<Stream> {
        Ok(match self {
            Stream::Tcp(stream) => Stream::Tcp(stream.try_clone()?),
            #[cfg(unix)]
            Stream::Unix(stream) => Stream::Unix(stream.try_clone()?),
        })
    }

    pub fn shutdown(&self, how: Shutdown) -> io::Result<()> {
        match self {
            Stream::Tcp(stream) => stream.shutdown(how),
            #[cfg(unix)]
            Stream::Unix(stream) => stream.shutdown(how),
        }
    }
}

impl Read for Stream {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        match self {
            Stream::Tcp(stream) => stream.read(buffer),
            #[cfg(unix)]
            Stream::Unix(stream) => stream.read(buffer),
        }
    }
}

impl Write for Stream {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        match self {
            Stream::Tcp(stream) => stream.write(buffer),
            #[cfg(unix)]
            Stream::Unix(stream) => stream.write(buffer),
        }
    }
    fn flush(&mut self) -> io::Result<()> {
        match self {
            Stream::Tcp(stream) => stream.flush(),
            #[cfg(unix)]
            Stream::Unix(stream) => stream.flush(),
        }
    }
}
