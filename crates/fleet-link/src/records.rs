//! Protected records, as shared/vendor/paseo-e2ee/protected-records.ts frames them: one
//! application frame becomes one record, and every Noise transport message (chunk) carries in its
//! authenticated plaintext the frame kind, FIRST and FINAL flags and the total frame length, so a
//! relay cannot merge, split, truncate or re-chunk a record unnoticed. Transport AD is empty.
//!
//! ```text
//! chunk plaintext = kind(1) || flags(1) || totalLength(u32 BE) || data
//! wire record     = for each chunk: ciphertextLength(u16 BE) || ciphertext
//! ```

use std::fmt;

use crate::noise::{CipherState, MAX_MESSAGE_BYTES, TAG_BYTES};
use crate::Error;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FrameKind {
    Text,
    Binary,
}

#[derive(Clone, PartialEq, Eq)]
pub struct Frame {
    pub kind: FrameKind,
    pub data: Vec<u8>,
}

impl fmt::Debug for Frame {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Frame").field("kind", &self.kind).field("bytes", &self.data.len()).finish()
    }
}

const KIND_TEXT: u8 = 0x00;
const KIND_BINARY: u8 = 0x01;
const FLAG_FIRST: u8 = 0x01;
const FLAG_FINAL: u8 = 0x02;
const HEADER_BYTES: usize = 6;
const LENGTH_PREFIX_BYTES: usize = 2;
const CHUNK_OVERHEAD_BYTES: usize = LENGTH_PREFIX_BYTES + HEADER_BYTES + TAG_BYTES;

/// The largest data payload one chunk carries.
pub const MAX_CHUNK_DATA_BYTES: usize = MAX_MESSAGE_BYTES - TAG_BYTES - HEADER_BYTES;
/// The largest frame a record may carry: its length travels as a u32.
pub const MAX_FRAME_BYTES: u64 = 0xffff_ffff;

pub const fn chunk_count(frame_bytes: usize) -> usize {
    if frame_bytes == 0 {
        1
    } else {
        frame_bytes.div_ceil(MAX_CHUNK_DATA_BYTES)
    }
}

/// Wire bytes a frame of `frame_bytes` occupies once protected.
pub const fn protected_record_byte_length(frame_bytes: usize) -> usize {
    frame_bytes + chunk_count(frame_bytes) * CHUNK_OVERHEAD_BYTES
}

/// The same in u64, for a length read off the wire before anything is allocated for it.
fn wire_length_of(total: u64) -> u64 {
    let chunks = if total == 0 { 1 } else { total.div_ceil(MAX_CHUNK_DATA_BYTES as u64) };
    total + chunks * CHUNK_OVERHEAD_BYTES as u64
}

pub(crate) fn encode(kind: FrameKind, frame: &[u8], sender: &mut CipherState) -> Result<Vec<u8>, Error> {
    if frame.len() as u64 > MAX_FRAME_BYTES {
        return Err(Error::FrameTooLarge);
    }
    let chunks = chunk_count(frame.len());
    let total = (frame.len() as u32).to_be_bytes();
    let mut out = Vec::with_capacity(protected_record_byte_length(frame.len()));
    for index in 0..chunks {
        let start = index * MAX_CHUNK_DATA_BYTES;
        let data = &frame[start..frame.len().min(start + MAX_CHUNK_DATA_BYTES)];
        let mut plaintext = Vec::with_capacity(HEADER_BYTES + data.len());
        plaintext.push(match kind {
            FrameKind::Text => KIND_TEXT,
            FrameKind::Binary => KIND_BINARY,
        });
        plaintext.push(if index == 0 { FLAG_FIRST } else { 0 } | if index == chunks - 1 { FLAG_FINAL } else { 0 });
        plaintext.extend_from_slice(&total);
        plaintext.extend_from_slice(data);
        let ciphertext = sender.encrypt_with_ad(&[], &plaintext)?;
        out.extend_from_slice(&(ciphertext.len() as u16).to_be_bytes());
        out.extend_from_slice(&ciphertext);
    }
    Ok(out)
}

struct Chunk {
    kind: FrameKind,
    first: bool,
    last: bool,
    total: u64,
    data: Vec<u8>,
}

struct Assembly {
    kind: FrameKind,
    total: u64,
    expected_chunks: u64,
    frame: Vec<u8>,
    index: u64,
}

/// Decodes one record. Chunks are authenticated in order and the receive counter advances per
/// authenticated chunk; any violation is an error and nothing partial is returned. The caller
/// must end the channel on an error.
pub(crate) fn decode(record: &[u8], receiver: &mut CipherState) -> Result<Frame, Error> {
    let mut offset = 0;
    let mut assembly: Option<Assembly> = None;
    while offset < record.len() {
        if assembly.as_ref().is_some_and(|assembly| assembly.index >= assembly.expected_chunks) {
            return Err(Error::UnexpectedChunkAfterFinal);
        }
        let (chunk, next) = read_chunk(record, offset, receiver)?;
        offset = next;
        assembly = Some(match assembly {
            None => start_assembly(chunk, record.len())?,
            Some(assembly) => continue_assembly(assembly, chunk)?,
        });
    }
    let assembly = assembly.ok_or(Error::EmptyRecord)?;
    if assembly.index != assembly.expected_chunks || assembly.frame.len() as u64 != assembly.total {
        return Err(Error::RecordIncomplete);
    }
    Ok(Frame { kind: assembly.kind, data: assembly.frame })
}

fn read_chunk(record: &[u8], offset: usize, receiver: &mut CipherState) -> Result<(Chunk, usize), Error> {
    if record.len() - offset < LENGTH_PREFIX_BYTES {
        return Err(Error::RecordTruncated);
    }
    // a u16 is never above NOISE_MAX_MESSAGE_BYTES (65535), the TypeScript code's upper bound
    let length = usize::from(u16::from_be_bytes([record[offset], record[offset + 1]]));
    let start = offset + LENGTH_PREFIX_BYTES;
    if length < TAG_BYTES + HEADER_BYTES {
        return Err(Error::InvalidChunkLength);
    }
    if record.len() - start < length {
        return Err(Error::RecordTruncated);
    }
    let plaintext = receiver.decrypt_with_ad(&[], &record[start..start + length])?;
    let flags = plaintext[1];
    if flags & !(FLAG_FIRST | FLAG_FINAL) != 0 {
        return Err(Error::ReservedFlag);
    }
    let kind = match plaintext[0] {
        KIND_TEXT => FrameKind::Text,
        KIND_BINARY => FrameKind::Binary,
        _ => return Err(Error::InvalidFrameKind),
    };
    let total = u64::from(u32::from_be_bytes([plaintext[2], plaintext[3], plaintext[4], plaintext[5]]));
    let chunk = Chunk {
        kind,
        first: flags & FLAG_FIRST != 0,
        last: flags & FLAG_FINAL != 0,
        total,
        data: plaintext[HEADER_BYTES..].to_vec(),
    };
    Ok((chunk, start + length))
}

fn start_assembly(chunk: Chunk, record_bytes: usize) -> Result<Assembly, Error> {
    if !chunk.first {
        return Err(Error::RecordNotFirst);
    }
    // the claimed length fixes the record's exact wire length: checked before allocating, so a
    // tiny authenticated header cannot demand gigabytes
    if wire_length_of(chunk.total) != record_bytes as u64 {
        return Err(Error::RecordLengthMismatch);
    }
    let expected_chunks = if chunk.total == 0 { 1 } else { chunk.total.div_ceil(MAX_CHUNK_DATA_BYTES as u64) };
    let assembly = Assembly {
        kind: chunk.kind,
        total: chunk.total,
        expected_chunks,
        frame: Vec::with_capacity(chunk.total as usize),
        index: 0,
    };
    append_chunk(assembly, chunk)
}

fn continue_assembly(assembly: Assembly, chunk: Chunk) -> Result<Assembly, Error> {
    if chunk.first {
        return Err(Error::FirstRepeated);
    }
    if chunk.kind != assembly.kind {
        return Err(Error::FrameKindChanged);
    }
    if chunk.total != assembly.total {
        return Err(Error::FrameLengthChanged);
    }
    append_chunk(assembly, chunk)
}

fn append_chunk(mut assembly: Assembly, chunk: Chunk) -> Result<Assembly, Error> {
    let last_expected = assembly.index == assembly.expected_chunks - 1;
    if chunk.last != last_expected {
        return Err(Error::FinalFlagMismatch);
    }
    let expected_data = if last_expected {
        assembly.total - assembly.index * MAX_CHUNK_DATA_BYTES as u64
    } else {
        MAX_CHUNK_DATA_BYTES as u64
    };
    if chunk.data.len() as u64 != expected_data {
        return Err(Error::ChunkSizeMismatch);
    }
    assembly.frame.extend_from_slice(&chunk.data);
    assembly.index += 1;
    Ok(assembly)
}
