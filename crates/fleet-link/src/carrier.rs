//! What the link agent puts on a carrier (shared/vendor/paseo-e2ee/secure-channel.ts, protected
//! mode only): message 1 inside an `e2ee_hello` JSON envelope, message 2 out of the `e2ee_ready`
//! that answers it, then one record per mux frame, as a binary carrier message when the
//! handshake selected binary ciphertext and as base64 text otherwise.

use x25519_dalek::{PublicKey, StaticSecret};

use crate::b64;
use crate::channel::{Channel, ClientHandshake, MAX_CARRIER_BINARY_BYTES, MAX_CARRIER_TEXT_BYTES};
use crate::json::{self, Json};
use crate::records::FrameKind;
use crate::Error;

const PROTECTED_ENVELOPE_VERSION: u64 = 1;

#[derive(Clone, PartialEq, Eq)]
pub enum Message {
    Text(String),
    Binary(Vec<u8>),
}

impl std::fmt::Debug for Message {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Message::Text(text) => f.debug_tuple("Text").field(&text.len()).finish(),
            Message::Binary(bytes) => f.debug_tuple("Binary").field(&bytes.len()).finish(),
        }
    }
}

/// Why the channel could not open or a carrier message was refused: fixed texts only.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CarrierError {
    Handshake(Error),
    MalformedReady,
    LegacyOnly,
    UnsupportedEnvelope,
    Plaintext,
    Record(Error),
    TextFrame,
}

impl std::fmt::Display for CarrierError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CarrierError::Handshake(error) => write!(f, "handshake failed: {error}"),
            CarrierError::MalformedReady => f.write_str("handshake failed: malformed ready envelope"),
            CarrierError::LegacyOnly => f.write_str("handshake failed: daemon offered only legacy endpoint security"),
            CarrierError::UnsupportedEnvelope => f.write_str("handshake failed: unsupported protected envelope version"),
            CarrierError::Plaintext => f.write_str("record failed: received plaintext frame on encrypted channel"),
            CarrierError::Record(error) => write!(f, "record failed: {error}"),
            CarrierError::TextFrame => f.write_str("record failed: a machine session carries binary frames only"),
        }
    }
}

impl std::error::Error for CarrierError {}

/// The `e2ee_hello` the client sends, as secure-channel.ts writes it. `key` is the legacy box
/// mode's public key, which a daemon reads only when `protected` is absent: a fresh key whose
/// secret is dropped at once, since this agent never runs the legacy mode.
pub fn hello(message1: &[u8]) -> String {
    let unused = PublicKey::from(&StaticSecret::random());
    format!(
        "{{\"type\":\"e2ee_hello\",\"key\":{},\"capabilities\":{{\"binaryCiphertext\":true}},\"protected\":{{\"v\":{PROTECTED_ENVELOPE_VERSION},\"message\":{}}}}}",
        json::quote(&b64::encode(unused.as_bytes())),
        json::quote(&b64::encode(message1)),
    )
}

/// Message 2 from a carrier text: `None` for anything that is not an `e2ee_ready` (secure-channel.ts
/// ignores it while it waits), an error for a ready it cannot use.
pub fn ready(text: &str) -> Result<Option<Vec<u8>>, CarrierError> {
    let Some(value) = json::parse(text.as_bytes()) else { return Ok(None) };
    if value.get("type").and_then(Json::as_str) != Some("e2ee_ready") {
        return Ok(None);
    }
    let capabilities_ok = match value.get("capabilities") {
        None => true,
        Some(capabilities) => capabilities.is_object() && capabilities.get("binaryCiphertext").is_none_or(|flag| matches!(flag, Json::Bool(_))),
    };
    let Some(envelope) = value.get("protected") else {
        return Err(if capabilities_ok { CarrierError::LegacyOnly } else { CarrierError::MalformedReady });
    };
    let version = envelope.get("v");
    let message = envelope.get("message").and_then(Json::as_str).filter(|message| !message.is_empty());
    let (Some(Json::Number(version)), Some(message), true) = (version, message, capabilities_ok) else {
        return Err(CarrierError::MalformedReady);
    };
    if *version != PROTECTED_ENVELOPE_VERSION as f64 {
        return Err(CarrierError::UnsupportedEnvelope);
    }
    b64::decode(message).map(Some).ok_or(CarrierError::MalformedReady)
}

pub fn finish(handshake: ClientHandshake, message2: &[u8]) -> Result<Channel, CarrierError> {
    handshake.finish(message2).map_err(CarrierError::Handshake)
}

/// One mux frame as one carrier message; a failure has ended the channel.
pub fn seal(channel: &mut Channel, frame: &[u8]) -> Result<Message, CarrierError> {
    let record = channel.seal(FrameKind::Binary, frame).map_err(CarrierError::Record)?;
    Ok(if channel.binary_ciphertext() { Message::Binary(record) } else { Message::Text(b64::encode(&record)) })
}

/// The wire bytes `frame_bytes` of mux frame take as a carrier message.
pub fn wire_bytes(binary_ciphertext: bool, frame_bytes: usize) -> usize {
    let record = crate::records::protected_record_byte_length(frame_bytes);
    if binary_ciphertext {
        record
    } else {
        record.div_ceil(3) * 4
    }
}

/// The mux frame a carrier message holds; `None` for a repeated handshake envelope, which the
/// client ignores once the channel is open. Any failure ends the channel.
pub fn open(channel: &mut Channel, message: &Message) -> Result<Option<Vec<u8>>, CarrierError> {
    let record = match message {
        Message::Binary(bytes) => {
            if bytes.len() > MAX_CARRIER_BINARY_BYTES {
                return Err(CarrierError::Record(Error::CarrierMessageTooLarge));
            }
            std::borrow::Cow::Borrowed(bytes.as_slice())
        }
        Message::Text(text) => {
            if text.len() > MAX_CARRIER_TEXT_BYTES {
                return Err(CarrierError::Record(Error::CarrierMessageTooLarge));
            }
            if text.trim_start().starts_with('{') {
                return match json::parse(text.as_bytes()) {
                    Some(value) if matches!(value.get("type").and_then(Json::as_str), Some("e2ee_hello" | "e2ee_ready")) => Ok(None),
                    _ => Err(CarrierError::Plaintext),
                };
            }
            let decoded = b64::decode(text.trim()).ok_or(CarrierError::Record(Error::RecordTruncated))?;
            if decoded.len() > MAX_CARRIER_BINARY_BYTES {
                return Err(CarrierError::Record(Error::CarrierMessageTooLarge));
            }
            std::borrow::Cow::Owned(decoded)
        }
    };
    let frame = channel.open(&record).map_err(CarrierError::Record)?;
    if frame.kind == FrameKind::Text {
        return Err(CarrierError::TextFrame);
    }
    Ok(Some(frame.data))
}
