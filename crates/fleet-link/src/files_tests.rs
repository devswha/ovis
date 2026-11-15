//! The files of `ovis-link run`'s state folder against server/fleet/vectors/machine-files.json, the
//! private-file reader they go through, and the exit-code table of docs/fleet-link.md.

use std::fs;
use std::path::PathBuf;

use serde_json::Value;

use crate::advert_file;
use crate::exit;
use crate::fleet::{self, FleetError};
use crate::hex;
use crate::mux::{Endpoint, UpDown};
use crate::private_file::PrivateFileError;
use crate::status::Status;

const FILES: &str = include_str!("../../../server/fleet/vectors/machine-files.json");
const CONTRACT: &str = include_str!("../../../docs/fleet-link.md");

fn cases(frame: &str) -> Vec<Value> {
    let data: Value = serde_json::from_str(FILES).expect("machine-files.json parses");
    data["cases"].as_array().expect("cases").iter().filter(|entry| entry["frame"] == frame).cloned().collect()
}

fn bytes(entry: &Value) -> Vec<u8> {
    hex::decode(entry["bytes"].as_str().unwrap()).unwrap()
}

/// A case as the agent meets it: a file of mode 0600 (`max_bytes` is the file reader's limit).
fn as_file(folder: &Folder, entry: &Value) -> PathBuf {
    folder.write(&entry["name"].as_str().unwrap().replace('/', "-"), &bytes(entry), 0o600)
}

/// A private temp folder, removed when dropped.
struct Folder(PathBuf);
impl Folder {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!("ovis-link-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir(&path).unwrap();
        Folder(path)
    }
    fn write(&self, name: &str, contents: &[u8], mode: u32) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = self.0.join(name);
        fs::write(&path, contents).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
        path
    }
}
impl Drop for Folder {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn reads_every_fleet_file_case_as_the_vectors_say() {
    let all = cases("FLEET_FILE");
    assert!(all.len() >= 10);
    let folder = Folder::new("fleet-cases");
    for entry in all {
        let name = entry["name"].as_str().unwrap();
        let result = fleet::load(&as_file(&folder, &entry));
        match entry["expect"].get("refuse") {
            Some(refuse) => {
                let error = result.expect_err(name);
                let code = match error {
                    FleetError::KeyMismatch => "controller_key_mismatch",
                    FleetError::NotMember => "controller_not_member",
                    _ => "invalid_fleet",
                };
                assert_eq!(refuse["code"], code, "{name}: {error}");
            }
            None => {
                let parsed = &entry["expect"]["parse"];
                let fleet = result.unwrap_or_else(|error| panic!("{name}: {error}"));
                let controller = &parsed["controller"];
                assert_eq!(fleet.server_id, controller["server_id"].as_str().unwrap(), "{name}");
                assert_eq!(fleet.server_id, fleet::server_id(&fleet.server_key), "{name}");
                assert_eq!(fleet.machine_key_file.to_str(), parsed["machine_key_file"].as_str(), "{name}");
                let owner = &parsed["owner"];
                assert_eq!(crate::b64::encode_url(&fleet.owner.public_key), owner["public_key"].as_str().unwrap(), "{name}");
                assert_eq!(fleet.owner.member.server_public_key, owner["member"]["server_public_key"].as_str().unwrap(), "{name}");
                assert_eq!(fleet.owner.member.class, owner["member"]["class"].as_str().unwrap(), "{name}");
                match parsed.get("invite") {
                    None => assert!(fleet.invite.is_none(), "{name}"),
                    Some(invite) => {
                        let held = fleet.invite.as_ref().unwrap_or_else(|| panic!("{name}: no invite"));
                        assert_eq!(held.id, invite["id"].as_str().unwrap(), "{name}");
                        assert_eq!(crate::b64::encode_url(held.secret.as_ref()), invite["secret"].as_str().unwrap(), "{name}");
                    }
                }
                assert_eq!(fleet.direct.len(), controller["direct"].as_array().unwrap().len(), "{name}");
                for (place, text) in fleet.direct.iter().zip(controller["direct"].as_array().unwrap()) {
                    assert_eq!(format!("ws://{}:{}", place.host, place.port), text.as_str().unwrap(), "{name}");
                }
                match controller["relay"].as_str() {
                    None => assert!(fleet.relay.is_none(), "{name}"),
                    Some(origin) => {
                        let relay = fleet.relay.as_ref().unwrap();
                        let url = relay.url(&fleet.server_id);
                        assert!(url.starts_with(&format!("{origin}{}", if relay.tls { ":443" } else { "" })) || url.starts_with(origin), "{name}: {url}");
                        assert!(url.ends_with(&format!("/v1/ws?server_id={}&role=client&v=1&lane=paced", fleet.server_id)), "{name}: {url}");
                    }
                }
            }
        }
    }
}

#[test]
fn reads_every_advert_file_case_as_the_vectors_say() {
    let all = cases("ADVERT_FILE");
    assert!(all.len() >= 10);
    let folder = Folder::new("advert-cases");
    for entry in all {
        let name = entry["name"].as_str().unwrap();
        let result = advert_file::load(&as_file(&folder, &entry));
        let Some(refuse) = entry["expect"].get("refuse") else {
            let parsed = &entry["expect"]["parse"];
            let file = result.unwrap_or_else(|error| panic!("{name}: {error}"));
            let advert = file.advert(true, 1);
            assert_eq!(advert.runtime_id, parsed["runtime_id"].as_str().unwrap(), "{name}");
            assert_eq!(advert.bridge_token.as_deref().map(String::as_str), parsed["bridge_token"].as_str(), "{name}");
            assert_eq!(advert.native_bearer.as_deref().map(String::as_str), parsed["native_bearer"].as_str(), "{name}");
            assert_eq!(advert.endpoints.contains(&Endpoint::Native), parsed.get("native_bearer").is_some(), "{name}");
            let down = parsed["runtime_down"].as_bool().unwrap_or(false);
            assert_eq!(advert.health.runtime, if down { UpDown::Down } else { UpDown::Up }, "{name}");
            assert_eq!(advert.versions.link, env!("CARGO_PKG_VERSION"), "{name}");
            let targets = file.targets(|| Some(PathBuf::from("/resolved.sock")));
            assert_eq!(targets.bridge_port, parsed["bridge_port"].as_u64().map(|port| port as u16), "{name}");
            if let Some(socket) = parsed["native_socket"].as_str() {
                assert_eq!(targets.native_socket, Some(PathBuf::from(socket)), "{name}");
            }
            continue;
        };
        assert_eq!(refuse["code"], "invalid_advert", "{name}");
        assert!(result.is_err(), "{name} is refused");
    }
}

#[test]
fn says_bridge_down_when_the_bridge_port_does_not_accept() {
    let entry = cases("ADVERT_FILE").into_iter().find(|entry| entry["name"] == "files/advert/accept").unwrap();
    let file = advert_file::parse(&bytes(&entry)).unwrap();
    assert_eq!(file.advert(true, 0).health.bridge, UpDown::Up);
    let down = file.advert(false, 0);
    assert_eq!(down.health.bridge, UpDown::Down);
    assert!(down.endpoints.contains(&Endpoint::Bridge), "the endpoint stays advertised; only its health changes");
}

#[test]
fn says_runtime_down_only_when_the_file_does_never_for_a_bridge_only_machine() {
    let entry = cases("ADVERT_FILE").into_iter().find(|entry| entry["name"] == "files/advert/bridge-only").unwrap();
    let file = advert_file::parse(&bytes(&entry)).unwrap();
    let advert = file.advert(true, 0);
    assert_eq!(advert.endpoints, vec![Endpoint::Bridge]);
    assert_eq!(advert.health.runtime, UpDown::Up, "offering no native endpoint is not a runtime that does not answer");
    let down = advert_file::AdvertFile { runtime_down: true, ..file };
    assert_eq!(down.advert(true, 0).health.runtime, UpDown::Down);
}

#[test]
fn reads_fleet_json_and_advert_json_only_as_private_regular_files_up_to_16_kib() {
    let folder = Folder::new("files");
    let accept = cases("FLEET_FILE").into_iter().find(|entry| entry["name"] == "files/fleet/accept").unwrap();
    let advert = cases("ADVERT_FILE").into_iter().find(|entry| entry["name"] == "files/advert/accept").unwrap();
    let fleet_path = folder.write("fleet.json", &bytes(&accept), 0o600);
    assert!(fleet::load(&fleet_path).is_ok());
    let advert_path = folder.write("advert.json", &bytes(&advert), 0o400);
    assert!(advert_file::load(&advert_path).is_ok(), "0400 is stricter than 0600");

    // a file over 16 KiB, padded with whitespace so that only its size is wrong
    let mut large = bytes(&accept);
    large.extend(std::iter::repeat_n(b' ', 16 * 1024 + 1 - large.len()));
    assert!(fleet::parse(&large).is_ok(), "the same bytes parse when not read from a file");
    let large_path = folder.write("large.json", &large, 0o600);
    assert_eq!(fleet::load(&large_path), Err(FleetError::File(PrivateFileError::TooLarge)));
    let mut advert_large = bytes(&advert);
    advert_large.extend(std::iter::repeat_n(b' ', 16 * 1024 + 1 - advert_large.len()));
    let advert_large_path = folder.write("advert-large.json", &advert_large, 0o600);
    assert_eq!(advert_file::load(&advert_large_path).unwrap_err(), advert_file::AdvertError::File(PrivateFileError::TooLarge));
    large.truncate(16 * 1024);
    assert!(fleet::load(&folder.write("exact.json", &large, 0o600)).is_ok(), "16 KiB exactly is read");

    let exposed = folder.write("exposed.json", &bytes(&accept), 0o640);
    assert_eq!(fleet::load(&exposed), Err(FleetError::File(PrivateFileError::Exposed)));
    let linked = folder.0.join("linked.json");
    std::os::unix::fs::symlink(&fleet_path, &linked).unwrap();
    assert_eq!(fleet::load(&linked), Err(FleetError::File(PrivateFileError::Symlink)));
    assert_eq!(advert_file::load(&linked).unwrap_err(), advert_file::AdvertError::File(PrivateFileError::Symlink));
    assert_eq!(fleet::load(&folder.0), Err(FleetError::File(PrivateFileError::NotAFile)));
    assert_eq!(fleet::load(&folder.0.join("missing.json")), Err(FleetError::File(PrivateFileError::Unreadable)));
}

#[test]
fn dials_only_addresses_a_direct_carrier_may_have() {
    use std::net::IpAddr;
    for allowed in ["10.1.2.3", "172.16.0.1", "192.168.1.20", "169.254.3.4", "100.64.0.1", "100.127.255.254", "127.0.0.1"] {
        assert!(fleet::direct_address(allowed.parse::<IpAddr>().unwrap()), "{allowed}");
    }
    for refused in ["8.8.8.8", "100.128.0.1", "172.32.0.1", "::1", "fd00::1", "0.0.0.0", "224.0.0.1"] {
        assert!(!fleet::direct_address(refused.parse::<IpAddr>().unwrap()), "{refused}");
    }
}

#[test]
fn writes_status_with_state_then_path_and_reads_it_back() {
    let status = Status { state: "connected".into(), path: Some("direct".into()), error: None, peer: Some("0123456789abcdef0123456789abcdef".into()), machine_id: None, advert: Some("ok".into()), since: 7, next_relay_dial: Some(1_767_225_700) };
    let text = status.to_json();
    assert!(text.starts_with("{\"state\":\"connected\",\"path\":\"direct\","), "{text}");
    assert_eq!(Status::from_json(text.as_bytes()), Some(status));
}

/// The rows of a `<!-- contract:<marker> -->` table of docs/fleet-link.md.
fn table(marker: &str) -> Vec<Vec<String>> {
    let lines: Vec<&str> = CONTRACT.lines().collect();
    let at = lines.iter().position(|line| line.trim() == format!("<!-- contract:{marker} -->")).unwrap_or_else(|| panic!("no table {marker}"));
    lines[at + 1..].iter().take_while(|line| line.starts_with('|')).skip(2).map(|line| line.trim_matches('|').split('|').map(|cell| cell.trim().replace('`', "")).collect()).collect()
}

#[test]
fn exits_with_the_codes_the_document_lists() {
    let rows = table("exit-codes");
    let documented: Vec<(u8, String)> = rows.iter().map(|row| (row[0].parse().expect("a code"), row[1].clone())).collect();
    let listed: Vec<(u8, String)> = exit::TABLE.iter().map(|(code, commands)| (*code, (*commands).to_owned())).collect();
    assert_eq!(documented, listed);
    let mut codes: Vec<u8> = listed.iter().map(|(code, _)| *code).collect();
    codes.dedup();
    assert_eq!(codes.len(), listed.len(), "each code has one row");
}

#[test]
fn stays_stopped_after_a_refusal_whose_stop_mark_could_not_be_written() {
    use crate::status::{StopChange, StopGate};
    use std::io::{Error, ErrorKind};
    for (kind, why) in [(ErrorKind::PermissionDenied, "the state folder is not writable"), (ErrorKind::ReadOnlyFilesystem, "the state folder is not writable"), (ErrorKind::StorageFull, "no space left"), (ErrorKind::Other, "write failed")] {
        let mut gate = StopGate::at_start(false);
        gate.refused(Err(Error::from(kind)));
        assert!(gate.stopped());
        assert_eq!(gate.unrecorded(), Some(why));
        // no mark on disk, look after look: nothing lifts the stop
        for _ in 0..3_600 {
            assert_eq!(gate.look(false), None);
        }
        assert!(gate.stopped());
        // the folder takes writes again: the mark is written, and only its removal (rejoin) lifts the stop
        gate.recorded(Ok(()));
        assert_eq!(gate.unrecorded(), None);
        assert_eq!(gate.look(true), None);
        assert_eq!(gate.look(false), Some(StopChange::Resume));
        assert!(!gate.stopped());
    }
    // a mark written at the refusal: rejoin lifts it at the next look
    let mut gate = StopGate::at_start(false);
    gate.refused(Ok(()));
    assert_eq!(gate.look(true), None);
    assert_eq!(gate.look(false), Some(StopChange::Resume));
    // a mark found at start holds until it goes; one that appears stops a running agent
    let mut gate = StopGate::at_start(true);
    assert!(gate.stopped());
    assert_eq!(gate.look(false), Some(StopChange::Resume));
    assert_eq!(gate.look(true), Some(StopChange::Stop));
}

#[test]
fn saves_the_carriers_an_auth_ok_named_into_fleet_json_keeping_the_rest() {
    let folder = Folder::new("save-carriers");
    let accept = cases("FLEET_FILE").into_iter().find(|entry| entry["name"] == "files/fleet/accept").unwrap();
    let path = as_file(&folder, &accept);
    let running = fleet::load(&path).unwrap();
    let carriers = vec!["ws://172.17.0.1:7319".to_owned(), "ws://100.101.102.103:7319".to_owned()];
    let bytes = fleet::with_direct(&path, &running, &carriers).unwrap();
    let saved = fleet::parse(&bytes).unwrap();
    assert_eq!(saved.direct.iter().map(fleet::Fleet::direct_url).collect::<Vec<_>>(), vec!["ws://172.17.0.1:7319/v1/ws?v=1", "ws://100.101.102.103:7319/v1/ws?v=1"]);
    assert_eq!((saved.server_id.as_str(), saved.server_key, &saved.relay, &saved.machine_key_file), (running.server_id.as_str(), running.server_key, &running.relay, &running.machine_key_file));
    // another controller's fleet.json in its place since the agent started is left as it is
    let other = fleet::Fleet { server_id: "0".repeat(32), ..running.clone() };
    assert!(fleet::with_direct(&path, &other, &carriers).is_err());
    // nor one that pins another controller key under the same server_id
    let rekeyed = fleet::Fleet { server_key: [7u8; 32], ..running.clone() };
    assert!(fleet::with_direct(&path, &rekeyed, &carriers).is_err());
    // nothing the agent would refuse at its next start is ever written
    assert!(fleet::with_direct(&path, &running, &["ws://203.0.113.5:7319".to_owned()]).is_err());
    assert!(fleet::with_direct(&path, &running, &[]).is_err());
}

#[test]
fn keeps_the_newest_fleet_state_in_fleet_json_and_reads_it_back() {
    let folder = Folder::new("seen-state");
    let accept = cases("FLEET_FILE")
        .into_iter()
        .find(|entry| entry["name"] == "files/fleet/accept")
        .unwrap();
    let path = folder.write("fleet.json", &bytes(&accept), 0o600);
    let running = fleet::load(&path).unwrap();
    assert_eq!(running.seen_state, None);
    let state = crate::mux::SeenState {
        generation: 7,
        tag: [5; 32],
    };
    let written = fleet::with_seen_state(&path, &running, &state).unwrap();
    fs::write(&path, &written).unwrap();
    assert_eq!(fleet::load(&path).unwrap().seen_state, Some(state));
    // a seen_state that is not a generation and a 32-byte tag refuses the file
    let mut value: Value = serde_json::from_slice(&written).unwrap();
    value["seen_state"]["tag"] = Value::from("short");
    fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
    assert_eq!(fleet::load(&path).unwrap_err(), FleetError::SeenState);
}

#[test]
fn leave_deletes_the_machine_key_and_fleet_json_and_nothing_else() {
    let folder = Folder::new("leave");
    let accept = cases("FLEET_FILE")
        .into_iter()
        .find(|entry| entry["name"] == "files/fleet/accept")
        .unwrap();
    let key = folder.write("machine.key", &[7u8; 32], 0o600);
    let mut value: Value = serde_json::from_slice(&bytes(&accept)).unwrap();
    value["machine_key_file"] = Value::from(key.to_str().unwrap());
    folder.write("fleet.json", &serde_json::to_vec(&value).unwrap(), 0o600);
    let advert = folder.write("advert.json", b"{}", 0o600);
    assert_eq!(crate::daemon::leave(&folder.0), exit::OK);
    assert!(!key.exists() && !folder.0.join("fleet.json").exists());
    assert!(
        advert.exists(),
        "the bridge's own advert.json is not the link agent's to delete"
    );
    // leaving again finds nothing to delete and says so as success
    assert_eq!(crate::daemon::leave(&folder.0), exit::OK);
}

#[test]
fn saves_the_relay_pace_into_fleet_json_keeping_the_rest_and_reads_it_back() {
    let folder = Folder::new("save-pace");
    let accept = cases("FLEET_FILE").into_iter().find(|entry| entry["name"] == "files/fleet/accept").unwrap();
    let path = as_file(&folder, &accept);
    let running = fleet::load(&path).unwrap();
    let pace = crate::mux::RelayPace { generation: 3, per_minute: 96, burst: 22, slot: 41, span: 100, controller_ms: 1_767_225_600_000, rtt_ms: 18 };
    let bytes = fleet::with_pace(&path, &running, &pace).unwrap();
    let saved = fleet::parse(&bytes).unwrap();
    assert_eq!(saved.relay_pace, Some(pace));
    assert_eq!(fleet::Fleet { relay_pace: None, ..saved }, running);
    let other = fleet::Fleet { server_id: "0".repeat(32), ..running.clone() };
    assert!(fleet::with_pace(&path, &other, &pace).is_err());
    // a pace that does not read (a slot outside its span) is left out, never a reason to refuse the file
    let mut value: Value = serde_json::from_slice(&bytes).unwrap();
    value["relay_pace"]["slot"] = Value::from(100);
    let edited = fleet::parse(&serde_json::to_vec(&value).unwrap()).unwrap();
    assert_eq!(edited.relay_pace, None);
}

#[cfg(unix)]
#[test]
fn reads_a_controllers_retry_hint_and_nothing_else() {
    use crate::dial::{retry_hint, MAX_RETRY_AFTER_MS};
    assert_eq!(retry_hint(r#"{"type":"retry","retry_after_ms":2500}"#), Some(2_500));
    assert_eq!(retry_hint(r#"{"type":"retry","retry_after_ms":9999999}"#), Some(MAX_RETRY_AFTER_MS), "at most a minute");
    for other in [r#"{"type":"retry"}"#, r#"{"type":"retry","retry_after_ms":-1}"#, r#"{"type":"e2ee_ready","retry_after_ms":1}"#, "not json"] {
        assert_eq!(retry_hint(other), None, "{other}");
    }
}

#[test]
fn ovis_link_run_spreads_its_first_dial_only_while_fleet_json_holds_the_invite() {
    use crate::daemon::start_delay;
    use crate::supervisor::FIRST_DIAL_SPREAD_MS;
    let folder = Folder::new("start-delay");
    let accept = cases("FLEET_FILE").into_iter().find(|entry| entry["name"] == "files/fleet/accept").unwrap();
    let enrolled = fleet::load(&as_file(&folder, &accept)).unwrap();
    assert!(enrolled.invite.is_none());
    assert_eq!(start_delay(&enrolled, FIRST_DIAL_SPREAD_MS, 0.5), 0);
    let fresh = fleet::Fleet { invite: Some(fleet::FleetInvite { id: "0123456789abcdef".into(), secret: zeroize::Zeroizing::new([1u8; 32]) }), ..enrolled };
    assert_eq!(start_delay(&fresh, FIRST_DIAL_SPREAD_MS, 0.5), FIRST_DIAL_SPREAD_MS / 2);
    assert_eq!(start_delay(&fresh, 0, 0.5), 0);
}
