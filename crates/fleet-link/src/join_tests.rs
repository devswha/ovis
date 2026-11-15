//! The invite reader and `ovis-link join` against server/fleet/vectors/invite.json: every invite file and every
//! single-line case as the TypeScript reader takes it, and what `join` writes in a state folder.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

use serde_json::Value;

use crate::exit;
use crate::fleet;
use crate::hex;
use crate::invite_file;
use crate::join;

const INVITE: &str = include_str!("../../../server/fleet/vectors/invite.json");

fn cases(frame: &str) -> Vec<Value> {
    let data: Value = serde_json::from_str(INVITE).expect("invite.json parses");
    data["cases"].as_array().expect("cases").iter().filter(|entry| entry["frame"] == frame).cloned().collect()
}
fn bytes(entry: &Value) -> Vec<u8> {
    hex::decode(entry["bytes"].as_str().unwrap()).unwrap()
}
fn accepted_file() -> Value {
    cases("INVITE").into_iter().find(|entry| entry["name"] == "invite/accept").unwrap()
}

struct Folder(PathBuf);
impl Folder {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!("ovis-link-join-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir(&path).unwrap();
        Folder(path)
    }
}
impl Drop for Folder {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn reads_every_invite_file_as_the_vectors_say() {
    let all = cases("INVITE");
    assert!(all.len() >= 10);
    for entry in all {
        let name = entry["name"].as_str().unwrap();
        let read = invite_file::parse(&bytes(&entry));
        if entry["expect"]["refuse"].is_object() {
            assert!(read.is_err(), "{name}: refused by the TypeScript reader, taken here");
            continue;
        }
        let invite = read.unwrap_or_else(|error| panic!("{name}: {error}"));
        let parse = &entry["expect"]["parse"];
        assert_eq!(invite.id, parse["id"].as_str().unwrap(), "{name}");
        assert_eq!(invite.slot, parse["slot"].as_u64().unwrap(), "{name}");
        assert_eq!(invite.exp, parse["exp"].as_u64().unwrap(), "{name}");
        assert_eq!(*invite.secret, parse["secret"].as_str().unwrap(), "{name}");
        // the controller and owner blocks are written back as the controller wrote them
        let controller: Value = serde_json::from_str(&invite.controller_json()).unwrap();
        assert_eq!(controller, parse["controller"], "{name}");
        let text = String::from_utf8(bytes(&entry)).unwrap();
        assert!(text.contains(&format!("\"owner\":{}", invite.owner_json())), "{name}: the owner block is not the invite's own bytes");
        assert!(text.contains(&format!("\"controller\":{}", invite.controller_json())), "{name}: the controller block is not the invite's own bytes");
    }
}

#[test]
fn reads_every_invite_line_through_the_one_invite_reader() {
    let all = cases("INVITE_LINE");
    assert!(all.len() >= 6);
    for entry in all {
        let name = entry["name"].as_str().unwrap();
        let line = bytes(&entry);
        let read = invite_file::read(&line);
        if entry["expect"]["refuse"].is_object() {
            assert!(read.is_err(), "{name}: refused by the TypeScript reader, taken here");
            continue;
        }
        // the line decodes (crate::invite::decode_line); what it carries is then read as an invite file, nothing more
        let file = hex::decode(entry["expect"]["parse"]["file_hex"].as_str().unwrap()).unwrap();
        assert_eq!(read, invite_file::parse(&file), "{name}: one reader for the line and the file");
    }
}

fn line_of(entry: &Value) -> String {
    let data: Value = serde_json::from_str(INVITE).unwrap();
    let line = data["cases"].as_array().unwrap().iter().find(|candidate| candidate["frame"] == "INVITE_LINE" && candidate["name"] == "invite_line/accept" && candidate["expect"]["parse"]["file_hex"] == entry["bytes"]).unwrap();
    String::from_utf8(bytes(line)).unwrap()
}

#[test]
fn join_makes_the_key_and_fleet_json_once_and_keeps_them_on_a_second_run() {
    let folder = Folder::new("once");
    let state = folder.0.join("state");
    let line = line_of(&accepted_file());
    // the line as an argument is refused (`ps` shows arguments), and nothing is made
    assert_eq!(join::run(&state, &line), exit::USAGE);
    assert!(!state.exists());
    let line_file = folder.0.join("line.txt");
    fs::write(&line_file, format!("{line}\n")).unwrap();
    assert_eq!(join::run(&state, line_file.to_str().unwrap()), exit::OK);
    assert_eq!(fs::metadata(&state).unwrap().permissions().mode() & 0o777, 0o700);
    let key = state.join(join::MACHINE_KEY_FILE);
    assert_eq!(fs::metadata(&key).unwrap().permissions().mode() & 0o777, 0o600);
    let fleet_file = state.join("fleet.json");
    assert_eq!(fs::metadata(&fleet_file).unwrap().permissions().mode() & 0o777, 0o600);
    let written = fleet::load(&fleet_file).expect("the agent takes what join wrote");
    let invite = invite_file::read(line.as_bytes()).unwrap();
    assert_eq!(written.server_id, invite.server_id);
    assert_eq!(written.invite.as_ref().map(|held| held.id.clone()), Some(invite.id.clone()));
    assert_eq!(written.machine_key_file, key);
    let text = fs::read_to_string(&fleet_file).unwrap();
    assert!(text.contains(&format!("\"owner\":{}", invite.owner_json())));
    let scalar = fs::read(&key).unwrap();
    let before = fs::read(&fleet_file).unwrap();
    // Running it again (the same invite, as a file this time) keeps the key and the file as they are
    let file = folder.0.join("invite.json");
    fs::write(&file, bytes(&accepted_file())).unwrap();
    assert_eq!(join::run(&state, file.to_str().unwrap()), exit::OK);
    assert_eq!(fs::read(&key).unwrap(), scalar);
    assert_eq!(fs::read(&fleet_file).unwrap(), before);
}

#[test]
fn join_refuses_a_bad_invite_and_writes_nothing() {
    let folder = Folder::new("bad");
    let state = folder.0.join("state");
    let refused = cases("INVITE_LINE").into_iter().find(|entry| entry["name"] == "invite_line/unused-bits-set").unwrap();
    let refused_file = folder.0.join("refused.txt");
    fs::write(&refused_file, bytes(&refused)).unwrap();
    assert_eq!(join::run(&state, refused_file.to_str().unwrap()), exit::JOIN_INVITE);
    let file = folder.0.join("rotated.json");
    let rotated = cases("INVITE").into_iter().find(|entry| entry["name"] == "invite/controller-rotated").unwrap();
    fs::write(&file, bytes(&rotated)).unwrap();
    assert_eq!(join::run(&state, file.to_str().unwrap()), exit::JOIN_CONTROLLER);
    assert_eq!(join::run(&state, folder.0.join("missing.json").to_str().unwrap()), exit::JOIN_INVITE);
    assert!(!state.exists(), "a refused invite leaves no state folder");
}

#[test]
fn join_keeps_a_folder_of_the_same_controller_and_leaves_it_on_a_foreign_invite() {
    let folder = Folder::new("other");
    let state = folder.0.join("state");
    let line_file = folder.0.join("line.txt");
    fs::write(&line_file, line_of(&accepted_file())).unwrap();
    assert_eq!(join::run(&state, line_file.to_str().unwrap()), exit::OK);
    let before = fs::read(state.join("fleet.json")).unwrap();
    let direct_only = cases("INVITE").into_iter().find(|entry| entry["name"] == "invite/direct-only").unwrap();
    let file = folder.0.join("direct-only.json");
    fs::write(&file, bytes(&direct_only)).unwrap();
    // the direct-only invite names the same controller: kept, nothing changes
    assert_eq!(join::run(&state, file.to_str().unwrap()), exit::OK);
    assert_eq!(fs::read(state.join("fleet.json")).unwrap(), before);
    // an invite of another controller is refused and fleet.json is left as it was
    let foreign = folder.0.join("foreign.json");
    let mut invite: Value = serde_json::from_slice(&bytes(&accepted_file())).unwrap();
    let key = crate::b64::encode(&[7u8; 32]);
    invite["controller"]["server_public_key"] = Value::from(key.clone());
    invite["controller"]["server_id"] = Value::from(fleet::server_id(&[7u8; 32]));
    fs::write(&foreign, serde_json::to_vec(&invite).unwrap()).unwrap();
    // its owner record names the first controller, so the reader itself refuses it first
    assert_eq!(join::run(&state, foreign.to_str().unwrap()), exit::JOIN_CONTROLLER);
    assert_eq!(fs::read(state.join("fleet.json")).unwrap(), before);
}
