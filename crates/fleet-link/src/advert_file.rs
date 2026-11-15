//! `<state>/advert.json` (docs/fleet-link.md section 5, "The agent's files"): what the machine's
//! bridge server (todo 27) writes for the agent to advertise, replaced in one rename after every
//! runtime or bridge restart. It holds the bridge token and the runtime bearer, so it is read as
//! crate::private_file reads a secret, and no type here formats either.
//!
//! ```json
//! {"v":1,"runtime_id":"rt-1","boot_id":"boot-1","bridge_port":17421,"bridge_token":"<64 hex>",
//!  "native_bearer":"<token>","native_socket":"/abs/core.sock","runtime_down":false,
//!  "versions":{"server":"0.5.0","agent":"0.5.0","runtime":"0.9.1"}}
//! ```

use std::fmt;
use std::path::{Path, PathBuf};

use zeroize::Zeroizing;

use crate::json::{self, Json};
use crate::mux::{Advert, Endpoint, Health, Outgoing, UpDown, Versions};
use crate::private_file::{self, PrivateFileError};
use crate::target::Targets;

pub const MAX_ADVERT_FILE_BYTES: u64 = 16 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AdvertError {
    File(PrivateFileError),
    NotJson,
    Version,
    Field,
    NoEndpoint,
    Socket,
}

impl fmt::Display for AdvertError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            AdvertError::File(PrivateFileError::Unreadable) => "advert.json cannot be read",
            AdvertError::File(PrivateFileError::Symlink) => "advert.json is a symbolic link",
            AdvertError::File(PrivateFileError::NotAFile) => "advert.json is not a regular file",
            AdvertError::File(PrivateFileError::Exposed) => "advert.json may be read or written by others (it must be mode 0600)",
            AdvertError::File(PrivateFileError::TooLarge) => "advert.json is too large",
            AdvertError::NotJson => "advert.json is not a JSON object",
            AdvertError::Version => "advert.json is not version 1",
            AdvertError::Field => "advert.json has a field that is not valid (docs/fleet-link.md, Fields)",
            AdvertError::NoEndpoint => "advert.json names neither the bridge nor the runtime",
            AdvertError::Socket => "advert.json native_socket is not an absolute path",
        })
    }
}

impl std::error::Error for AdvertError {}

#[derive(Clone, PartialEq, Eq)]
pub struct AdvertFile {
    pub runtime_id: String,
    pub boot_id: String,
    pub bridge: Option<(u16, Zeroizing<String>)>,
    pub native_bearer: Option<Zeroizing<String>>,
    pub native_socket: Option<PathBuf>,
    pub runtime_down: bool,
    pub versions: Versions,
}

impl fmt::Debug for AdvertFile {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AdvertFile")
            .field("runtime_id", &self.runtime_id)
            .field("boot_id", &self.boot_id)
            .field("bridge_port", &self.bridge.as_ref().map(|(port, _)| port))
            .field("native", &self.native_bearer.is_some())
            .field("runtime_down", &self.runtime_down)
            .finish_non_exhaustive()
    }
}

fn text(value: &Json, key: &str) -> Option<String> {
    value.get(key).and_then(Json::as_str).map(str::to_owned)
}

pub fn parse(bytes: &[u8]) -> Result<AdvertFile, AdvertError> {
    let value = json::parse(bytes).filter(Json::is_object).ok_or(AdvertError::NotJson)?;
    if value.get("v").and_then(|v| v.as_integer(1, 1)).is_none() {
        return Err(AdvertError::Version);
    }
    let bridge = match (value.get("bridge_port"), text(&value, "bridge_token")) {
        (None, None) => None,
        (Some(port), Some(token)) => Some((port.as_integer(1, 65535).ok_or(AdvertError::Field)? as u16, Zeroizing::new(token))),
        _ => return Err(AdvertError::Field),
    };
    let native_bearer = text(&value, "native_bearer").map(Zeroizing::new);
    if bridge.is_none() && native_bearer.is_none() {
        return Err(AdvertError::NoEndpoint);
    }
    let native_socket = match value.get("native_socket") {
        None => None,
        Some(path) => Some(path.as_str().map(PathBuf::from).filter(|path| path.is_absolute()).ok_or(AdvertError::Socket)?),
    };
    let runtime_down = match value.get("runtime_down") {
        None => false,
        Some(Json::Bool(down)) => *down,
        Some(_) => return Err(AdvertError::Field),
    };
    let versions = value.get("versions").filter(|versions| versions.is_object()).ok_or(AdvertError::Field)?;
    let file = AdvertFile {
        runtime_id: text(&value, "runtime_id").ok_or(AdvertError::Field)?,
        boot_id: text(&value, "boot_id").ok_or(AdvertError::Field)?,
        bridge,
        native_bearer,
        native_socket,
        runtime_down,
        versions: Versions {
            server: text(versions, "server").ok_or(AdvertError::Field)?,
            link: env!("CARGO_PKG_VERSION").to_owned(),
            agent: text(versions, "agent").ok_or(AdvertError::Field)?,
            runtime: text(versions, "runtime").ok_or(AdvertError::Field)?,
        },
    };
    // every field must be one PIPE_ADVERT may carry: the codec's own checks
    Outgoing::PipeAdvert(file.advert(true, 0)).encode().map_err(|_| AdvertError::Field)?;
    Ok(file)
}

pub fn load(path: &Path) -> Result<AdvertFile, AdvertError> {
    let bytes = private_file::read(path, MAX_ADVERT_FILE_BYTES).map_err(AdvertError::File)?;
    parse(&bytes)
}

impl AdvertFile {
    /// The PIPE_ADVERT this file makes: `health.bridge` is `down` when the bridge port did not
    /// accept (`bridge_accepts`), `health.runtime` only when the file says `runtime_down` (a file
    /// that offers no `native` endpoint says nothing about the runtime); `now` is the machine's
    /// clock in seconds.
    pub fn advert(&self, bridge_accepts: bool, now: u64) -> Advert {
        let mut endpoints = Vec::new();
        if self.bridge.is_some() {
            endpoints.push(Endpoint::Bridge);
        }
        if self.native_bearer.is_some() {
            endpoints.push(Endpoint::Native);
        }
        let up = |up: bool| if up { UpDown::Up } else { UpDown::Down };
        Advert {
            health: Health { runtime: up(!self.runtime_down), bridge: up(self.bridge.is_some() && bridge_accepts) },
            endpoints,
            runtime_id: self.runtime_id.clone(),
            boot_id: self.boot_id.clone(),
            bridge_token: self.bridge.as_ref().map(|(_, token)| token.clone()),
            native_bearer: self.native_bearer.clone(),
            now,
            versions: self.versions.clone(),
        }
    }

    /// Where the pipes go: the bridge port, and the runtime's socket (the file's, else where the
    /// runtime resolves it, crate::target::runtime_socket).
    pub fn targets(&self, resolved: impl FnOnce() -> Option<PathBuf>) -> Targets {
        Targets {
            bridge_port: self.bridge.as_ref().map(|(port, _)| *port),
            native_socket: self.native_bearer.as_ref().and_then(|_| self.native_socket.clone().or_else(resolved)),
        }
    }
}
