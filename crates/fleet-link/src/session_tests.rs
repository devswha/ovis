//! The machine side of docs/fleet-link.md against the TypeScript side's bytes: every case of
//! server/fleet/vectors/{auth,pipe-frames,enroll,pace}.json (written by scripts/fleet-vectors.ts
//! from the TypeScript code) goes through this crate's reader, encoder and session, and the rows
//! of the document's tables that bind the machine are read from the document itself.

use serde_json::{json, Map, Value};

use crate::b64;
use crate::carrier::{self, CarrierError, Message};
use crate::hex;
use crate::machine_key::{auth_message, KeyError, MachineKey};
use crate::mux::{self, Advert, Endpoint, Health, Incoming, Outgoing, PipeReset, SessionError, UpDown, Versions};
use crate::session::{Action, End, Millis, Session, SessionConfig, SLOW_CONSUMER_MS};
use crate::target::{runtime_socket, Targets};

const AUTH: &str = include_str!("../../../server/fleet/vectors/auth.json");
const PIPES: &str = include_str!("../../../server/fleet/vectors/pipe-frames.json");
const ENROLL: &str = include_str!("../../../server/fleet/vectors/enroll.json");
const PACE: &str = include_str!("../../../server/fleet/vectors/pace.json");
const CONTRACT: &str = include_str!("../../../docs/fleet-link.md");
const SERVER_ID: &str = "0123456789abcdef0123456789abcdef";
const BINDING: [u8; 32] = [7; 32];
const BRIDGE_TOKEN: &str = "abababababababababababababababababababababababababababababababab";
const NATIVE_BEARER: &str = "ovb_test-only-bearer";

fn parse(text: &str) -> Value {
    serde_json::from_str(text).expect("a vector file parses")
}
fn cases() -> Vec<Value> {
    [AUTH, PIPES, ENROLL, PACE].iter().flat_map(|text| parse(text)["cases"].as_array().expect("cases").clone()).collect()
}
fn case(name: &str) -> Value {
    cases().into_iter().find(|entry| entry["name"] == name).unwrap_or_else(|| panic!("no case {name}"))
}
fn name(entry: &Value) -> &str {
    entry["name"].as_str().expect("a name")
}
fn bytes(entry: &Value) -> Vec<u8> {
    hex::decode(entry["bytes"].as_str().expect("bytes")).expect("hex")
}
fn from_controller(entry: &Value) -> bool {
    entry["direction"] == "controller_to_machine"
}
fn refusal(entry: &Value) -> Option<&Value> {
    entry["expect"].get("refuse")
}
fn machine_a() -> MachineKey {
    let derivations = &parse(AUTH)["derivations"]["machine_a"];
    MachineKey::from_scalar(&hex::decode(derivations["private_scalar_hex"].as_str().unwrap()).unwrap()).expect("machine a")
}

/// The rows of a `<!-- contract:<marker> -->` table, as scripts/fleet-contract-check.ts reads them.
fn table(marker: &str) -> Vec<Vec<String>> {
    let lines: Vec<&str> = CONTRACT.lines().collect();
    let at = lines.iter().position(|line| line.trim() == format!("<!-- contract:{marker} -->")).unwrap_or_else(|| panic!("no table {marker}"));
    let mut rows = Vec::new();
    for line in &lines[at + 1..] {
        if !line.starts_with('|') {
            if rows.is_empty() {
                continue;
            }
            break;
        }
        let inner = line.trim_end().trim_start_matches('|').trim_end_matches('|');
        rows.push(inner.replace("\\|", "\u{1}").split('|').map(|cell| cell.trim().replace('\u{1}', "|").replace('`', "")).collect());
    }
    rows.split_off(2)
}

fn counter(field: &str, value: u64) -> Value {
    let mut map = Map::new();
    map.insert(field.to_owned(), Value::String(value.to_string()));
    Value::Object(map)
}
fn advert_json(advert: &Advert) -> Value {
    let mut value = json!({
        "endpoints": advert.endpoints.iter().map(|endpoint| endpoint.as_str()).collect::<Vec<_>>(),
        "runtime_id": advert.runtime_id, "boot_id": advert.boot_id,
        "health": { "runtime": advert.health.runtime.as_str(), "bridge": advert.health.bridge.as_str() },
        "now": advert.now,
        "versions": { "server": advert.versions.server, "link": advert.versions.link, "agent": advert.versions.agent, "runtime": advert.versions.runtime },
    });
    if let Some(token) = &advert.bridge_token {
        value["bridge_token"] = json!(token.as_str());
    }
    if let Some(bearer) = &advert.native_bearer {
        value["native_bearer"] = json!(bearer.as_str());
    }
    value
}
/// A frame the reader read, as the vectors write its `parse`.
fn incoming_json(frame: &Incoming) -> Value {
    match frame {
        Incoming::Welcome(welcome) => {
            let mut value = json!({
                "protocol": "ovis-mux", "version": 1, "features": welcome.features,
                "limits": {
                    "max_streams": welcome.limits.max_streams, "max_ws_streams": welcome.limits.max_ws_streams, "max_sse_streams": welcome.limits.max_sse_streams,
                    "max_frame_bytes": 16384, "http_window_bytes": 327680, "ws_window_bytes": 1048576, "max_ws_message_bytes": 1048576,
                    "max_request_body_bytes": 67108864, "max_pipe_streams": welcome.limits.max_pipe_streams,
                },
                "nonce": b64::encode_url(&welcome.nonce), "server_version": welcome.server_version,
                "relay_protocol": welcome.relay_protocol, "min_supported_client": welcome.min_supported_client,
            });
            if welcome.provisional {
                value["provisional"] = json!(true);
            }
            value
        }
        Incoming::AuthOk(ok) => {
            let mut value = json!({ "session_id": ok.session_id, "machine_id": ok.machine_id, "role": "machine" });
            if let Some(pace) = &ok.relay_pace {
                value["relay_pace"] = json!({ "generation": pace.generation, "per_minute": pace.per_minute, "burst": pace.burst, "slot": pace.slot, "span": pace.span, "controller_ms": pace.controller_ms, "rtt_ms": pace.rtt_ms });
            }
            if let Some(direct) = &ok.direct {
                value["direct"] = json!(direct);
            }
            if ok.pending {
                value["pending"] = json!(true);
            }
            value
        }
        Incoming::SessionError { code, message } => json!({ "code": code.as_str(), "message": message }),
        Incoming::GoAway(goaway) => {
            let mut value = json!({ "code": goaway.code.as_str(), "last_open_id": goaway.last_open_id, "drain_ms": goaway.drain_ms });
            if let Some(reason) = &goaway.reason {
                value["reason"] = json!(reason);
            }
            value
        }
        Incoming::Ping(probe) | Incoming::Pong(probe) => counter("probe", *probe),
        Incoming::Received(frames) => counter("frames", *frames),
        Incoming::Credit { consumed, .. } => counter("consumed", *consumed),
        Incoming::Reset { code, .. } => json!({ "code": code.as_str(), "message": "" }),
        Incoming::PipeOpen { endpoint, .. } => json!({ "endpoint": endpoint }),
        Incoming::PipeData { data, .. } => json!({ "data": hex::encode(data) }),
        Incoming::PipeEnd { .. } => json!({}),
        Incoming::EnrollOk { machine_id } => json!({ "machine_id": machine_id }),
        Incoming::FleetState(state) => json!({ "generation": state.generation, "tag": b64::encode_url(&state.tag) }),
        Incoming::Pace(pace) => json!({ "generation": pace.generation, "per_minute": pace.per_minute, "burst": pace.burst, "slot": pace.slot, "span": pace.span, "controller_ms": pace.controller_ms, "rtt_ms": pace.rtt_ms }),
    }
}
/// A frame the machine-side reader read, as the vectors write its `parse`.
fn outgoing_json(frame: &Outgoing) -> Value {
    match frame {
        Outgoing::Hello => json!({ "protocol": "ovis-mux", "versions": [1], "features": ["pipe-stream"], "required_features": ["pipe-stream"] }),
        Outgoing::Enroll(enroll) => json!({ "invite_id": enroll.invite_id, "machine_public_key": b64::encode_url(&enroll.machine_public_key), "signature": b64::encode_url(&enroll.signature), "now": enroll.now }),
        Outgoing::Auth(auth) => {
            let mut value = json!({ "scheme": "machine-key", "machine_id": auth.machine_id, "signature": b64::encode_url(&auth.signature) });
            if !auth.features.is_empty() {
                value["features"] = json!(auth.features);
            }
            if let Some(seen) = &auth.seen_state {
                value["seen_state"] = json!({ "generation": seen.generation, "tag": b64::encode_url(&seen.tag) });
            }
            value
        }
        Outgoing::SessionError { code, message } => json!({ "code": code.as_str(), "message": message }),
        Outgoing::GoAway(goaway) => json!({ "code": goaway.code.as_str(), "last_open_id": goaway.last_open_id, "drain_ms": goaway.drain_ms }),
        Outgoing::Ping(probe) | Outgoing::Pong(probe) => counter("probe", *probe),
        Outgoing::Received(frames) => counter("frames", *frames),
        Outgoing::Credit { consumed, .. } => counter("consumed", *consumed),
        Outgoing::Reset { code, .. } => json!({ "code": code.as_str(), "message": "" }),
        Outgoing::PipeAccept { .. } | Outgoing::PipeEnd { .. } => json!({}),
        Outgoing::PipeData { data, .. } => json!({ "data": hex::encode(data) }),
        Outgoing::PipeAdvert(advert) => advert_json(advert),
    }
}

fn frame(kind: u8, id: u32, payload: &[u8]) -> Vec<u8> {
    let mut out = vec![1, kind, 0, 0];
    out.extend_from_slice(&id.to_be_bytes());
    out.extend_from_slice(payload);
    out
}
fn pipe_open(id: u32, endpoint: &str) -> Vec<u8> {
    frame(0x40, id, format!("{{\"endpoint\":{}}}", serde_json::to_string(endpoint).unwrap()).as_bytes())
}

fn advert(endpoints: &[Endpoint]) -> Advert {
    let has = |endpoint| endpoints.contains(&endpoint);
    Advert {
        endpoints: endpoints.to_vec(),
        runtime_id: "rt-test".into(),
        boot_id: "boot-test".into(),
        bridge_token: has(Endpoint::Bridge).then(|| zeroize::Zeroizing::new(BRIDGE_TOKEN.to_owned())),
        native_bearer: has(Endpoint::Native).then(|| zeroize::Zeroizing::new(NATIVE_BEARER.to_owned())),
        health: Health { runtime: UpDown::Up, bridge: UpDown::Up },
        now: 1_767_225_600,
        versions: Versions { server: "0.5.0".into(), link: "0.1.0".into(), agent: "0.5.0".into(), runtime: "0.9.1".into() },
    }
}

/// A machine session driven by hand: what it sent (read back by the machine-side reader) and what
/// it asked of its targets.
struct Machine {
    session: Session,
    now: Millis,
    sent: Vec<Outgoing>,
    actions: Vec<Action>,
}

impl Machine {
    fn new(endpoints: &[Endpoint]) -> Self {
        let config = SessionConfig { key: machine_a(), server_id: SERVER_ID.into(), advert: Some(advert(endpoints)), binary_ciphertext: true, enroll: None, seen_state: None };
        let mut machine = Machine { session: Session::new(config, BINDING, 0), now: 0, sent: Vec::new(), actions: Vec::new() };
        machine.pump();
        machine
    }
    fn pump(&mut self) {
        while let Some(bytes) = self.session.poll_transmit(self.now) {
            self.sent.push(mux::read_outgoing(&bytes, true).expect("the machine sends only frames its own reader takes"));
        }
        while let Some(action) = self.session.poll_action() {
            self.actions.push(action);
        }
    }
    fn feed(&mut self, bytes: &[u8]) {
        self.session.receive(bytes, self.now);
        self.pump();
    }
    fn sign_in(&mut self) {
        self.feed(&bytes(&case("auth/welcome/machine")));
        self.feed(&bytes(&case("auth/auth-ok/machine")));
        assert!(self.session.signed_in());
    }
    fn open(&mut self, id: u32, endpoint: &str) {
        self.feed(&pipe_open(id, endpoint));
    }
    fn connect(&mut self, id: u32) {
        assert!(self.session.target_connected(id), "pipe {id} is waiting for its target");
        self.pump();
    }
    fn advance(&mut self, ms: Millis) {
        self.now += ms;
        self.pump();
    }
    fn ended(&self) -> Option<End> {
        self.session.end()
    }
    fn connects(&self) -> Vec<u32> {
        self.actions.iter().filter_map(|action| if let Action::Connect { id, .. } = action { Some(*id) } else { None }).collect()
    }
    fn resets(&self) -> Vec<(u32, PipeReset)> {
        self.sent.iter().filter_map(|frame| if let Outgoing::Reset { id, code } = frame { Some((*id, *code)) } else { None }).collect()
    }
}

/// A machine brought to the state a vector case's context describes, as server/fleet/pipe-vectors.test.ts does.
fn machine_for(entry: &Value) -> Machine {
    let context = &entry["context"];
    let endpoints: Vec<Endpoint> = match context["advert"].as_array() {
        Some(list) => list.iter().map(|endpoint| Endpoint::parse(endpoint.as_str().unwrap()).unwrap()).collect(),
        None => vec![Endpoint::Bridge, Endpoint::Native],
    };
    let mut machine = Machine::new(&endpoints);
    if context["state"] == "after_auth" {
        machine.sign_in();
    } else if entry["frame"] == "AUTH_OK" {
        // AUTH_OK answers an AUTH: the machine has sent one (one before it is a protocol error)
        machine.feed(&bytes(&case("auth/welcome/machine")));
    }
    let stream = entry["stream_id"].as_u64().unwrap_or(0) as u32;
    let last = context["last_pipe_id"].as_u64().map_or(if entry["frame"] == "PIPE_OPEN" { 0 } else { stream }, |last| last as u32);
    if last == 0x7fff_fffe {
        machine.session.set_last_open_id_for_test(last);
    } else {
        for id in (2..=last).step_by(2) {
            machine.open(id, "bridge");
            if context["accepted"] != false {
                machine.connect(id);
            }
        }
    }
    if context["ended_by_sender"] == true {
        machine.feed(&frame(0x43, stream, &[]));
    }
    let mut left = context["received"].as_u64().unwrap_or(0) as usize;
    while left > 0 {
        let chunk = left.min(mux::PIPE_DATA_BYTES);
        machine.feed(&frame(0x42, stream, &vec![0; chunk]));
        left -= chunk;
    }
    machine
}

/// What a machine must do with a frame its controller sends, checked once the frame is in.
fn check_effect(entry: &Value, machine: &mut Machine) {
    let parsed = &entry["expect"]["parse"];
    let stream = entry["stream_id"].as_u64().unwrap() as u32;
    let label = name(entry);
    match entry["frame"].as_str().unwrap() {
        "WELCOME" => {
            let Some(Outgoing::Auth(auth)) = machine.sent.last() else { panic!("{label}: no AUTH after WELCOME") };
            let nonce: [u8; 32] = b64::decode_url(parsed["nonce"].as_str().unwrap(), 32).unwrap().try_into().unwrap();
            let key = p256::ecdsa::VerifyingKey::from_sec1_bytes(&machine_a().spki()[26..]).unwrap();
            let signature = p256::ecdsa::Signature::from_slice(&auth.signature).unwrap();
            use p256::ecdsa::signature::Verifier;
            key.verify(&auth_message(&nonce, SERVER_ID, &BINDING), &signature).unwrap_or_else(|_| panic!("{label}: AUTH does not verify"));
            assert_eq!(auth.machine_id, machine_a().machine_id(), "{label}");
            assert_eq!(auth.features, [mux::PACE_FEATURE, mux::FLEET_STATE_FEATURE], "{label}: this agent reads PACE and FLEET_STATE frames");
        }
        "FLEET_STATE" => {
            // kept (the agent saves it in fleet.json), and presented as it came in the next AUTH (todo 31)
            let kept = machine.session.take_fleet_state().unwrap_or_else(|| panic!("{label}: FLEET_STATE was not kept"));
            assert_eq!(json!({ "generation": kept.generation, "tag": b64::encode_url(&kept.tag) }), *parsed, "{label}");
            let older = mux::SeenState { generation: kept.generation - 1, tag: [9; 32] };
            machine.feed(&frame(0x48, 0, format!("{{\"generation\":{},\"tag\":\"{}\"}}", older.generation, b64::encode_url(&older.tag)).as_bytes()));
            assert!(machine.session.take_fleet_state().is_none(), "{label}: an older FLEET_STATE is not kept");
            let config = SessionConfig { key: machine_a(), server_id: SERVER_ID.into(), advert: None, binary_ciphertext: true, enroll: None, seen_state: Some(kept.clone()) };
            let mut next = Machine { session: Session::new(config, BINDING, 0), now: 0, sent: Vec::new(), actions: Vec::new() };
            next.pump();
            next.feed(&bytes(&case("auth/welcome/machine")));
            let Some(Outgoing::Auth(auth)) = next.sent.last() else { panic!("{label}: no AUTH") };
            assert_eq!(auth.seen_state.as_ref(), Some(&kept), "{label}: the next AUTH presents it");
        }
        "AUTH_OK" => {
            assert!(machine.session.signed_in(), "{label}");
            assert!(matches!(machine.sent.last(), Some(Outgoing::PipeAdvert(_))), "{label}: PIPE_ADVERT follows AUTH_OK");
        }
        "SESSION_ERROR" => {
            let code = SessionError::parse(parsed["code"].as_str().unwrap()).unwrap();
            let cause = mux::Cause::parse(parsed["message"].as_str().unwrap());
            assert_eq!(machine.ended(), Some(End::Peer { code, cause }), "{label}");
        }
        "PIPE_OPEN" => {
            assert_eq!(machine.connects().last(), Some(&stream), "{label}: connects its configured target");
            machine.connect(stream);
            assert_eq!(machine.sent.last(), Some(&Outgoing::PipeAccept { id: stream }), "{label}");
        }
        "PIPE_DATA" => {
            let data = hex::decode(parsed["data"].as_str().unwrap()).unwrap();
            assert_eq!(machine.actions.last(), Some(&Action::Write { id: stream, data }), "{label}");
        }
        "PIPE_END" => assert_eq!(machine.actions.last(), Some(&Action::ShutdownWrite { id: stream }), "{label}"),
        "RESET" => {
            assert_eq!(machine.actions.last(), Some(&Action::Close { id: stream }), "{label}: the target is closed");
            assert_eq!(machine.session.open_pipes(), 0, "{label}");
            assert!(machine.resets().is_empty(), "{label}: a RESET is not answered");
        }
        "GOAWAY" => {
            machine.advance(parsed["drain_ms"].as_u64().unwrap());
            // only the owner's confirmation names reason `confirmed`; any other GOAWAY, an unknown reason included, drains
            let confirmed = parsed["reason"].as_str() == Some(mux::GOAWAY_CONFIRMED);
            assert_eq!(machine.ended(), Some(if confirmed { End::Confirmed } else { End::Drained }), "{label}");
        }
        "PING" => assert_eq!(machine.sent.last(), Some(&Outgoing::Pong(parsed["probe"].as_str().unwrap().parse().unwrap())), "{label}"),
        "PACE" => {
            // the machine keeps the fields and the moment of receipt on its own clock: offset = controller_ms - that moment
            let (pace, received) = machine.session.take_pace().unwrap_or_else(|| panic!("{label}: the pace is kept"));
            assert_eq!(incoming_json(&Incoming::Pace(pace)), *parsed, "{label}");
            assert_eq!(received, machine.now, "{label}");
            assert_eq!(machine.ended(), None, "{label}");
        }
        "RECEIVED" => {
            let (submitted, _, ordinary, control) = machine.session.stats();
            assert_eq!(submitted.to_string(), parsed["frames"].as_str().unwrap(), "{label}");
            assert_eq!((ordinary, control), (0, 0), "{label}: the receipt budget is free again");
        }
        other => panic!("{label}: no effect checked for {other}"),
    }
}

/// Accepted controller frames whose reader is a later todo's: refused until then, as the
/// TypeScript extension refuses them (docs/fleet-link.md, "Frame types").
const LATER_READERS: [(&str, &str); 0] = [];

#[test]
fn takes_every_frame_a_controller_sends_as_the_vectors_say() {
    let mut checked = 0;
    for entry in cases().iter().filter(|entry| from_controller(entry)) {
        let label = name(entry);
        let selected = entry["context"]["selected"].as_array().unwrap().iter().any(|feature| feature == "pipe-stream");
        if !selected && entry["frame"] != "WELCOME" {
            // a session without `pipe-stream`: a machine requires it, so it never has one
            assert_eq!(label, "pipe/open/without-pipe-stream");
            continue;
        }
        let read = mux::read_incoming(&bytes(entry));
        if let Some((_, todo)) = LATER_READERS.iter().find(|(later, _)| *later == label) {
            assert_eq!(read.map(|_| ()).map_err(|refusal| refusal.code), Err(SessionError::ProtocolError), "{label}: read by {todo}");
            continue;
        }
        let refuse = refusal(entry);
        match refuse {
            Some(refuse) if refuse["stage"] == "decode" => {
                let code = read.expect_err(label).code;
                assert_eq!(code.as_str(), refuse["code"], "{label}");
            }
            Some(_) => {}
            None => assert_eq!(incoming_json(&read.unwrap_or_else(|refusal| panic!("{label}: {refusal:?}"))), entry["expect"]["parse"], "{label}"),
        }
        if entry["frame"] == "ENROLL_OK" {
            // what ENROLL_OK does is checked on a machine holding an invite (src/enroll_tests.rs)
            checked += 1;
            continue;
        }
        let mut machine = machine_for(entry);
        let before = machine.connects().len();
        machine.feed(&bytes(entry));
        match refuse {
            Some(refuse) if refuse["kind"] == "reset" => {
                let stream = entry["stream_id"].as_u64().unwrap() as u32;
                assert_eq!(machine.resets(), vec![(stream, PipeReset::Refused)], "{label}");
                assert_eq!(machine.connects().len(), before, "{label}: no target is reached");
                assert_eq!(machine.ended(), None, "{label}");
            }
            Some(refuse) => {
                let code = SessionError::parse(refuse["code"].as_str().unwrap()).unwrap();
                assert_eq!(machine.ended(), Some(End::Local { code }), "{label}");
                assert!(matches!(machine.sent.last(), Some(Outgoing::SessionError { code: sent, .. }) if *sent == code), "{label}: SESSION_ERROR {code} is the last frame");
            }
            None => check_effect(entry, &mut machine),
        }
        checked += 1;
    }
    assert!(checked >= 40, "only {checked} controller cases");
}

/// Frames a machine sends, by the frames table; the agent's reader takes no other type.
const MACHINE_FRAMES: [&str; 14] = ["HELLO", "ENROLL", "AUTH", "SESSION_ERROR", "GOAWAY", "PING", "PONG", "RECEIVED", "CREDIT", "RESET", "PIPE_ACCEPT", "PIPE_DATA", "PIPE_END", "PIPE_ADVERT"];

#[test]
fn writes_every_frame_a_machine_sends_byte_for_byte() {
    let mut encoded = 0;
    for entry in cases().iter().filter(|entry| !from_controller(entry) && entry["direction"] != "file") {
        let label = name(entry);
        let pipe_stream = entry["context"]["selected"].as_array().unwrap().iter().any(|feature| feature == "pipe-stream");
        let read = mux::read_outgoing(&bytes(entry), pipe_stream);
        if !MACHINE_FRAMES.contains(&entry["frame"].as_str().unwrap()) {
            assert!(read.is_err(), "{label}: the agent can never send a {} frame", entry["frame"]);
            continue;
        }
        match refusal(entry) {
            None => {
                let frame = read.unwrap_or_else(|refusal| panic!("{label}: {refusal:?}"));
                assert_eq!(outgoing_json(&frame), entry["expect"]["parse"], "{label}");
                if entry["canonical"] != false {
                    assert_eq!(hex::encode(&frame.encode().expect(label)), entry["bytes"].as_str().unwrap(), "{label}");
                    encoded += 1;
                }
            }
            Some(refuse) if refuse["stage"] == "decode" => assert_eq!(read.map(|_| ()).map_err(|refusal| refusal.code.as_str()), Err(refuse["code"].as_str().unwrap()), "{label}"),
            // the controller's own checks (a signature, its store, its session state): the agent
            // signs as the next test shows and keeps to the session order of `sends_in_session_order`
            Some(_) => {}
        }
    }
    assert!(encoded >= 15, "only {encoded} frames encoded");
}

#[test]
fn signs_auth_as_the_vectors_do() {
    let accept = case("auth/machine-key/accept");
    let context = &accept["context"];
    let nonce: [u8; 32] = b64::decode_url(context["nonce"].as_str().unwrap(), 32).unwrap().try_into().unwrap();
    let binding: [u8; 32] = hex::decode(context["binding_hex"].as_str().unwrap()).unwrap().try_into().unwrap();
    let server_id = context["server_id"].as_str().unwrap();
    let key = machine_a();
    let derivations = &parse(AUTH)["derivations"];
    assert_eq!(hex::encode(&auth_message(&nonce, server_id, &binding)), derivations["auth_message"]["accept_hex"].as_str().unwrap());
    assert_eq!(b64::encode_url(&key.spki()), derivations["machine_a"]["spki"].as_str().unwrap());
    assert_eq!(key.machine_id(), derivations["machine_a"]["machine_id"].as_str().unwrap());
    // RFC 6979 on both sides, low s on both: the very bytes of the vector
    let auth = Outgoing::Auth(mux::Auth { machine_id: key.machine_id().into(), signature: key.sign_auth(&nonce, server_id, &binding), features: Vec::new(), seen_state: None });
    assert_eq!(hex::encode(&auth.encode().unwrap()), accept["bytes"].as_str().unwrap());
}

#[test]
fn offers_and_requires_pipe_stream_and_nothing_else() {
    assert_eq!(hex::encode(&Outgoing::Hello.encode().unwrap()), case("auth/hello/machine")["bytes"].as_str().unwrap());
    for refused in ["auth/hello/machine-and-device-feature", "auth/hello/offered-not-required"] {
        assert!(mux::read_outgoing(&bytes(&case(refused)), true).is_err(), "{refused}: a HELLO the agent cannot send");
    }
}

#[test]
fn sends_in_session_order_and_never_a_frame_section_3_refuses() {
    let mut machine = Machine::new(&[Endpoint::Bridge, Endpoint::Native]);
    assert_eq!(machine.sent, vec![Outgoing::Hello]);
    machine.feed(&bytes(&case("auth/welcome/machine")));
    let before_auth_ok = machine.sent.len();
    // after AUTH nothing but receipts goes out until AUTH_OK (section 1.5)
    assert!(machine.sent[1..].iter().all(|frame| matches!(frame, Outgoing::Auth(_) | Outgoing::Received(_))), "{:?}", machine.sent);
    assert!(!machine.sent.iter().any(|frame| matches!(frame, Outgoing::PipeAdvert(_))), "no PIPE_ADVERT before AUTH_OK");
    machine.feed(&bytes(&case("auth/auth-ok/machine")));
    machine.open(2, "bridge");
    machine.connect(2);
    machine.session.target_data(2, b"hello".to_vec());
    machine.session.target_eof(2);
    machine.feed(&frame(0x07, 0, &9u64.to_be_bytes()));
    let after: Vec<&Outgoing> = machine.sent[before_auth_ok..].iter().filter(|frame| !matches!(frame, Outgoing::Received(_))).collect();
    assert!(matches!(after[0], Outgoing::PipeAdvert(_)), "PIPE_ADVERT is the first frame after AUTH_OK: {after:?}");
    assert!(!after.iter().any(|frame| matches!(frame, Outgoing::Hello | Outgoing::Auth(_))), "no HELLO or AUTH after AUTH_OK: {after:?}");
    for expected in [Outgoing::PipeAccept { id: 2 }, Outgoing::PipeData { id: 2, data: b"hello".to_vec() }, Outgoing::PipeEnd { id: 2 }, Outgoing::Pong(9)] {
        assert!(after.contains(&&expected), "{expected:?} in {after:?}");
    }
    // an AUTH_OK before the machine's AUTH answers nothing it asked
    let mut early = Machine::new(&[Endpoint::Bridge]);
    early.feed(&bytes(&case("auth/auth-ok/machine")));
    assert_eq!(early.ended(), Some(End::Local { code: SessionError::ProtocolError }));
}

#[test]
fn holds_the_controller_to_every_row_of_section_3() {
    let rows = table("never-from-controller");
    assert!(rows.len() >= 9);
    let mut failures = Vec::new();
    for row in &rows {
        let (frame, when, answer) = (&row[0], &row[1], &row[2]);
        let code = answer.strip_prefix("SESSION_ERROR ").and_then(SessionError::parse).unwrap_or_else(|| panic!("row {frame}: {answer}"));
        let matching: Vec<Value> = cases()
            .into_iter()
            .filter(|entry| from_controller(entry) && entry["frame"] == frame.as_str() && (when == "any" || entry["context"]["state"] == when.as_str()))
            .filter(|entry| refusal(entry).is_some_and(|refuse| refuse["code"] == code.as_str()))
            .collect();
        if matching.is_empty() {
            failures.push(format!("{frame} ({when}): no vector"));
        }
        for entry in matching {
            let mut machine = machine_for(&entry);
            machine.feed(&bytes(&entry));
            if machine.ended() != Some(End::Local { code }) || !matches!(machine.sent.last(), Some(Outgoing::SessionError { code: sent, .. }) if *sent == code) {
                failures.push(format!("{frame} ({when}) {}: ended {:?}", name(&entry), machine.ended()));
            }
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

#[test]
fn never_sends_what_section_3_refuses_from_a_machine() {
    let mut failures = Vec::new();
    for row in table("never-from-machine") {
        let (frame, when) = (&row[0], &row[1]);
        let matching: Vec<Value> = cases().into_iter().filter(|entry| !from_controller(entry) && entry["frame"] == frame.as_str()).collect();
        if matching.is_empty() {
            failures.push(format!("{frame}: no vector"));
        }
        for entry in matching {
            let readable = mux::read_outgoing(&bytes(&entry), true).is_ok();
            // a frame the agent can write at all is refused only in a state it never sends it in
            let by_state = matches!((frame.as_str(), when.as_str()), ("PIPE_ADVERT", "before_auth") | ("AUTH", "after_auth") | ("HELLO", "after_auth") | ("ENROLL", "after_auth"));
            if readable && !by_state {
                failures.push(format!("{frame} ({when}) {}: the agent could send it", name(&entry)));
            }
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

#[test]
fn answers_every_limit_of_the_contract() {
    let mut failures = Vec::new();
    for row in table("limits") {
        let (limit, answer) = (&row[0], &row[3]);
        for entry in cases().into_iter().filter(|entry| entry["limit"] == limit.as_str()) {
            let label = name(&entry).to_owned();
            if from_controller(&entry) {
                let mut machine = machine_for(&entry);
                machine.feed(&bytes(&entry));
                let outcome = match (machine.ended(), machine.resets().last()) {
                    (Some(End::Local { code }), _) => format!("SESSION_ERROR {code}"),
                    (None, Some((_, code))) => format!("RESET {code}"),
                    other => format!("{other:?}"),
                };
                if &outcome != answer {
                    failures.push(format!("{limit} {label}: {outcome}, the document says {answer}"));
                }
            } else if limit == "enroll_tries_per_invite" {
                // counted by the controller over sessions: each try is a frame the agent may send (src/enroll_tests.rs)
            } else if mux::read_outgoing(&bytes(&entry), true).is_ok() {
                failures.push(format!("{limit} {label}: the agent could send it"));
            }
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

#[test]
fn sends_and_takes_every_pipe_reset_code() {
    let rows = table("reset-codes");
    assert_eq!(rows.len(), PipeReset::ALL.len());
    for row in rows {
        let code = PipeReset::parse(&row[0]).unwrap_or_else(|| panic!("code {}", row[0]));
        let vector = case(&format!("pipe/reset/{}", row[0].replace('_', "-")));
        if row[1] == "machine" || row[1] == "either" {
            assert_eq!(hex::encode(&Outgoing::Reset { id: 2, code }.encode().unwrap()), vector["bytes"].as_str().unwrap(), "{}", row[0]);
        }
        let mut machine = Machine::new(&[Endpoint::Bridge]);
        machine.sign_in();
        machine.open(2, "bridge");
        machine.connect(2);
        machine.feed(&bytes(&vector));
        assert_eq!((machine.ended(), machine.session.open_pipes()), (None, 0), "{}", row[0]);
    }
    let mut machine = Machine::new(&[Endpoint::Bridge]);
    machine.sign_in();
    machine.open(2, "bridge");
    machine.feed(&frame(0x31, 2, br#"{"code":"bad_request","message":""}"#));
    assert_eq!(machine.ended(), Some(End::Local { code: SessionError::ProtocolError }), "a code no pipe takes");
}

#[test]
fn reads_no_frame_type_but_its_own_and_writes_no_http_ws_or_pair() {
    // a new Outgoing variant must be placed here, or this does not build
    const fn kind(frame: &Outgoing) -> u8 {
        match frame {
            Outgoing::Hello => 0x01,
            Outgoing::Auth(_) => 0x03,
            Outgoing::Enroll(_) => 0x45,
            Outgoing::SessionError { .. } => 0x05,
            Outgoing::GoAway(_) => 0x06,
            Outgoing::Ping(_) => 0x07,
            Outgoing::Pong(_) => 0x08,
            Outgoing::Received(_) => 0x09,
            Outgoing::Credit { .. } => 0x30,
            Outgoing::Reset { .. } => 0x31,
            Outgoing::PipeAccept { .. } => 0x41,
            Outgoing::PipeData { .. } => 0x42,
            Outgoing::PipeEnd { .. } => 0x43,
            Outgoing::PipeAdvert(_) => 0x44,
        }
    }
    // what the frames table says a machine sends ("machine" or "either")
    let documented: std::collections::BTreeSet<u8> = table("frames")
        .iter()
        .filter(|row| row[4] == "machine" || row[4] == "either")
        .map(|row| u8::from_str_radix(row[0].trim_start_matches("0x"), 16).expect("a type"))
        .collect();
    // every type the machine-side reader (and so the encoder) takes: each type with trivial payloads, and
    // every vector a machine or a controller sends
    let mut inputs: Vec<Vec<u8>> = cases().iter().filter(|entry| entry["direction"] != "file").map(bytes).collect();
    for kind in 0..=255u8 {
        for payload in [&b"{}"[..], &[0u8; 8][..], &[][..]] {
            for id in [0, 1, 2] {
                inputs.push(frame(kind, id, payload));
            }
        }
    }
    let read: std::collections::BTreeSet<u8> = inputs.iter().filter(|input| mux::read_outgoing(input, true).is_ok()).map(|input| input[1]).collect();
    assert_eq!(read, documented, "the types the agent can write are the frames table's machine frames");
    for frame in [Outgoing::Hello, Outgoing::Pong(1), Outgoing::PipeAccept { id: 2 }] {
        assert!(documented.contains(&kind(&frame)));
    }
    for never in [0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x20, 0x21, 0x22, 0x23, 0x40, 0x46, 0x47, 0x48] {
        assert!(!read.contains(&never), "type {never:#04x}: HTTP, WS, PAIR, PIPE_OPEN, ENROLL_OK and the later fleet frames are never written");
    }
}

#[test]
fn honours_max_pipe_streams_only_from_1_to_16() {
    let welcome = |limit: &str| {
        let text = String::from_utf8(bytes(&case("auth/welcome/machine"))[8..].to_vec()).unwrap().replace("\"max_pipe_streams\":16", &format!("\"max_pipe_streams\":{limit}"));
        frame(0x02, 0, text.as_bytes())
    };
    for bad in ["0", "17", "16.5", "\"16\"", "-1", "null"] {
        let mut machine = Machine::new(&[Endpoint::Bridge]);
        machine.feed(&welcome(bad));
        assert_eq!(machine.ended(), Some(End::Local { code: SessionError::ProtocolError }), "max_pipe_streams {bad}");
    }
    let missing = String::from_utf8(bytes(&case("auth/welcome/machine"))[8..].to_vec()).unwrap().replace(",\"max_pipe_streams\":16", "");
    let mut machine = Machine::new(&[Endpoint::Bridge]);
    machine.feed(&frame(0x02, 0, missing.as_bytes()));
    assert_eq!(machine.ended(), Some(End::Local { code: SessionError::ProtocolError }), "max_pipe_streams missing");

    let mut machine = Machine::new(&[Endpoint::Bridge]);
    machine.feed(&welcome("2"));
    machine.feed(&bytes(&case("auth/auth-ok/machine")));
    for id in [2, 4, 6] {
        machine.open(id, "bridge");
    }
    assert_eq!(machine.connects(), vec![2, 4]);
    assert_eq!(machine.resets(), vec![(6, PipeReset::Refused)]);
}

#[test]
fn reaches_no_target_the_controller_names() {
    let mut machine = Machine::new(&[Endpoint::Bridge, Endpoint::Native]);
    machine.sign_in();
    // not even a valid endpoint name: the frame itself is refused
    for (id, endpoint) in [(2, "10.0.0.1:80"), (2, "127.0.0.1:22"), (2, "/tmp/other.sock"), (2, "::1"), (2, "[::1]:17421"), (2, "Bridge")] {
        let mut attempt = Machine::new(&[Endpoint::Bridge, Endpoint::Native]);
        attempt.sign_in();
        attempt.open(id, endpoint);
        assert_eq!(attempt.ended(), Some(End::Local { code: SessionError::ProtocolError }), "{endpoint}");
        assert!(attempt.connects().is_empty(), "{endpoint}");
    }
    // a valid name that is not one of the two endpoints, including one that resolves to loopback
    for (id, endpoint) in [(2, "localhost"), (4, "loopback"), (6, "ip6-localhost"), (8, "shell"), (10, "tcp-22"), (12, "native-2"), (14, "unix")] {
        machine.open(id, endpoint);
        assert_eq!(machine.resets().last(), Some(&(id, PipeReset::Refused)), "{endpoint}");
    }
    assert!(machine.connects().is_empty());
    assert_eq!(machine.ended(), None);
    // the endpoints map to the configuration's targets and nothing else
    let targets = Targets { bridge_port: Some(17421), native_socket: Some("/run/user/1000/ovis-runtime/default.sock".into()) };
    assert!(targets.has(Endpoint::Bridge) && targets.has(Endpoint::Native));
    assert!(!Targets::default().has(Endpoint::Bridge) && !Targets::default().has(Endpoint::Native));
    assert!(Targets::default().connect(Endpoint::Bridge).is_err());
}

#[test]
fn resolves_the_runtime_socket_as_the_runtime_does() {
    let env = |pairs: &'static [(&'static str, &'static str)]| move |name: &str| pairs.iter().find(|(key, _)| *key == name).map(|(_, value)| value.into());
    assert_eq!(runtime_socket(env(&[("OVIS_RUNTIME_SOCKET", "/srv/core.sock"), ("XDG_RUNTIME_DIR", "/run/user/1")])), Some("/srv/core.sock".into()));
    assert_eq!(runtime_socket(env(&[("OVIS_RUNTIME_SOCKET", "relative.sock")])), None);
    assert_eq!(runtime_socket(env(&[("XDG_RUNTIME_DIR", "/run/user/1")])), Some("/run/user/1/ovis-runtime/default.sock".into()));
    assert_eq!(runtime_socket(env(&[("XDG_RUNTIME_DIR", "/run/user/1"), ("OVIS_RUNTIME_SESSION", "work_2")])), Some("/run/user/1/ovis-runtime/work_2.sock".into()));
    assert_eq!(runtime_socket(env(&[("XDG_RUNTIME_DIR", "/run/user/1"), ("OVIS_RUNTIME_SESSION", "../x")])), None);
    assert_eq!(runtime_socket(env(&[("XDG_RUNTIME_DIR", "relative"), ("XDG_STATE_HOME", "/state")])), Some("/state/ovis-runtime/default.sock".into()));
    assert_eq!(runtime_socket(env(&[("HOME", "/home/m")])), Some("/home/m/.local/state/ovis-runtime/default.sock".into()));
    assert_eq!(runtime_socket(env(&[])), None);
    assert_eq!(runtime_socket(env(&[("XDG_RUNTIME_DIR", "/a-very-long-runtime-directory-name-that-goes-on-and-on-and-on-and-on-for-a-while-longer")])), None);
}

#[test]
fn copies_under_the_window_and_credits_only_what_reached_the_target() {
    let mut machine = Machine::new(&[Endpoint::Bridge]);
    machine.sign_in();
    machine.open(2, "bridge");
    machine.connect(2);
    // the target's chunks go out one by one, each read only after the last was sent
    let chunk = vec![5u8; mux::PIPE_DATA_BYTES];
    let mut sent = 0u64;
    loop {
        machine.session.target_data(2, chunk.clone());
        machine.pump();
        if machine.actions.last() != Some(&Action::ReadMore { id: 2 }) {
            break;
        }
        machine.actions.clear();
        sent += chunk.len() as u64;
        // the controller confirms its frames at once, so only the window holds the pipe
        let (submitted, ..) = machine.session.stats();
        machine.feed(&frame(0x09, 0, &submitted.to_be_bytes()));
    }
    assert!(sent <= mux::PIPE_WINDOW_BYTES && sent + chunk.len() as u64 > mux::PIPE_WINDOW_BYTES, "stopped at {sent}");
    // CREDIT opens it again
    machine.feed(&frame(0x30, 2, &16376u64.to_be_bytes()));
    assert_eq!(machine.actions.last(), Some(&Action::ReadMore { id: 2 }));
    // a CREDIT beyond what was sent is a flow control error
    machine.feed(&frame(0x30, 2, &(sent + 2 * 16376).to_be_bytes()));
    assert_eq!(machine.ended(), Some(End::Local { code: SessionError::FlowControlError }));

    let mut machine = Machine::new(&[Endpoint::Bridge]);
    machine.sign_in();
    machine.open(2, "bridge");
    machine.connect(2);
    let data = vec![1u8; 16376];
    for _ in 0..48 {
        machine.feed(&frame(0x42, 2, &data));
    }
    assert!(!machine.sent.iter().any(|frame| matches!(frame, Outgoing::Credit { .. })), "no credit before a write");
    machine.session.target_written(2, 16376);
    machine.pump();
    assert_eq!(machine.sent.last(), Some(&Outgoing::Credit { id: 2, consumed: 16376 }));
    // 48 frames filled 786048 of 786432 bytes; one credited frame frees room for one more, not two
    machine.feed(&frame(0x42, 2, &data));
    assert_eq!(machine.ended(), None);
    machine.feed(&frame(0x42, 2, &data));
    assert_eq!(machine.ended(), Some(End::Local { code: SessionError::FlowControlError }));
}

#[test]
fn half_closes_each_way_and_retires_a_pipe_both_ended() {
    let mut machine = Machine::new(&[Endpoint::Bridge]);
    machine.sign_in();
    machine.open(2, "bridge");
    machine.connect(2);
    machine.feed(&frame(0x42, 2, b"ping"));
    machine.feed(&frame(0x43, 2, &[]));
    assert_eq!(&machine.actions[machine.actions.len() - 2..], &[Action::Write { id: 2, data: b"ping".to_vec() }, Action::ShutdownWrite { id: 2 }]);
    // the target still talks after the controller's END, then ends too
    machine.session.target_data(2, b"pong".to_vec());
    machine.session.target_eof(2);
    machine.pump();
    assert!(machine.sent.ends_with(&[Outgoing::PipeData { id: 2, data: b"pong".to_vec() }, Outgoing::PipeEnd { id: 2 }]));
    assert_eq!(machine.session.open_pipes(), 1, "the target has not written what it got yet");
    machine.session.target_written(2, 4);
    machine.pump();
    assert_eq!(machine.actions.last(), Some(&Action::Close { id: 2 }));
    assert_eq!(machine.session.open_pipes(), 0);
    // a second END in one direction is refused
    let mut machine = Machine::new(&[Endpoint::Bridge]);
    machine.sign_in();
    machine.open(2, "bridge");
    machine.connect(2);
    machine.feed(&frame(0x43, 2, &[]));
    machine.feed(&frame(0x43, 2, &[]));
    assert_eq!(machine.ended(), Some(End::Local { code: SessionError::ProtocolError }));
}

#[test]
fn resets_upstream_lost_slow_consumer_and_ends_every_pipe_with_the_carrier() {
    let mut machine = Machine::new(&[Endpoint::Bridge, Endpoint::Native]);
    machine.sign_in();
    machine.open(2, "bridge");
    machine.session.target_failed(2);
    machine.pump();
    assert_eq!(machine.resets(), vec![(2, PipeReset::UpstreamLost)], "a failed connect is upstream_lost");
    machine.open(4, "native");
    machine.connect(4);
    machine.session.target_failed(4);
    machine.pump();
    assert_eq!(machine.resets().last(), Some(&(4, PipeReset::UpstreamLost)), "a target that closed without ending");
    // a reader that takes nothing for 30 s while the window is full
    machine.open(6, "bridge");
    machine.connect(6);
    let chunk = vec![0u8; mux::PIPE_DATA_BYTES];
    while machine.session.open_pipes() == 1 && !machine.resets().iter().any(|(id, _)| *id == 6) {
        machine.actions.clear();
        machine.session.target_data(6, chunk.clone());
        machine.pump();
        let (submitted, ..) = machine.session.stats();
        machine.feed(&frame(0x09, 0, &submitted.to_be_bytes()));
        if machine.actions.last() != Some(&Action::ReadMore { id: 6 }) {
            break;
        }
    }
    machine.advance(SLOW_CONSUMER_MS - 1);
    assert!(!machine.resets().contains(&(6, PipeReset::SlowConsumer)));
    machine.advance(1);
    assert_eq!(machine.resets().last(), Some(&(6, PipeReset::SlowConsumer)));
    // carrier loss: every pipe closes with no frame
    machine.open(8, "bridge");
    machine.connect(8);
    machine.open(10, "native");
    let frames = machine.sent.len();
    machine.session.carrier_lost();
    machine.pump();
    assert_eq!(machine.ended(), Some(End::CarrierLost));
    assert_eq!(machine.sent.len(), frames);
    assert!(machine.actions.ends_with(&[Action::Close { id: 8 }, Action::Close { id: 10 }]));
    assert!(!machine.session.target_connected(10), "a target that connects after the end is closed");
}

#[test]
fn drains_after_goaway_both_ways() {
    let mut machine = Machine::new(&[Endpoint::Bridge]);
    machine.sign_in();
    for id in [2, 4, 6] {
        machine.open(id, "bridge");
        machine.connect(id);
    }
    machine.feed(&frame(0x06, 0, br#"{"code":"shutdown","last_open_id":4,"drain_ms":5000}"#));
    assert!(machine.actions.ends_with(&[Action::Close { id: 6 }]) && machine.resets().is_empty());
    machine.open(8, "bridge");
    assert_eq!(machine.resets(), vec![(8, PipeReset::Refused)], "no pipe opens past a GOAWAY");
    machine.advance(5000);
    assert_eq!(machine.ended(), Some(End::Drained));

    // the owner's confirmation: GOAWAY reason `confirmed`, whether the carrier closes first or the drain ends
    for close_first in [true, false] {
        let mut machine = Machine::new(&[Endpoint::Bridge]);
        machine.sign_in();
        machine.feed(&frame(0x06, 0, br#"{"code":"shutdown","last_open_id":0,"drain_ms":1000,"reason":"confirmed"}"#));
        if close_first {
            machine.session.carrier_lost();
        } else {
            machine.advance(1000);
        }
        machine.pump();
        assert_eq!(machine.ended(), Some(End::Confirmed), "close first: {close_first}");
    }
    // a reason this agent does not act on drains as any GOAWAY
    let mut machine = Machine::new(&[Endpoint::Bridge]);
    machine.sign_in();
    machine.feed(&frame(0x06, 0, br#"{"code":"shutdown","last_open_id":0,"drain_ms":0,"reason":"later-reason"}"#));
    machine.session.carrier_lost();
    machine.pump();
    assert_eq!(machine.ended(), Some(End::Drained));

    // the controller closes the carrier as its drain ends, before this end's deadline: the session still drained
    let mut machine = Machine::new(&[Endpoint::Bridge]);
    machine.sign_in();
    machine.feed(&frame(0x06, 0, br#"{"code":"shutdown","last_open_id":0,"drain_ms":1000}"#));
    machine.session.carrier_lost();
    machine.pump();
    assert_eq!(machine.ended(), Some(End::Drained));

    let goaway = case("pipe/goaway/machine");
    let mut machine = Machine::new(&[Endpoint::Bridge]);
    machine.sign_in();
    machine.session.set_last_open_id_for_test(4);
    machine.session.go_away(machine.now);
    machine.pump();
    assert_eq!(hex::encode(&machine.sent.last().unwrap().encode().unwrap()), goaway["bytes"].as_str().unwrap());
}

/// A refusal the machine makes on its own: the session ends `protocol_error` with SESSION_ERROR as its last frame.
fn assert_refused(machine: &Machine, what: &str) {
    assert_eq!(machine.ended(), Some(End::Local { code: SessionError::ProtocolError }), "{what}");
    assert!(matches!(machine.sent.last(), Some(Outgoing::SessionError { code: SessionError::ProtocolError, .. })), "{what}: {:?}", machine.sent.last());
}

#[test]
fn refuses_data_after_the_controllers_pipe_end() {
    let mut machine = Machine::new(&[Endpoint::Bridge]);
    machine.sign_in();
    machine.open(2, "bridge");
    machine.connect(2);
    machine.feed(&frame(0x43, 2, &[]));
    assert_eq!(machine.ended(), None);
    machine.feed(&frame(0x42, 2, b"late"));
    assert_refused(&machine, "PIPE_DATA after PIPE_END");
}

#[test]
fn refuses_a_goaway_watermark_above_the_last_opened_pipe() {
    let mut machine = Machine::new(&[Endpoint::Bridge]);
    machine.sign_in();
    machine.open(2, "bridge");
    machine.connect(2);
    machine.feed(&frame(0x06, 0, br#"{"code":"shutdown","last_open_id":4,"drain_ms":5000}"#));
    assert_refused(&machine, "GOAWAY naming pipe 4 when 2 is the last");
}

#[test]
fn refuses_an_auth_ok_for_another_machine() {
    let other = parse(AUTH)["derivations"]["machine_b"]["machine_id"].as_str().unwrap().to_owned();
    assert_ne!(other, machine_a().machine_id());
    let mut machine = Machine::new(&[Endpoint::Bridge]);
    machine.feed(&bytes(&case("auth/welcome/machine")));
    let ok = format!(r#"{{"session_id":"{}","machine_id":"{other}","role":"machine"}}"#, "ab".repeat(16));
    machine.feed(&frame(0x04, 0, ok.as_bytes()));
    assert!(!machine.session.signed_in());
    assert_refused(&machine, "AUTH_OK naming machine b");
}

#[test]
fn ends_after_its_setup_deadline_without_auth_ok() {
    // docs/relay.md, the limits table: "Admission | AUTH_OK within 10 seconds | the session ends (timeout)",
    // the rule docs/fleet-link.md keeps "as today" for a machine
    let mut machine = Machine::new(&[Endpoint::Bridge]);
    machine.feed(&bytes(&case("auth/welcome/machine")));
    machine.advance(9_999);
    assert_eq!(machine.ended(), None);
    machine.advance(1);
    assert_eq!(machine.ended(), Some(End::Local { code: SessionError::Timeout }));
    assert!(matches!(machine.sent.last(), Some(Outgoing::SessionError { code: SessionError::Timeout, .. })));
}

/// shared/relay-mux-engine.ts Bucket, as the controller counts what it receives.
struct PeerBucket {
    tokens: f64,
    updated: Millis,
}
impl PeerBucket {
    fn take(&mut self, now: Millis) -> bool {
        self.tokens = (self.tokens + (now - self.updated) as f64 * 4096.0 / 1000.0).min(8192.0);
        self.updated = now;
        if self.tokens < 1.0 {
            return false;
        }
        self.tokens -= 1.0;
        true
    }
}

#[test]
fn paces_its_frames_within_the_peer_engines_receive_limit() {
    let mut machine = Machine::new(&[Endpoint::Bridge]);
    machine.sign_in();
    machine.open(2, "bridge");
    machine.connect(2);
    let mut peer = PeerBucket { tokens: 8192.0, updated: 0 };
    let mut times: Vec<Millis> = Vec::new();
    let mut data_frames = 0u64;
    let setup = machine.sent.len();
    // A target that yields one byte per read, always ready (a terminal printing byte by byte): each
    // byte is a PIPE_DATA frame. The controller credits and confirms every frame at once, so only
    // the pace holds the machine back.
    const TOTAL: u64 = 30_000;
    machine.session.target_data(2, b"x".to_vec());
    while data_frames < TOTAL {
        while let Some(bytes) = machine.session.poll_transmit(machine.now) {
            times.push(machine.now);
            assert!(peer.take(machine.now), "frame {} at {} ms passes the controller's bucket", times.len(), machine.now);
            match bytes[1] {
                0x42 => data_frames += 1,
                0x09 => continue,
                other => panic!("frame type {other:#04x}: {:?}", mux::read_outgoing(&bytes, true)),
            }
            let (submitted, ..) = machine.session.stats();
            machine.session.receive(&frame(0x30, 2, &data_frames.to_be_bytes()), machine.now);
            machine.session.receive(&frame(0x09, 0, &submitted.to_be_bytes()), machine.now);
            while let Some(action) = machine.session.poll_action() {
                if action == (Action::ReadMore { id: 2 }) {
                    machine.session.target_data(2, b"x".to_vec());
                }
            }
        }
        machine.now = machine.session.next_deadline().expect("a byte is waiting").max(machine.now + 1);
    }
    assert_eq!(machine.ended(), None);
    // docs/fleet-link.md section 2, "Pace": a burst of 2048 frames, then 3072 a second (the peer's
    // bucket is 8192 and 4096 a second); RECEIVED for the controller's CREDITs went out too
    let burst = setup + times.iter().take_while(|&&time| time == 0).count();
    assert_eq!(burst, 2048, "frames sent at once, the sign-in's included");
    for (index, start) in times.iter().enumerate() {
        let within = times[index..].iter().take_while(|&&time| time < start + 1000).count();
        assert!(within <= 2048 + 3072 + 1, "{within} frames in the second from {start} ms");
    }
    let rate = (times.len() - 2048) as f64 * 1000.0 / *times.last().unwrap() as f64;
    assert!((3072.0 * 0.99..=3072.0 * 1.01).contains(&rate), "{rate} frames a second after the burst");

    // a peer that floods PING past the engine's control queue ends the session, as the engine would
    let mut flooded = Machine::new(&[Endpoint::Bridge]);
    flooded.sign_in();
    for probe in 0..5000u64 {
        flooded.session.receive(&frame(0x07, 0, &probe.to_be_bytes()), flooded.now);
    }
    flooded.pump();
    assert_eq!(flooded.ended(), Some(End::Local { code: SessionError::ResourceExhausted }));
}

#[test]
fn loads_a_machine_key_only_from_a_private_regular_file() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let dir = std::env::temp_dir().join(format!("ovis-link-key-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let scalar = hex::decode(parse(AUTH)["derivations"]["machine_a"]["private_scalar_hex"].as_str().unwrap()).unwrap();
    let write = |name: &str, bytes: &[u8], mode: u32| {
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
        path
    };
    // a FIFO must not block the open: the load runs on a thread and must answer within 5 s
    let fifo = dir.join("fifo.key");
    assert!(std::process::Command::new("mkfifo").arg("-m").arg("600").arg(&fifo).status().unwrap().success());
    let (answer, answered) = std::sync::mpsc::channel();
    let path = fifo.clone();
    std::thread::spawn(move || answer.send(MachineKey::load(&path).map(|_| ())).unwrap());
    assert_eq!(answered.recv_timeout(std::time::Duration::from_secs(5)).expect("a FIFO blocks the load"), Err(KeyError::NotAFile));

    let private = write("private.key", &scalar, 0o600);
    let exposed = write("exposed.key", &scalar, 0o644);
    symlink(&private, dir.join("to-private.key")).unwrap();
    symlink(&exposed, dir.join("to-exposed.key")).unwrap();
    let cases: Vec<(std::path::PathBuf, Result<(), KeyError>)> = vec![
        (private.clone(), Ok(())),
        (write("read-only.key", &scalar, 0o400), Ok(())),
        (exposed.clone(), Err(KeyError::Exposed)),
        (write("group.key", &scalar, 0o640), Err(KeyError::Exposed)),
        (dir.join("to-private.key"), Err(KeyError::Symlink)),
        (dir.join("to-exposed.key"), Err(KeyError::Symlink)),
        (dir.clone(), Err(KeyError::NotAFile)),
        (write("short.key", &scalar[..31], 0o600), Err(KeyError::WrongLength)),
        (write("long.key", &[&scalar[..], b"\n"].concat(), 0o600), Err(KeyError::WrongLength)),
        (write("zero.key", &[0u8; 32], 0o600), Err(KeyError::NotAScalar)),
        (write("order.key", &[0xffu8; 32], 0o600), Err(KeyError::NotAScalar)),
        (dir.join("missing.key"), Err(KeyError::Unreadable)),
    ];
    for (path, expected) in cases {
        assert_eq!(MachineKey::load(&path).map(|_| ()), expected, "{}", path.display());
    }
    assert_eq!(MachineKey::load(&private).unwrap().machine_id(), machine_a().machine_id());
    std::fs::remove_dir_all(&dir).unwrap();
}

fn reference_channel() -> crate::channel::Channel {
    let records = parse(include_str!("../../../server/fleet/vectors/records.json"));
    let derivations = &records["derivations"];
    let key = |name: &str| -> [u8; 32] { hex::decode(derivations[name].as_str().unwrap()).unwrap().try_into().unwrap() };
    let (handshake, _) = crate::channel::ClientHandshake::start_with_ephemeral(&key("responder_static_public_hex"), key("initiator_ephemeral_secret_hex")).unwrap();
    handshake.finish(&hex::decode(derivations["message_2_hex"].as_str().unwrap()).unwrap()).unwrap()
}

#[test]
fn speaks_the_handshake_envelopes_of_the_typescript_client() {
    let hello: Value = serde_json::from_str(&carrier::hello(b"message one")).unwrap();
    assert_eq!(hello["type"], "e2ee_hello");
    assert_eq!(hello["capabilities"], json!({ "binaryCiphertext": true }));
    assert_eq!(hello["protected"], json!({ "v": 1, "message": b64::encode(b"message one") }));
    assert_eq!(b64::decode(hello["key"].as_str().unwrap()).map(|key| key.len()), Some(32));

    let ready = |value: Value| carrier::ready(&value.to_string());
    assert_eq!(ready(json!({ "type": "e2ee_ready", "protected": { "v": 1, "message": b64::encode(b"two") } })), Ok(Some(b"two".to_vec())));
    assert_eq!(ready(json!({ "type": "e2ee_ready", "capabilities": { "binaryCiphertext": true }, "protected": { "v": 1, "message": "dHdv" } })), Ok(Some(b"two".to_vec())));
    assert_eq!(ready(json!({ "type": "e2ee_ready" })), Err(CarrierError::LegacyOnly), "the legacy mode is never taken");
    assert_eq!(ready(json!({ "type": "e2ee_ready", "capabilities": { "binaryCiphertext": true } })), Err(CarrierError::LegacyOnly));
    assert_eq!(ready(json!({ "type": "e2ee_ready", "protected": { "v": 2, "message": "dHdv" } })), Err(CarrierError::UnsupportedEnvelope));
    assert_eq!(ready(json!({ "type": "e2ee_ready", "protected": { "v": 1, "message": "" } })), Err(CarrierError::MalformedReady));
    assert_eq!(ready(json!({ "type": "e2ee_ready", "protected": { "v": 1, "message": "not base64!" } })), Err(CarrierError::MalformedReady));
    assert_eq!(ready(json!({ "type": "e2ee_ready", "capabilities": 3, "protected": { "v": 1, "message": "dHdv" } })), Err(CarrierError::MalformedReady));
    assert_eq!(ready(json!({ "type": "something else" })), Ok(None), "other traffic is ignored while waiting");
    assert_eq!(carrier::ready("not json"), Ok(None));
}

#[test]
fn carries_frames_as_binary_or_as_base64_text_as_the_handshake_chose() {
    let mut channel = reference_channel();
    let binary = carrier::seal(&mut channel, b"\x01\x07frame").unwrap();
    assert!(matches!(&binary, Message::Binary(record) if record.len() == carrier::wire_bytes(true, 7)));
    let mut text_mode = reference_channel();
    text_mode.set_binary_ciphertext_for_test(false);
    let Message::Text(text) = carrier::seal(&mut text_mode, b"\x01\x07frame").unwrap() else { panic!("text expected") };
    assert_eq!(text.len(), carrier::wire_bytes(false, 7));
    assert_eq!(b64::decode(&text), match binary { Message::Binary(record) => Some(record), Message::Text(_) => None }, "the same record, as base64");

    // what the machine reads: binary records, base64 records, repeated envelopes; never plaintext or a text frame
    let (_, receive) = reference_channel().keys_for_test();
    let record = |kind: crate::records::FrameKind, data: &[u8], nonce: u64| crate::records::encode(kind, data, &mut crate::noise::CipherState::with_nonce(receive, nonce)).unwrap();
    let mut channel = reference_channel();
    assert_eq!(carrier::open(&mut channel, &Message::Binary(record(crate::records::FrameKind::Binary, b"one", 0))), Ok(Some(b"one".to_vec())));
    assert_eq!(carrier::open(&mut channel, &Message::Text(b64::encode(&record(crate::records::FrameKind::Binary, b"two", 1)))), Ok(Some(b"two".to_vec())));
    assert_eq!(carrier::open(&mut channel, &Message::Text(r#"{"type":"e2ee_ready","protected":{"v":1,"message":"eA=="}}"#.into())), Ok(None));
    assert_eq!(carrier::open(&mut channel, &Message::Text(r#"{"type":"hello"}"#.into())), Err(CarrierError::Plaintext));
    let mut channel = reference_channel();
    assert_eq!(carrier::open(&mut channel, &Message::Binary(record(crate::records::FrameKind::Text, b"text", 0))), Err(CarrierError::TextFrame));
    let mut channel = reference_channel();
    assert_eq!(carrier::open(&mut channel, &Message::Binary(vec![0; crate::channel::MAX_CARRIER_BINARY_BYTES + 1])), Err(CarrierError::Record(crate::Error::CarrierMessageTooLarge)));
}

#[test]
fn parses_json_as_the_mux_does() {
    use crate::json;
    assert!(json::parse(br#"{"a":1,"b":{"c":[1,2]}}"#).is_some());
    assert!(json::parse(br#"{"a":1,"a":2}"#).is_none(), "duplicate key");
    assert!(json::parse(br#"{"a":1,"\u0061":2}"#).is_none(), "duplicate key spelled with an escape");
    assert!(json::parse(br#"{"x":{"a":1,"a":2}}"#).is_none(), "duplicate nested key");
    assert!(json::parse(b"{\"a\":\"\xff\"}").is_none(), "not UTF-8");
    assert!(json::parse(b"{} {}").is_none(), "two values");
    assert_eq!(json::parse(b"1.0").and_then(|value| value.as_integer(0, 5)), Some(1));
    assert_eq!(json::parse(b"1.5").and_then(|value| value.as_integer(0, 5)), None);
    assert_eq!(json::quote("a\"\n\u{1}é"), "\"a\\\"\\n\\u0001é\"");
}

#[test]
fn encodes_base64_as_both_readers_do() {
    assert_eq!(b64::encode(b""), "");
    assert_eq!(b64::encode(b"f"), "Zg==");
    assert_eq!(b64::encode(b"fo"), "Zm8=");
    assert_eq!(b64::encode(b"foo"), "Zm9v");
    assert_eq!(b64::decode("Zm8="), Some(b"fo".to_vec()));
    assert_eq!(b64::decode("Zm9="), None, "unused bits set");
    assert_eq!(b64::decode("Zm8"), None, "unpadded");
    assert_eq!(b64::encode_url(&[0xfb, 0xff]), "-_8");
    assert_eq!(b64::decode_url("-_8", 2), Some(vec![0xfb, 0xff]));
    assert_eq!(b64::decode_url("-_9", 2), None, "noncanonical");
    assert_eq!(b64::decode_url("-_8", 3), None, "wrong length");
}

#[test]
fn pings_after_20_s_of_silence_and_ends_timeout_when_no_pong_comes_in_60_s() {
    use crate::session::{KEEPALIVE_IDLE_MS, PONG_TIMEOUT_MS};
    let mut machine = Machine::new(&[Endpoint::Bridge]);
    machine.advance(KEEPALIVE_IDLE_MS * 3);
    assert!(!machine.sent.iter().any(|frame| matches!(frame, Outgoing::Ping(_))), "no keepalive before sign-in: the setup deadline rules");
    let mut machine = Machine::new(&[Endpoint::Bridge]);
    machine.sign_in();
    let pings = |machine: &Machine| machine.sent.iter().filter_map(|frame| if let Outgoing::Ping(probe) = frame { Some(*probe) } else { None }).collect::<Vec<_>>();
    machine.advance(KEEPALIVE_IDLE_MS - 1);
    assert!(pings(&machine).is_empty());
    machine.advance(1);
    let probe = *pings(&machine).last().expect("a PING after 20 s of silence");
    // the PONG comes back: the next PING follows 20 s more of silence
    machine.feed(&frame(0x08, 0, &probe.to_be_bytes()));
    machine.advance(KEEPALIVE_IDLE_MS - 1);
    assert_eq!(pings(&machine).len(), 1);
    machine.advance(1);
    assert_eq!(pings(&machine).len(), 2);
    // a PONG for another probe does not answer it; one PING at a time is out
    let last = *pings(&machine).last().unwrap();
    machine.feed(&frame(0x08, 0, &(last + 100).to_be_bytes()));
    for _ in 0..(PONG_TIMEOUT_MS / 1_000 - 1) {
        machine.advance(1_000);
    }
    assert_eq!(machine.ended(), None);
    assert_eq!(pings(&machine).len(), 2);
    machine.advance(1_000);
    assert!(matches!(machine.sent.last(), Some(Outgoing::SessionError { code: SessionError::Timeout, .. })), "{:?}", machine.sent.last());
    machine.advance(10_000);
    assert_eq!(machine.ended(), Some(End::Local { code: SessionError::Timeout }));
}

#[test]
fn hears_any_frame_as_life_and_puts_off_the_keepalive() {
    use crate::session::KEEPALIVE_IDLE_MS;
    let mut machine = Machine::new(&[Endpoint::Bridge]);
    machine.sign_in();
    for _ in 0..10 {
        machine.advance(KEEPALIVE_IDLE_MS - 1);
        machine.feed(&frame(0x07, 0, &7u64.to_be_bytes()));
    }
    assert!(!machine.sent.iter().any(|frame| matches!(frame, Outgoing::Ping(_))));
    assert_eq!(machine.session.next_deadline(), Some(machine.now + KEEPALIVE_IDLE_MS));
}

#[test]
fn replaces_the_advert_mid_session_and_resets_only_the_pipes_whose_target_changed() {
    let mut machine = Machine::new(&[Endpoint::Bridge, Endpoint::Native]);
    machine.sign_in();
    machine.open(2, "bridge");
    machine.connect(2);
    machine.open(4, "native");
    machine.connect(4);
    let first = advert(&[Endpoint::Bridge, Endpoint::Native]);

    // a runtime restart: new boot_id and bearer; the native pipe ends upstream_lost, the bridge pipe stays
    let restarted = Advert { boot_id: "boot-2".into(), native_bearer: Some(zeroize::Zeroizing::new("ovb_restarted".into())), ..first.clone() };
    machine.session.replace_advert(Some(restarted.clone()), &[]);
    machine.pump();
    assert_eq!(machine.resets(), [(4, PipeReset::UpstreamLost)]);
    assert_eq!(machine.actions.last(), Some(&Action::Close { id: 4 }));
    assert_eq!(machine.sent.last(), Some(&Outgoing::PipeAdvert(restarted.clone())));
    assert_eq!(machine.session.open_pipes(), 1);

    // health alone changes: the advert goes out, no pipe ends
    let down = Advert { health: Health { runtime: UpDown::Up, bridge: UpDown::Down }, ..restarted.clone() };
    machine.session.replace_advert(Some(down.clone()), &[]);
    machine.pump();
    assert_eq!(machine.resets().len(), 1);
    assert_eq!(machine.sent.last(), Some(&Outgoing::PipeAdvert(down.clone())));

    // the bridge restarted with a new token on the same port: its pipe ends
    let new_token = Advert { bridge_token: Some(zeroize::Zeroizing::new("cd".repeat(32))), ..down.clone() };
    machine.session.replace_advert(Some(new_token.clone()), &[]);
    machine.pump();
    assert_eq!(machine.resets(), [(4, PipeReset::UpstreamLost), (2, PipeReset::UpstreamLost)]);
    assert_eq!(machine.sent.last(), Some(&Outgoing::PipeAdvert(new_token.clone())));

    // the bridge moved to another port: a pipe opened since ends too
    machine.open(6, "bridge");
    machine.connect(6);
    machine.session.replace_advert(Some(new_token.clone()), &[Endpoint::Bridge]);
    machine.pump();
    assert_eq!(machine.resets().last(), Some(&(6, PipeReset::UpstreamLost)));

    // native no longer offered: a PIPE_OPEN for it is refused
    let bridge_only = advert(&[Endpoint::Bridge]);
    machine.session.replace_advert(Some(bridge_only), &[]);
    machine.open(8, "native");
    assert_eq!(machine.resets().last(), Some(&(8, PipeReset::Refused)));

    // no usable advert.json: nothing goes out, and every open is refused
    let sent = machine.sent.len();
    machine.session.replace_advert(None, &[]);
    machine.pump();
    assert_eq!(machine.sent.len(), sent);
    machine.open(10, "bridge");
    assert_eq!(machine.resets().last(), Some(&(10, PipeReset::Refused)));
}

#[test]
fn holds_a_new_advert_until_sign_in_and_sends_the_newest_after_auth_ok() {
    let mut machine = Machine::new(&[Endpoint::Bridge]);
    let newer = Advert { boot_id: "boot-9".into(), ..advert(&[Endpoint::Bridge]) };
    machine.session.replace_advert(Some(newer.clone()), &[]);
    machine.pump();
    assert!(!machine.sent.iter().any(|frame| matches!(frame, Outgoing::PipeAdvert(_))), "no PIPE_ADVERT before AUTH_OK");
    machine.sign_in();
    let adverts: Vec<&Outgoing> = machine.sent.iter().filter(|frame| matches!(frame, Outgoing::PipeAdvert(_))).collect();
    assert_eq!(adverts, [&Outgoing::PipeAdvert(newer)]);
}

#[test]
fn pending_is_what_the_auth_ok_says_and_absent_reads_as_not_pending() {
    // a controller that does not send `pending` (auth/auth-ok/machine) leaves the machine connected, as before
    let mut plain = Machine::new(&[Endpoint::Bridge]);
    plain.sign_in();
    assert!(!plain.session.pending());
    let mut pending = Machine::new(&[Endpoint::Bridge]);
    pending.feed(&bytes(&case("auth/welcome/machine")));
    pending.feed(&bytes(&case("auth/auth-ok/machine-pending")));
    assert!(pending.session.signed_in());
    assert!(pending.session.pending());
}
