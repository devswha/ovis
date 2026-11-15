//! `<state>/status.json`: what `ovis-link run` says of itself, read by `ovis-link status`. The agent
//! listens on no port, so this file is how it is asked. It holds the state, the route, the peer's
//! server id, the machine id and the class of the last error: never a token, key or bearer.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::Path;

use crate::json::{self, Json};

pub const STATUS_FILE: &str = "status.json";
pub const LOCK_FILE: &str = "run.lock";
pub const STOPPED_FILE: &str = "stopped";

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Status {
    pub state: String,
    pub path: Option<String>,
    pub error: Option<String>,
    pub peer: Option<String>,
    pub machine_id: Option<String>,
    pub advert: Option<String>,
    pub since: u64,
    /// When the next relay dial is due (seconds since the epoch), while one is armed (todo 37).
    pub next_relay_dial: Option<u64>,
}

fn field(value: Option<&str>) -> String {
    value.map_or_else(|| "null".to_owned(), json::quote)
}

impl Status {
    /// Compact JSON, keys in this order: `state` first and `path` after it.
    pub fn to_json(&self) -> String {
        format!(
            "{{\"state\":{},\"path\":{},\"error\":{},\"peer\":{},\"machine_id\":{},\"advert\":{},\"since\":{},\"next_relay_dial\":{}}}",
            json::quote(&self.state),
            field(self.path.as_deref()),
            field(self.error.as_deref()),
            field(self.peer.as_deref()),
            field(self.machine_id.as_deref()),
            field(self.advert.as_deref()),
            self.since,
            self.next_relay_dial.map_or_else(|| "null".to_owned(), |at| at.to_string()),
        )
    }

    pub fn from_json(bytes: &[u8]) -> Option<Status> {
        let value = json::parse(bytes).filter(Json::is_object)?;
        let text = |key: &str| value.get(key).and_then(Json::as_str).map(str::to_owned);
        Some(Status {
            state: text("state")?,
            path: text("path"),
            error: text("error"),
            peer: text("peer"),
            machine_id: text("machine_id"),
            advert: text("advert"),
            since: value.get("since").and_then(|since| since.as_integer(0, (1 << 53) - 1)).unwrap_or(0),
            next_relay_dial: value.get("next_relay_dial").and_then(|at| at.as_integer(0, (1 << 53) - 1)),
        })
    }
}

/// Writes `name` in `dir` whole, mode 0600, through a rename: a reader sees the old file or the new one.
/// `durable` also syncs it to disk first (the stop mark must outlive a reboot; the status need not).
pub fn write_private(dir: &Path, name: &str, contents: &[u8], durable: bool) -> io::Result<()> {
    let temporary = dir.join(format!(".{name}.tmp"));
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    file.write_all(contents)?;
    if durable {
        file.sync_all()?;
    }
    drop(file);
    fs::rename(&temporary, dir.join(name))?;
    if durable {
        // the rename itself is durable only once the folder's entry is on disk
        File::open(dir)?.sync_all()?;
    }
    Ok(())
}

/// Why a stop mark could not be written, as `status` and the log name it: never a path or a byte of data.
pub fn write_failure(error: &io::Error) -> &'static str {
    match error.kind() {
        io::ErrorKind::PermissionDenied | io::ErrorKind::ReadOnlyFilesystem => "the state folder is not writable",
        io::ErrorKind::StorageFull | io::ErrorKind::QuotaExceeded => "no space left",
        _ => "write failed",
    }
}

/// The stop after an `auth_revoked` refusal (docs/fleet-link.md section 5). It holds in memory for the life of the
/// process, whether or not the stop mark could be written; only a mark this process saw on disk and then saw removed
/// (`ovis-link rejoin`) lifts it. A mark that could not be written is written again at each look, so a restart honours
/// it once the folder takes writes again.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StopGate {
    stopped: bool,
    mark_seen: bool,
    unrecorded: Option<&'static str>,
}

/// What a look at the stop mark changes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StopChange {
    Stop,
    Resume,
}

impl StopGate {
    /// At start: stopped when the mark is on disk.
    pub fn at_start(mark: bool) -> Self {
        StopGate { stopped: mark, mark_seen: mark, unrecorded: None }
    }

    /// The controller refused the machine; `recorded` is how the write of the mark went.
    pub fn refused(&mut self, recorded: io::Result<()>) {
        self.stopped = true;
        match recorded {
            Ok(()) => {
                self.mark_seen = true;
                self.unrecorded = None;
            }
            Err(error) => self.unrecorded = Some(write_failure(&error)),
        }
    }

    /// A later attempt at writing the mark went `recorded`.
    pub fn recorded(&mut self, recorded: io::Result<()>) {
        if self.unrecorded.is_some() {
            self.refused(recorded);
        }
    }

    /// The mark is on disk now, or not.
    pub fn look(&mut self, mark: bool) -> Option<StopChange> {
        match (self.stopped, mark) {
            (false, true) => {
                self.stopped = true;
                self.mark_seen = true;
                Some(StopChange::Stop)
            }
            (true, true) => {
                self.mark_seen = true;
                None
            }
            (true, false) if self.mark_seen => {
                *self = StopGate::default();
                Some(StopChange::Resume)
            }
            _ => None,
        }
    }

    pub fn stopped(&self) -> bool {
        self.stopped
    }

    /// Why the mark is not on disk, while it is not.
    pub fn unrecorded(&self) -> Option<&'static str> {
        self.unrecorded
    }
}

/// The lock `ovis-link run` holds on its state folder for as long as it runs.
pub fn open_lock(dir: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(dir.join(LOCK_FILE))
}

/// Whether an `ovis-link run` holds `dir`'s lock now.
pub fn running(dir: &Path) -> bool {
    let Ok(file) = File::open(dir.join(LOCK_FILE)) else { return false };
    file.try_lock_shared().is_err()
}
