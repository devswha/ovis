//! Lowercase hex, for the selftest's lines and the tests' vectors.

pub fn encode(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(DIGITS[usize::from(byte >> 4)] as char);
        out.push(DIGITS[usize::from(byte & 0x0f)] as char);
    }
    out
}

/// `None` for an odd length or a character that is not a hex digit.
pub fn decode(text: &str) -> Option<Vec<u8>> {
    let digits = text.as_bytes();
    let (pairs, rest) = digits.as_chunks::<2>();
    if !rest.is_empty() {
        return None;
    }
    let value = |digit: u8| (digit as char).to_digit(16).map(|v| v as u8);
    pairs.iter().map(|[high, low]| Some(value(*high)? << 4 | value(*low)?)).collect()
}
