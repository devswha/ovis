//! Base64 as the mux and the carrier use it: `base64url` without padding and canonical, as
//! shared/relay-mux.ts reads it (WELCOME's nonce, AUTH's signature), and standard base64 with
//! padding (the handshake envelopes and text carrier messages of shared/vendor/paseo-e2ee).

use zeroize::Zeroizing;

const STANDARD: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

fn encode_with(bytes: &[u8], alphabet: &[u8; 64], pad: bool) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let word = (u32::from(chunk[0]) << 16) | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8) | u32::from(*chunk.get(2).unwrap_or(&0));
        let symbols = chunk.len() + 1;
        for index in 0..4 {
            if index < symbols {
                out.push(alphabet[(word >> (18 - 6 * index) & 0x3f) as usize] as char);
            } else if pad {
                out.push('=');
            }
        }
    }
    out
}

fn value(alphabet: &[u8; 64], symbol: u8) -> Option<u32> {
    alphabet.iter().position(|&candidate| candidate == symbol).map(|index| index as u32)
}

/// Decodes unpadded symbols; refuses a last symbol whose unused bits are not zero. A refusal part way wipes what was
/// decoded so far (an invite line's secret is in it), as the caller's `Zeroizing` does for a result.
fn decode_with(symbols: &[u8], alphabet: &[u8; 64]) -> Option<Vec<u8>> {
    if symbols.len() % 4 == 1 {
        return None;
    }
    let mut out = Zeroizing::new(Vec::with_capacity(symbols.len() / 4 * 3 + 2));
    for chunk in symbols.chunks(4) {
        let mut word = 0u32;
        for (index, &symbol) in chunk.iter().enumerate() {
            word |= value(alphabet, symbol)? << (18 - 6 * index);
        }
        let bytes = chunk.len() - 1;
        let unused = word & (0x00ff_ffff >> (8 * bytes));
        if unused != 0 {
            return None;
        }
        out.extend_from_slice(&word.to_be_bytes()[1..=bytes]);
    }
    Some(std::mem::take(&mut *out))
}

/// Standard base64 with padding, as `base64-js` writes it.
pub fn encode(bytes: &[u8]) -> String {
    encode_with(bytes, STANDARD, true)
}

/// Standard base64: whole groups of four, padding only at the end, canonical.
pub fn decode(text: &str) -> Option<Vec<u8>> {
    let bytes = text.as_bytes();
    if !bytes.len().is_multiple_of(4) {
        return None;
    }
    let padding = bytes.iter().rev().take_while(|&&byte| byte == b'=').count();
    if padding > 2 {
        return None;
    }
    decode_with(&bytes[..bytes.len() - padding], STANDARD)
}

/// RFC 4648 section 5 without padding.
pub fn encode_url(bytes: &[u8]) -> String {
    encode_with(bytes, URL, false)
}

/// Any length of canonical unpadded base64url (the invite line, src/invite.rs).
pub fn decode_url_any(text: &str) -> Option<Vec<u8>> {
    decode_with(text.as_bytes(), URL)
}

/// Exactly `length` bytes of canonical unpadded base64url, as shared/relay-mux.ts `base64url` reads it.
pub fn decode_url(text: &str, length: usize) -> Option<Vec<u8>> {
    if text.len() != (length * 4).div_ceil(3) {
        return None;
    }
    decode_with(text.as_bytes(), URL).filter(|bytes| bytes.len() == length)
}
