//! The link agent's secure channel to its controller: the protected mode of
//! shared/vendor/paseo-e2ee/secure-channel.ts, initiator side only (the legacy box mode is not
//! implemented), with the channel binding of shared/relay-e2ee.ts and its carrier limit.
//!
//! What travels on the carrier is left to the caller: message 1 and message 2 (inside the
//! `e2ee_hello` / `e2ee_ready` envelopes) and the records [`Channel::seal`] returns and
//! [`Channel::open`] takes. Any failure ends the channel and drops its keys.

use std::fmt;

use sha2::{Digest, Sha256};
use x25519_dalek::StaticSecret;
use zeroize::Zeroize;

use crate::noise::{AwaitingResponse, CipherState, Initiator};
use crate::records::{self, protected_record_byte_length, Frame, FrameKind};
use crate::Error;

pub const PROLOGUE: &[u8] = b"paseo-relay-e2ee/1";
const BINDING_DOMAIN: &[u8] = b"ovis-relay-channel-binding/1";
const PARAMS_VERSION: u8 = 0x01;
const PARAM_FLAG_BINARY_CIPHERTEXT: u8 = 0x01;

/// shared/relay-mux.ts MAX_FRAME_BYTES: the largest frame the channel carries.
pub const MAX_MUX_FRAME_BYTES: usize = 16384;
/// shared/relay-e2ee.ts: the largest carrier message, as binary and as base64 text.
pub const MAX_CARRIER_BINARY_BYTES: usize = protected_record_byte_length(MAX_MUX_FRAME_BYTES);
pub const MAX_CARRIER_TEXT_BYTES: usize = 4 * MAX_CARRIER_BINARY_BYTES.div_ceil(3);

/// secure-channel.ts decodeParams: the 2-byte handshake payload; true when binary ciphertext is on.
pub(crate) fn decode_params(payload: &[u8]) -> Result<bool, Error> {
    let &[version, flags] = payload else {
        return Err(Error::InvalidParameterPayload);
    };
    if version != PARAMS_VERSION {
        return Err(Error::UnsupportedParameterVersion);
    }
    if flags & !PARAM_FLAG_BINARY_CIPHERTEXT != 0 {
        return Err(Error::ReservedParameterFlag);
    }
    Ok(flags & PARAM_FLAG_BINARY_CIPHERTEXT != 0)
}

/// Message 1 is written; message 2 has not arrived.
pub struct ClientHandshake {
    awaiting: AwaitingResponse,
    server_static: [u8; 32],
    message1: Vec<u8>,
}

impl ClientHandshake {
    /// Writes message 1 to the controller whose static key the invite pinned, from a fresh
    /// ephemeral key. Offers binary ciphertext, as the TypeScript client does.
    pub fn start(server_static: &[u8; 32]) -> Result<(Self, Vec<u8>), Error> {
        Self::begin(server_static, StaticSecret::random())
    }

    #[cfg(test)]
    pub(crate) fn start_with_ephemeral(server_static: &[u8; 32], ephemeral: [u8; 32]) -> Result<(Self, Vec<u8>), Error> {
        Self::begin(server_static, StaticSecret::from(ephemeral))
    }

    fn begin(server_static: &[u8; 32], ephemeral: StaticSecret) -> Result<(Self, Vec<u8>), Error> {
        let offered = [PARAMS_VERSION, PARAM_FLAG_BINARY_CIPHERTEXT];
        let (awaiting, message1) = Initiator::new(*server_static, PROLOGUE, ephemeral).write_message(&offered)?;
        Ok((ClientHandshake { awaiting, server_static: *server_static, message1: message1.clone() }, message1))
    }

    /// Reads message 2. Only binary ciphertext was offered, so any valid selection was offered.
    pub fn finish(self, message2: &[u8]) -> Result<Channel, Error> {
        let (payload, transport) = self.awaiting.read_message(message2)?;
        let binary_ciphertext = decode_params(&payload)?;
        let length = |message: &[u8]| (message.len() as u32).to_be_bytes();
        let binding = Sha256::new()
            .chain_update(BINDING_DOMAIN)
            .chain_update(self.server_static)
            .chain_update(length(&self.message1))
            .chain_update(&self.message1)
            .chain_update(length(message2))
            .chain_update(message2)
            .finalize()
            .into();
        Ok(Channel {
            keys: Some(Keys { send: transport.send, receive: transport.receive }),
            binding,
            handshake_hash: transport.handshake_hash,
            binary_ciphertext,
        })
    }

    #[cfg(test)]
    pub(crate) fn chaining_key_for_test(&self) -> [u8; 32] {
        self.awaiting.chaining_key_for_test()
    }
}

impl fmt::Debug for ClientHandshake {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ClientHandshake").field("state", &self.awaiting).finish_non_exhaustive()
    }
}

struct Keys {
    send: CipherState,
    receive: CipherState,
}

pub struct Channel {
    keys: Option<Keys>,
    binding: [u8; 32],
    handshake_hash: [u8; 32],
    binary_ciphertext: bool,
}

impl Channel {
    /// The 32 bytes both ends of this handshake hold and no one else can make them share
    /// (docs/fleet-link.md section 1): what AUTH and ENROLL sign.
    pub fn binding(&self) -> [u8; 32] {
        self.binding
    }

    /// Whether binary frames may travel as binary carrier messages (else as base64 text).
    pub fn binary_ciphertext(&self) -> bool {
        self.binary_ciphertext
    }

    pub fn is_open(&self) -> bool {
        self.keys.is_some()
    }

    /// One frame as one record. A frame the peer's carrier limit would refuse ends the channel.
    pub fn seal(&mut self, kind: FrameKind, data: &[u8]) -> Result<Vec<u8>, Error> {
        let result = match self.keys.as_mut() {
            None => return Err(Error::Closed),
            Some(_) if data.len() > MAX_MUX_FRAME_BYTES => Err(Error::FrameTooLarge),
            Some(keys) => records::encode(kind, data, &mut keys.send),
        };
        if result.is_err() {
            self.keys = None;
        }
        result
    }

    /// One record as one frame, refused undecrypted above the carrier limit.
    pub fn open(&mut self, record: &[u8]) -> Result<Frame, Error> {
        let result = match self.keys.as_mut() {
            None => return Err(Error::Closed),
            Some(_) if record.len() > MAX_CARRIER_BINARY_BYTES => Err(Error::CarrierMessageTooLarge),
            Some(keys) => records::decode(record, &mut keys.receive).and_then(|frame| {
                if frame.kind == FrameKind::Text && std::str::from_utf8(&frame.data).is_err() {
                    return Err(Error::InvalidText);
                }
                Ok(frame)
            }),
        };
        if result.is_err() {
            self.keys = None;
        }
        result
    }

    #[cfg(test)]
    pub(crate) fn handshake_hash(&self) -> [u8; 32] {
        self.handshake_hash
    }

    /// A daemon that did not select binary ciphertext: every record then travels as base64 text.
    #[cfg(test)]
    pub(crate) fn set_binary_ciphertext_for_test(&mut self, on: bool) {
        self.binary_ciphertext = on;
    }

    #[cfg(test)]
    pub(crate) fn keys_for_test(&self) -> ([u8; 32], [u8; 32]) {
        let keys = self.keys.as_ref().expect("open");
        (keys.send.key_for_test(), keys.receive.key_for_test())
    }
}

impl Drop for Channel {
    fn drop(&mut self) {
        self.binding.zeroize();
        self.handshake_hash.zeroize();
    }
}

impl fmt::Debug for Channel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Channel")
            .field("open", &self.is_open())
            .field("binary_ciphertext", &self.binary_ciphertext)
            .finish_non_exhaustive()
    }
}
