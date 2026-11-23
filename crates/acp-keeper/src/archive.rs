//! The numbered message file and the replay stream, carried over from the rust-process-trial archiver:
//! every JSON-RPC line is appended to ROOT/archive.jsonl as `{"seq","dir","ts","raw"}`; a client sends
//! `{"replay":N}` and gets rows N.. from the file, a `{"through":seq,"pid":pid}` watermark, then live rows.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use tokio::io::{AsyncWrite, AsyncWriteExt};
use tokio::sync::watch;

pub const MAX_LINE: usize = 1_100_000;
pub const PUSH: usize = 64 * 1024;

pub struct Framer {
    buf: Vec<u8>,
    discard: bool,
}

impl Framer {
    pub fn new() -> Self {
        Framer { buf: Vec::new(), discard: false }
    }

    /// Complete lines in `chunk`; a line longer than MAX_LINE is dropped up to its newline.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<Vec<u8>> {
        let mut lines = Vec::new();
        let mut start = 0;
        while start < chunk.len() {
            let lf = memchr::memchr(b'\n', &chunk[start..]).map(|at| start + at);
            let piece = &chunk[start..lf.unwrap_or(chunk.len())];
            if !self.discard {
                if self.buf.len() + piece.len() > MAX_LINE {
                    self.discard = true;
                    self.buf = Vec::new();
                } else {
                    self.buf.extend_from_slice(piece);
                }
            }
            let Some(lf) = lf else { break };
            if !self.discard {
                let mut line = std::mem::take(&mut self.buf);
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                lines.push(line);
            }
            self.buf.clear();
            self.discard = false;
            start = lf + 1;
        }
        lines
    }
}

/// A JSON-RPC 2.0 message object, parsed; anything else is None.
pub fn rpc(line: &str) -> Option<serde_json::Map<String, serde_json::Value>> {
    use serde_json::Value;
    let Ok(Value::Object(msg)) = serde_json::from_str::<Value>(line) else { return None };
    if msg.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return None;
    }
    let id_ok = |id: Option<&Value>| matches!(id, Some(Value::Null | Value::String(_))) || id.and_then(Value::as_i64).is_some();
    let ok = if let Some(method) = msg.get("method") {
        method.as_str().is_some_and(|m| !m.is_empty())
            && (!msg.contains_key("id") || id_ok(msg.get("id")))
            && !msg.contains_key("result")
            && !msg.contains_key("error")
            && msg.get("params").is_none_or(|p| p.is_object() || p.is_array())
    } else if !id_ok(msg.get("id")) || msg.contains_key("params") {
        false
    } else {
        match (msg.get("result"), msg.get("error")) {
            (Some(_), None) => true,
            (None, Some(Value::Object(error))) => error.get("code").and_then(Value::as_i64).is_some() && error.get("message").is_some_and(Value::is_string),
            _ => false,
        }
    };
    ok.then_some(msg)
}

pub fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

struct Log {
    file: File,
    offsets: Vec<u64>,
}

pub struct Archive {
    log: Mutex<Log>,
    pub end: watch::Sender<u64>,
    pub path: PathBuf,
}

impl Archive {
    pub fn create(path: PathBuf) -> std::io::Result<Archive> {
        let file = create(&path)?;
        let (end, _) = watch::channel(0u64);
        Ok(Archive { log: Mutex::new(Log { file, offsets: vec![0] }), end, path })
    }

    pub fn append(&self, dir: &str, raw: &str) -> u64 {
        let ts = now_ms();
        let mut log = self.log.lock().expect("archive lock");
        let seq = log.offsets.len() as u64;
        let row = format!("{{\"seq\":{seq},\"dir\":\"{dir}\",\"ts\":{ts},\"raw\":{}}}\n", serde_json::to_string(raw).expect("a string serializes"));
        log.file.write_all(row.as_bytes()).expect("archive write");
        let end = log.offsets.last().copied().unwrap_or(0) + row.len() as u64;
        log.offsets.push(end);
        drop(log);
        self.end.send_replace(end);
        seq
    }

    /// Where row `n` starts, the current end and the last sequence number, read together.
    pub fn replay_from(&self, n: u64) -> Option<(u64, u64, u64)> {
        let log = self.log.lock().expect("archive lock");
        let count = log.offsets.len() as u64;
        if n < 1 || n > count {
            return None;
        }
        Some((log.offsets[(n - 1) as usize], *log.offsets.last().expect("offsets start at 0"), count - 1))
    }
}

#[cfg(unix)]
fn read_at(file: &File, buf: &mut [u8], at: u64) -> std::io::Result<usize> {
    std::os::unix::fs::FileExt::read_at(file, buf, at)
}

#[cfg(windows)]
fn read_at(file: &File, buf: &mut [u8], at: u64) -> std::io::Result<usize> {
    std::os::windows::fs::FileExt::seek_read(file, buf, at)
}

/// Sends rows from `cursor` up to `boundary`, the watermark, then every row appended later.
pub async fn pump<W: AsyncWrite + Unpin>(archive: &Archive, mut out: W, mut cursor: u64, boundary: u64, through: u64, pid: u32) -> std::io::Result<()> {
    let reader = File::open(&archive.path)?;
    let mut end_rx = archive.end.subscribe();
    let mut marker = false;
    let mut bytes = vec![0u8; PUSH];
    loop {
        let limit = if marker { *end_rx.borrow_and_update() } else { boundary };
        if cursor < limit {
            let want = PUSH.min((limit - cursor) as usize);
            let count = read_at(&reader, &mut bytes[..want], cursor)?;
            if count == 0 {
                return Err(std::io::Error::other("archive truncated while replaying"));
            }
            cursor += count as u64;
            out.write_all(&bytes[..count]).await?;
        } else if !marker {
            marker = true;
            out.write_all(format!("{{\"through\":{through},\"pid\":{pid}}}\n").as_bytes()).await?;
        } else if end_rx.changed().await.is_err() {
            return Ok(());
        }
    }
}

pub fn create(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(path)
}
