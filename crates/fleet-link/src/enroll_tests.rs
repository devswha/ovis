//! Enrolment on the machine's side (docs/fleet-link.md section 4) against
//! server/fleet/vectors/enroll.json, written by scripts/fleet-vectors.ts from the TypeScript code:
//! the invite key derived from the secret, ENROLL byte for byte as the accepted case has it, the
//! controller's ENROLL_OK read, and AUTH only after it, on the same session.

use serde_json::Value;
use zeroize::Zeroizing;

use crate::hex;
use crate::invite::{enroll_message, InviteKey};
use crate::machine_key::MachineKey;
use crate::mux::{self, Cause, Incoming, Outgoing, SessionError};
use crate::session::{End, Enrolment, Session, SessionConfig};

const ENROLL: &str = include_str!("../../../server/fleet/vectors/enroll.json");
const AUTH: &str = include_str!("../../../server/fleet/vectors/auth.json");
const SERVER_ID: &str = "0123456789abcdef0123456789abcdef";

fn file(text: &str) -> Value {
    serde_json::from_str(text).expect("a vector file parses")
}
fn case(text: &str, name: &str) -> Value {
    file(text)["cases"].as_array().expect("cases").iter().find(|entry| entry["name"] == name).cloned().unwrap_or_else(|| panic!("no case {name}"))
}
fn bytes(entry: &Value) -> Vec<u8> {
    hex::decode(entry["bytes"].as_str().expect("bytes")).expect("hex")
}
fn derivation(path: &[&str]) -> String {
    let mut value = file(ENROLL)["derivations"].clone();
    for key in path {
        value = value[*key].clone();
    }
    value.as_str().expect("a derivation").to_owned()
}
fn secret() -> [u8; 32] {
    crate::b64::decode_url(&derivation(&["invite", "secret"]), 32).expect("base64url").try_into().expect("32 bytes")
}
fn enrolling_key() -> MachineKey {
    MachineKey::from_scalar(&hex::decode(&derivation(&["machine_enrolling", "private_scalar_hex"])).unwrap()).expect("the enrolling machine's key")
}
fn binding(hex_text: &str) -> [u8; 32] {
    hex::decode(hex_text).unwrap().try_into().unwrap()
}

/// A session of the enrolling machine on the channel of the accepted case, holding the vector's invite.
fn enrolling() -> (Session, Vec<Outgoing>) {
    let accept = case(ENROLL, "enroll/accept");
    let signed = &accept["context"]["signed"];
    let enrolment = Enrolment {
        invite_id: derivation(&["invite", "invite_id"]),
        secret: Zeroizing::new(secret()),
        now: accept["expect"]["parse"]["now"].as_u64().unwrap(),
    };
    let config = SessionConfig { key: enrolling_key(), server_id: SERVER_ID.into(), advert: None, binary_ciphertext: true, enroll: Some(enrolment), seen_state: None };
    let session = Session::new(config, binding(signed["binding_hex"].as_str().unwrap()), 0);
    (session, Vec::new())
}
fn pump(session: &mut Session, sent: &mut Vec<Outgoing>, raw: &mut Vec<Vec<u8>>) {
    while let Some(frame) = session.poll_transmit(0) {
        sent.push(mux::read_outgoing(&frame, true).expect("the machine sends only frames its own reader takes"));
        raw.push(frame);
    }
}

#[test]
fn derives_the_invite_key_from_its_secret() {
    let key = InviteKey::derive(&secret(), &derivation(&["invite", "invite_id"]));
    assert_eq!(hex::encode(key.seed()), derivation(&["invite", "seed_hex"]));
    assert_eq!(hex::encode(&key.public_key()), derivation(&["invite", "public_key_hex"]));
    let accept = case(ENROLL, "enroll/accept");
    let signed = &accept["context"]["signed"];
    let message = enroll_message(&binding(signed["binding_hex"].as_str().unwrap()), &enrolling_key().spki(), &derivation(&["invite", "invite_id"]));
    assert_eq!(hex::encode(&message), derivation(&["enroll_message", "accept_hex"]));
}

#[test]
fn sends_enroll_before_auth_exactly_as_the_accepted_case() {
    let (mut session, mut sent) = enrolling();
    let mut raw = Vec::new();
    pump(&mut session, &mut sent, &mut raw);
    session.receive(&bytes(&case(AUTH, "auth/welcome/machine")), 0);
    pump(&mut session, &mut sent, &mut raw);
    // receipts (RECEIVED) aside, HELLO and then ENROLL, and nothing else until ENROLL_OK
    let frames: Vec<(&Outgoing, &Vec<u8>)> = sent.iter().zip(raw.iter()).filter(|(frame, _)| !matches!(frame, Outgoing::Received(_))).collect();
    assert!(matches!(frames.as_slice(), [(Outgoing::Hello, _), (Outgoing::Enroll(_), _)]), "{sent:?}");
    assert_eq!(hex::encode(frames[1].1), case(ENROLL, "enroll/accept")["bytes"].as_str().unwrap());
    assert!(!session.take_enrolled());
}

#[test]
fn signs_in_with_auth_on_the_same_session_once_enroll_ok_comes() {
    let (mut session, mut sent) = enrolling();
    let mut raw = Vec::new();
    session.receive(&bytes(&case(AUTH, "auth/welcome/machine")), 0);
    pump(&mut session, &mut sent, &mut raw);
    let ok = case(ENROLL, "enroll/enroll-ok/accept");
    assert_eq!(mux::read_incoming(&bytes(&ok)).expect("ENROLL_OK is read"), Incoming::EnrollOk { machine_id: enrolling_key().machine_id().to_owned() });
    session.receive(&bytes(&ok), 0);
    pump(&mut session, &mut sent, &mut raw);
    assert!(matches!(sent.last(), Some(Outgoing::Auth(auth)) if auth.machine_id == enrolling_key().machine_id()), "{sent:?}");
    assert!(session.take_enrolled(), "the secret can go");
    assert!(!session.take_enrolled(), "told once");
}

#[test]
fn refuses_an_enroll_ok_for_another_machine_or_one_it_did_not_ask_for() {
    let (mut session, mut sent) = enrolling();
    let mut raw = Vec::new();
    session.receive(&bytes(&case(AUTH, "auth/welcome/machine")), 0);
    pump(&mut session, &mut sent, &mut raw);
    let other = String::from_utf8(bytes(&case(ENROLL, "enroll/enroll-ok/accept"))[8..].to_vec()).unwrap().replace(enrolling_key().machine_id(), &"0".repeat(32));
    let mut frame = vec![1, 0x46, 0, 0, 0, 0, 0, 0];
    frame.extend_from_slice(other.as_bytes());
    session.receive(&frame, 0);
    pump(&mut session, &mut sent, &mut raw);
    assert_eq!(session.end(), Some(End::Local { code: SessionError::ProtocolError }));

    // a machine with no invite sent no ENROLL: an ENROLL_OK is a protocol error
    let config = SessionConfig { key: enrolling_key(), server_id: SERVER_ID.into(), advert: None, binary_ciphertext: true, enroll: None, seen_state: None };
    let mut plain = Session::new(config, [7; 32], 0);
    plain.receive(&bytes(&case(AUTH, "auth/welcome/machine")), 0);
    plain.receive(&bytes(&case(ENROLL, "enroll/enroll-ok/accept")), 0);
    let mut ignored = (Vec::new(), Vec::new());
    pump(&mut plain, &mut ignored.0, &mut ignored.1);
    assert_eq!(plain.end(), Some(End::Local { code: SessionError::ProtocolError }));
}

#[test]
fn reads_why_an_enrolment_was_refused() {
    for (cause, code) in [(Cause::Signature, SessionError::AuthFailed), (Cause::Unknown, SessionError::AuthFailed), (Cause::Expired, SessionError::AuthFailed), (Cause::RateLimited, SessionError::AuthFailed), (Cause::FleetTokenRequired, SessionError::AuthFailed), (Cause::Quarantined, SessionError::AuthRevoked)] {
        let (mut session, mut sent) = enrolling();
        let mut raw = Vec::new();
        session.receive(&bytes(&case(AUTH, "auth/welcome/machine")), 0);
        pump(&mut session, &mut sent, &mut raw);
        let text = format!("{{\"code\":\"{}\",\"message\":\"{}\"}}", code.as_str(), cause.as_str());
        let mut frame = vec![1, 0x05, 0, 0, 0, 0, 0, 0];
        frame.extend_from_slice(text.as_bytes());
        session.receive(&frame, 0);
        assert_eq!(session.end(), Some(End::Peer { code, cause: Some(cause) }));
        assert!(!session.take_enrolled());
    }
}

#[test]
fn writes_enroll_only_as_the_vectors_take_it() {
    for entry in file(ENROLL)["cases"].as_array().unwrap().iter().filter(|entry| entry["frame"] == "ENROLL" && entry["direction"] == "machine_to_controller") {
        let read = mux::read_outgoing(&bytes(entry), true);
        if entry["expect"]["refuse"]["stage"] == "decode" {
            assert!(read.is_err(), "{}", entry["name"]);
        } else {
            assert!(matches!(read, Ok(Outgoing::Enroll(_))), "{}", entry["name"]);
        }
    }
    // a controller never sends ENROLL, and a machine never sends ENROLL_OK
    assert!(mux::read_incoming(&bytes(&case(ENROLL, "enroll/to-machine"))).is_err());
    assert!(mux::read_outgoing(&bytes(&case(ENROLL, "enroll/enroll-ok/from-machine")), true).is_err());
}
