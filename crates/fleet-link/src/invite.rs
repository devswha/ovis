//! The invite key (docs/fleet-link.md section 4): an Ed25519 key whose RFC 8032 seed is derived
//! from the invite's 32-byte secret, so the controller can keep only the public key and still
//! check an ENROLL across a restart. The secret, the seed and the signing key are wiped when they
//! drop and never formatted.

use std::fmt;

use ed25519_dalek::{Signer, SigningKey};
use hkdf::Hkdf;
use sha2::Sha256;
use zeroize::Zeroizing;

const INVITE_INFO: &[u8] = b"ovis-fleet-invite/1";
const ENROLL_DOMAIN: &[u8] = b"ovis-fleet-enroll/1";

pub struct InviteKey {
    seed: Zeroizing<[u8; 32]>,
    signing: SigningKey,
}

impl InviteKey {
    /// `seed = HKDF-SHA256(ikm = secret, salt = empty, info = "ovis-fleet-invite/1" || invite id, 32)`.
    pub fn derive(secret: &[u8; 32], invite_id: &str) -> Self {
        let mut seed = Zeroizing::new([0u8; 32]);
        let info = [INVITE_INFO, invite_id.as_bytes()].concat();
        Hkdf::<Sha256>::new(Some(&[]), secret).expand(&info, seed.as_mut()).expect("32 bytes is a valid HKDF-SHA256 length");
        let signing = SigningKey::from_bytes(&seed);
        InviteKey { seed, signing }
    }

    pub fn seed(&self) -> &[u8] {
        self.seed.as_ref()
    }

    pub fn public_key(&self) -> [u8; 32] {
        self.signing.verifying_key().to_bytes()
    }

    pub fn sign(&self, message: &[u8]) -> [u8; 64] {
        self.signing.sign(message).to_bytes()
    }
}

impl fmt::Debug for InviteKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("InviteKey").finish_non_exhaustive()
    }
}

/// `"ovis-fleet-enroll/1" || channel binding || machine key SPKI DER || invite id as its 16 ASCII hex digits`.
pub fn enroll_message(binding: &[u8; 32], spki: &[u8], invite_id: &str) -> Vec<u8> {
    [ENROLL_DOMAIN, binding, spki, invite_id.as_bytes()].concat()
}

/// The single-line form of an invite file (docs/fleet-link.md section 4): this prefix and the file in base64url.
pub const INVITE_LINE_PREFIX: &str = "ovis-invite:1:";
/// The invite file's own bound (4096 bytes).
pub const MAX_INVITE_BYTES: usize = 4096;
/// The prefix and MAX_INVITE_BYTES of file in unpadded base64url: 5476 bytes.
pub const MAX_INVITE_LINE_BYTES: usize = INVITE_LINE_PREFIX.len() + (MAX_INVITE_BYTES * 4).div_ceil(3);

/// Why a line is not an invite line. It never carries any part of the line: the line holds the secret.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InviteLineError {
    TooLong,
    Prefix,
    Encoding,
}

impl fmt::Display for InviteLineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            InviteLineError::TooLong => "invalid invite line: too long",
            InviteLineError::Prefix => "invalid invite line: it does not start with ovis-invite:1:",
            InviteLineError::Encoding => "invalid invite line: not canonical base64url",
        })
    }
}

/// The invite file's bytes a line holds: the ASCII whitespace around it dropped, at most MAX_INVITE_LINE_BYTES, exactly
/// INVITE_LINE_PREFIX, then canonical unpadded base64url. Nothing of the invite is judged here: the bytes are read as
/// the invite file is, by whatever reads that file.
pub fn decode_line(line: &str) -> Result<Zeroizing<Vec<u8>>, InviteLineError> {
    let text = line.trim_matches(|c| matches!(c, ' ' | '\t' | '\r' | '\n'));
    if text.len() > MAX_INVITE_LINE_BYTES {
        return Err(InviteLineError::TooLong);
    }
    let body = text.strip_prefix(INVITE_LINE_PREFIX).ok_or(InviteLineError::Prefix)?;
    if body.is_empty() {
        return Err(InviteLineError::Encoding);
    }
    crate::b64::decode_url_any(body).map(Zeroizing::new).ok_or(InviteLineError::Encoding)
}

#[cfg(test)]
mod line_tests {
    //! `decode_line` against the `INVITE_LINE` cases of server/fleet/vectors/invite.json (written by
    //! scripts/fleet-vectors.ts from the TypeScript reader): a line that decodes gives exactly the file's bytes.
    use serde_json::Value;

    use super::decode_line;
    use crate::hex;

    const INVITE: &str = include_str!("../../../server/fleet/vectors/invite.json");

    #[test]
    fn invite_line_vectors() {
        let data: Value = serde_json::from_str(INVITE).expect("invite.json parses");
        let cases: Vec<&Value> = data["cases"].as_array().expect("cases").iter().filter(|entry| entry["frame"] == "INVITE_LINE").collect();
        assert!(cases.len() >= 5, "invite.json has the line cases");
        for entry in cases {
            let name = entry["name"].as_str().unwrap();
            let line = String::from_utf8(hex::decode(entry["bytes"].as_str().unwrap()).unwrap()).unwrap();
            let decoded = decode_line(&line);
            if entry["expect"]["refuse"]["stage"] == "decode" {
                assert!(decoded.is_err(), "{name}: refused");
                continue;
            }
            let file = hex::decode(entry["expect"]["parse"]["file_hex"].as_str().unwrap()).unwrap();
            assert_eq!(*decoded.unwrap_or_else(|error| panic!("{name}: {error}")), file, "{name}");
        }
    }
}
