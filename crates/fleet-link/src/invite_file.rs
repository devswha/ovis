//! The invite file a machine joins with (docs/fleet-link.md section 4), read as server/fleet/invites.ts `parseInvite`
//! reads it (server/fleet/vectors/invite.json holds the cases both readers share). Its single-line form is decoded by
//! crate::invite::decode_line and then read here: one reader for both. The secret is wiped on drop and never formatted.

use std::fmt;

use zeroize::Zeroizing;

use crate::b64;
use crate::fleet::{self, FleetError, Owner};
use crate::json::{self, Json};

use crate::invite::{decode_line, INVITE_LINE_PREFIX, MAX_INVITE_BYTES};

/// Why an invite was refused. No variant carries data read from it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InviteError {
    /// The line is not `ovis-invite:1:` and canonical base64url within the bound (crate::invite::decode_line).
    Line,
    /// The file breaks a rule of section 4 (the text says which).
    Invalid(&'static str),
    /// `server_id` is not the one `server_public_key` derives.
    KeyMismatch,
    /// The owner record does not name the controller as a member that may open, under the owner key.
    NotMember,
}

impl fmt::Display for InviteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            InviteError::Line => f.write_str("invalid invite line: not ovis-invite:1: and canonical base64url of at most 4096 bytes"),
            InviteError::Invalid(why) => write!(f, "invalid invite: {why}"),
            InviteError::KeyMismatch => f.write_str("controller key mismatch"),
            InviteError::NotMember => f.write_str("controller not signed by the owner key"),
        }
    }
}

impl std::error::Error for InviteError {}

/// An invite as read: the controller and the owner block as their canonical JSON (what the controller wrote, so a
/// canonical invite's own bytes), the id, the slot, the secret and the expiry.
#[derive(Clone, PartialEq, Eq)]
pub struct Invite {
    pub id: String,
    pub slot: u64,
    pub server_id: String,
    /// standard base64, as written
    pub server_public_key: String,
    /// a `wss:` origin, as written
    pub relay: Option<String>,
    pub direct: Vec<String>,
    pub owner: Owner,
    pub secret: Zeroizing<String>,
    pub exp: u64,
}

impl fmt::Debug for Invite {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Invite").field("id", &self.id).field("slot", &self.slot).field("server_id", &self.server_id).finish_non_exhaustive()
    }
}

/// The invite of `bytes`: a file, or its single-line form when they start with the line prefix (decoded by
/// crate::invite::decode_line, which drops the ASCII whitespace around a pasted line).
pub fn read(bytes: &[u8]) -> Result<Invite, InviteError> {
    if bytes.trim_ascii_start().starts_with(INVITE_LINE_PREFIX.as_bytes()) {
        let line = std::str::from_utf8(bytes).map_err(|_| InviteError::Line)?;
        return parse(&decode_line(line).map_err(|_| InviteError::Line)?);
    }
    parse(bytes)
}

fn is_hex(text: &str, length: usize) -> bool {
    text.len() == length && text.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// A direct carrier an invite may name: a private or Tailscale IPv4 address, or a name (never loopback, never public).
fn invite_carrier(text: &str) -> bool {
    fleet::direct(text).is_some_and(|place| fleet::ipv4(&place.host).is_none_or(|address| !address.is_loopback()))
}

/// The invite file of section 4, refused whole when it breaks any rule.
pub fn parse(bytes: &[u8]) -> Result<Invite, InviteError> {
    use InviteError::Invalid;
    if bytes.len() > MAX_INVITE_BYTES {
        return Err(Invalid("more than 4096 bytes"));
    }
    let value = json::parse(bytes).filter(Json::is_object).ok_or(Invalid("not a JSON object"))?;
    if value.get("v").and_then(|v| v.as_integer(1, 1)).is_none() {
        return Err(Invalid("not version 1"));
    }
    let id = value.get("id").and_then(Json::as_str).filter(|id| is_hex(id, 16)).ok_or(Invalid("id is not 16 hex digits"))?;
    let slot = value.get("slot").and_then(|slot| slot.as_integer(0, 65535)).ok_or(Invalid("slot is not 0..65535"))?;
    let controller = value.get("controller").filter(|controller| controller.is_object()).ok_or(Invalid("controller is not an object"))?;
    let key_text = controller.get("server_public_key").and_then(Json::as_str).ok_or(Invalid("server_public_key is not 32 bytes of base64"))?;
    let key: [u8; 32] = b64::decode(key_text)
        .filter(|bytes| b64::encode(bytes) == key_text)
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or(Invalid("server_public_key is not 32 bytes of base64"))?;
    let server_id = controller.get("server_id").and_then(Json::as_str).ok_or(Invalid("server_id is not 32 hex digits"))?;
    if server_id != fleet::server_id(&key) {
        return Err(InviteError::KeyMismatch);
    }
    let relay = match controller.get("relay") {
        Some(Json::Null) => None,
        Some(Json::String(origin)) if fleet::relay(origin).is_some_and(|relay| relay.tls) => Some(origin.clone()),
        _ => return Err(Invalid("relay is not a wss: origin or null")),
    };
    let items = controller.get("direct").and_then(Json::as_array).filter(|items| items.len() <= fleet::MAX_DIRECT_CARRIERS).ok_or(Invalid("direct is not up to 4 distinct direct carriers"))?;
    let mut direct: Vec<String> = Vec::new();
    for item in items {
        let text = item.as_str().filter(|text| invite_carrier(text) && !direct.iter().any(|seen| seen == text)).ok_or(Invalid("direct is not up to 4 distinct direct carriers"))?;
        direct.push(text.to_owned());
    }
    if relay.is_none() && direct.is_empty() {
        return Err(Invalid("it names no carrier"));
    }
    let owner = value.get("owner").filter(|owner| owner.is_object()).ok_or(Invalid("owner is missing"));
    let owner = fleet::owner(owner?).map_err(|_| Invalid("owner is not an owner key and a member record"))?;
    fleet::verify_member(&owner, &key).map_err(|error| if error == FleetError::NotMember { InviteError::NotMember } else { Invalid("owner is not an owner key and a member record") })?;
    let secret = value.get("secret").and_then(Json::as_str).filter(|text| b64::decode_url(text, 32).is_some()).ok_or(Invalid("secret is not 32 bytes of base64url"))?;
    let exp = value.get("exp").and_then(|exp| exp.as_integer(0, (1 << 53) - 1)).ok_or(Invalid("exp is not seconds"))?;
    Ok(Invite {
        id: id.to_owned(),
        slot,
        server_id: server_id.to_owned(),
        server_public_key: key_text.to_owned(),
        relay,
        direct,
        owner,
        secret: Zeroizing::new(secret.to_owned()),
        exp,
    })
}

impl Invite {
    /// `controller` as the controller writes it (field-table order, compact).
    pub fn controller_json(&self) -> String {
        let relay = self.relay.as_deref().map_or_else(|| "null".to_owned(), json::quote);
        let direct: Vec<String> = self.direct.iter().map(|carrier| json::quote(carrier)).collect();
        format!(
            "{{\"server_id\":{},\"server_public_key\":{},\"relay\":{relay},\"direct\":[{}]}}",
            json::quote(&self.server_id),
            json::quote(&self.server_public_key),
            direct.join(",")
        )
    }

    /// `owner` as the controller writes it: the same bytes as the invite's own for a canonical invite.
    pub fn owner_json(&self) -> String {
        let member = &self.owner.member;
        format!(
            "{{\"public_key\":{},\"member\":{{\"v\":1,\"server_id\":{},\"server_public_key\":{},\"class\":{},\"open\":{},\"write\":{}}},\"signature\":{}}}",
            json::quote(&b64::encode_url(&self.owner.public_key)),
            json::quote(&member.server_id),
            json::quote(&member.server_public_key),
            json::quote(&member.class),
            member.open,
            member.write,
            json::quote(&b64::encode_url(&self.owner.signature)),
        )
    }
}
