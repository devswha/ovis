//! `ovis-link join --state <dir> --invite <file | ovis-invite:1:...>` (todo 28): makes a state folder a fleet machine's.
//! It reads the invite (crate::invite_file), makes the machine key in the folder when there is none (it never leaves
//! the machine), and writes fleet.json from the invite, the `owner` block included as the controller wrote it. It
//! dials nothing: `ovis-link run` enrols with the invite fleet.json holds. Running it again on a folder that already
//! belongs to the invite's controller changes nothing (same key, same machine id); a folder of another controller is
//! refused. It prints one JSON line on stdout, the result or the refusal.

use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::path::Path;

use crate::daemon::FLEET_FILE;
use crate::exit;
use crate::fleet;
use crate::invite::{INVITE_LINE_PREFIX, MAX_INVITE_LINE_BYTES};
use crate::invite_file::{self, InviteError};
use crate::json;
use crate::machine_key::MachineKey;
use crate::status;

pub const MACHINE_KEY_FILE: &str = "machine.key";

/// A refusal: its exit code, its fixed `error` and a sentence for the operator. Never a secret.
struct Refusal {
    code: u8,
    error: &'static str,
    detail: String,
}

fn refusal(code: u8, error: &'static str, detail: impl Into<String>) -> Refusal {
    Refusal { code, error, detail: detail.into() }
}

fn storage(error: &std::io::Error, what: &str) -> Refusal {
    match error.kind() {
        ErrorKind::StorageFull | ErrorKind::QuotaExceeded => refusal(exit::JOIN_STORAGE, "disk full", format!("{what}: no space left")),
        _ => refusal(exit::JOIN_STORAGE, "state folder unusable", format!("{what}: {}", status::write_failure(error))),
    }
}

/// The invite's bytes: `-` reads them from stdin (the line, as the paste block sends it), anything else names a file
/// (a regular file, at most a line's bound). The line itself is refused as an argument: `ps` shows arguments.
fn invite_bytes(argument: &str) -> Result<Vec<u8>, Refusal> {
    if argument.trim_start().starts_with(INVITE_LINE_PREFIX) {
        return Err(refusal(exit::USAGE, "usage", "the invite line is never an argument: pass it on stdin with --invite -"));
    }
    let unreadable = |why: &str| refusal(exit::JOIN_INVITE, "invite unreadable", format!("the invite {why}"));
    let mut bytes = Vec::new();
    if argument == "-" {
        Read::take(std::io::stdin().lock(), MAX_INVITE_LINE_BYTES as u64 + 64).read_to_end(&mut bytes).map_err(|_| unreadable("cannot be read from stdin"))?;
        return Ok(bytes);
    }
    let mut file = fs::File::open(argument).map_err(|_| unreadable("file cannot be read"))?;
    if !file.metadata().map_err(|_| unreadable("file cannot be read"))?.is_file() {
        return Err(unreadable("file is not a regular file"));
    }
    Read::take(&mut file, MAX_INVITE_LINE_BYTES as u64 + 1).read_to_end(&mut bytes).map_err(|_| unreadable("file cannot be read"))?;
    Ok(bytes)
}

fn private_folder(dir: &Path) -> Result<(), Refusal> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    match fs::symlink_metadata(dir) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => return Err(refusal(exit::JOIN_STORAGE, "state folder unusable", "the state path is not a folder")),
        Err(error) if error.kind() == ErrorKind::NotFound => {
            fs::DirBuilder::new().recursive(true).mode(0o700).create(dir).map_err(|error| storage(&error, "the state folder cannot be made"))?;
        }
        Err(error) => return Err(storage(&error, "the state folder cannot be read")),
    }
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).map_err(|error| storage(&error, "the state folder cannot be made private"))
}

/// The machine key of the folder: the one there, or a new one made from the OS's random source (mode 0600, synced).
fn machine_key(path: &Path) -> Result<(MachineKey, bool), Refusal> {
    match MachineKey::load(path) {
        Ok(key) => return Ok((key, false)),
        Err(_) if path.symlink_metadata().is_ok() => return Err(refusal(exit::JOIN_STORAGE, "state folder unusable", "the folder's machine key cannot be used; leave this machine with --uninstall first")),
        Err(_) => {}
    }
    let mut scalar = zeroize::Zeroizing::new([0u8; 32]);
    let key = loop {
        getrandom::fill(scalar.as_mut()).map_err(|_| refusal(exit::JOIN_STORAGE, "state folder unusable", "no random source"))?;
        if let Ok(key) = MachineKey::from_scalar(scalar.as_ref()) {
            break key;
        }
    };
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let written = options.open(path).and_then(|mut file| file.write_all(scalar.as_ref()).and_then(|()| file.sync_all()));
    if let Err(error) = written {
        let _ = fs::remove_file(path);
        return Err(storage(&error, "the machine key cannot be written"));
    }
    Ok((key, true))
}

fn join(dir: &Path, argument: &str) -> Result<String, Refusal> {
    let invite = invite_file::read(&invite_bytes(argument)?).map_err(|error| match error {
        InviteError::KeyMismatch | InviteError::NotMember => refusal(exit::JOIN_CONTROLLER, "controller key mismatch", error.to_string()),
        InviteError::Line | InviteError::Invalid(_) => refusal(exit::JOIN_INVITE, "invite unreadable", error.to_string()),
    })?;
    let fleet_path = dir.join(FLEET_FILE);
    let held = match fleet::load(&fleet_path) {
        Ok(held) => Some(held),
        Err(_) if fleet_path.symlink_metadata().is_err() => None,
        Err(error) => return Err(refusal(exit::JOIN_STORAGE, "state folder unusable", format!("{error}; leave this machine with --uninstall first"))),
    };
    if let Some(held) = &held {
        if held.server_id != invite.server_id {
            return Err(refusal(exit::JOIN_ENROLLED, "already enrolled", "this machine belongs to another controller; leave it with --uninstall first"));
        }
    }
    private_folder(dir)?;
    let key_path = dir.join(MACHINE_KEY_FILE);
    let (key, made) = machine_key(&key_path)?;
    let result = if held.is_some() && !made {
        // the same controller: fleet.json stays as the agent keeps it (its invite gone once enrolled, its carriers saved)
        "kept"
    } else {
        let key_file = key_path.to_str().ok_or_else(|| refusal(exit::JOIN_STORAGE, "state folder unusable", "the state path is not UTF-8"))?;
        let bytes = format!(
            "{{\"v\":1,\"controller\":{},\"owner\":{},\"machine_key_file\":{},\"invite\":{{\"id\":{},\"secret\":{}}}}}",
            invite.controller_json(),
            invite.owner_json(),
            json::quote(key_file),
            json::quote(&invite.id),
            json::quote(&invite.secret),
        );
        // what the agent will read at its start: refused here, nothing is written
        fleet::parse(bytes.as_bytes()).map_err(|error| refusal(exit::JOIN_INVITE, "invite unreadable", error.to_string()))?;
        status::write_private(dir, FLEET_FILE, bytes.as_bytes(), true).map_err(|error| storage(&error, "fleet.json cannot be written"))?;
        "written"
    };
    Ok(format!(
        "{{\"result\":\"{result}\",\"machine_id\":{},\"server_id\":{},\"invite_id\":{},\"slot\":{},\"exp\":{}}}",
        json::quote(key.machine_id()),
        json::quote(&invite.server_id),
        json::quote(&invite.id),
        invite.slot,
        invite.exp
    ))
}

/// `ovis-link join --state <dir> --invite <- | file>`: one JSON line on stdout, and the exit code of crate::exit.
pub fn run(dir: &Path, argument: &str) -> u8 {
    match join(dir, argument) {
        Ok(line) => {
            println!("{line}");
            exit::OK
        }
        Err(refusal) => {
            println!("{{\"error\":{},\"detail\":{}}}", json::quote(refusal.error), json::quote(&refusal.detail));
            refusal.code
        }
    }
}
