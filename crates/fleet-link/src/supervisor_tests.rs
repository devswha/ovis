//! crate::supervisor on a clock the test moves and a jitter source the test chooses: no sleep, no
//! thread, no socket.

use std::collections::VecDeque;

use crate::mux::{Cause, RelayPace, SessionError};
use crate::pace::{Timeline, RELAY_ANSWER_MS};
use crate::supervisor::{first_dial_delay, Backoff, Command, Failure, Input, Millis, Route, State, Supervisor, BACKOFF_CAP_MS, DIRECT_BUDGET_MS, FIRST_DIAL_SPREAD_MS, PROBE_EVERY_MS, STABLE_MS};

struct Rig {
    supervisor: Supervisor,
    now: Millis,
    units: VecDeque<f64>,
    commands: Vec<(Millis, Command)>,
}

impl Rig {
    fn new(direct: usize, relay: bool) -> Self {
        let mut rig = Rig { supervisor: Supervisor::new(direct, relay), now: 0, units: VecDeque::new(), commands: Vec::new() };
        rig.supervisor.start(0);
        rig.drain();
        rig
    }
    fn drain(&mut self) -> Vec<Command> {
        let mut out = Vec::new();
        while let Some(command) = self.supervisor.poll() {
            self.commands.push((self.now, command));
            out.push(command);
        }
        out
    }
    fn input(&mut self, input: Input) -> Vec<Command> {
        let mut units = std::mem::take(&mut self.units);
        let mut draw = || units.pop_front().unwrap_or(1.0);
        self.supervisor.input(input, self.now, &mut draw);
        self.units = units;
        self.drain()
    }
    /// Moves the clock `ms` ahead, ticking at every deadline on the way.
    fn advance(&mut self, ms: Millis) -> Vec<Command> {
        let until = self.now + ms;
        let mut out = Vec::new();
        loop {
            let next = self.supervisor.next_deadline().filter(|deadline| *deadline <= until);
            self.now = next.unwrap_or(until).max(self.now);
            let mut units = std::mem::take(&mut self.units);
            let mut draw = || units.pop_front().unwrap_or(1.0);
            self.supervisor.tick(self.now, &mut draw);
            self.units = units;
            out.extend(self.drain());
            if next.is_none() || self.now >= until {
                return out;
            }
        }
    }
    fn dials(commands: &[Command]) -> Vec<(u64, Route)> {
        commands.iter().filter_map(|command| if let Command::Dial { id, route } = command { Some((*id, *route)) } else { None }).collect()
    }
}

/// When the last Dial went out.
fn last_dial_at(rig: &Rig) -> Millis {
    rig.commands.iter().rev().find(|(_, command)| matches!(command, Command::Dial { .. })).map(|(at, _)| *at).unwrap()
}

fn direct_ids(commands: &[Command]) -> Vec<u64> {
    Rig::dials(commands).into_iter().filter(|(_, route)| matches!(route, Route::Direct(_))).map(|(id, _)| id).collect()
}

/// A deterministic stream of draws in 0..=1.
struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (self.0 >> 11) as f64 / (1u64 << 53) as f64
    }
}

#[test]
fn backs_off_from_1_s_to_60_s_with_full_jitter() {
    let mut backoff = Backoff::default();
    let mut ceilings = Vec::new();
    for _ in 0..9 {
        ceilings.push(backoff.ceiling());
        assert_eq!(backoff.next(1.0), *ceilings.last().unwrap(), "the largest draw is the ceiling itself");
    }
    assert_eq!(ceilings, [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]);
    for _ in 0..100 {
        backoff.next(1.0);
    }
    assert_eq!(backoff.ceiling(), BACKOFF_CAP_MS, "it never passes 60 s, however many failures");

    // full jitter: anywhere from 0 to the ceiling, both ends included
    let mut backoff = Backoff::default();
    assert_eq!(backoff.next(0.0), 0);
    let mut draws = Lcg(7);
    let mut seen = (u64::MAX, 0u64);
    for _ in 0..10_000 {
        let ceiling = backoff.ceiling();
        let delay = backoff.next(draws.next());
        assert!(delay <= ceiling && ceiling <= BACKOFF_CAP_MS, "{delay} within 0..={ceiling}");
        seen = (seen.0.min(delay), seen.1.max(delay));
    }
    assert!(seen.0 < 1_000 && seen.1 > 55_000, "draws spread over the whole range: {seen:?}");
    backoff.reset();
    assert_eq!(backoff.ceiling(), 1_000);
}

#[test]
fn dials_every_direct_carrier_first_and_the_relay_after_1_5_s() {
    let mut rig = Rig::new(2, true);
    let first: Vec<Command> = rig.commands.iter().map(|(_, command)| *command).collect();
    assert_eq!(Rig::dials(&first).iter().map(|(_, route)| *route).collect::<Vec<_>>(), [Route::Direct(0), Route::Direct(1)]);
    assert!(rig.advance(DIRECT_BUDGET_MS - 1).is_empty(), "nothing before the budget is spent");
    let at_budget = rig.advance(1);
    assert_eq!(rig.now, 1_500);
    let ids = direct_ids(&first);
    assert_eq!(at_budget, [Command::Abandon { id: ids[0] }, Command::Abandon { id: ids[1] }, Command::Dial { id: 3, route: Route::Relay }]);
}

#[test]
fn dials_the_relay_at_once_when_every_direct_carrier_has_failed() {
    let mut rig = Rig::new(2, true);
    let ids = direct_ids(&rig.commands.iter().map(|(_, command)| *command).collect::<Vec<_>>());
    rig.advance(200);
    assert!(rig.input(Input::Failed { id: ids[0], failure: Failure::Unreachable }).is_empty());
    assert_eq!(Rig::dials(&rig.input(Input::Failed { id: ids[1], failure: Failure::Unreachable })), [(3, Route::Relay)]);
    assert_eq!(rig.now, 200);
}

#[test]
fn signs_in_on_the_first_direct_carrier_that_proves_the_controller_and_never_dials_the_relay() {
    let mut rig = Rig::new(2, true);
    rig.advance(300);
    assert_eq!(rig.input(Input::Proved { id: 2 }), [Command::Proceed { id: 2 }, Command::Abandon { id: 1 }]);
    assert!(rig.input(Input::Proved { id: 1 }).is_empty(), "an abandoned attempt is not told anything again");
    assert!(Rig::dials(&rig.advance(10 * DIRECT_BUDGET_MS)).is_empty());
    rig.input(Input::SignedIn { id: 2 });
    assert_eq!(rig.supervisor.state(), State::Connected);
    assert_eq!(rig.supervisor.connected(), Some(Route::Direct(1)));
    assert!(rig.advance(PROBE_EVERY_MS * 3).is_empty(), "a direct session is not probed away from");
}

#[test]
fn waits_with_backoff_between_failed_rounds_and_starts_over_after_a_session_that_lasted() {
    let mut rig = Rig::new(0, true);
    let mut waits = Vec::new();
    let mut id = 1;
    for _ in 0..8 {
        rig.input(Input::Failed { id, failure: Failure::Unreachable });
        assert_eq!(rig.supervisor.state(), State::Waiting);
        let failed_at = rig.now;
        let dials = Rig::dials(&rig.advance(BACKOFF_CAP_MS));
        assert_eq!(dials.len(), 1, "one redial per wait");
        waits.push(last_dial_at(&rig) - failed_at);
        id = dials[0].0;
    }
    // the draws are all 1.0: each wait is its ceiling
    assert_eq!(waits, [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);

    // a session that lasted STABLE_MS: the next wait is drawn from 1 s again
    rig.input(Input::Proved { id });
    rig.input(Input::SignedIn { id });
    rig.advance(STABLE_MS);
    rig.input(Input::Ended { id, failure: Failure::CarrierLost });
    let ended = rig.now;
    let next = Rig::dials(&rig.advance(BACKOFF_CAP_MS))[0].0;
    assert_eq!(last_dial_at(&rig) - ended, 1_000);

    // one that did not last keeps climbing
    rig.input(Input::Proved { id: next });
    rig.input(Input::SignedIn { id: next });
    rig.advance(STABLE_MS - 1);
    rig.input(Input::Ended { id: next, failure: Failure::CarrierLost });
    let ended = rig.now;
    rig.advance(BACKOFF_CAP_MS);
    assert_eq!(last_dial_at(&rig) - ended, 2_000);
}

#[test]
fn draws_each_wait_from_the_jitter_source() {
    let mut rig = Rig::new(0, true);
    rig.units = VecDeque::from([0.25]);
    rig.input(Input::Failed { id: 1, failure: Failure::RelayBusy });
    assert_eq!(rig.supervisor.next_deadline(), Some(250));
    assert_eq!(rig.supervisor.last_failure(), Some(Failure::RelayBusy));
}

#[test]
fn switches_from_the_relay_to_a_direct_carrier_with_two_sessions_only_meanwhile() {
    let mut rig = Rig::new(1, true);
    rig.advance(DIRECT_BUDGET_MS);
    rig.input(Input::Proved { id: 2 });
    rig.input(Input::SignedIn { id: 2 });
    assert_eq!(rig.supervisor.connected(), Some(Route::Relay));
    assert_eq!(rig.supervisor.sessions(), 1);
    assert!(rig.advance(PROBE_EVERY_MS - 1).is_empty());
    assert_eq!(Rig::dials(&rig.advance(1)), [(3, Route::Direct(0))]);
    assert_eq!(rig.input(Input::Proved { id: 3 }), [Command::Proceed { id: 3 }]);
    assert_eq!(rig.supervisor.sessions(), 2, "the new session signs in before the old one goes");
    assert_eq!(rig.input(Input::SignedIn { id: 3 }), [Command::Retire { id: 2 }]);
    assert_eq!(rig.supervisor.connected(), Some(Route::Direct(0)));
    rig.advance(5_000);
    rig.input(Input::Ended { id: 2, failure: Failure::GoneAway });
    assert_eq!(rig.supervisor.sessions(), 1);
    assert_eq!(rig.supervisor.state(), State::Connected);
    assert!(rig.advance(PROBE_EVERY_MS * 2).is_empty());
}

#[test]
fn keeps_the_relay_session_when_a_switch_fails_and_tries_again_later() {
    let mut rig = Rig::new(1, true);
    rig.advance(DIRECT_BUDGET_MS);
    rig.input(Input::Proved { id: 2 });
    rig.input(Input::SignedIn { id: 2 });
    rig.advance(PROBE_EVERY_MS);
    assert!(rig.input(Input::Failed { id: 3, failure: Failure::Unreachable }).is_empty(), "the relay session is left alone");
    assert_eq!(rig.supervisor.connected(), Some(Route::Relay));
    assert!(rig.advance(PROBE_EVERY_MS - 1).is_empty());
    assert_eq!(Rig::dials(&rig.advance(1)), [(4, Route::Direct(0))]);
    // a probe that never answers is given up at the budget, the relay session still up
    assert_eq!(rig.advance(DIRECT_BUDGET_MS), [Command::Abandon { id: 4 }]);
    assert_eq!(rig.supervisor.sessions(), 1);
}

#[test]
fn never_holds_more_than_two_sessions_whatever_happens() {
    let mut draws = Lcg(42);
    for seed in 0..50u64 {
        let mut rig = Rig::new(1 + (seed % 4) as usize, seed % 3 != 0);
        let mut open: Vec<u64> = rig.commands.iter().filter_map(|(_, command)| if let Command::Dial { id, .. } = command { Some(*id) } else { None }).collect();
        for _ in 0..2_000 {
            let pick = (draws.next() * 6.0) as usize;
            let commands = if pick == 5 || open.is_empty() {
                rig.advance((draws.next() * 400_000.0) as Millis)
            } else {
                let id = open[(draws.next() * open.len() as f64) as usize % open.len()];
                let input = match pick {
                    0 => Input::Proved { id },
                    1 => Input::SignedIn { id },
                    2 => Input::Failed { id, failure: Failure::Unreachable },
                    3 => Input::Ended { id, failure: Failure::CarrierLost },
                    _ => Input::Ended { id, failure: Failure::GoneAway },
                };
                if matches!(input, Input::Failed { .. } | Input::Ended { .. }) {
                    open.retain(|other| *other != id);
                }
                rig.input(input)
            };
            for command in &commands {
                match command {
                    Command::Dial { id, .. } => open.push(*id),
                    Command::Abandon { id } => open.retain(|other| other != id),
                    _ => {}
                }
            }
            assert!(rig.supervisor.sessions() <= 2, "seed {seed}: {} sessions", rig.supervisor.sessions());
            assert!(rig.supervisor.attempts() <= 5, "seed {seed}: {} attempts", rig.supervisor.attempts());
        }
    }
}

#[test]
fn dials_nothing_more_after_auth_revoked_until_rejoin() {
    for cause in [Cause::Revoked, Cause::Quarantined] {
        let mut rig = Rig::new(1, true);
        rig.advance(100);
        rig.input(Input::Proved { id: 1 });
        rig.input(Input::SignedIn { id: 1 });
        let revoked = Failure::Refused { code: SessionError::AuthRevoked, cause: Some(cause) };
        assert!(revoked.stops());
        assert!(rig.input(Input::Ended { id: 1, failure: revoked }).is_empty());
        assert_eq!(rig.supervisor.state(), State::Stopped);
        assert_eq!(rig.supervisor.next_deadline(), None);
        // an hour on the clock, ticked every second: not one dial
        for _ in 0..3_600 {
            assert!(rig.advance(1_000).is_empty());
        }
        assert_eq!(rig.supervisor.last_failure(), Some(revoked));
        rig.supervisor.resume(rig.now);
        assert_eq!(Rig::dials(&rig.drain()).len(), 1, "rejoin dials again at once");
    }
    // another refusal is retried with backoff
    let mut rig = Rig::new(0, true);
    rig.input(Input::Proved { id: 1 });
    let failed = Failure::Refused { code: SessionError::AuthFailed, cause: Some(Cause::Unknown) };
    assert!(!failed.stops());
    rig.input(Input::Ended { id: 1, failure: failed });
    assert_eq!(rig.supervisor.state(), State::Waiting);
    assert_eq!(Rig::dials(&rig.advance(1_000)).len(), 1);
}

#[test]
fn keeps_dialing_on_its_backoff_after_fleet_token_required() {
    let held = Failure::Refused { code: SessionError::AuthFailed, cause: Some(Cause::FleetTokenRequired) };
    assert!(!held.stops());
    assert_eq!(held.to_string(), "refused: auth_failed (fleet_token_required)");
    let mut rig = Rig::new(0, true);
    let mut id = 1;
    // ten refusals in a row: each is followed by one dial within the backoff's ceiling, never by a stop
    for failures in 0..10u32 {
        rig.input(Input::Proved { id });
        let ceiling = BACKOFF_CAP_MS.min(1_000 << failures);
        assert!(rig.input(Input::Ended { id, failure: held }).is_empty(), "no dial before the backoff");
        assert_eq!(rig.supervisor.state(), State::Waiting, "refusal {failures}");
        assert_eq!(rig.supervisor.last_failure(), Some(held));
        let dials = Rig::dials(&rig.advance(ceiling));
        assert_eq!(dials.len(), 1, "refusal {failures}: one dial within {ceiling} ms");
        id = dials[0].0;
    }
}

#[test]
fn names_each_failure_with_a_fixed_text() {
    assert_eq!(Failure::KeyMismatch.to_string(), "controller key mismatch");
    assert_eq!(Failure::Refused { code: SessionError::AuthRevoked, cause: Some(Cause::Revoked) }.to_string(), "refused: auth_revoked (revoked)");
    assert_eq!(Failure::RelayBusy.to_string(), "relay busy");
}

#[test]
fn starts_the_backoff_over_only_after_a_session_of_30_s() {
    for (lasted, next_wait) in [(29_999, 2_000), (30_000, 1_000)] {
        let mut rig = Rig::new(0, true);
        rig.input(Input::Failed { id: 1, failure: Failure::Unreachable });
        let id = Rig::dials(&rig.advance(BACKOFF_CAP_MS))[0].0;
        rig.input(Input::Proved { id });
        rig.input(Input::SignedIn { id });
        rig.advance(lasted);
        rig.input(Input::Ended { id, failure: Failure::CarrierLost });
        let ended = rig.now;
        rig.advance(BACKOFF_CAP_MS);
        assert_eq!(last_dial_at(&rig) - ended, next_wait, "a session of {lasted} ms");
    }
}

#[test]
fn takes_carriers_an_auth_ok_named_while_the_relay_carries_the_session() {
    // Given a machine with a relay only, signed in through it: nothing to probe
    let mut rig = Rig::new(0, true);
    let relay = Rig::dials(&rig.commands.iter().map(|(_, command)| *command).collect::<Vec<_>>())[0].0;
    rig.input(Input::Proved { id: relay });
    rig.input(Input::SignedIn { id: relay });
    assert_eq!(rig.supervisor.next_deadline(), None);
    // When its AUTH_OK named two direct carriers
    rig.supervisor.set_direct(2, rig.now);
    // Then they are probed after PROBE_EVERY_MS, as fleet.json's own would be
    assert_eq!(rig.supervisor.next_deadline(), Some(rig.now + PROBE_EVERY_MS));
    let probed = rig.advance(PROBE_EVERY_MS);
    assert_eq!(Rig::dials(&probed).iter().map(|(_, route)| *route).collect::<Vec<_>>(), vec![Route::Direct(0), Route::Direct(1)]);
    // And after a loss the next round dials them first
    let mut lost = Rig::new(0, true);
    let relay = Rig::dials(&lost.commands.iter().map(|(_, command)| *command).collect::<Vec<_>>())[0].0;
    lost.input(Input::Proved { id: relay });
    lost.input(Input::SignedIn { id: relay });
    lost.supervisor.set_direct(1, lost.now);
    lost.units.push_back(0.0);
    lost.input(Input::Ended { id: relay, failure: Failure::CarrierLost });
    let round = lost.advance(1);
    assert_eq!(Rig::dials(&round).first().map(|(_, route)| *route), Some(Route::Direct(0)));
}

// ---- the relay pace (todo 37) ----

/// The hosted profile on a timeline that starts at the controller's 1_767_225_600_000 at this rig's 0.
fn hosted(slot: u64) -> Timeline {
    Timeline::received(RelayPace { generation: 1, per_minute: 24, burst: 4, slot, span: 100, controller_ms: 1_767_225_600_000, rtt_ms: 10 }, 0, 0)
}
/// The rig's time of slot `slot`'s instant k cycles after the first one past 1_767_225_600_000.
fn instant(slot: u64, k: u64) -> Millis {
    // 1_767_225_600_000 is 100_000 into a 250_000 ms cycle: slot s's instants are at s * 2_500 - 100_000 + k * 250_000
    (slot * 2_500 + 250_000 * (k + 1)) - 100_000 - if slot * 2_500 > 100_000 { 250_000 } else { 0 }
}
fn paced(direct: usize, slot: u64) -> Rig {
    let mut rig = Rig { supervisor: Supervisor::new(direct, true), now: 0, units: VecDeque::new(), commands: Vec::new() };
    rig.supervisor.set_timeline(hosted(slot));
    rig.supervisor.start(0);
    rig.drain();
    rig
}
fn relay_dials_at(rig: &Rig) -> Vec<Millis> {
    rig.commands.iter().filter(|(_, command)| matches!(command, Command::Dial { route: Route::Relay, .. })).map(|(at, _)| *at).collect()
}

#[test]
fn paced_the_relay_is_dialed_only_at_the_machines_instant() {
    let mut rig = paced(0, 7);
    assert!(Rig::dials(&rig.commands.iter().map(|(_, command)| *command).collect::<Vec<_>>()).is_empty(), "nothing at the loss itself");
    assert_eq!(rig.supervisor.state(), State::Waiting);
    rig.advance(instant(7, 0) - 1);
    assert!(relay_dials_at(&rig).is_empty());
    let dials = Rig::dials(&rig.advance(1));
    assert_eq!(dials.len(), 1);
    assert_eq!(relay_dials_at(&rig), vec![instant(7, 0)]);
}

#[test]
fn paced_a_relay_that_fails_is_dialed_again_one_cycle_later_never_sooner() {
    let mut rig = paced(0, 7);
    for k in 0..4 {
        let at = instant(7, k);
        let dials = Rig::dials(&rig.advance(at - rig.now));
        assert_eq!(dials.len(), 1, "cycle {k}");
        rig.input(Input::Failed { id: dials[0].0, failure: Failure::RelayBusy });
    }
    assert_eq!(relay_dials_at(&rig), (0..4).map(|k| instant(7, k)).collect::<Vec<_>>(), "one dial a cycle of 250 s");
}

#[test]
fn paced_the_instant_does_not_depend_on_when_the_session_was_lost() {
    let mut instants = Vec::new();
    for lost in [1_000, 30_000, 77_777] {
        let mut rig = paced(0, 42);
        let dial = Rig::dials(&rig.advance(instant(42, 0)))[0].0;
        rig.input(Input::Proved { id: dial });
        rig.input(Input::SignedIn { id: dial });
        rig.advance(lost);
        rig.input(Input::Ended { id: dial, failure: Failure::CarrierLost });
        rig.advance(300_000);
        instants.push(relay_dials_at(&rig)[1]);
    }
    assert_eq!(instants, vec![instant(42, 1); 3], "one grid, whatever the loss moment");
}

#[test]
fn paced_two_slots_never_dial_at_one_instant() {
    let mut seen = std::collections::BTreeSet::new();
    for slot in 0..100 {
        let mut rig = paced(0, slot);
        rig.advance(250_000);
        let at = relay_dials_at(&rig);
        assert_eq!(at.len(), 1, "slot {slot}: one dial in one cycle");
        assert!(seen.insert(at[0]), "slot {slot} shares {}", at[0]);
    }
    let sorted: Vec<Millis> = seen.into_iter().collect();
    assert!(sorted.windows(2).all(|pair| pair[1] - pair[0] == 2_500), "one dial every 2.5 s");
}

#[test]
fn paced_a_429_is_retried_once_after_1_to_5_s_then_waits_for_the_next_instant() {
    let mut rig = paced(0, 7);
    let first = Rig::dials(&rig.advance(instant(7, 0)))[0].0;
    rig.units.push_back(0.5);
    rig.input(Input::Failed { id: first, failure: Failure::RelayLimited });
    let retry = Rig::dials(&rig.advance(5_000));
    assert_eq!(retry.len(), 1);
    assert_eq!(relay_dials_at(&rig)[1], instant(7, 0) + 3_000, "1 s + 0.5 x 4 s");
    rig.input(Input::Failed { id: retry[0].0, failure: Failure::RelayLimited });
    rig.advance(240_000);
    assert_eq!(relay_dials_at(&rig).len(), 2, "no third dial before the next instant");
    rig.advance(instant(7, 1) - rig.now);
    assert_eq!(relay_dials_at(&rig)[2], instant(7, 1));
}

#[test]
fn paced_a_relay_dial_the_controller_does_not_answer_within_5_s_is_given_up() {
    let mut rig = paced(0, 7);
    let dial = Rig::dials(&rig.advance(instant(7, 0)))[0].0;
    let out = rig.advance(RELAY_ANSWER_MS);
    assert!(out.contains(&Command::Abandon { id: dial }), "{out:?}");
    assert_eq!(rig.supervisor.last_failure(), Some(Failure::NotAnswering));
    rig.advance(instant(7, 1) - rig.now);
    assert_eq!(relay_dials_at(&rig), vec![instant(7, 0), instant(7, 1)]);
}

#[test]
fn paced_direct_carriers_keep_their_rounds_and_win_over_a_relay_dial() {
    let mut rig = paced(1, 7);
    let first = direct_ids(&rig.commands.iter().map(|(_, command)| *command).collect::<Vec<_>>());
    assert_eq!(first.len(), 1, "the direct carrier at once");
    // every wait drawn at 0: a direct round each time the 1.5 s budget of the last one runs out
    rig.units.extend(std::iter::repeat_n(0.0, 1_000));
    let rounds = rig.advance(instant(7, 0) - 1);
    assert!(direct_ids(&rounds).len() >= 5, "rounds go on: {}", direct_ids(&rounds).len());
    assert!(relay_dials_at(&rig).is_empty(), "the relay waits for its instant");
    let relay = Rig::dials(&rig.advance(1)).into_iter().find(|(_, route)| *route == Route::Relay).expect("the relay at its instant").0;
    let direct = direct_ids(&rig.advance(DIRECT_BUDGET_MS)).first().copied().expect("another direct round");
    let out = rig.input(Input::Proved { id: direct });
    assert!(out.contains(&Command::Abandon { id: relay }), "the relay dial gives way: {out:?}");
}

#[test]
fn a_direct_carriers_retry_hint_holds_the_next_round_back() {
    let mut rig = Rig::new(1, false);
    let first = direct_ids(&rig.commands.iter().map(|(_, command)| *command).collect::<Vec<_>>())[0];
    rig.units.push_back(0.0);
    rig.input(Input::Proved { id: first });
    rig.input(Input::Ended { id: first, failure: Failure::ControllerBusy { retry_after_ms: 7_000 } });
    assert!(direct_ids(&rig.advance(6_999)).is_empty(), "the hint, not the jitter's 0 ms");
    assert_eq!(direct_ids(&rig.advance(1)).len(), 1);
    assert_eq!(Failure::ControllerBusy { retry_after_ms: 7_000 }.to_string(), "controller busy");
}

#[test]
fn paced_a_machine_frozen_for_15_minutes_dials_once_on_waking() {
    let mut rig = paced(0, 7);
    let dial = Rig::dials(&rig.advance(instant(7, 0)))[0].0;
    rig.input(Input::Proved { id: dial });
    rig.input(Input::SignedIn { id: dial });
    rig.advance(1_000);
    rig.input(Input::Ended { id: dial, failure: Failure::CarrierLost });
    // frozen: no tick for 15 minutes, then one
    rig.now += 15 * 60_000;
    let mut draw = || 1.0;
    rig.supervisor.tick(rig.now, &mut draw);
    let woke = rig.drain();
    assert!(Rig::dials(&woke).len() <= 1, "no burst: {woke:?}");
    rig.advance(250_000);
    let dials = relay_dials_at(&rig);
    // after the wake every dial is on one of slot 7's instants, one a cycle at most
    assert!(dials[1..].windows(2).all(|pair| pair[1] - pair[0] >= 250_000), "{dials:?}");
}

#[test]
fn a_room_without_a_fleet_share_says_controller_limit_in_status() {
    let failure = Failure::Refused { code: SessionError::ResourceExhausted, cause: Cause::parse("controller_limit") };
    assert_eq!(failure.to_string(), "refused: resource_exhausted (controller_limit)");
}

// ---- a fresh machine's first relay dial ----

fn fresh(direct: usize) -> Rig {
    let mut rig = Rig { supervisor: Supervisor::new(direct, true), now: 0, units: VecDeque::new(), commands: Vec::new() };
    rig.supervisor.set_timeline(Timeline::fallback("7fda5abbaaccaa974084419f97585cea", 0, 1_767_225_600_000));
    rig.supervisor.set_fresh(true);
    rig.supervisor.start(0);
    rig.drain();
    rig
}

#[test]
fn a_machine_that_never_held_a_pace_dials_the_relay_once_at_once_then_on_its_grid() {
    let mut rig = fresh(0);
    let first = Rig::dials(&rig.advance(0));
    assert_eq!(first.len(), 1, "the relay at once, not at its fallback instant");
    assert!(rig.supervisor.take_fresh_dial(), "recorded once");
    assert!(!rig.supervisor.take_fresh_dial());
    rig.input(Input::Failed { id: first[0].0, failure: Failure::RelayBusy });
    let next = rig.supervisor.next_relay_dial().expect("the next dial is armed");
    assert!(next > 0, "the second dial waits for the grid");
    rig.advance(next - 1);
    assert_eq!(relay_dials_at(&rig), vec![0]);
    rig.advance(1);
    assert_eq!(relay_dials_at(&rig), vec![0, next]);
}

#[test]
fn a_fresh_machine_with_direct_carriers_dials_the_relay_once_their_budget_passed() {
    let mut rig = fresh(1);
    rig.advance(DIRECT_BUDGET_MS - 1);
    assert!(relay_dials_at(&rig).is_empty());
    rig.advance(1);
    assert_eq!(relay_dials_at(&rig), vec![DIRECT_BUDGET_MS]);
}

#[test]
fn a_machine_that_used_its_first_dial_or_heard_a_pace_is_not_fresh() {
    // the daemon found the mark: not fresh, its fallback instant
    let mut rig = Rig { supervisor: Supervisor::new(0, true), now: 0, units: VecDeque::new(), commands: Vec::new() };
    rig.supervisor.set_timeline(Timeline::fallback("7fda5abbaaccaa974084419f97585cea", 0, 1_767_225_600_000));
    rig.supervisor.start(0);
    assert!(Rig::dials(&rig.advance(1_000)).is_empty());
    // a PACE from the controller ends freshness before the first dial went
    let mut heard = fresh(0);
    heard.supervisor.set_timeline(hosted(7));
    let _ = heard.supervisor.take_fresh_dial();
    heard.supervisor.stop(None);
    heard.supervisor.resume(0);
    assert!(Rig::dials(&heard.advance(1_000)).is_empty(), "paced from here on");
}

/// Signs in on a relay dial at slot 7's next instant (or at once when one is due), `pending` as AUTH_OK said.
fn paced_sign_in(rig: &mut Rig, pending: bool) -> u64 {
    let due = rig.supervisor.next_relay_dial().expect("a relay dial armed");
    let dial = Rig::dials(&rig.advance(due.saturating_sub(rig.now))).into_iter().find(|(_, route)| *route == Route::Relay).expect("the relay dial").0;
    rig.input(Input::Proved { id: dial });
    if pending {
        rig.supervisor.mark_pending(dial);
    }
    rig.input(Input::SignedIn { id: dial });
    dial
}

/// The session ends after the controller's GOAWAY: the owner's confirmation (reason `confirmed`) or a shutdown.
fn goaway_ends(rig: &mut Rig, id: u64, confirmed: bool) {
    if confirmed {
        rig.supervisor.mark_confirmed(id);
    }
    rig.input(Input::Ended { id, failure: Failure::GoneAway });
}

#[test]
fn paced_a_confirmed_machine_dials_the_relay_at_once_after_the_goaway_once_per_confirmation() {
    let mut rig = paced(0, 7);
    let first = paced_sign_in(&mut rig, true);
    rig.advance(10_000);
    // the owner confirms: the controller ends the pending session with GOAWAY reason `confirmed`
    goaway_ends(&mut rig, first, true);
    let ended = rig.now;
    assert_eq!(rig.supervisor.next_relay_dial(), Some(ended), "at once, not at the next instant");
    let second = paced_sign_in(&mut rig, true);
    assert_eq!(*relay_dials_at(&rig).last().unwrap(), ended);
    // a second confirmed GOAWAY while still pending gets the paced instant, not another dial at once
    rig.advance(1_000);
    goaway_ends(&mut rig, second, true);
    assert_eq!(rig.supervisor.next_relay_dial(), Some(instant(7, 1)));
    // a session that is not pending gives the next confirmation its dial again
    let third = paced_sign_in(&mut rig, false);
    rig.advance(1_000);
    rig.input(Input::Ended { id: third, failure: Failure::CarrierLost });
    let fourth = paced_sign_in(&mut rig, true);
    rig.advance(1_000);
    goaway_ends(&mut rig, fourth, true);
    assert_eq!(rig.supervisor.next_relay_dial(), Some(rig.now));
}

#[test]
fn paced_a_shutdown_goaway_neither_gives_nor_spends_the_confirmed_dial() {
    let mut rig = paced(0, 7);
    let first = paced_sign_in(&mut rig, true);
    rig.advance(10_000);
    // a graceful controller restart: GOAWAY without a reason to every session; a pending machine stays on its grid
    goaway_ends(&mut rig, first, false);
    assert_eq!(rig.supervisor.next_relay_dial(), Some(instant(7, 1)), "paced, as an active machine");
    let second = paced_sign_in(&mut rig, true);
    rig.advance(3_000);
    // the owner confirms after the restart: still at once
    goaway_ends(&mut rig, second, true);
    assert_eq!(rig.supervisor.next_relay_dial(), Some(rig.now));
}

#[test]
fn paced_a_pending_session_lost_otherwise_waits_for_the_next_instant() {
    let mut rig = paced(0, 7);
    let first = paced_sign_in(&mut rig, true);
    rig.advance(10_000);
    rig.input(Input::Ended { id: first, failure: Failure::CarrierLost });
    assert_eq!(rig.supervisor.next_relay_dial(), Some(instant(7, 1)));
}

#[test]
fn a_fresh_machine_spreads_its_first_dial_over_the_window_and_an_enrolled_one_dials_at_once() {
    assert_eq!(first_dial_delay(false, FIRST_DIAL_SPREAD_MS, 0.7), 0);
    assert_eq!(first_dial_delay(true, 0, 0.7), 0);
    assert_eq!(first_dial_delay(true, FIRST_DIAL_SPREAD_MS, 0.0), 0);
    assert_eq!(first_dial_delay(true, FIRST_DIAL_SPREAD_MS, 0.25), 2_500);
    assert_eq!(first_dial_delay(true, FIRST_DIAL_SPREAD_MS, 1.0), FIRST_DIAL_SPREAD_MS - 1);
    assert_eq!(first_dial_delay(true, FIRST_DIAL_SPREAD_MS, 7.0), FIRST_DIAL_SPREAD_MS - 1);
    // a hundred fresh machines started together: their first dials fall in every tenth of the window, none after it
    let mut draws = Lcg(28);
    let mut tenths = [0u32; 10];
    for _ in 0..100 {
        let delay = first_dial_delay(true, FIRST_DIAL_SPREAD_MS, draws.next());
        assert!(delay < FIRST_DIAL_SPREAD_MS);
        tenths[(delay * 10 / FIRST_DIAL_SPREAD_MS) as usize] += 1;
    }
    assert!(tenths.iter().all(|count| (2..=20).contains(count)), "{tenths:?}");
}

#[test]
fn start_after_waits_the_delay_before_the_first_round_and_dials_nothing_before() {
    let mut supervisor = Supervisor::new(1, true);
    supervisor.start_after(0, 4_000);
    assert!(supervisor.poll().is_none());
    assert_eq!(supervisor.state(), State::Waiting);
    assert_eq!(supervisor.next_deadline(), Some(4_000));
    let mut draw = || 1.0;
    supervisor.tick(3_999, &mut draw);
    assert!(supervisor.poll().is_none());
    supervisor.tick(4_000, &mut draw);
    assert!(matches!(supervisor.poll(), Some(Command::Dial { route: Route::Direct(0), .. })));
    // no delay: the round at once, as start
    let mut now = Supervisor::new(0, true);
    now.start_after(0, 0);
    assert!(matches!(now.poll(), Some(Command::Dial { route: Route::Relay, .. })));
}

#[test]
fn paced_a_relay_session_signed_in_ends_the_wait_for_the_next_direct_round() {
    // a confirmed machine with a direct carrier: the confirmation's GOAWAY sends it to the relay at once and arms the
    // wait before its next direct round; the relay signs in first
    let mut rig = paced(1, 7);
    rig.advance(DIRECT_BUDGET_MS);
    let first = paced_sign_in(&mut rig, true);
    rig.advance(10_000);
    goaway_ends(&mut rig, first, true);
    let relay = paced_sign_in(&mut rig, false);
    assert_eq!(rig.supervisor.connected(), Some(Route::Relay));
    // a direct round now would be no switch: its session would sign in beside the relay one with nothing retiring
    // either, and the controller quarantines a key that holds two sessions past its switch window. The direct
    // carriers are probed as a switch after PROBE_EVERY_MS instead.
    assert!(Rig::dials(&rig.advance(PROBE_EVERY_MS - 1)).is_empty(), "no direct round beside the relay session");
    let probe = Rig::dials(&rig.advance(1));
    assert_eq!(probe.iter().map(|(_, route)| *route).collect::<Vec<_>>(), [Route::Direct(0)]);
    rig.input(Input::Proved { id: probe[0].0 });
    assert_eq!(rig.input(Input::SignedIn { id: probe[0].0 }), [Command::Retire { id: relay }]);
}
