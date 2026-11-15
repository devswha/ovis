//! The initiator side of Noise_NK_25519_ChaChaPoly_SHA256 (Noise rev 34), as
//! shared/vendor/paseo-e2ee/noise does it:
//!
//! ```text
//! NK:
//!   <- s
//!   ...
//!   -> e, es
//!   <- e, ee
//! ```
//!
//! The two handshake messages are two types, so a message can only be written or read in its
//! turn, and a failed read consumes the state it would have advanced. Every secret (ephemeral
//! key, chaining key, cipher keys) is cleared when its holder drops, and no type formats one.

use std::fmt;

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use hkdf::Hkdf;
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroize;

use crate::Error;

pub const PROTOCOL_NAME: &[u8; 32] = b"Noise_NK_25519_ChaChaPoly_SHA256";
pub const MAX_MESSAGE_BYTES: usize = 65535;
pub const TAG_BYTES: usize = 16;
pub const DH_BYTES: usize = 32;

/// Noise section 5.1 for ChaChaPoly: the nonce is 4 zero bytes then n, 64-bit little-endian.
/// n = 2^64 - 1 is reserved, so a state at it neither encrypts nor decrypts.
pub struct CipherState {
    key: [u8; 32],
    nonce: u64,
}

impl CipherState {
    pub(crate) fn new(key: [u8; 32]) -> Self {
        CipherState { key, nonce: 0 }
    }

    #[cfg(test)]
    pub(crate) fn with_nonce(key: [u8; 32], nonce: u64) -> Self {
        CipherState { key, nonce }
    }

    #[cfg(test)]
    pub(crate) fn nonce(&self) -> u64 {
        self.nonce
    }

    fn aead_nonce(n: u64) -> Nonce {
        let mut nonce = [0u8; 12];
        nonce[4..].copy_from_slice(&n.to_le_bytes());
        Nonce::from(nonce)
    }

    pub(crate) fn encrypt_with_ad(&mut self, ad: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, Error> {
        if self.nonce == u64::MAX {
            return Err(Error::NonceExhausted);
        }
        let nonce = Self::aead_nonce(self.nonce);
        // the nonce is spent before the cipher runs, so no two messages can share it
        self.nonce += 1;
        ChaCha20Poly1305::new(&Key::from(self.key))
            .encrypt(&nonce, Payload { msg: plaintext, aad: ad })
            .map_err(|_| Error::FrameTooLarge)
    }

    pub(crate) fn decrypt_with_ad(&mut self, ad: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>, Error> {
        if self.nonce == u64::MAX {
            return Err(Error::NonceExhausted);
        }
        let plaintext = ChaCha20Poly1305::new(&Key::from(self.key))
            .decrypt(&Self::aead_nonce(self.nonce), Payload { msg: ciphertext, aad: ad })
            .map_err(|_| Error::AuthenticationFailed)?;
        // only an authenticated message advances the receive counter
        self.nonce += 1;
        Ok(plaintext)
    }

    #[cfg(test)]
    pub(crate) fn key_for_test(&self) -> [u8; 32] {
        self.key
    }
}

impl Drop for CipherState {
    fn drop(&mut self) {
        self.key.zeroize();
    }
}

impl fmt::Debug for CipherState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CipherState").field("key", &"<redacted>").field("nonce", &self.nonce).finish()
    }
}

/// Noise section 4.3 HKDF with two outputs: HMAC-SHA256 with the chaining key as salt, and the
/// expansion's two blocks (info empty, counters 0x01 and 0x02).
fn hkdf2(chaining_key: &[u8; 32], input_key_material: &[u8]) -> ([u8; 32], [u8; 32]) {
    let (mut prk, hkdf) = Hkdf::<Sha256>::extract(Some(chaining_key), input_key_material);
    prk.as_mut_slice().zeroize();
    let mut okm = [0u8; 64];
    hkdf.expand(&[], &mut okm).expect("64 bytes is a valid HKDF-SHA256 length");
    let mut first = [0u8; 32];
    let mut second = [0u8; 32];
    first.copy_from_slice(&okm[..32]);
    second.copy_from_slice(&okm[32..]);
    okm.zeroize();
    (first, second)
}

/// Noise section 5.2 for SHA-256.
struct SymmetricState {
    ck: [u8; 32],
    h: [u8; 32],
    cipher: Option<CipherState>,
}

impl SymmetricState {
    fn new() -> Self {
        // the protocol name is exactly HASHLEN bytes, so it is h itself
        SymmetricState { ck: *PROTOCOL_NAME, h: *PROTOCOL_NAME, cipher: None }
    }

    fn mix_hash(&mut self, data: &[u8]) {
        self.h = Sha256::new().chain_update(self.h).chain_update(data).finalize().into();
    }

    fn mix_key(&mut self, input_key_material: &[u8]) {
        let (ck, temp_key) = hkdf2(&self.ck, input_key_material);
        self.ck = ck;
        self.cipher = Some(CipherState::new(temp_key));
    }

    fn encrypt_and_hash(&mut self, plaintext: &[u8]) -> Result<Vec<u8>, Error> {
        let ciphertext = match &mut self.cipher {
            Some(cipher) => cipher.encrypt_with_ad(&self.h, plaintext)?,
            None => plaintext.to_vec(),
        };
        self.mix_hash(&ciphertext);
        Ok(ciphertext)
    }

    fn decrypt_and_hash(&mut self, ciphertext: &[u8]) -> Result<Vec<u8>, Error> {
        let plaintext = match &mut self.cipher {
            Some(cipher) => cipher.decrypt_with_ad(&self.h, ciphertext)?,
            None => ciphertext.to_vec(),
        };
        self.mix_hash(ciphertext);
        Ok(plaintext)
    }

    fn mix_dh(&mut self, local: &StaticSecret, remote: &[u8; 32]) -> Result<(), Error> {
        let shared = local.diffie_hellman(&PublicKey::from(*remote));
        // an all-zero result (a low-order point) would key the channel with a constant
        if !shared.was_contributory() {
            return Err(Error::InvalidDhPublicKey);
        }
        self.mix_key(shared.as_bytes());
        Ok(())
    }

    fn split(&self) -> (CipherState, CipherState) {
        let (first, second) = hkdf2(&self.ck, &[]);
        (CipherState::new(first), CipherState::new(second))
    }
}

impl Drop for SymmetricState {
    fn drop(&mut self) {
        self.ck.zeroize();
        self.h.zeroize();
    }
}

impl fmt::Debug for SymmetricState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SymmetricState").field("keys", &"<redacted>").field("cipher", &self.cipher).finish()
    }
}

/// Before message 1: the responder's static key is known (the pre-message `<- s`).
pub(crate) struct Initiator {
    symmetric: SymmetricState,
    e: StaticSecret,
    rs: [u8; 32],
}

/// After message 1, waiting for message 2.
pub(crate) struct AwaitingResponse {
    symmetric: SymmetricState,
    e: StaticSecret,
}

/// The transport keys, oriented for the initiator, and the final handshake hash.
pub(crate) struct Transport {
    pub send: CipherState,
    pub receive: CipherState,
    pub handshake_hash: [u8; 32],
}

impl Initiator {
    /// `e` is a fresh ephemeral in production; tests pass the vectors' fixed one.
    pub(crate) fn new(rs: [u8; 32], prologue: &[u8], e: StaticSecret) -> Self {
        let mut symmetric = SymmetricState::new();
        symmetric.mix_hash(prologue);
        symmetric.mix_hash(&rs);
        Initiator { symmetric, e, rs }
    }

    /// `-> e, es`, then the payload.
    pub(crate) fn write_message(mut self, payload: &[u8]) -> Result<(AwaitingResponse, Vec<u8>), Error> {
        let e_public = PublicKey::from(&self.e);
        let mut message = e_public.as_bytes().to_vec();
        self.symmetric.mix_hash(e_public.as_bytes());
        self.symmetric.mix_dh(&self.e, &self.rs)?;
        message.extend(self.symmetric.encrypt_and_hash(payload)?);
        if message.len() > MAX_MESSAGE_BYTES {
            return Err(Error::HandshakeMessageTooLarge);
        }
        let Initiator { symmetric, e, .. } = self;
        Ok((AwaitingResponse { symmetric, e }, message))
    }
}

impl AwaitingResponse {
    /// `<- e, ee`, then the payload; the handshake ends here and the ephemeral key is dropped.
    pub(crate) fn read_message(mut self, message: &[u8]) -> Result<(Vec<u8>, Transport), Error> {
        if message.len() > MAX_MESSAGE_BYTES {
            return Err(Error::HandshakeMessageTooLarge);
        }
        if message.len() < DH_BYTES {
            return Err(Error::HandshakeMessageTruncated);
        }
        let (re, ciphertext) = message.split_at(DH_BYTES);
        let re: [u8; 32] = re.try_into().expect("split at 32 bytes");
        self.symmetric.mix_hash(&re);
        self.symmetric.mix_dh(&self.e, &re)?;
        let payload = self.symmetric.decrypt_and_hash(ciphertext)?;
        let (send, receive) = self.symmetric.split();
        Ok((payload, Transport { send, receive, handshake_hash: self.symmetric.h }))
    }

    #[cfg(test)]
    pub(crate) fn chaining_key_for_test(&self) -> [u8; 32] {
        self.symmetric.ck
    }
}

impl fmt::Debug for Initiator {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Initiator").field("symmetric", &self.symmetric).field("e", &"<redacted>").finish()
    }
}

impl fmt::Debug for AwaitingResponse {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AwaitingResponse").field("symmetric", &self.symmetric).field("e", &"<redacted>").finish()
    }
}

impl fmt::Debug for Transport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Transport").field("send", &self.send).field("receive", &self.receive).finish_non_exhaustive()
    }
}
