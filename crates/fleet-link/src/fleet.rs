//! `<state>/fleet.json` (docs/fleet-link.md section 5, "The agent's files"): the controller this
//! machine belongs to and how to reach it. Written by the installer from the invite (todo 28) and
//! read as crate::private_file reads a secret: a regular file of mode 0600 or stricter, never through
//! a symbolic link. Everything the agent dials comes from here; nothing from the wire chooses a host.
//! While it holds an `invite` (the id and secret of the invite file the installer was given), the
//! agent enrols before its first AUTH and removes the invite once ENROLL_OK came (section 4).
//! It pins the fleet's OWNER key ("Owner key and members"): the controller is accepted only as a
//! member record that key signed, checked at every start (and so before any enrolment).
//!
//! ```json
//! {"v":1,"controller":{"server_id":"<32 hex>","server_public_key":"<base64, 32 bytes>",
//!  "relay":"wss://relay.example" | null,"direct":["ws://192.168.1.20:7319"]},
//!  "machine_key_file":"/abs/path/machine.key","invite":{"id":"<16 hex>","secret":"<base64url, 32 bytes>"},"relay_pace":{...}}
//! ```
//!
//! `relay_pace` (todo 37) is the newest relay pace the controller sent, written back by the agent; it is
//! a cache, so one that does not read is left out rather than refusing the file.

use std::fmt;
use std::net::{IpAddr, Ipv4Addr};
use std::path::{Path, PathBuf};

use ed25519_dalek::{Signature, VerifyingKey};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::b64;
use crate::hex;
use crate::json::{self, Json};
use crate::mux::RelayPace;
use crate::private_file::{self, PrivateFileError};

pub const MAX_FLEET_FILE_BYTES: u64 = 16 * 1024;
pub const MAX_DIRECT_CARRIERS: usize = 4;
const MAX_HOST_BYTES: usize = 253;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FleetError {
    File(PrivateFileError),
    NotJson,
    Version,
    ServerId,
    ServerKey,
    KeyMismatch,
    Relay,
    Direct,
    NoCarrier,
    KeyFile,
    Invite,
    Owner,
    NotMember,
    SeenState,
}

impl fmt::Display for FleetError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            FleetError::File(PrivateFileError::Unreadable) => "fleet.json cannot be read",
            FleetError::File(PrivateFileError::Symlink) => "fleet.json is a symbolic link",
            FleetError::File(PrivateFileError::NotAFile) => "fleet.json is not a regular file",
            FleetError::File(PrivateFileError::Exposed) => "fleet.json may be read or written by others (it must be mode 0600)",
            FleetError::File(PrivateFileError::TooLarge) => "fleet.json is too large",
            FleetError::NotJson => "fleet.json is not a JSON object",
            FleetError::Version => "fleet.json is not version 1",
            FleetError::ServerId => "fleet.json controller.server_id takes 32 hex digits",
            FleetError::ServerKey => "fleet.json controller.server_public_key takes 32 bytes of base64",
            FleetError::KeyMismatch => "controller key mismatch",
            FleetError::Relay => "fleet.json controller.relay is not a wss: origin",
            FleetError::Direct => "fleet.json controller.direct holds an address that is not a direct carrier",
            FleetError::NoCarrier => "fleet.json names neither a relay nor a direct carrier",
            FleetError::KeyFile => "fleet.json machine_key_file is not an absolute path",
            FleetError::Invite => "fleet.json invite takes an id of 16 hex digits and a secret of 32 bytes of base64url",
            FleetError::Owner => "fleet.json owner takes the owner key and the controller's member record signed by it",
            FleetError::NotMember => "controller not signed by the owner key",
            FleetError::SeenState => "fleet.json seen_state takes a generation and a tag of 32 bytes of base64url",
        })
    }
}

impl std::error::Error for FleetError {}

/// Where a carrier is: a host as written in fleet.json and a port.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Place {
    pub host: String,
    pub port: u16,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Relay {
    /// `wss:`, or `ws:` for a relay on this machine's loopback.
    pub tls: bool,
    pub place: Place,
}

impl Relay {
    /// The client socket of relay/core.ts in the paced lane of todo 35.
    pub fn url(&self, server_id: &str) -> String {
        let scheme = if self.tls { "wss" } else { "ws" };
        format!("{scheme}://{}:{}/v1/ws?server_id={server_id}&role=client&v=1&lane=paced", self.place.host, self.place.port)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fleet {
    pub server_id: String,
    pub server_key: [u8; 32],
    pub relay: Option<Relay>,
    /// `ws://<host>:<port>`: a private, Tailscale or loopback IPv4 address, or a name resolved at every dial.
    pub direct: Vec<Place>,
    pub machine_key_file: PathBuf,
    /// The invite to enrol with before the first AUTH, until ENROLL_OK came.
    pub invite: Option<FleetInvite>,
    /// The fleet's owner key and the controller as the member it signed.
    pub owner: Owner,
    /// The newest FLEET_STATE the controller sent (todo 31), presented as `seen_state` in AUTH.
    pub seen_state: Option<crate::mux::SeenState>,
    /// The newest relay pace the controller sent (todo 37), kept across restarts.
    pub relay_pace: Option<RelayPace>,
}

/// A member record as the owner key signs it (docs/fleet-link.md, "Owner key and members").
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Member {
    pub server_id: String,
    /// as written: standard base64 of the controller's 32-byte static key
    pub server_public_key: String,
    /// `opener` or `worker`
    pub class: String,
    pub open: bool,
    pub write: bool,
}

impl Member {
    /// `"ovis-fleet-member/1" || the record's canonical JSON`: what the owner key signs.
    pub fn signed_bytes(&self) -> Vec<u8> {
        format!(
            "ovis-fleet-member/1{{\"v\":1,\"server_id\":\"{}\",\"server_public_key\":\"{}\",\"class\":\"{}\",\"open\":{},\"write\":{}}}",
            self.server_id, self.server_public_key, self.class, self.open, self.write
        )
        .into_bytes()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Owner {
    pub public_key: [u8; 32],
    pub member: Member,
    pub signature: [u8; 64],
}

pub(crate) fn owner(value: &Json) -> Result<Owner, FleetError> {
    let public_key: [u8; 32] = value.get("public_key").and_then(Json::as_str).and_then(|text| b64::decode_url(text, 32)).and_then(|bytes| bytes.try_into().ok()).ok_or(FleetError::Owner)?;
    let signature: [u8; 64] = value.get("signature").and_then(Json::as_str).and_then(|text| b64::decode_url(text, 64)).and_then(|bytes| bytes.try_into().ok()).ok_or(FleetError::Owner)?;
    let record = value.get("member").filter(|member| member.is_object()).ok_or(FleetError::Owner)?;
    if record.get("v").and_then(|v| v.as_integer(1, 1)).is_none() {
        return Err(FleetError::Owner);
    }
    let server_public_key = record.get("server_public_key").and_then(Json::as_str).ok_or(FleetError::Owner)?;
    let key: [u8; 32] = b64::decode(server_public_key).filter(|bytes| b64::encode(bytes) == server_public_key).and_then(|bytes| bytes.try_into().ok()).ok_or(FleetError::Owner)?;
    let member_id = record.get("server_id").and_then(Json::as_str).filter(|id| *id == server_id(&key)).ok_or(FleetError::Owner)?;
    let class = record.get("class").and_then(Json::as_str).filter(|class| matches!(*class, "opener" | "worker")).ok_or(FleetError::Owner)?;
    let flag = |name: &str| match record.get(name) {
        Some(Json::Bool(value)) => Ok(*value),
        _ => Err(FleetError::Owner),
    };
    let member = Member { server_id: member_id.to_owned(), server_public_key: server_public_key.to_owned(), class: class.to_owned(), open: flag("open")?, write: flag("write")? };
    Ok(Owner { public_key, member, signature })
}

/// The owner key signed `owner.member`, and that member is the controller `server_key` that may open: the only
/// controller a machine accepts. A record another key signed, or one for another (a rotated) key, is `NotMember`.
pub(crate) fn verify_member(owner: &Owner, server_key: &[u8; 32]) -> Result<(), FleetError> {
    let key = VerifyingKey::from_bytes(&owner.public_key).map_err(|_| FleetError::Owner)?;
    key.verify_strict(&owner.member.signed_bytes(), &Signature::from_bytes(&owner.signature)).map_err(|_| FleetError::NotMember)?;
    if owner.member.server_public_key != b64::encode(server_key) || !owner.member.open {
        return Err(FleetError::NotMember);
    }
    Ok(())
}

/// fleet.json's `invite`: the secret is wiped on drop and never formatted.
#[derive(Clone, PartialEq, Eq)]
pub struct FleetInvite {
    pub id: String,
    pub secret: Zeroizing<[u8; 32]>,
}

impl fmt::Debug for FleetInvite {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("FleetInvite").field("id", &self.id).finish_non_exhaustive()
    }
}

fn invite(value: &Json) -> Result<FleetInvite, FleetError> {
    let id = value.get("id").and_then(Json::as_str).filter(|id| id.len() == 16 && id.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))).ok_or(FleetError::Invite)?;
    let secret: [u8; 32] = value.get("secret").and_then(Json::as_str).and_then(|text| b64::decode_url(text, 32)).and_then(|bytes| bytes.try_into().ok()).ok_or(FleetError::Invite)?;
    Ok(FleetInvite { id: id.to_owned(), secret: Zeroizing::new(secret) })
}

impl Fleet {
    pub fn direct_url(place: &Place) -> String {
        format!("ws://{}:{}/v1/ws?v=1", place.host, place.port)
    }
}

/// shared/relay-server-proof.ts deriveServerId: the controller's id from its static key.
pub fn server_id(controller_key: &[u8; 32]) -> String {
    hex::encode(&Sha256::new().chain_update(b"ovis-relay-server-id-v1").chain_update(controller_key).finalize()[..16])
}

/// An address a direct carrier may have: private (RFC 1918, link-local), Tailscale (100.64.0.0/10) or loopback.
pub fn direct_address(address: IpAddr) -> bool {
    let IpAddr::V4(v4) = address else { return false };
    let [a, b, ..] = v4.octets();
    v4.is_private() || v4.is_link_local() || v4.is_loopback() || (a == 100 && (64..128).contains(&b))
}

fn host_name(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= MAX_HOST_BYTES
        && text.split('.').all(|label| !label.is_empty() && label.len() <= 63 && !label.starts_with('-') && !label.ends_with('-') && label.bytes().all(|byte| matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'-')))
}

/// `<host>:<port>` with the port written out, no leading zero.
fn place(text: &str) -> Option<Place> {
    let (host, port) = text.rsplit_once(':')?;
    let port_ok = !port.is_empty() && port.len() <= 5 && port.bytes().all(|byte| byte.is_ascii_digit()) && !port.starts_with('0');
    let port: u16 = port.parse().ok().filter(|_| port_ok)?;
    Some(Place { host: host.to_owned(), port })
}

pub(crate) fn ipv4(text: &str) -> Option<Ipv4Addr> {
    // canonical dotted quads only: Rust refuses leading zeros, as isDirectCarrier does
    text.parse().ok()
}

pub(crate) fn relay(text: &str) -> Option<Relay> {
    if let Some(rest) = text.strip_prefix("wss://") {
        let (host, port) = match rest.rsplit_once(':') {
            Some(_) => {
                let place = place(rest)?;
                (place.host, place.port)
            }
            None => (rest.to_owned(), 443),
        };
        let canonical = if port == 443 { host.clone() } else { format!("{host}:{port}") };
        return (canonical == rest && host_name(&host)).then_some(Relay { tls: true, place: Place { host, port } });
    }
    let place = place(text.strip_prefix("ws://")?)?;
    ipv4(&place.host).filter(Ipv4Addr::is_loopback)?;
    Some(Relay { tls: false, place })
}

/// A carrier a controller may name in AUTH_OK (todo 29): `ws://<IPv4>:<port>`, private or Tailscale, as
/// shared/relay-mux.ts isDirectCarrier takes it; never a name or loopback, which only the installer may write here.
pub fn announced_carrier(text: &str) -> bool {
    direct(text).is_some_and(|place| ipv4(&place.host).is_some_and(|address| !address.is_loopback()))
}

pub fn direct(text: &str) -> Option<Place> {
    let place = place(text.strip_prefix("ws://")?)?;
    match ipv4(&place.host) {
        Some(address) => direct_address(IpAddr::V4(address)).then_some(place),
        None => (host_name(&place.host) && place.host.parse::<IpAddr>().is_err()).then_some(place),
    }
}

pub fn parse(bytes: &[u8]) -> Result<Fleet, FleetError> {
    let value = json::parse(bytes).filter(Json::is_object).ok_or(FleetError::NotJson)?;
    if value.get("v").and_then(|v| v.as_integer(1, 1)).is_none() {
        return Err(FleetError::Version);
    }
    let controller = value.get("controller").filter(|controller| controller.is_object()).ok_or(FleetError::ServerId)?;
    let server_id = controller.get("server_id").and_then(Json::as_str).filter(|id| id.len() == 32 && id.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))).ok_or(FleetError::ServerId)?;
    let server_key: [u8; 32] = controller.get("server_public_key").and_then(Json::as_str).and_then(b64::decode).and_then(|key| key.try_into().ok()).ok_or(FleetError::ServerKey)?;
    if self::server_id(&server_key) != server_id {
        return Err(FleetError::KeyMismatch);
    }
    let relay = match controller.get("relay") {
        None | Some(Json::Null) => None,
        Some(origin) => Some(origin.as_str().and_then(relay).ok_or(FleetError::Relay)?),
    };
    let direct = match controller.get("direct") {
        None => Vec::new(),
        Some(list) => {
            let items = list.as_array().filter(|items| items.len() <= MAX_DIRECT_CARRIERS).ok_or(FleetError::Direct)?;
            let mut places: Vec<Place> = Vec::new();
            for item in items {
                let place = item.as_str().and_then(direct).ok_or(FleetError::Direct)?;
                if places.contains(&place) {
                    return Err(FleetError::Direct);
                }
                places.push(place);
            }
            places
        }
    };
    if relay.is_none() && direct.is_empty() {
        return Err(FleetError::NoCarrier);
    }
    let owner = owner(value.get("owner").filter(|owner| owner.is_object()).ok_or(FleetError::Owner)?)?;
    verify_member(&owner, &server_key)?;
    let machine_key_file = value.get("machine_key_file").and_then(Json::as_str).map(PathBuf::from).filter(|path| path.is_absolute()).ok_or(FleetError::KeyFile)?;
    let invite = match value.get("invite") {
        None => None,
        Some(entry) if entry.is_object() => Some(invite(entry)?),
        Some(_) => return Err(FleetError::Invite),
    };
    let seen_state = match value.get("seen_state") {
        None => None,
        Some(state) => Some(seen_state(state).ok_or(FleetError::SeenState)?),
    };
    let relay_pace = value.get("relay_pace").and_then(saved_pace);
    Ok(Fleet { server_id: server_id.to_owned(), server_key, relay, direct, machine_key_file, invite, owner, seen_state, relay_pace })
}

/// fleet.json's bytes without `invite` (ENROLL_OK came: the secret goes), every other key kept; refused when the file on
/// disk names another controller or another invite now, or when the result would be refused at the next start.
pub fn without_invite(path: &Path, running: &Fleet, invite_id: &str) -> Result<Vec<u8>, &'static str> {
    let bytes = Zeroizing::new(private_file::read(path, MAX_FLEET_FILE_BYTES).map_err(|_| "fleet.json cannot be read")?);
    let on_disk = parse(&bytes).map_err(|_| "fleet.json is refused")?;
    if on_disk.server_id != running.server_id || on_disk.server_key != running.server_key {
        return Err("fleet.json names another controller now");
    }
    if on_disk.invite.as_ref().is_none_or(|held| held.id != invite_id) {
        return Err("fleet.json holds another invite now");
    }
    let mut value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| "fleet.json is refused")?;
    if let Some(object) = value.as_object_mut() {
        if let Some(mut gone) = object.remove("invite") {
            if let Some(secret) = gone.get_mut("secret") {
                *secret = serde_json::Value::Null;
            }
        }
    }
    let written = serde_json::to_vec(&value).map_err(|_| "fleet.json cannot be written")?;
    match parse(&written) {
        Ok(saved) if saved.invite.is_none() => Ok(written),
        _ => Err("fleet.json would be refused"),
    }
}

/// A `relay_pace` as PACE's field table bounds it (docs/fleet-link.md, Fields), or None.
fn saved_pace(value: &Json) -> Option<RelayPace> {
    let field = |name: &str, min: u64, max: u64| value.get(name).and_then(|field| field.as_integer(min, max));
    let span = field("span", 1, 4096)?;
    let per_minute = field("per_minute", 1, 600)?;
    if span < per_minute {
        return None;
    }
    Some(RelayPace {
        generation: field("generation", 0, (1 << 53) - 1)?,
        per_minute,
        burst: field("burst", 0, 600)?,
        slot: field("slot", 0, span - 1)?,
        span,
        controller_ms: field("controller_ms", 0, (1 << 53) - 1)?,
        rtt_ms: field("rtt_ms", 0, 60_000)?,
    })
}

/// fleet.json's bytes with `relay_pace` replaced by `pace` (todo 37), every other key kept; refused as `with_direct` is.
pub fn with_pace(path: &Path, running: &Fleet, pace: &RelayPace) -> Result<Vec<u8>, &'static str> {
    let bytes = private_file::read(path, MAX_FLEET_FILE_BYTES).map_err(|_| "fleet.json cannot be read")?;
    let on_disk = parse(&bytes).map_err(|_| "fleet.json is refused")?;
    if on_disk.server_id != running.server_id || on_disk.server_key != running.server_key {
        return Err("fleet.json names another controller now");
    }
    let mut value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| "fleet.json is refused")?;
    value["relay_pace"] = serde_json::json!({
        "generation": pace.generation, "per_minute": pace.per_minute, "burst": pace.burst, "slot": pace.slot,
        "span": pace.span, "controller_ms": pace.controller_ms, "rtt_ms": pace.rtt_ms,
    });
    let written = serde_json::to_vec(&value).map_err(|_| "fleet.json cannot be written")?;
    match parse(&written) {
        Ok(saved) if saved.relay_pace == Some(*pace) && written.len() as u64 <= MAX_FLEET_FILE_BYTES => Ok(written),
        _ => Err("fleet.json would be refused"),
    }
}

/// fleet.json's bytes with `controller.direct` replaced by `carriers` (an AUTH_OK's, todo 29), every other key kept;
/// refused when the file on disk is no longer the running agent's controller, or when the result would be refused at
/// the next start.
pub fn with_direct(path: &Path, running: &Fleet, carriers: &[String]) -> Result<Vec<u8>, &'static str> {
    if carriers.is_empty() || !carriers.iter().all(|carrier| announced_carrier(carrier)) {
        return Err("the carriers are not direct carriers");
    }
    let bytes = private_file::read(path, MAX_FLEET_FILE_BYTES).map_err(|_| "fleet.json cannot be read")?;
    let on_disk = parse(&bytes).map_err(|_| "fleet.json is refused")?;
    if on_disk.server_id != running.server_id || on_disk.server_key != running.server_key {
        return Err("fleet.json names another controller now");
    }
    let mut value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| "fleet.json is refused")?;
    value["controller"]["direct"] = serde_json::Value::from(carriers.to_vec());
    let written = serde_json::to_vec(&value).map_err(|_| "fleet.json cannot be written")?;
    match parse(&written) {
        Ok(saved) if saved.direct.len() == carriers.len() && written.len() as u64 <= MAX_FLEET_FILE_BYTES => Ok(written),
        _ => Err("fleet.json would be refused"),
    }
}

fn seen_state(value: &Json) -> Option<crate::mux::SeenState> {
    let generation = value.get("generation").and_then(|generation| generation.as_integer(0, (1 << 53) - 1))?;
    let tag: [u8; 32] = value.get("tag").and_then(Json::as_str).and_then(|tag| b64::decode_url(tag, 32)).and_then(|tag| tag.try_into().ok())?;
    Some(crate::mux::SeenState { generation, tag })
}

/// fleet.json's bytes with `seen_state` set to a FLEET_STATE the running agent's controller sent (todo 31), every other
/// key kept; refused when the file on disk names another controller now, or when the result would be refused.
pub fn with_seen_state(path: &Path, running: &Fleet, state: &crate::mux::SeenState) -> Result<Vec<u8>, &'static str> {
    let bytes = Zeroizing::new(private_file::read(path, MAX_FLEET_FILE_BYTES).map_err(|_| "fleet.json cannot be read")?);
    let on_disk = parse(&bytes).map_err(|_| "fleet.json is refused")?;
    if on_disk.server_id != running.server_id || on_disk.server_key != running.server_key {
        return Err("fleet.json names another controller now");
    }
    let mut value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| "fleet.json is refused")?;
    value["seen_state"] = serde_json::json!({ "generation": state.generation, "tag": b64::encode_url(&state.tag) });
    let written = serde_json::to_vec(&value).map_err(|_| "fleet.json cannot be written")?;
    match parse(&written) {
        Ok(saved) if saved.seen_state.as_ref() == Some(state) && written.len() as u64 <= MAX_FLEET_FILE_BYTES => Ok(written),
        _ => Err("fleet.json would be refused"),
    }
}

pub fn load(path: &Path) -> Result<Fleet, FleetError> {
    let bytes = private_file::read(path, MAX_FLEET_FILE_BYTES).map_err(FleetError::File)?;
    parse(&bytes)
}
