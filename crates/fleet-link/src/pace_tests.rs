//! The relay pace of docs/fleet-link.md (todo 37) against server/fleet/vectors/pace.json, whose
//! `derivations` scripts/fleet-vectors.ts computes with server/fleet/relay-pace.ts: the default
//! slot, the next dial instant after a loss, and the common timeline a PACE starts.

use serde_json::Value;

use crate::mux::RelayPace;
use crate::pace::{default_slot, next_instant, Timeline, DEFAULT_PER_MINUTE, DEFAULT_SPAN, MAX_RELAY_WAIT_MS, STALE_ERROR_MS};

const PACE: &str = include_str!("../../../server/fleet/vectors/pace.json");

fn derivations() -> Value {
    serde_json::from_str::<Value>(PACE).expect("pace.json parses")["derivations"].clone()
}

fn pace(slot: u64, per_minute: u64, controller_ms: u64, rtt_ms: u64) -> RelayPace {
    RelayPace { generation: 1, per_minute, burst: 4, slot, span: 100, controller_ms, rtt_ms }
}

#[test]
fn the_default_slot_is_the_first_four_hex_digits_mod_100() {
    let row = &derivations()["default_slot"];
    assert_eq!(default_slot(row["machine_id"].as_str().unwrap()), row["slot"].as_u64().unwrap());
}

#[test]
fn the_next_instant_after_a_loss_is_the_vectors() {
    for row in derivations()["next_instant"].as_array().unwrap() {
        let per_minute = 60_000 / row["spacing_ms"].as_u64().unwrap();
        let instant = next_instant(row["slot"].as_u64().unwrap(), row["span"].as_u64().unwrap(), per_minute, row["loss_controller_ms"].as_u64().unwrap());
        assert_eq!(instant, row["instant_controller_ms"].as_u64().unwrap(), "{row}");
    }
}

#[test]
fn the_next_instant_does_not_depend_on_when_the_loss_was_within_one_spacing() {
    // slot 7 at 2.5 s: every loss in the 2.5 s before an instant dials at that instant
    let base = 1_767_225_767_500 - 2_500;
    let instants: Vec<u64> = (0..2_500).step_by(97).map(|late| next_instant(7, 100, 24, base + late)).collect();
    assert!(instants.iter().all(|instant| *instant == 1_767_225_767_500), "{instants:?}");
    // and the instant itself is never dialed again: it is not after a loss at that moment
    assert_eq!(next_instant(7, 100, 24, 1_767_225_767_500), 1_767_225_767_500 + 250_000);
}

#[test]
fn before_any_pace_a_machine_uses_24_a_minute_span_100_and_its_default_slot() {
    let timeline = Timeline::fallback("7fda5abbaaccaa974084419f97585cea", 1_000, 1_767_225_600_000);
    assert_eq!((timeline.pace.per_minute, timeline.pace.span, timeline.pace.slot), (DEFAULT_PER_MINUTE, DEFAULT_SPAN, 30));
    assert!(timeline.stale(1_000, 1_767_225_600_000), "no PACE yet: its offset is a guess from its wall clock");
}

#[test]
fn a_pace_reads_the_controllers_timeline_through_the_offset() {
    // received at the machine's monotonic 5_000 with the controller at 1_767_225_600_000
    let timeline = Timeline::received(pace(7, 24, 1_767_225_600_000, 42), 5_000, 9_000);
    assert_eq!(timeline.controller_at(5_000), 1_767_225_600_000);
    assert_eq!(timeline.controller_at(65_000), 1_767_225_660_000);
    // the next relay dial after a loss at monotonic 5_000, on the machine's own clock
    assert_eq!(timeline.next_dial_after(5_000), 5_000 + (1_767_225_767_500 - 1_767_225_600_000));
    assert!(!timeline.stale(5_000, 9_000));
}

#[test]
fn a_machine_is_stale_past_one_second_of_error_or_when_its_clocks_drift_apart() {
    assert!(Timeline::received(pace(7, 24, 0, STALE_ERROR_MS + 1), 0, 0).stale(0, 0), "an error bound above 1 s");
    let timeline = Timeline::received(pace(7, 24, 1_000_000, 10), 0, 50_000);
    assert!(!timeline.stale(60_000, 110_000), "wall and monotonic moved together");
    // the wall clock moved 15 minutes further than the monotonic one: the machine slept
    assert!(timeline.stale(60_000, 110_000 + 15 * 60_000), "a sleep the monotonic clock did not count");
}

#[test]
fn a_machine_that_slept_rejoins_the_common_timeline_at_one_instant() {
    // received at mono 0 / wall 0; frozen 15 minutes: both clocks moved 15 minutes (a frozen process's monotonic clock runs on)
    let timeline = Timeline::received(pace(7, 24, 1_767_225_600_000, 10), 0, 0);
    let woke = 15 * 60_000;
    assert!(!timeline.stale(woke, woke));
    let dial = timeline.next_dial_after(woke);
    // one instant of its own slot, after the wake, and nothing sooner
    assert_eq!((timeline.controller_at(dial) - 7 * 2_500) % 250_000, 0);
    assert!(dial > woke && dial <= woke + 250_000);
}

#[test]
fn a_pace_whose_cycle_passes_an_hour_still_dials_within_the_hour() {
    // 1 a minute over 4096 slots is a cycle of 68 hours; the slot's next instant may be days away
    let pace = RelayPace { generation: 1, per_minute: 1, burst: 0, slot: 4095, span: 4096, controller_ms: 0, rtt_ms: 0 };
    let timeline = Timeline::received(pace, 1_000, 0);
    assert_eq!(timeline.next_dial_after(1_000), 1_000 + MAX_RELAY_WAIT_MS);
}

#[test]
fn a_pace_with_a_cycle_under_a_minute_is_refused_on_the_wire_and_left_out_of_fleet_json() {
    // 24 a minute over 10 slots: one dial every 25 s from one machine
    let frame = crate::mux::read_incoming(b"\x01\x47\x00\x00\x00\x00\x00\x00{\"generation\":1,\"per_minute\":24,\"burst\":4,\"slot\":7,\"span\":10,\"controller_ms\":0,\"rtt_ms\":0}");
    assert_eq!(frame.map(|_| ()).map_err(|refusal| refusal.code), Err(crate::mux::SessionError::ProtocolError));
    // fleet.json's accepted vector (with its owner block), given a saved pace of 24 a minute over 10 slots
    let files: Value = serde_json::from_str(include_str!("../../../server/fleet/vectors/machine-files.json")).unwrap();
    let accept = files["cases"].as_array().unwrap().iter().find(|entry| entry["name"] == "files/fleet/accept").unwrap();
    let mut fleet: Value = serde_json::from_slice(&crate::hex::decode(accept["bytes"].as_str().unwrap()).unwrap()).unwrap();
    fleet["relay_pace"] = serde_json::json!({"generation":1,"per_minute":24,"burst":4,"slot":7,"span":10,"controller_ms":0,"rtt_ms":0});
    let text = serde_json::to_string(&fleet).unwrap();
    assert_eq!(crate::fleet::parse(text.as_bytes()).unwrap().relay_pace, None);
}
