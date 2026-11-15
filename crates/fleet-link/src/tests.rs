//! The Rust side against the TypeScript side's bytes: the vendored Noise NK fixture
//! (shared/vendor/paseo-e2ee/noise/fixtures) and server/fleet/vectors/records.json, which
//! scripts/fleet-vectors.ts writes from the vendored TypeScript code.

use serde_json::Value;
use x25519_dalek::StaticSecret;

use crate::channel::{Channel, ClientHandshake, MAX_CARRIER_BINARY_BYTES, MAX_CARRIER_TEXT_BYTES, MAX_MUX_FRAME_BYTES};
use crate::hex;
use crate::noise::{CipherState, Initiator};
use crate::records::{self, Frame, FrameKind, MAX_CHUNK_DATA_BYTES};
use crate::Error;

const NK_FIXTURE: &str = include_str!("../../../shared/vendor/paseo-e2ee/noise/fixtures/nk-25519-chachapoly-sha256.json");
const RECORDS: &str = include_str!("../../../server/fleet/vectors/records.json");

fn bytes(value: &Value) -> Vec<u8> {
    hex::decode(value.as_str().expect("a hex string")).expect("valid hex")
}
fn key(value: &Value) -> [u8; 32] {
    bytes(value).try_into().expect("32 bytes")
}
fn records() -> Value {
    serde_json::from_str(RECORDS).expect("records.json parses")
}
fn kind(value: &Value) -> FrameKind {
    match value["kind"].as_str() {
        Some("text") => FrameKind::Text,
        Some("binary") => FrameKind::Binary,
        other => panic!("unknown kind {other:?}"),
    }
}
/// A frame as records.json writes it: hex, or a length whose byte i is i mod 251.
fn data(value: &Value) -> Vec<u8> {
    if let Some(text) = value.get("data_hex") {
        return bytes(text);
    }
    assert_eq!(value["pattern"], "mod251");
    let length = value["length"].as_u64().expect("a length") as usize;
    (0..length).map(|i| (i % 251) as u8).collect()
}
fn nonce(value: &Value) -> u64 {
    value.as_str().expect("a decimal string").parse().expect("a u64")
}

/// The initiator of records.json's derivations, before message 2.
fn reference_start(pinned: [u8; 32]) -> (ClientHandshake, Vec<u8>) {
    let derivations = &records()["derivations"];
    ClientHandshake::start_with_ephemeral(&pinned, key(&derivations["initiator_ephemeral_secret_hex"])).expect("message 1")
}
fn reference_channel() -> Channel {
    let derivations = &records()["derivations"];
    let (handshake, _) = reference_start(key(&derivations["responder_static_public_hex"]));
    handshake.finish(&bytes(&derivations["message_2_hex"])).expect("the reference handshake opens")
}

#[test]
fn matches_both_noise_nk_reference_vectors() {
    let fixture: Value = serde_json::from_str(NK_FIXTURE).expect("fixture parses");
    let vectors = fixture["vectors"].as_array().expect("vectors");
    assert_eq!(vectors.len(), 2);
    for vector in vectors {
        assert_eq!(vector["name"], "Noise_NK_25519_ChaChaPoly_SHA256");
        let messages = vector["messages"].as_array().expect("messages");
        let initiator = Initiator::new(
            key(&vector["init_remote_static"]),
            &bytes(&vector["init_prologue"]),
            StaticSecret::from(key(&vector["init_ephemeral"])),
        );
        let (awaiting, first) = initiator.write_message(&bytes(&messages[0]["payload"])).expect("message 1");
        assert_eq!(hex::encode(&first), messages[0]["ciphertext"].as_str().unwrap());
        let (payload, mut transport) = awaiting.read_message(&bytes(&messages[1]["ciphertext"])).expect("message 2");
        assert_eq!(hex::encode(&payload), messages[1]["payload"].as_str().unwrap());
        if let Some(hash) = vector.get("handshake_hash") {
            assert_eq!(hex::encode(&transport.handshake_hash), hash.as_str().unwrap());
        }
        for (index, message) in messages.iter().enumerate().skip(2) {
            let payload = bytes(&message["payload"]);
            let ciphertext = bytes(&message["ciphertext"]);
            // after the handshake the initiator writes the even messages and reads the odd ones
            if index % 2 == 0 {
                assert_eq!(transport.send.encrypt_with_ad(&[], &payload).unwrap(), ciphertext, "message {index}");
            } else {
                assert_eq!(transport.receive.decrypt_with_ad(&[], &ciphertext).unwrap(), payload, "message {index}");
            }
        }
    }
}

#[test]
fn opens_the_records_handshake_and_derives_the_channel_binding() {
    let vectors = records();
    let derivations = &vectors["derivations"];
    assert_eq!(hex::encode(crate::channel::PROLOGUE), derivations["prologue_hex"].as_str().unwrap());
    let (handshake, message1) = reference_start(key(&derivations["responder_static_public_hex"]));
    assert_eq!(hex::encode(&message1), derivations["message_1_hex"].as_str().unwrap());
    let channel = handshake.finish(&bytes(&derivations["message_2_hex"])).expect("opens");
    assert!(channel.binary_ciphertext());
    assert_eq!(hex::encode(&channel.binding()), derivations["channel_binding"]["binding_hex"].as_str().unwrap());
    assert_eq!(hex::encode(&channel.handshake_hash()), derivations["handshake_hash_hex"].as_str().unwrap());
}

#[test]
fn uses_the_limits_of_the_typescript_code() {
    let limits = &records()["derivations"]["limits"];
    assert_eq!(limits["max_chunk_data_bytes"], MAX_CHUNK_DATA_BYTES);
    assert_eq!(limits["max_mux_frame_bytes"], MAX_MUX_FRAME_BYTES);
    assert_eq!(limits["max_carrier_binary_bytes"], MAX_CARRIER_BINARY_BYTES);
    assert_eq!(limits["max_carrier_text_bytes"], MAX_CARRIER_TEXT_BYTES);
    assert_eq!(nonce(&limits["max_nonce"]), u64::MAX);
}

#[test]
fn seals_and_opens_the_transcript_byte_for_byte() {
    let vectors = records();
    let transcript = vectors["records"].as_array().expect("records");
    let mut channel = reference_channel();
    let (mut sent, mut received) = (0, 0);
    for record in transcript {
        let name = record["name"].as_str().unwrap();
        let wire = bytes(&record["wire_hex"]);
        let frame = Frame { kind: kind(record), data: data(record) };
        match record["direction"].as_str() {
            Some("initiator_to_responder") => {
                assert_eq!(channel.seal(frame.kind, &frame.data).expect(name), wire, "{name}");
                sent += 1;
            }
            Some("responder_to_initiator") => {
                assert_eq!(channel.open(&wire).expect(name), frame, "{name}");
                received += 1;
            }
            other => panic!("{name}: direction {other:?}"),
        }
    }
    assert!(sent > 0 && received > 0);
}

#[test]
fn refuses_and_accepts_every_case_as_the_typescript_code_does() {
    let vectors = records();
    let cases = vectors["cases"].as_array().expect("cases");
    let derivations = &vectors["derivations"];
    let mut stages = std::collections::BTreeMap::<&str, usize>::new();
    let find = |name: &str| cases.iter().find(|entry| entry["name"] == name).unwrap_or_else(|| panic!("no case {name}"));
    for entry in cases {
        let name = entry["name"].as_str().unwrap();
        let input = &entry["input"];
        let expect = &entry["expect"];
        let refused = expect["refuse"]["error"].as_str();
        let stage = entry["stage"].as_str().unwrap();
        *stages.entry(stage).or_default() += 1;
        match stage {
            "handshake" => {
                let (handshake, message1) = reference_start(key(&input["pinned_responder_public_hex"]));
                // 32 bytes of ephemeral key, the 2-byte parameter payload and its 16-byte tag
                assert_eq!(message1.len(), 50, "{name}");
                let error = handshake.finish(&bytes(&input["message_2_hex"])).expect_err(name);
                assert_eq!(Some(error.message()), refused, "{name}");
            }
            "record" => {
                let mut channel = reference_channel();
                let deliver = input["deliver_hex"].as_array().unwrap();
                let frames = expect["frames"].as_array().unwrap();
                for (step, wire) in deliver.iter().enumerate() {
                    let result = channel.open(&bytes(wire));
                    if Some(step as u64) == expect["refuse"]["step"].as_u64() {
                        assert_eq!(result.map(|_| ()).map_err(|error| error.message()), Err(refused.unwrap()), "{name} step {step}");
                        // a failure ends the channel: not even the record that came first opens again
                        assert!(!channel.is_open(), "{name}");
                        assert_eq!(channel.open(&bytes(&deliver[0])), Err(Error::Closed), "{name}");
                        assert_eq!(channel.seal(FrameKind::Binary, b"after"), Err(Error::Closed), "{name}");
                        break;
                    }
                    let frame = result.unwrap_or_else(|error| panic!("{name} step {step}: {error}"));
                    assert_eq!(frame, Frame { kind: kind(&frames[step]), data: data(&frames[step]) }, "{name} step {step}");
                }
            }
            "encode" => {
                let mut sender = CipherState::with_nonce(key(&input["key_hex"]), nonce(&input["nonce"]));
                let frame = &input["frame"];
                let result = records::encode(kind(frame), &data(frame), &mut sender);
                match refused {
                    Some(error) => assert_eq!(result.map_err(|error| error.message()), Err(error), "{name}"),
                    None => {
                        assert_eq!(hex::encode(&result.expect(name)), expect["wire_hex"].as_str().unwrap(), "{name}");
                        assert_eq!(sender.nonce(), nonce(&expect["next_nonce"]), "{name}");
                    }
                }
            }
            "decode" => {
                let wire = match input.get("wire_from") {
                    Some(from) => {
                        let mut wire = bytes(&find(from.as_str().unwrap())["expect"]["wire_hex"]);
                        wire.truncate(input["wire_length"].as_u64().unwrap() as usize);
                        wire
                    }
                    None => bytes(&input["wire_hex"]),
                };
                let mut receiver = CipherState::with_nonce(key(&input["key_hex"]), nonce(&input["nonce"]));
                let result = records::decode(&wire, &mut receiver);
                match refused {
                    Some(error) => assert_eq!(result.map_err(|error| error.message()), Err(error), "{name}"),
                    None => {
                        let frame = &expect["frame"];
                        assert_eq!(result.expect(name), Frame { kind: kind(frame), data: data(frame) }, "{name}");
                        assert_eq!(receiver.nonce(), nonce(&expect["next_nonce"]), "{name}");
                    }
                }
            }
            other => panic!("{name}: unknown stage {other}"),
        }
    }
    assert_eq!(stages.keys().copied().collect::<Vec<_>>(), ["decode", "encode", "handshake", "record"]);
    assert!(derivations["message_2_hex"].is_string());
}

#[test]
fn refuses_a_responder_key_whose_shared_secret_is_zero() {
    // a low-order point: every DH with it is all zero, so it would key the channel with a constant
    assert_eq!(ClientHandshake::start(&[0; 32]).map(|_| ()), Err(Error::InvalidDhPublicKey));
}

#[test]
fn refuses_a_parameter_payload_it_does_not_know() {
    use crate::channel::decode_params;
    assert_eq!(decode_params(&[0x01, 0x01]), Ok(true));
    assert_eq!(decode_params(&[0x01, 0x00]), Ok(false));
    assert_eq!(decode_params(&[0x01]), Err(Error::InvalidParameterPayload));
    assert_eq!(decode_params(&[0x01, 0x01, 0x00]), Err(Error::InvalidParameterPayload));
    assert_eq!(decode_params(&[0x02, 0x01]), Err(Error::UnsupportedParameterVersion));
    assert_eq!(decode_params(&[0x01, 0x03]), Err(Error::ReservedParameterFlag));
}

#[test]
fn never_seals_what_the_peer_would_refuse_and_closes_instead() {
    let mut channel = reference_channel();
    let largest = channel.seal(FrameKind::Binary, &vec![7; MAX_MUX_FRAME_BYTES]).expect("the largest mux frame");
    assert_eq!(largest.len(), MAX_CARRIER_BINARY_BYTES);
    assert_eq!(channel.seal(FrameKind::Binary, &vec![7; MAX_MUX_FRAME_BYTES + 1]), Err(Error::FrameTooLarge));
    assert!(!channel.is_open());
}

#[test]
fn refuses_a_text_frame_that_is_not_utf8_and_closes() {
    // a record the peer sealed correctly, of kind text, whose data is not UTF-8: secure-channel.ts's
    // fatal TextDecoder refuses it, so this side does too, and the channel ends
    let mut channel = reference_channel();
    let (_, receive) = channel.keys_for_test();
    let record = records::encode(FrameKind::Text, b"ok \xff\xfe", &mut CipherState::with_nonce(receive, 0)).unwrap();
    assert_eq!(channel.open(&record), Err(Error::InvalidText));
    assert!(!channel.is_open());
    let mut channel = reference_channel();
    let record = records::encode(FrameKind::Text, "ünï".as_bytes(), &mut CipherState::with_nonce(receive, 0)).unwrap();
    assert_eq!(channel.open(&record).map(|frame| frame.data), Ok("ünï".as_bytes().to_vec()));
}

#[test]
fn reports_only_fixed_error_texts() {
    // what a failure prints is the error's text alone: it can carry no byte of a key
    let derivations = &records()["derivations"];
    let mut forged = bytes(&derivations["message_2_hex"]);
    *forged.last_mut().unwrap() ^= 1;
    let error = reference_start(key(&derivations["responder_static_public_hex"])).0.finish(&forged).expect_err("a forged message 2");
    assert_eq!(error.to_string(), "authentication failed");
    assert_eq!(format!("{error:?}"), "AuthenticationFailed");
}

/// Every form a key's bytes could take in formatted text.
fn forms(key: &[u8; 32]) -> Vec<String> {
    let list = format!("{key:?}");
    vec![hex::encode(key), hex::encode(key).to_uppercase(), list.clone(), list[1..list.len() - 1].split(", ").take(3).collect::<Vec<_>>().join(", ")]
}
fn assert_hides(text: &str, keys: &[[u8; 32]]) {
    for key in keys {
        for form in forms(key) {
            assert!(!text.contains(&form), "formatted text shows key bytes {form}: {text}");
        }
    }
}

#[test]
fn formats_no_key_holding_type_with_its_key() {
    let send_key = [0xa5; 32];
    let distinct: [u8; 32] = std::array::from_fn(|i| 200 - i as u8);
    let cipher = CipherState::with_nonce(distinct, 9);
    for text in [format!("{cipher:?}"), format!("{cipher:#?}")] {
        assert!(text.contains("CipherState"), "{text}");
        assert_hides(&text, &[distinct]);
    }
    drop(CipherState::with_nonce(send_key, 0));

    let derivations = &records()["derivations"];
    let ephemeral = key(&derivations["initiator_ephemeral_secret_hex"]);
    let responder = key(&derivations["responder_static_public_hex"]);
    let initiator = Initiator::new(responder, crate::channel::PROLOGUE, StaticSecret::from(ephemeral));
    assert_hides(&format!("{initiator:?}{initiator:#?}"), &[ephemeral]);
    let (awaiting, _) = initiator.write_message(&[1, 1]).unwrap();
    let chaining = awaiting.chaining_key_for_test();
    assert_hides(&format!("{awaiting:?}{awaiting:#?}"), &[ephemeral, chaining]);
    let (handshake, _) = reference_start(responder);
    assert_hides(&format!("{handshake:?}{handshake:#?}"), &[ephemeral, handshake.chaining_key_for_test()]);
    let channel = handshake.finish(&bytes(&derivations["message_2_hex"])).unwrap();
    let (send, receive) = channel.keys_for_test();
    assert_hides(&format!("{channel:?}{channel:#?}"), &[send, receive, channel.binding()]);
    let frame = Frame { kind: FrameKind::Binary, data: send.to_vec() };
    assert_hides(&format!("{frame:?}{frame:#?}"), &[send]);

    // the types todo 23 added that hold a key, a token or a bearer
    use crate::machine_key::MachineKey;
    use crate::mux::{Advert, Endpoint, Health, Outgoing, UpDown, Versions};
    use crate::session::{Session, SessionConfig};
    let scalar: [u8; 32] = std::array::from_fn(|i| 0x30 + i as u8);
    let token: [u8; 32] = [0xc4; 32];
    let bearer: [u8; 32] = std::array::from_fn(|i| 0x41 + (i % 26) as u8);
    let key = MachineKey::from_scalar(&scalar).unwrap();
    let advert = Advert {
        endpoints: vec![Endpoint::Bridge, Endpoint::Native],
        runtime_id: "rt".into(),
        boot_id: "boot".into(),
        bridge_token: Some(zeroize::Zeroizing::new(hex::encode(&token))),
        native_bearer: Some(zeroize::Zeroizing::new(String::from_utf8(bearer.to_vec()).unwrap())),
        health: Health { runtime: UpDown::Up, bridge: UpDown::Up },
        now: 1,
        versions: Versions { server: "1".into(), link: "1".into(), agent: "1".into(), runtime: "1".into() },
    };
    let bearer_text = String::from_utf8(bearer.to_vec()).unwrap();
    let hides_secrets = |text: &str| {
        assert_hides(text, &[scalar, token]);
        assert!(!text.contains(&bearer_text), "formatted text shows the bearer: {text}");
    };
    hides_secrets(&format!("{key:?}{key:#?}"));
    hides_secrets(&format!("{advert:?}{advert:#?}"));
    let frame = Outgoing::PipeAdvert(advert.clone());
    hides_secrets(&format!("{frame:?}{frame:#?}"));
    let signature = key.sign_auth(&[1; 32], "0123456789abcdef0123456789abcdef", &[2; 32]);
    let auth = Outgoing::Auth(crate::mux::Auth { machine_id: key.machine_id().into(), signature, features: Vec::new(), seen_state: None });
    let signature_half: [u8; 32] = signature[..32].try_into().unwrap();
    assert_hides(&format!("{auth:?}{auth:#?}"), &[signature_half]);
    let config = SessionConfig { key: MachineKey::from_scalar(&scalar).unwrap(), server_id: "0123456789abcdef0123456789abcdef".into(), advert: Some(advert), binary_ciphertext: true, enroll: None, seen_state: None };
    hides_secrets(&format!("{config:?}{config:#?}"));
    let session = Session::new(config, [3; 32], 0);
    hides_secrets(&format!("{session:?}{session:#?}"));
    let json = crate::json::parse(format!("{{\"bridge_token\":\"{}\"}}", hex::encode(&token)).as_bytes()).unwrap();
    hides_secrets(&format!("{json:?}{json:#?}"));
    let message = crate::carrier::Message::Binary(scalar.to_vec());
    hides_secrets(&format!("{message:?}{message:#?}"));
    let error = crate::machine_key::KeyError::NotAScalar;
    hides_secrets(&format!("{error:?}{error}"));

    // the types todo 24 added that hold a token or a bearer
    let file = format!("{{\"v\":1,\"runtime_id\":\"rt\",\"boot_id\":\"boot\",\"bridge_port\":1,\"bridge_token\":\"{}\",\"native_bearer\":\"{bearer_text}\",\"versions\":{{\"server\":\"1\",\"agent\":\"1\",\"runtime\":\"1\"}}}}", hex::encode(&token));
    let advert_file = crate::advert_file::parse(file.as_bytes()).unwrap();
    hides_secrets(&format!("{advert_file:?}{advert_file:#?}"));
    let made = advert_file.advert(true, 0);
    hides_secrets(&format!("{made:?}{made:#?}"));
    for error in [crate::advert_file::AdvertError::Field, crate::advert_file::AdvertError::NotJson] {
        hides_secrets(&format!("{error:?}{error}"));
    }
}
