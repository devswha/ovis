//! The machine key (docs/fleet-link.md section 1.5): an ECDSA P-256 key made on the machine that
//! never leaves it. Its file holds the 32-byte private scalar and nothing else, and is read only
//! when no one but its owner may read or write it (mode 0600 or stricter). The key signs AUTH;
//! its fingerprint is the machine id. No type here formats a byte of the scalar.

use std::fmt;
use std::path::Path;

use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, SigningKey};
use sha2::{Digest, Sha256};
use crate::hex;
use crate::private_file::{self, PrivateFileError};

const SCALAR_BYTES: usize = 32;
/// DER SubjectPublicKeyInfo of id-ecPublicKey with prime256v1, before the uncompressed point.
const SPKI_PREFIX: [u8; 26] = [
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03,
    0x42, 0x00,
];
pub const SPKI_BYTES: usize = 91;
const AUTH_DOMAIN: &[u8] = b"ovis-fleet-auth/1";

/// Why a key file was refused. No variant carries data read from the file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyError {
    Unreadable,
    Symlink,
    NotAFile,
    Exposed,
    WrongLength,
    NotAScalar,
}

impl fmt::Display for KeyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            KeyError::Unreadable => "machine key file cannot be read",
            KeyError::Symlink => "machine key path is a symbolic link",
            KeyError::NotAFile => "machine key is not a regular file",
            KeyError::Exposed => "machine key file may be read or written by others (it must be mode 0600)",
            KeyError::WrongLength => "machine key file does not hold exactly 32 bytes",
            KeyError::NotAScalar => "machine key file does not hold a P-256 private key",
        })
    }
}

impl std::error::Error for KeyError {}

pub struct MachineKey {
    signing: SigningKey,
    spki: [u8; SPKI_BYTES],
    machine_id: String,
}

impl MachineKey {
    pub fn from_scalar(scalar: &[u8]) -> Result<Self, KeyError> {
        if scalar.len() != SCALAR_BYTES {
            return Err(KeyError::WrongLength);
        }
        let signing = SigningKey::from_slice(scalar).map_err(|_| KeyError::NotAScalar)?;
        let point = signing.verifying_key().to_sec1_point(false);
        let mut spki = [0u8; SPKI_BYTES];
        spki[..SPKI_PREFIX.len()].copy_from_slice(&SPKI_PREFIX);
        spki[SPKI_PREFIX.len()..].copy_from_slice(point.as_bytes());
        let machine_id = hex::encode(&Sha256::digest(spki)[..16]);
        Ok(MachineKey { signing, spki, machine_id })
    }

    /// Reads the key file (crate::private_file): a regular file of mode 0600 or stricter, never
    /// through a symbolic link, holding exactly 32 bytes.
    pub fn load(path: &Path) -> Result<Self, KeyError> {
        let scalar = private_file::read(path, SCALAR_BYTES as u64).map_err(|error| match error {
            PrivateFileError::Unreadable => KeyError::Unreadable,
            PrivateFileError::Symlink => KeyError::Symlink,
            PrivateFileError::NotAFile => KeyError::NotAFile,
            PrivateFileError::Exposed => KeyError::Exposed,
            PrivateFileError::TooLarge => KeyError::WrongLength,
        })?;
        Self::from_scalar(&scalar)
    }

    /// The key's SubjectPublicKeyInfo DER: what the controller stores and ENROLL carries.
    pub fn spki(&self) -> [u8; SPKI_BYTES] {
        self.spki
    }

    /// The first 16 bytes of SHA-256 over the SPKI DER, as lowercase hex.
    pub fn machine_id(&self) -> &str {
        &self.machine_id
    }

    /// The AUTH signature: raw `r || s` over the 113 bytes of docs/fleet-link.md section 1.5,
    /// RFC 6979 with the low `s`, as @noble/curves writes it for scripts/fleet-vectors.ts.
    pub fn sign_auth(&self, nonce: &[u8; 32], server_id: &str, binding: &[u8; 32]) -> [u8; 64] {
        let signature: Signature = self.signing.sign(&auth_message(nonce, server_id, binding));
        signature.normalize_s().to_bytes().into()
    }
}

/// `"ovis-fleet-auth/1" || WELCOME nonce || server_id as its 32 ASCII hex digits || channel binding`.
pub fn auth_message(nonce: &[u8; 32], server_id: &str, binding: &[u8; 32]) -> Vec<u8> {
    [AUTH_DOMAIN, nonce, server_id.as_bytes(), binding].concat()
}

impl fmt::Debug for MachineKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MachineKey").field("machine_id", &self.machine_id).finish_non_exhaustive()
    }
}
