//! The part of Ovis Mux v1 a fleet machine speaks (docs/fleet-link.md, shared/relay-mux.ts and
//! server/fleet/mux-ext.ts): the 8-byte envelope, the frames a controller may send a machine, and
//! the frames a machine sends. Each direction has its own reader; every frame the encoder writes
//! is read back by the machine-side reader before it goes out, so the agent cannot send a frame
//! that reader refuses, and that reader has no arm for HTTP, WS, PAIR, ENROLL_OK or PIPE_OPEN.

use std::fmt;

use zeroize::Zeroizing;

use crate::b64;
use crate::json::{self, Json};

pub const RELAY_PROTOCOL: u8 = 1;
pub const ENVELOPE_BYTES: usize = 8;
pub const MAX_FRAME_BYTES: usize = 16384;
pub const PIPE_DATA_BYTES: usize = MAX_FRAME_BYTES - ENVELOPE_BYTES;
pub const PIPE_WINDOW_BYTES: u64 = 786_432;
pub const MAX_PIPE_STREAMS: u64 = 16;
pub const PIPE_STREAM: &str = "pipe-stream";
pub const MACHINE_KEY: &str = "machine-key";
/// GOAWAY's `reason` when the owner confirmed this pending machine (todo 37): only that GOAWAY carries it, and only after
/// it does the agent dial the relay at once; a controller's shutdown sends none.
pub const GOAWAY_CONFIRMED: &str = "confirmed";
/// AUTH's `features` entry saying this agent reads PACE frames (todo 37): the controller sends PACE only to an agent that
/// announced it, since an older one refuses the frame. Todo 31 adds `fleet_state` to the same list.
pub const PACE_FEATURE: &str = "pace";
/// The AUTH feature that says this agent reads FLEET_STATE (todo 31): the controller sends it only then.
pub const FLEET_STATE_FEATURE: &str = "fleet_state";
const METADATA_FRAME_BYTES: usize = 1024;
const SETUP_FRAME_BYTES: usize = 4096;
const PIPE_ADVERT_BYTES: usize = 4096;
const MAX_STREAM_ID: u32 = 0x7fff_ffff;
const MAX_INTEGER: u64 = (1 << 53) - 1;

pub mod frame_type {
    pub const HELLO: u8 = 0x01;
    pub const WELCOME: u8 = 0x02;
    pub const AUTH: u8 = 0x03;
    pub const AUTH_OK: u8 = 0x04;
    pub const SESSION_ERROR: u8 = 0x05;
    pub const GOAWAY: u8 = 0x06;
    pub const PING: u8 = 0x07;
    pub const PONG: u8 = 0x08;
    pub const RECEIVED: u8 = 0x09;
    pub const CREDIT: u8 = 0x30;
    pub const RESET: u8 = 0x31;
    pub const PIPE_OPEN: u8 = 0x40;
    pub const PIPE_ACCEPT: u8 = 0x41;
    pub const PIPE_DATA: u8 = 0x42;
    pub const PIPE_END: u8 = 0x43;
    pub const PIPE_ADVERT: u8 = 0x44;
    pub const ENROLL: u8 = 0x45;
    pub const ENROLL_OK: u8 = 0x46;
    pub const FLEET_STATE: u8 = 0x48;
    pub const PACE: u8 = 0x47;
}
use frame_type as t;

macro_rules! names {
    ($name:ident { $($variant:ident = $text:literal),+ $(,)? }) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        pub enum $name { $($variant),+ }
        impl $name {
            pub const ALL: &'static [$name] = &[$($name::$variant),+];
            pub fn as_str(self) -> &'static str {
                match self { $($name::$variant => $text),+ }
            }
            pub fn parse(text: &str) -> Option<Self> {
                Self::ALL.iter().copied().find(|value| value.as_str() == text)
            }
        }
        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str(self.as_str()) }
        }
    };
}

names!(SessionError {
    UnsupportedVersion = "unsupported_version",
    UnsupportedExtension = "unsupported_extension",
    UnsupportedTransport = "unsupported_transport",
    ProtocolError = "protocol_error",
    AuthFailed = "auth_failed",
    AuthRevoked = "auth_revoked",
    AuthChanged = "auth_changed",
    FlowControlError = "flow_control_error",
    ResourceExhausted = "resource_exhausted",
    Timeout = "timeout",
    InternalError = "internal_error",
});

names!(StreamError {
    Cancelled = "cancelled",
    Refused = "refused",
    BadRequest = "bad_request",
    BodyTooLarge = "body_too_large",
    MessageTooLarge = "message_too_large",
    StreamProtocolError = "stream_protocol_error",
    UpstreamLost = "upstream_lost",
    SlowConsumer = "slow_consumer",
    ResourceExhausted = "resource_exhausted",
    InternalError = "internal_error",
});

// the five codes a RESET on a pipe carries (docs/fleet-link.md section 2)
names!(PipeReset {
    Refused = "refused",
    InternalError = "internal_error",
    UpstreamLost = "upstream_lost",
    SlowConsumer = "slow_consumer",
    Cancelled = "cancelled",
});

// the refusal causes of docs/fleet-link.md section 1 a SESSION_ERROR message may name
names!(Cause {
    Signature = "signature",
    Unknown = "unknown",
    Expired = "expired",
    RateLimited = "rate_limited",
    WrongScheme = "wrong_scheme",
    Restored = "restored",
    Revoked = "revoked",
    Quarantined = "quarantined",
    FleetTokenRequired = "fleet_token_required",
    ControllerLimit = "controller_limit",
});

names!(Endpoint { Bridge = "bridge", Native = "native" });
names!(UpDown { Up = "up", Down = "down" });
names!(GoAwayCode { Shutdown = "shutdown", IdExhausted = "id_exhausted" });

/// Why a frame was refused. The message is a fixed text: it never carries a byte of the frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Refusal {
    pub code: SessionError,
    pub message: &'static str,
}

fn refuse<T>(message: &'static str) -> Result<T, Refusal> {
    Err(Refusal { code: SessionError::ProtocolError, message })
}
fn require(condition: bool, message: &'static str) -> Result<(), Refusal> {
    if condition {
        Ok(())
    } else {
        refuse(message)
    }
}

pub const NOT_FOR_A_MACHINE: &str = "Not a frame for a machine";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction {
    ControllerToMachine,
    MachineToController,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Limits {
    pub max_streams: u64,
    pub max_ws_streams: u64,
    pub max_sse_streams: u64,
    pub max_pipe_streams: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Welcome {
    pub features: Vec<String>,
    pub limits: Limits,
    pub nonce: [u8; 32],
    pub server_version: String,
    pub relay_protocol: u64,
    pub min_supported_client: String,
    pub provisional: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RelayPace {
    pub generation: u64,
    pub per_minute: u64,
    pub burst: u64,
    pub slot: u64,
    pub span: u64,
    pub controller_ms: u64,
    pub rtt_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthOk {
    pub session_id: String,
    pub machine_id: String,
    pub relay_pace: Option<RelayPace>,
    /// The controller's direct carriers for this machine (todo 29), as written: saved as fleet.json `controller.direct`.
    pub direct: Option<Vec<String>>,
    /// The controller holds this machine `pending` until the owner confirms its batch (todo 30): signed in, but no
    /// pipe opens to it. Absent (a controller that does not send it) reads as not pending.
    pub pending: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SeenState {
    pub generation: u64,
    pub tag: [u8; 32],
}

#[derive(Clone, PartialEq, Eq)]
pub struct Auth {
    pub machine_id: String,
    pub signature: [u8; 64],
    /// What this agent reads beyond the frames every agent reads (`pace`); unknown names are ignored, absent is none.
    pub features: Vec<String>,
    pub seen_state: Option<SeenState>,
}

impl fmt::Debug for Auth {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Auth").field("machine_id", &self.machine_id).field("signature", &"<64 bytes>").finish_non_exhaustive()
    }
}

/// ENROLL (docs/fleet-link.md section 4): the invite, the new machine key and the invite key's signature.
#[derive(Clone, PartialEq, Eq)]
pub struct Enroll {
    pub invite_id: String,
    pub machine_public_key: [u8; crate::machine_key::SPKI_BYTES],
    pub signature: [u8; 64],
    pub now: u64,
}

impl fmt::Debug for Enroll {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Enroll").field("invite_id", &self.invite_id).field("signature", &"<64 bytes>").finish_non_exhaustive()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GoAway {
    pub code: GoAwayCode,
    pub last_open_id: u32,
    pub drain_ms: u64,
    /// Why the controller ends the session, when it says: [`GOAWAY_CONFIRMED`] after the owner confirmed this pending
    /// machine. A reason this agent does not act on is ignored.
    pub reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Health {
    pub runtime: UpDown,
    pub bridge: UpDown,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Versions {
    pub server: String,
    pub link: String,
    pub agent: String,
    pub runtime: String,
}

/// PIPE_ADVERT (docs/fleet-link.md section 1.8). The bridge token and the runtime bearer are wiped
/// when it drops, and never formatted.
#[derive(Clone, PartialEq, Eq)]
pub struct Advert {
    pub endpoints: Vec<Endpoint>,
    pub runtime_id: String,
    pub boot_id: String,
    pub bridge_token: Option<Zeroizing<String>>,
    pub native_bearer: Option<Zeroizing<String>>,
    pub health: Health,
    pub now: u64,
    pub versions: Versions,
}

impl fmt::Debug for Advert {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Advert")
            .field("endpoints", &self.endpoints)
            .field("runtime_id", &self.runtime_id)
            .field("boot_id", &self.boot_id)
            .field("bridge_token", &self.bridge_token.as_ref().map(|_| "<redacted>"))
            .field("native_bearer", &self.native_bearer.as_ref().map(|_| "<redacted>"))
            .field("health", &self.health)
            .field("now", &self.now)
            .field("versions", &self.versions)
            .finish()
    }
}

/// What a controller may send a machine.
#[derive(Clone, PartialEq, Eq)]
pub enum Incoming {
    Welcome(Welcome),
    AuthOk(AuthOk),
    SessionError { code: SessionError, message: String },
    GoAway(GoAway),
    Ping(u64),
    Pong(u64),
    Received(u64),
    Credit { id: u32, consumed: u64 },
    Reset { id: u32, code: StreamError },
    PipeOpen { id: u32, endpoint: String },
    PipeData { id: u32, data: Vec<u8> },
    PipeEnd { id: u32 },
    EnrollOk { machine_id: String },
    /// FLEET_STATE (docs/fleet-link.md section 1.7): kept, and presented as `seen_state` in the next AUTH.
    FleetState(SeenState),
    /// PACE (todo 37): the relay pace and the controller's clock when it left.
    Pace(RelayPace),
}

impl fmt::Debug for Incoming {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Incoming::PipeData { id, data } => f.debug_struct("PipeData").field("id", id).field("bytes", &data.len()).finish(),
            Incoming::Welcome(welcome) => f.debug_tuple("Welcome").field(welcome).finish(),
            Incoming::AuthOk(ok) => f.debug_tuple("AuthOk").field(ok).finish(),
            Incoming::SessionError { code, .. } => f.debug_struct("SessionError").field("code", code).finish_non_exhaustive(),
            Incoming::GoAway(goaway) => f.debug_tuple("GoAway").field(goaway).finish(),
            Incoming::Ping(value) => f.debug_tuple("Ping").field(value).finish(),
            Incoming::Pong(value) => f.debug_tuple("Pong").field(value).finish(),
            Incoming::Received(value) => f.debug_tuple("Received").field(value).finish(),
            Incoming::Credit { id, consumed } => f.debug_struct("Credit").field("id", id).field("consumed", consumed).finish(),
            Incoming::Reset { id, code } => f.debug_struct("Reset").field("id", id).field("code", code).finish(),
            Incoming::PipeOpen { id, endpoint } => f.debug_struct("PipeOpen").field("id", id).field("endpoint", endpoint).finish(),
            Incoming::PipeEnd { id } => f.debug_struct("PipeEnd").field("id", id).finish(),
            Incoming::EnrollOk { machine_id } => f.debug_struct("EnrollOk").field("machine_id", machine_id).finish(),
            Incoming::FleetState(state) => f.debug_struct("FleetState").field("generation", &state.generation).finish_non_exhaustive(),
            Incoming::Pace(pace) => f.debug_tuple("Pace").field(pace).finish(),
        }
    }
}

/// What a machine sends: every frame type the link agent can write.
#[derive(Clone, PartialEq, Eq)]
pub enum Outgoing {
    Hello,
    Enroll(Enroll),
    Auth(Auth),
    SessionError { code: SessionError, message: String },
    GoAway(GoAway),
    Ping(u64),
    Pong(u64),
    Received(u64),
    Credit { id: u32, consumed: u64 },
    Reset { id: u32, code: PipeReset },
    PipeAccept { id: u32 },
    PipeData { id: u32, data: Vec<u8> },
    PipeEnd { id: u32 },
    PipeAdvert(Advert),
}

impl fmt::Debug for Outgoing {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Outgoing::PipeData { id, data } => f.debug_struct("PipeData").field("id", id).field("bytes", &data.len()).finish(),
            Outgoing::Hello => f.write_str("Hello"),
            Outgoing::Enroll(enroll) => f.debug_tuple("Enroll").field(enroll).finish(),
            Outgoing::Auth(auth) => f.debug_tuple("Auth").field(auth).finish(),
            Outgoing::SessionError { code, message } => f.debug_struct("SessionError").field("code", code).field("message", message).finish(),
            Outgoing::GoAway(goaway) => f.debug_tuple("GoAway").field(goaway).finish(),
            Outgoing::Ping(value) => f.debug_tuple("Ping").field(value).finish(),
            Outgoing::Pong(value) => f.debug_tuple("Pong").field(value).finish(),
            Outgoing::Received(value) => f.debug_tuple("Received").field(value).finish(),
            Outgoing::Credit { id, consumed } => f.debug_struct("Credit").field("id", id).field("consumed", consumed).finish(),
            Outgoing::Reset { id, code } => f.debug_struct("Reset").field("id", id).field("code", code).finish(),
            Outgoing::PipeAccept { id } => f.debug_struct("PipeAccept").field("id", id).finish(),
            Outgoing::PipeEnd { id } => f.debug_struct("PipeEnd").field("id", id).finish(),
            Outgoing::PipeAdvert(advert) => f.debug_tuple("PipeAdvert").field(advert).finish(),
        }
    }
}

struct Envelope<'a> {
    kind: u8,
    flags: u16,
    stream_id: u32,
    payload: &'a [u8],
    size: usize,
}

fn envelope(bytes: &[u8]) -> Result<Envelope<'_>, Refusal> {
    require(bytes.len() >= ENVELOPE_BYTES && bytes.len() <= MAX_FRAME_BYTES, "Invalid frame length")?;
    if bytes[0] != RELAY_PROTOCOL {
        return Err(Refusal { code: SessionError::UnsupportedVersion, message: "Unsupported envelope version" });
    }
    Ok(Envelope {
        kind: bytes[1],
        flags: u16::from_be_bytes([bytes[2], bytes[3]]),
        stream_id: u32::from_be_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]),
        payload: &bytes[ENVELOPE_BYTES..],
        size: bytes.len(),
    })
}

fn object(payload: &[u8]) -> Result<Json, Refusal> {
    let value = json::parse(payload).ok_or(Refusal { code: SessionError::ProtocolError, message: "Invalid JSON metadata" })?;
    require(value.is_object(), "Expected metadata object")?;
    Ok(value)
}
fn field<'a>(value: &'a Json, key: &str) -> &'a Json {
    const ABSENT: &Json = &Json::Null;
    value.get(key).unwrap_or(ABSENT)
}
fn present(value: &Json, key: &str) -> bool {
    value.get(key).is_some()
}
/// shared/relay-mux.ts `text`: at most `max` UTF-16 units and `max` UTF-8 bytes.
fn text(value: &Json, max: usize) -> Result<String, Refusal> {
    let text = value.as_str().ok_or(Refusal { code: SessionError::ProtocolError, message: "Invalid string" })?;
    require(text.len() <= max && text.encode_utf16().count() <= max, "Invalid string")?;
    Ok(text.to_owned())
}
fn integer(value: &Json, min: u64, max: u64) -> Result<u64, Refusal> {
    value.as_integer(min, max).ok_or(Refusal { code: SessionError::ProtocolError, message: "Invalid integer" })
}
fn hex_id(value: &Json, length: usize) -> Result<String, Refusal> {
    let text = value.as_str().unwrap_or("");
    require(text.len() == length && text.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')), "Invalid hex identifier")?;
    Ok(text.to_owned())
}
fn base64url<const N: usize>(value: &Json) -> Result<[u8; N], Refusal> {
    let decoded = value.as_str().and_then(|text| b64::decode_url(text, N));
    decoded.and_then(|bytes| bytes.try_into().ok()).ok_or(Refusal { code: SessionError::ProtocolError, message: "Invalid base64url" })
}
fn matches(text: &str, min: usize, max: usize, allowed: impl Fn(u8) -> bool) -> bool {
    text.len() >= min && text.len() <= max && text.bytes().all(allowed)
}
fn token(value: &Json, min: usize, max: usize, allowed: impl Fn(u8) -> bool) -> Result<String, Refusal> {
    let text = value.as_str().unwrap_or("");
    require(value.as_str().is_some() && matches(text, min, max, allowed), "Invalid value")?;
    Ok(text.to_owned())
}
fn feature_byte(byte: u8) -> bool {
    matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'-')
}
fn runtime_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-')
}
fn version_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'+' | b'-')
}
/// shared/relay-mux.ts `list`: at most `max` entries, none twice.
fn list<T: PartialEq>(value: &Json, max: usize, read: impl Fn(&Json) -> Result<T, Refusal>) -> Result<Vec<T>, Refusal> {
    let items = value.as_array().ok_or(Refusal { code: SessionError::ProtocolError, message: "Invalid list" })?;
    require(items.len() <= max, "Invalid list")?;
    let mut out: Vec<T> = Vec::with_capacity(items.len());
    for item in items {
        let entry = read(item)?;
        require(!out.contains(&entry), "Duplicate list entry")?;
        out.push(entry);
    }
    Ok(out)
}
fn feature(value: &Json) -> Result<String, Refusal> {
    token(value, 1, 32, feature_byte)
}
/// A name in AUTH's `features`: a HELLO feature's bytes and `_` (todo 31's `fleet_state`).
fn auth_feature(value: &Json) -> Result<String, Refusal> {
    token(value, 1, 32, |byte| feature_byte(byte) || byte == b'_')
}
fn u64_payload(frame: &Envelope<'_>) -> Result<u64, Refusal> {
    let bytes: [u8; 8] = frame.payload.try_into().map_err(|_| Refusal { code: SessionError::ProtocolError, message: "Expected u64" })?;
    Ok(u64::from_be_bytes(bytes))
}
/// A session frame: stream 0, flags 0, at most `limit` bytes.
fn session_frame(frame: &Envelope<'_>, limit: usize) -> Result<(), Refusal> {
    require(frame.size <= limit, "Invalid frame length")?;
    require(frame.flags == 0, "Reserved flags")?;
    require(frame.stream_id == 0, "Session frame needs stream zero")
}
/// CREDIT and RESET: flags 0, an id of the pipe space (even with `pipe-stream`, else odd).
fn stream_frame(frame: &Envelope<'_>, limit: usize, pipe_stream: bool) -> Result<u32, Refusal> {
    require(frame.size <= limit, "Invalid frame length")?;
    require(frame.flags == 0, "Reserved flags")?;
    let id = frame.stream_id;
    require((1..=MAX_STREAM_ID).contains(&id) && id % 2 == u32::from(!pipe_stream), "Reserved stream id")?;
    Ok(id)
}
/// A pipe frame's id: even, 2 ..= 0x7ffffffe (server/fleet/mux-ext.ts pipeFrame).
fn pipe_id(frame: &Envelope<'_>) -> Result<u32, Refusal> {
    let id = frame.stream_id;
    require((2..=MAX_STREAM_ID - 1).contains(&id) && id.is_multiple_of(2), "Reserved stream id")?;
    Ok(id)
}
fn empty(frame: &Envelope<'_>) -> Result<(), Refusal> {
    require(frame.payload.is_empty(), "Expected empty payload")
}

fn goaway(frame: &Envelope<'_>, pipe_stream: bool) -> Result<GoAway, Refusal> {
    session_frame(frame, METADATA_FRAME_BYTES)?;
    let v = object(frame.payload)?;
    let code = GoAwayCode::parse(field(&v, "code").as_str().unwrap_or("")).ok_or(Refusal { code: SessionError::ProtocolError, message: "Invalid value" })?;
    let last = integer(field(&v, "last_open_id"), 0, u64::from(MAX_STREAM_ID))? as u32;
    require(last == 0 || last % 2 == u32::from(!pipe_stream), "Reserved stream id")?;
    let reason = if present(&v, "reason") { Some(auth_feature(field(&v, "reason"))?) } else { None };
    Ok(GoAway { code, last_open_id: last, drain_ms: integer(field(&v, "drain_ms"), 0, 5000)?, reason })
}

fn session_error(frame: &Envelope<'_>) -> Result<(SessionError, String), Refusal> {
    session_frame(frame, METADATA_FRAME_BYTES)?;
    let v = object(frame.payload)?;
    let code = SessionError::parse(field(&v, "code").as_str().unwrap_or("")).ok_or(Refusal { code: SessionError::ProtocolError, message: "Invalid value" })?;
    Ok((code, text(field(&v, "message"), 256)?))
}

fn reset_frame(frame: &Envelope<'_>, pipe_stream: bool) -> Result<(u32, StreamError), Refusal> {
    let id = stream_frame(frame, METADATA_FRAME_BYTES, pipe_stream)?;
    let v = object(frame.payload)?;
    let code = StreamError::parse(field(&v, "code").as_str().unwrap_or("")).ok_or(Refusal { code: SessionError::ProtocolError, message: "Invalid value" })?;
    text(field(&v, "message"), 256)?;
    Ok((id, code))
}

const V1_LIMITS: [(&str, u64); 5] = [
    ("max_frame_bytes", 16384),
    ("http_window_bytes", 327_680),
    ("ws_window_bytes", 1_048_576),
    ("max_ws_message_bytes", 1_048_576),
    ("max_request_body_bytes", 67_108_864),
];

fn welcome(frame: &Envelope<'_>) -> Result<Welcome, Refusal> {
    session_frame(frame, SETUP_FRAME_BYTES)?;
    let v = object(frame.payload)?;
    require(field(&v, "protocol").as_str() == Some("ovis-mux") && field(&v, "version").as_integer(1, 1).is_some(), "Invalid welcome protocol")?;
    let features = list(field(&v, "features"), 16, feature)?;
    let limits = field(&v, "limits");
    require(limits.is_object(), "Expected metadata object")?;
    for (key, value) in V1_LIMITS {
        require(field(limits, key).as_integer(value, value).is_some(), "Invalid v1 limit")?;
    }
    let limits = Limits {
        max_streams: integer(field(limits, "max_streams"), 1, 32)?,
        max_ws_streams: integer(field(limits, "max_ws_streams"), 1, 8)?,
        max_sse_streams: integer(field(limits, "max_sse_streams"), 1, 4)?,
        // docs/fleet-link.md, Fields: 1..16 from a controller; anything else is a protocol error
        max_pipe_streams: integer(field(limits, "max_pipe_streams"), 1, MAX_PIPE_STREAMS)?,
    };
    let provisional = match v.get("provisional") {
        None => false,
        Some(Json::Bool(true)) => true,
        Some(_) => return refuse("Invalid provisional welcome"),
    };
    Ok(Welcome {
        features,
        limits,
        nonce: base64url::<32>(field(&v, "nonce"))?,
        server_version: text(field(&v, "server_version"), 64)?,
        relay_protocol: integer(field(&v, "relay_protocol"), 1, 65535)?,
        min_supported_client: text(field(&v, "min_supported_client"), 64)?,
        provisional,
    })
}

fn relay_pace(value: &Json) -> Result<RelayPace, Refusal> {
    require(value.is_object(), "Expected metadata object")?;
    let span = integer(field(value, "span"), 1, 4096)?;
    let per_minute = integer(field(value, "per_minute"), 1, 600)?;
    // a cycle of span * 60000 / per_minute ms is a minute at least (todo 37 (d)): one relay dial a minute at most
    require(span >= per_minute, "Pace cycle under a minute")?;
    Ok(RelayPace {
        generation: integer(field(value, "generation"), 0, MAX_INTEGER)?,
        per_minute,
        burst: integer(field(value, "burst"), 0, 600)?,
        slot: integer(field(value, "slot"), 0, span - 1)?,
        span,
        controller_ms: integer(field(value, "controller_ms"), 0, MAX_INTEGER)?,
        rtt_ms: integer(field(value, "rtt_ms"), 0, 60_000)?,
    })
}

/// AUTH_OK `direct`: 1..4 distinct `ws://<IPv4>:<port>`, each private or Tailscale (no name, no loopback).
fn carriers(value: &Json) -> Result<Vec<String>, Refusal> {
    let carriers = list(value, crate::fleet::MAX_DIRECT_CARRIERS, |item| {
        let text = item.as_str().filter(|text| crate::fleet::announced_carrier(text)).ok_or(Refusal { code: SessionError::ProtocolError, message: "Invalid direct carrier" })?;
        Ok(text.to_owned())
    })?;
    require(!carriers.is_empty(), "Invalid direct carrier")?;
    Ok(carriers)
}

fn auth_ok(frame: &Envelope<'_>) -> Result<AuthOk, Refusal> {
    session_frame(frame, METADATA_FRAME_BYTES)?;
    let v = object(frame.payload)?;
    // a `drive` or `watch` AUTH_OK answers a device: a machine signed in as none
    require(field(&v, "role").as_str() == Some("machine"), NOT_FOR_A_MACHINE)?;
    Ok(AuthOk {
        session_id: hex_id(field(&v, "session_id"), 32)?,
        machine_id: hex_id(field(&v, "machine_id"), 32)?,
        relay_pace: if present(&v, "relay_pace") { Some(relay_pace(field(&v, "relay_pace"))?) } else { None },
        direct: if present(&v, "direct") { Some(carriers(field(&v, "direct"))?) } else { None },
        // only `true` is ever written: a controller leaves the field out for a machine that is not pending
        pending: match v.get("pending") {
            None => false,
            Some(Json::Bool(true)) => true,
            Some(_) => return refuse("Invalid pending"),
        },
    })
}

/// A frame from the controller, on a session that offered and requires `pipe-stream`.
pub fn read_incoming(bytes: &[u8]) -> Result<Incoming, Refusal> {
    let frame = envelope(bytes)?;
    let incoming = match frame.kind {
        t::WELCOME => Incoming::Welcome(welcome(&frame)?),
        t::AUTH_OK => Incoming::AuthOk(auth_ok(&frame)?),
        t::SESSION_ERROR => {
            let (code, message) = session_error(&frame)?;
            Incoming::SessionError { code, message }
        }
        t::GOAWAY => Incoming::GoAway(goaway(&frame, true)?),
        t::PING | t::PONG | t::RECEIVED => {
            session_frame(&frame, METADATA_FRAME_BYTES)?;
            let value = u64_payload(&frame)?;
            match frame.kind {
                t::PING => Incoming::Ping(value),
                t::PONG => Incoming::Pong(value),
                _ => Incoming::Received(value),
            }
        }
        t::CREDIT => {
            let id = stream_frame(&frame, METADATA_FRAME_BYTES, true)?;
            Incoming::Credit { id, consumed: u64_payload(&frame)? }
        }
        t::RESET => {
            let (id, code) = reset_frame(&frame, true)?;
            Incoming::Reset { id, code }
        }
        t::PIPE_OPEN | t::PIPE_DATA | t::PIPE_END => {
            require(frame.flags == 0, "Reserved flags")?;
            let id = pipe_id(&frame)?;
            match frame.kind {
                t::PIPE_OPEN => {
                    require(frame.size <= METADATA_FRAME_BYTES, "Invalid frame length")?;
                    let v = object(frame.payload)?;
                    Incoming::PipeOpen { id, endpoint: token(field(&v, "endpoint"), 1, 32, feature_byte)? }
                }
                t::PIPE_DATA => {
                    require(!frame.payload.is_empty(), "Empty DATA forbidden")?;
                    Incoming::PipeData { id, data: frame.payload.to_vec() }
                }
                _ => {
                    empty(&frame)?;
                    Incoming::PipeEnd { id }
                }
            }
        }
        t::ENROLL_OK => {
            session_frame(&frame, METADATA_FRAME_BYTES)?;
            let v = object(frame.payload)?;
            Incoming::EnrollOk { machine_id: hex_id(field(&v, "machine_id"), 32)? }
        }
        t::PACE => {
            session_frame(&frame, METADATA_FRAME_BYTES)?;
            Incoming::Pace(relay_pace(&object(frame.payload)?)?)
        }
        t::FLEET_STATE => {
            session_frame(&frame, METADATA_FRAME_BYTES)?;
            let v = object(frame.payload)?;
            Incoming::FleetState(SeenState { generation: integer(field(&v, "generation"), 0, MAX_INTEGER)?, tag: base64url::<32>(field(&v, "tag"))? })
        }
        // HELLO, AUTH, PAIR*, HTTP*, WS*, PIPE_ACCEPT, PIPE_ADVERT, ENROLL and every unassigned type
        _ => return refuse(NOT_FOR_A_MACHINE),
    };
    Ok(incoming)
}

fn hello(frame: &Envelope<'_>) -> Result<(), Refusal> {
    session_frame(frame, SETUP_FRAME_BYTES)?;
    let v = object(frame.payload)?;
    require(field(&v, "protocol").as_str() == Some("ovis-mux"), "Invalid protocol")?;
    let versions = list(field(&v, "versions"), 8, |value| integer(value, 1, 65535))?;
    let features = list(field(&v, "features"), 16, feature)?;
    let required = list(field(&v, "required_features"), 16, feature)?;
    // a machine offers and requires `pipe-stream` and nothing else (docs/fleet-link.md section 1.3)
    let only = |features: &[String]| features.len() == 1 && features[0] == PIPE_STREAM;
    require(versions == [1] && only(&features) && only(&required), "Not a machine HELLO")
}

fn auth(frame: &Envelope<'_>) -> Result<Auth, Refusal> {
    session_frame(frame, METADATA_FRAME_BYTES)?;
    let v = object(frame.payload)?;
    require(field(&v, "scheme").as_str() == Some(MACHINE_KEY), "Invalid auth scheme")?;
    let seen_state = match v.get("seen_state") {
        None => None,
        Some(seen) => {
            require(seen.is_object(), "Expected metadata object")?;
            Some(SeenState { generation: integer(field(seen, "generation"), 0, MAX_INTEGER)?, tag: base64url::<32>(field(seen, "tag"))? })
        }
    };
    let features = if present(&v, "features") { list(field(&v, "features"), 16, auth_feature)? } else { Vec::new() };
    Ok(Auth { machine_id: hex_id(field(&v, "machine_id"), 32)?, signature: base64url::<64>(field(&v, "signature"))?, features, seen_state })
}

fn enroll(frame: &Envelope<'_>) -> Result<Enroll, Refusal> {
    session_frame(frame, METADATA_FRAME_BYTES)?;
    let v = object(frame.payload)?;
    Ok(Enroll {
        invite_id: hex_id(field(&v, "invite_id"), 16)?,
        machine_public_key: base64url::<{ crate::machine_key::SPKI_BYTES }>(field(&v, "machine_public_key"))?,
        signature: base64url::<64>(field(&v, "signature"))?,
        now: integer(field(&v, "now"), 0, MAX_INTEGER)?,
    })
}

fn advert(frame: &Envelope<'_>) -> Result<Advert, Refusal> {
    session_frame(frame, PIPE_ADVERT_BYTES)?;
    let v = object(frame.payload)?;
    let endpoints = field(&v, "endpoints").as_array().ok_or(Refusal { code: SessionError::ProtocolError, message: "Invalid endpoints" })?;
    require(!endpoints.is_empty() && endpoints.len() <= 2, "Invalid endpoints")?;
    let mut list = Vec::with_capacity(2);
    for endpoint in endpoints {
        let endpoint = endpoint.as_str().and_then(Endpoint::parse).ok_or(Refusal { code: SessionError::ProtocolError, message: "Invalid value" })?;
        require(!list.contains(&endpoint), "Duplicate endpoint")?;
        list.push(endpoint);
    }
    let bridge = list.contains(&Endpoint::Bridge);
    let native = list.contains(&Endpoint::Native);
    require(bridge == present(&v, "bridge_token") && native == present(&v, "native_bearer"), "Secret without its endpoint")?;
    let health = field(&v, "health");
    let versions = field(&v, "versions");
    require(health.is_object() && versions.is_object(), "Expected metadata object")?;
    let up_down = |value: &Json| value.as_str().and_then(UpDown::parse).ok_or(Refusal { code: SessionError::ProtocolError, message: "Invalid value" });
    let version = |key: &str| token(field(versions, key), 1, 64, version_byte);
    Ok(Advert {
        endpoints: list,
        runtime_id: token(field(&v, "runtime_id"), 1, 64, runtime_byte)?,
        boot_id: token(field(&v, "boot_id"), 1, 64, runtime_byte)?,
        bridge_token: if bridge { Some(Zeroizing::new(hex_id(field(&v, "bridge_token"), 64)?)) } else { None },
        native_bearer: if native { Some(Zeroizing::new(token(field(&v, "native_bearer"), 1, 512, |byte| (0x21..=0x7e).contains(&byte))?)) } else { None },
        health: Health { runtime: up_down(field(health, "runtime"))?, bridge: up_down(field(health, "bridge"))? },
        now: integer(field(&v, "now"), 0, MAX_INTEGER)?,
        versions: Versions { server: version("server")?, link: version("link")?, agent: version("agent")?, runtime: version("runtime")? },
    })
}

/// A frame as a machine may send it: the reader the encoder checks every frame against. With
/// `pipe_stream` false (only for the vectors of a session that did not select it), CREDIT and
/// RESET take odd ids.
pub fn read_outgoing(bytes: &[u8], pipe_stream: bool) -> Result<Outgoing, Refusal> {
    let frame = envelope(bytes)?;
    let outgoing = match frame.kind {
        t::HELLO => {
            hello(&frame)?;
            Outgoing::Hello
        }
        t::AUTH => Outgoing::Auth(auth(&frame)?),
        t::ENROLL if pipe_stream => Outgoing::Enroll(enroll(&frame)?),
        t::SESSION_ERROR => {
            let (code, message) = session_error(&frame)?;
            Outgoing::SessionError { code, message }
        }
        t::GOAWAY => Outgoing::GoAway(goaway(&frame, pipe_stream)?),
        t::PING | t::PONG | t::RECEIVED => {
            session_frame(&frame, METADATA_FRAME_BYTES)?;
            let value = u64_payload(&frame)?;
            match frame.kind {
                t::PING => Outgoing::Ping(value),
                t::PONG => Outgoing::Pong(value),
                _ => Outgoing::Received(value),
            }
        }
        t::CREDIT => {
            let id = stream_frame(&frame, METADATA_FRAME_BYTES, pipe_stream)?;
            Outgoing::Credit { id, consumed: u64_payload(&frame)? }
        }
        t::RESET => {
            let (id, code) = reset_frame(&frame, pipe_stream)?;
            let code = PipeReset::parse(code.as_str()).ok_or(Refusal { code: SessionError::ProtocolError, message: "Invalid RESET code" })?;
            Outgoing::Reset { id, code }
        }
        t::PIPE_ACCEPT | t::PIPE_DATA | t::PIPE_END if pipe_stream => {
            require(frame.flags == 0, "Reserved flags")?;
            let id = pipe_id(&frame)?;
            match frame.kind {
                t::PIPE_ACCEPT => {
                    empty(&frame)?;
                    Outgoing::PipeAccept { id }
                }
                t::PIPE_DATA => {
                    require(!frame.payload.is_empty(), "Empty DATA forbidden")?;
                    Outgoing::PipeData { id, data: frame.payload.to_vec() }
                }
                _ => {
                    empty(&frame)?;
                    Outgoing::PipeEnd { id }
                }
            }
        }
        t::PIPE_ADVERT if pipe_stream => Outgoing::PipeAdvert(advert(&frame)?),
        _ => return refuse("Not a frame a machine sends"),
    };
    Ok(outgoing)
}

fn with_envelope(kind: u8, stream_id: u32, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(ENVELOPE_BYTES + payload.len());
    out.extend_from_slice(&[RELAY_PROTOCOL, kind, 0, 0]);
    out.extend_from_slice(&stream_id.to_be_bytes());
    out.extend_from_slice(payload);
    out
}

/// Compact JSON with its keys in the order given: the canonical form of docs/fleet-link.md.
struct Object(String);

impl Object {
    fn new() -> Self {
        Object(String::from("{"))
    }
    fn key(&mut self, key: &str) -> &mut String {
        if self.0.len() > 1 {
            self.0.push(',');
        }
        self.0.push_str(&json::quote(key));
        self.0.push(':');
        &mut self.0
    }
    fn text(mut self, key: &str, value: &str) -> Self {
        self.key(key).push_str(&json::quote(value));
        self
    }
    fn number(mut self, key: &str, value: u64) -> Self {
        self.key(key).push_str(&value.to_string());
        self
    }
    fn raw(mut self, key: &str, value: &str) -> Self {
        self.key(key).push_str(value);
        self
    }
    fn texts(self, key: &str, values: &[&str]) -> Self {
        let list = values.iter().map(|value| json::quote(value)).collect::<Vec<_>>().join(",");
        self.raw(key, &format!("[{list}]"))
    }
    fn end(mut self) -> Zeroizing<String> {
        self.0.push('}');
        Zeroizing::new(std::mem::take(&mut self.0))
    }
}

impl Outgoing {
    fn bytes(&self) -> Vec<u8> {
        match self {
            Outgoing::Hello => {
                let features = [PIPE_STREAM];
                let payload = Object::new().text("protocol", "ovis-mux").raw("versions", "[1]").texts("features", &features).texts("required_features", &features).end();
                with_envelope(t::HELLO, 0, payload.as_bytes())
            }
            Outgoing::Enroll(enroll) => {
                let payload = Object::new()
                    .text("invite_id", &enroll.invite_id)
                    .text("machine_public_key", &b64::encode_url(&enroll.machine_public_key))
                    .text("signature", &b64::encode_url(&enroll.signature))
                    .number("now", enroll.now)
                    .end();
                with_envelope(t::ENROLL, 0, payload.as_bytes())
            }
            Outgoing::Auth(auth) => {
                let mut payload = Object::new().text("scheme", MACHINE_KEY).text("machine_id", &auth.machine_id).text("signature", &b64::encode_url(&auth.signature));
                if !auth.features.is_empty() {
                    let names: Vec<&str> = auth.features.iter().map(String::as_str).collect();
                    payload = payload.texts("features", &names);
                }
                if let Some(seen) = &auth.seen_state {
                    let state = Object::new().number("generation", seen.generation).text("tag", &b64::encode_url(&seen.tag)).end();
                    payload = payload.raw("seen_state", &state);
                }
                with_envelope(t::AUTH, 0, payload.end().as_bytes())
            }
            Outgoing::SessionError { code, message } => {
                with_envelope(t::SESSION_ERROR, 0, Object::new().text("code", code.as_str()).text("message", message).end().as_bytes())
            }
            Outgoing::GoAway(goaway) => {
                let mut payload = Object::new().text("code", goaway.code.as_str()).number("last_open_id", u64::from(goaway.last_open_id)).number("drain_ms", goaway.drain_ms);
                if let Some(reason) = &goaway.reason {
                    payload = payload.text("reason", reason);
                }
                with_envelope(t::GOAWAY, 0, payload.end().as_bytes())
            }
            Outgoing::Ping(value) => with_envelope(t::PING, 0, &value.to_be_bytes()),
            Outgoing::Pong(value) => with_envelope(t::PONG, 0, &value.to_be_bytes()),
            Outgoing::Received(value) => with_envelope(t::RECEIVED, 0, &value.to_be_bytes()),
            Outgoing::Credit { id, consumed } => with_envelope(t::CREDIT, *id, &consumed.to_be_bytes()),
            Outgoing::Reset { id, code } => with_envelope(t::RESET, *id, Object::new().text("code", code.as_str()).text("message", "").end().as_bytes()),
            Outgoing::PipeAccept { id } => with_envelope(t::PIPE_ACCEPT, *id, &[]),
            Outgoing::PipeData { id, data } => with_envelope(t::PIPE_DATA, *id, data),
            Outgoing::PipeEnd { id } => with_envelope(t::PIPE_END, *id, &[]),
            Outgoing::PipeAdvert(advert) => {
                let endpoints: Vec<&str> = advert.endpoints.iter().map(|endpoint| endpoint.as_str()).collect();
                let mut payload = Object::new().texts("endpoints", &endpoints).text("runtime_id", &advert.runtime_id).text("boot_id", &advert.boot_id);
                if let Some(token) = &advert.bridge_token {
                    payload = payload.text("bridge_token", token);
                }
                if let Some(bearer) = &advert.native_bearer {
                    payload = payload.text("native_bearer", bearer);
                }
                let health = Object::new().text("runtime", advert.health.runtime.as_str()).text("bridge", advert.health.bridge.as_str()).end();
                let versions = Object::new()
                    .text("server", &advert.versions.server)
                    .text("link", &advert.versions.link)
                    .text("agent", &advert.versions.agent)
                    .text("runtime", &advert.versions.runtime)
                    .end();
                let payload = payload.raw("health", &health).number("now", advert.now).raw("versions", &versions).end();
                with_envelope(t::PIPE_ADVERT, 0, payload.as_bytes())
            }
        }
    }

    /// The frame's bytes, refused unless the machine-side reader reads them back as this frame.
    pub fn encode(&self) -> Result<Vec<u8>, Refusal> {
        let bytes = self.bytes();
        let read = read_outgoing(&bytes, true)?;
        require(read == *self, "Frame does not read back as written")?;
        Ok(bytes)
    }
}
