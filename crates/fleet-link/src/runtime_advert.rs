//! The runtime's `serve --root <dir>` piped into `ovis-link runtime-advert --state <dir> --runtime-version <v>` (todo 28): turns the
//! runtime's ready line into `<state>/advert.json` (docs/fleet-link.md section 5), the `native` endpoint with the
//! runtime's socket and owner bearer, until the machine's bridge server (todo 27) writes it instead. The ready line holds
//! the bearers, so it goes nowhere else: every other line of the runtime is passed on to stderr. When the runtime's
//! output ends (it stopped), the advert is written again with `runtime_down`, and the command ends.

use std::io::{self, BufRead, Read, Write};
use std::path::Path;

use crate::advert_file;
use crate::daemon::ADVERT_FILE;
use crate::exit;
use crate::hex;
use crate::json::{self, Json};
use crate::status;

/// What stands in for the two programs this slice does not install (no bridge server, no agent sidecar).
const ABSENT_VERSION: &str = "none";
const RUNTIME_ID: &str = "ovis-runtime";
/// A line longer than this is not a ready line: it is passed on in pieces.
const MAX_LINE_BYTES: u64 = 64 * 1024;

fn advert(socket: &str, bearer: &str, boot_id: &str, version: &str, down: bool) -> String {
    format!(
        "{{\"v\":1,\"runtime_id\":\"{RUNTIME_ID}\",\"boot_id\":{},\"native_bearer\":{},\"native_socket\":{},{}\"versions\":{{\"server\":\"{ABSENT_VERSION}\",\"agent\":\"{ABSENT_VERSION}\",\"runtime\":{}}}}}",
        json::quote(boot_id),
        json::quote(bearer),
        json::quote(socket),
        if down { "\"runtime_down\":true," } else { "" },
        json::quote(version),
    )
}

/// The socket and owner bearer of a `{"ready": {"socket", "bearer", ...}}` line.
fn ready(line: &[u8]) -> Option<(String, zeroize::Zeroizing<String>)> {
    let value = json::parse(line)?;
    let ready = value.get("ready").filter(|ready| ready.is_object())?;
    let socket = ready.get("socket").and_then(Json::as_str)?.to_owned();
    let bearer = zeroize::Zeroizing::new(ready.get("bearer").and_then(Json::as_str)?.to_owned());
    Some((socket, bearer))
}

fn boot_id() -> String {
    let mut bytes = [0u8; 16];
    let _ = getrandom::fill(&mut bytes);
    hex::encode(&bytes)
}

fn write(dir: &Path, bytes: &str) -> bool {
    // only what the agent will take: a ready line it would refuse is not written over a good advert
    if advert_file::parse(bytes.as_bytes()).is_err() {
        eprintln!("ovis-link runtime-advert: the runtime's ready line does not make an advert the agent takes");
        return false;
    }
    if status::write_private(dir, ADVERT_FILE, bytes.as_bytes(), false).is_err() {
        eprintln!("ovis-link runtime-advert: advert.json cannot be written");
        return false;
    }
    true
}

pub fn run(dir: &Path, version: &str) -> u8 {
    let mut input = io::stdin().lock();
    let mut last: Option<(String, zeroize::Zeroizing<String>, String)> = None;
    loop {
        let mut line = zeroize::Zeroizing::new(Vec::new());
        match Read::take(&mut input, MAX_LINE_BYTES).read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        if let Some((socket, bearer)) = ready(line.trim_ascii_end()) {
            let boot = boot_id();
            if write(dir, &advert(&socket, &bearer, &boot, version, false)) {
                eprintln!("ovis-link runtime-advert: the runtime is ready; advert.json names its socket");
            }
            last = Some((socket, bearer, boot));
            continue;
        }
        let _ = io::stderr().write_all(&line);
    }
    if let Some((socket, bearer, boot)) = last {
        write(dir, &advert(&socket, &bearer, &boot, version, true));
        eprintln!("ovis-link runtime-advert: the runtime's output ended; advert.json says runtime_down");
    }
    exit::OK
}
