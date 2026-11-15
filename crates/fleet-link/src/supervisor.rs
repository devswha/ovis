//! When `ovis-link run` dials, and where (docs/fleet-link.md section 5, "Dialing"), with no I/O of its
//! own: what happened goes in with the time, and what to do comes out, so every rule is tested on a
//! clock the test moves.
//!
//! - A round dials every direct carrier of fleet.json at once and gives them [`DIRECT_BUDGET_MS`] to
//!   prove the controller (the Noise handshake against the pinned key); the relay is dialed when that
//!   budget passes, or at once when every direct carrier has failed. The first carrier that proves
//!   the controller is told to go on (HELLO); every other attempt is abandoned.
//! - After a loss, or a round in which nothing proved the controller, the next round waits a delay
//!   drawn uniformly from 0 to a ceiling that starts at 1 s and doubles with each failure up to 60 s
//!   (full jitter). A session that stayed signed in for [`STABLE_MS`] starts the ceiling at 1 s again.
//! - While the relay carries the session, the direct carriers are dialed again [`PROBE_EVERY_MS`]
//!   after sign-in. One that proves the controller opens a second session; once that one is signed
//!   in, the relay session is told to GOAWAY (it drains for 5 s). Two sessions at most, and only then.
//! - `auth_revoked` (`revoked` or `quarantined`) stops dialing until `ovis-link rejoin`. `auth_failed`
//!   `fleet_token_required` (a controller with no OVIS_TOKEN holds its fleet) is temporary: dialing goes on with the
//!   backoff, so the machine signs in again once the controller restarts with its token.
//! - With a relay pace (todo 37, crate::pace) the relay is not dialed with the rounds: only at the
//!   machine's instants of the controller's timeline after its loss, at most once a cycle, each dial
//!   given [`RELAY_ANSWER_MS`]. A relay that answers 429 is tried once more after 1 to 5 s; a second
//!   refusal, a 1013, or no answer waits for the next instant. Rounds keep dialing the direct
//!   carriers meanwhile, and a controller that closes a direct carrier 1013 with `retry_after_ms`
//!   is not dialed there again sooner.
//! - A fresh machine (its fleet.json still holds an invite) dials first after a delay drawn uniformly from 0 to
//!   [`FIRST_DIAL_SPREAD_MS`] ([`first_dial_delay`]): a batch of machines started at the same instant reaches the
//!   controller spread over that window, not all at once. A machine that enrolled before dials at once.

use std::collections::VecDeque;
use std::fmt;

use crate::mux::{Cause, SessionError};
use crate::pace::{Timeline, RELAY_ANSWER_MS, STALE_ERROR_MS};

pub type Millis = u64;

pub const DIRECT_BUDGET_MS: Millis = 1_500;
pub const BACKOFF_FIRST_MS: Millis = 1_000;
pub const BACKOFF_CAP_MS: Millis = 60_000;
pub const STABLE_MS: Millis = 30_000;
pub const PROBE_EVERY_MS: Millis = 5 * 60_000;
/// The window a fresh machine's first dial is spread over. The relay's waiting room holds 17 machines and one fresh
/// sign-in through it takes under a second, so 24 machines started together waited up to 225 s for their first
/// sign-in (one fallback cycle). Spread over 10 s, N machines arrive about N/10 a second: a hundred keep about ten in
/// the waiting room at a time, and a machine joining alone waits 5 s on average, 10 s at most.
pub const FIRST_DIAL_SPREAD_MS: Millis = 10_000;

/// When a machine's first dial is due after its start: at once for one that enrolled before (`fresh` false, its return is
/// paced by the controller), else `unit` (drawn uniformly in `0.0..=1.0`) of `window`, always less than `window`.
pub fn first_dial_delay(fresh: bool, window: Millis, unit: f64) -> Millis {
    if !fresh || window == 0 {
        return 0;
    }
    ((window as f64 * unit.clamp(0.0, 1.0)) as Millis).min(window - 1)
}

/// Exponential backoff with full jitter.
#[derive(Clone, Debug, Default)]
pub struct Backoff {
    failures: u32,
}

impl Backoff {
    /// The ceiling of the next delay: 1 s, 2 s, 4 s ... 32 s, then 60 s.
    pub fn ceiling(&self) -> Millis {
        BACKOFF_CAP_MS.min(BACKOFF_FIRST_MS << self.failures.min(16))
    }
    /// The next delay, `unit` in `0.0..=1.0` drawn uniformly: anywhere from 0 to the ceiling.
    pub fn next(&mut self, unit: f64) -> Millis {
        let ceiling = self.ceiling();
        self.failures = self.failures.saturating_add(1);
        (ceiling as f64 * unit.clamp(0.0, 1.0)).round() as Millis
    }
    pub fn reset(&mut self) {
        self.failures = 0;
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Route {
    /// The n-th direct carrier of fleet.json.
    Direct(usize),
    Relay,
}

/// Why a dial or a session failed: the `error` of `ovis-link status`. Fixed texts only.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    /// fleet.json's `server_id` is not the pinned key's, or the peer could not finish the handshake as that key.
    KeyMismatch,
    /// No connection, or no WebSocket on it.
    Unreachable,
    /// The relay's TLS certificate was refused.
    Certificate,
    /// The relay closed the socket 1013 (a limit: try again later).
    RelayBusy,
    /// The relay answered the upgrade 429 (its per-address budget): one retry after 1 to 5 s.
    RelayLimited,
    /// A direct carrier closed 1013 with `retry_after_ms`: the controller's sign-in queue is full.
    ControllerBusy { retry_after_ms: Millis },
    /// The carrier came up but no controller finished the handshake or sign-in in time.
    NotAnswering,
    /// The carrier closed during the handshake.
    HandshakeRefused,
    CarrierLost,
    /// The controller sent GOAWAY and the session drained.
    GoneAway,
    KeepaliveTimeout,
    /// A frame or record broke the contract (either side).
    Protocol,
    /// The machine key file could not be used when a session began.
    MachineKey,
    /// The controller ended the session with SESSION_ERROR.
    Refused { code: SessionError, cause: Option<Cause> },
}

impl Failure {
    /// A refusal after which dialing stops until `ovis-link rejoin`.
    pub fn stops(self) -> bool {
        matches!(self, Failure::Refused { code: SessionError::AuthRevoked, .. })
    }
}

impl fmt::Display for Failure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Failure::KeyMismatch => f.write_str("controller key mismatch"),
            Failure::Unreachable => f.write_str("controller unreachable"),
            Failure::Certificate => f.write_str("relay certificate refused"),
            Failure::RelayBusy => f.write_str("relay busy"),
            Failure::RelayLimited => f.write_str("relay rate limited"),
            Failure::ControllerBusy { .. } => f.write_str("controller busy"),
            Failure::NotAnswering => f.write_str("controller not answering"),
            Failure::HandshakeRefused => f.write_str("handshake refused"),
            Failure::CarrierLost => f.write_str("carrier lost"),
            Failure::GoneAway => f.write_str("controller went away"),
            Failure::KeepaliveTimeout => f.write_str("keepalive timed out"),
            Failure::Protocol => f.write_str("protocol error"),
            Failure::MachineKey => f.write_str("machine key refused"),
            Failure::Refused { code, cause: Some(cause) } => write!(f, "refused: {code} ({cause})"),
            Failure::Refused { code, cause: None } => write!(f, "refused: {code}"),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Command {
    /// Connect, open the carrier and run the Noise handshake; report Proved or Failed.
    Dial { id: u64, route: Route },
    /// Go on from the handshake to HELLO and sign-in.
    Proceed { id: u64 },
    /// Close it: another carrier won, or its time ran out.
    Abandon { id: u64 },
    /// GOAWAY: a planned switch signed in elsewhere.
    Retire { id: u64 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Input {
    Proved { id: u64 },
    /// The dial failed before the controller was proven.
    Failed { id: u64, failure: Failure },
    SignedIn { id: u64 },
    /// A session that went on (Proceed) ended.
    Ended { id: u64, failure: Failure },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Dialing,
    Connected,
    Waiting,
    Stopped,
}

impl State {
    pub fn as_str(self) -> &'static str {
        match self {
            State::Dialing => "dialing",
            State::Connected => "connected",
            State::Waiting => "waiting",
            State::Stopped => "stopped",
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct Attempt {
    id: u64,
    route: Route,
    /// Dialed while a session was up, to replace it.
    switch: bool,
    proceeding: bool,
    signed_in: Option<Millis>,
    retiring: bool,
    /// Its AUTH_OK said `pending`: the controller waits for the owner to confirm this machine.
    pending: bool,
    /// It ended after the GOAWAY of the owner's confirmation (reason `confirmed`), not a shutdown's.
    confirmed: bool,
}

#[derive(Debug)]
pub struct Supervisor {
    direct: usize,
    relay: bool,
    attempts: Vec<Attempt>,
    next_id: u64,
    backoff: Backoff,
    wait_until: Option<Millis>,
    direct_deadline: Option<Millis>,
    relay_dialed: bool,
    probe_at: Option<Millis>,
    stopped: bool,
    last: Option<Failure>,
    commands: VecDeque<Command>,
    /// The relay pace: with one, the relay is dialed only at the machine's instants.
    timeline: Option<Timeline>,
    /// The next relay instant (this machine's clock), armed while no session is up.
    relay_at: Option<Millis>,
    /// Instants dialed are after this: the loss, then each dial.
    relay_after: Millis,
    /// The paced relay dial under way and when its answer is due.
    relay_deadline: Option<(u64, Millis)>,
    /// A 429 was retried once already since the last instant.
    relay_retried: bool,
    /// Dials of the relay so far (the storm counts them).
    relay_dials: u64,
    /// A machine that never held a PACE (and has not used its one unpaced dial within a cycle): its first relay dial goes
    /// at once, not at its fallback instant, so a new machine shows up in seconds.
    fresh: bool,
    /// The unpaced dial went out and is to be recorded on disk.
    fresh_used: bool,
    /// A pending session ended by the GOAWAY of the owner's confirmation (reason `confirmed`, docs/fleet-link.md section 4):
    /// the next relay dial goes at once, not at the next instant, so a confirmed machine is back in seconds. A shutdown's
    /// GOAWAY neither gives nor spends it.
    confirmed_redial: bool,
    /// That dial was given since the last session that was not pending: one per confirmation, never a stream of them.
    confirmed_redial_spent: bool,
}

impl Supervisor {
    /// `direct` carriers and whether there is a relay, as fleet.json names them.
    pub fn new(direct: usize, relay: bool) -> Self {
        Supervisor {
            direct,
            relay,
            attempts: Vec::new(),
            next_id: 0,
            backoff: Backoff::default(),
            wait_until: None,
            direct_deadline: None,
            relay_dialed: false,
            probe_at: None,
            stopped: false,
            last: None,
            commands: VecDeque::new(),
            timeline: None,
            relay_at: None,
            relay_after: 0,
            relay_deadline: None,
            relay_retried: false,
            relay_dials: 0,
            fresh: false,
            fresh_used: false,
            confirmed_redial: false,
            confirmed_redial_spent: false,
        }
    }

    /// A machine that never held a PACE: one relay dial without waiting for an instant (see `fresh`).
    pub fn set_fresh(&mut self, fresh: bool) {
        self.fresh = fresh;
    }

    /// Session `id`'s AUTH_OK said `pending` (told before its `SignedIn`).
    pub fn mark_pending(&mut self, id: u64) {
        if let Some(attempt) = self.attempts.iter_mut().find(|attempt| attempt.id == id) {
            attempt.pending = true;
        }
    }

    /// Session `id` ended after the GOAWAY of the owner's confirmation (told before its `Ended`).
    pub fn mark_confirmed(&mut self, id: u64) {
        if let Some(attempt) = self.attempts.iter_mut().find(|attempt| attempt.id == id) {
            attempt.confirmed = true;
        }
    }

    /// Whether the fresh machine's unpaced dial went out since the last call (the daemon records it).
    pub fn take_fresh_dial(&mut self) -> bool {
        std::mem::take(&mut self.fresh_used)
    }

    /// When the next relay dial is due, on this machine's clock, while one is armed.
    pub fn next_relay_dial(&self) -> Option<Millis> {
        self.relay_at
    }

    pub fn start(&mut self, now: Millis) {
        self.relay_after = now;
        self.round(now, false);
    }

    /// The relay pace (a PACE, AUTH_OK's `relay_pace`, or the fallback before either): from now on the relay is
    /// dialed at this timeline's instants. An instant already armed is moved to the new timeline's.
    pub fn set_timeline(&mut self, timeline: Timeline) {
        self.timeline = Some(timeline);
        // a pace from the controller: a machine that held none is not fresh any more
        if !timeline.guessed() {
            self.fresh = false;
        }
        if self.relay_at.is_some() && !self.relay_retried && !self.confirmed_redial {
            self.relay_at = Some(timeline.next_dial_after(self.relay_after));
        }
    }

    pub fn timeline(&self) -> Option<&Timeline> {
        self.timeline.as_ref()
    }

    /// Relay dials made so far.
    pub fn relay_dials(&self) -> u64 {
        self.relay_dials
    }

    fn paced(&self) -> bool {
        self.timeline.is_some() && self.relay
    }

    /// Arms the next relay instant after the loss or the last dial, unless one is armed or a session is up.
    fn arm_relay(&mut self) {
        if !self.paced() || self.relay_at.is_some() || self.relay_deadline.is_some() || self.stopped {
            return;
        }
        if self.attempts.iter().any(|attempt| attempt.signed_in.is_some() && !attempt.retiring) {
            return;
        }
        self.relay_at = if self.fresh || self.confirmed_redial { Some(self.relay_after) } else { self.timeline.map(|timeline| timeline.next_dial_after(self.relay_after)) };
    }

    /// A paced relay dial ended without a session: the 429 retry once, else the next instant.
    fn relay_failed(&mut self, failure: Failure, now: Millis, unit: &mut dyn FnMut() -> f64) {
        self.relay_deadline = None;
        self.relay_at = None;
        if failure == Failure::RelayLimited && !self.relay_retried {
            self.relay_retried = true;
            self.relay_at = Some(now + 1_000 + (4_000.0 * unit().clamp(0.0, 1.0)).round() as Millis);
            return;
        }
        self.relay_retried = false;
        self.arm_relay();
    }

    /// The first round, `delay` from `now` ([`first_dial_delay`]): waiting until then, at once when it is 0.
    pub fn start_after(&mut self, now: Millis, delay: Millis) {
        if delay == 0 {
            self.start(now);
        } else {
            // the paced relay counts from the delayed start, as `start` counts from its own
            self.relay_after = now + delay;
            self.wait_until = Some(now + delay);
        }
    }

    /// Dialing stops (a refusal found on disk, or `auth_revoked`): every attempt is abandoned.
    pub fn stop(&mut self, failure: Option<Failure>) {
        self.stopped = true;
        self.last = failure.or(self.last);
        for attempt in self.attempts.drain(..) {
            self.commands.push_back(Command::Abandon { id: attempt.id });
        }
        self.wait_until = None;
        self.direct_deadline = None;
        self.probe_at = None;
        self.relay_at = None;
        self.relay_deadline = None;
    }

    /// `ovis-link rejoin` cleared the refusal: a new round at once, the backoff from its start.
    pub fn resume(&mut self, now: Millis) {
        if self.stopped {
            self.stopped = false;
            self.last = None;
            self.backoff.reset();
            self.relay_after = now;
            self.round(now, false);
        }
    }

    /// The direct carriers changed (an AUTH_OK named others, saved to fleet.json): every round from now dials `direct`,
    /// and a session the relay carries probes them after PROBE_EVERY_MS, as it would fleet.json's own.
    pub fn set_direct(&mut self, direct: usize, now: Millis) {
        self.direct = direct;
        let on_relay = self.connected() == Some(Route::Relay) && !self.switching();
        if direct == 0 {
            if on_relay {
                self.probe_at = None;
            }
        } else if on_relay && self.probe_at.is_none() {
            self.probe_at = Some(now + PROBE_EVERY_MS);
        }
    }

    pub fn poll(&mut self) -> Option<Command> {
        self.commands.pop_front()
    }

    fn dial(&mut self, route: Route, switch: bool) {
        self.next_id += 1;
        let id = self.next_id;
        self.attempts.push(Attempt { id, route, switch, proceeding: false, signed_in: None, retiring: false, pending: false, confirmed: false });
        self.commands.push_back(Command::Dial { id, route });
    }

    fn abandon(&mut self, keep: impl Fn(&Attempt) -> bool) {
        let mut kept = Vec::new();
        for attempt in self.attempts.drain(..) {
            if keep(&attempt) {
                kept.push(attempt);
            } else {
                self.commands.push_back(Command::Abandon { id: attempt.id });
            }
        }
        self.attempts = kept;
    }

    fn round(&mut self, now: Millis, switch: bool) {
        self.relay_dialed = false;
        if self.direct > 0 {
            for index in 0..self.direct {
                self.dial(Route::Direct(index), switch);
            }
            self.direct_deadline = Some(now + DIRECT_BUDGET_MS);
        } else if !switch && self.paced() {
            self.arm_relay();
        } else if !switch && self.relay {
            self.relay_dialed = true;
            self.dial(Route::Relay, false);
        }
    }

    fn wait(&mut self, now: Millis, unit: f64) {
        self.direct_deadline = None;
        self.probe_at = None;
        let hint = match self.last {
            Some(Failure::ControllerBusy { retry_after_ms }) => retry_after_ms.min(BACKOFF_CAP_MS),
            _ => 0,
        };
        self.wait_until = Some(now + self.backoff.next(unit).max(hint));
    }

    fn switching(&self) -> bool {
        self.attempts.iter().any(|attempt| attempt.switch)
    }

    /// What happened, at `now`; `unit` draws the jitter when a wait begins.
    pub fn input(&mut self, input: Input, now: Millis, unit: &mut dyn FnMut() -> f64) {
        let id = match input {
            Input::Proved { id } | Input::Failed { id, .. } | Input::SignedIn { id } | Input::Ended { id, .. } => id,
        };
        let Some(index) = self.attempts.iter().position(|attempt| attempt.id == id) else { return };
        match input {
            Input::Proved { .. } => {
                let attempt = self.attempts[index];
                if self.stopped {
                    self.attempts.remove(index);
                    self.commands.push_back(Command::Abandon { id });
                    return;
                }
                self.attempts[index].proceeding = true;
                self.commands.push_back(Command::Proceed { id });
                // the other carriers of this round are not needed any more
                self.abandon(|other| other.id == id || other.proceeding || other.switch != attempt.switch);
                self.direct_deadline = None;
                // nor the next round: one now would be no switch, and its session would sign in beside this one
                self.wait_until = None;
            }
            Input::Failed { failure, .. } => {
                let attempt = self.attempts.remove(index);
                self.last = Some(failure);
                if attempt.route == Route::Relay && self.paced() && !attempt.switch {
                    self.relay_failed(failure, now, unit);
                }
                self.settle(attempt, now, unit);
            }
            Input::SignedIn { .. } => {
                self.attempts[index].signed_in = Some(now);
                self.relay_at = None;
                self.relay_deadline = None;
                self.relay_retried = false;
                let attempt = self.attempts[index];
                if attempt.switch {
                    self.attempts[index].switch = false;
                    for other in self.attempts.iter_mut().filter(|other| other.id != id && other.signed_in.is_some() && !other.retiring) {
                        other.retiring = true;
                        self.commands.push_back(Command::Retire { id: other.id });
                    }
                }
                self.last = None;
                self.probe_at = (attempt.route == Route::Relay && self.direct > 0).then_some(now + PROBE_EVERY_MS);
                if !attempt.pending {
                    self.confirmed_redial_spent = false;
                }
            }
            Input::Ended { failure, .. } => {
                let attempt = self.attempts.remove(index);
                if failure.stops() {
                    self.stop(Some(failure));
                    return;
                }
                if attempt.retiring {
                    return;
                }
                self.last = Some(failure);
                if attempt.signed_in.is_some_and(|since| now >= since + STABLE_MS) {
                    self.backoff.reset();
                }
                if attempt.signed_in.is_some() {
                    // a loss: the instants that count come after it
                    self.relay_after = self.relay_after.max(now);
                }
                // only the confirmation's GOAWAY: a controller's shutdown (a restart) sends one to every session, and a
                // pending fleet that dialed at once after it would be the burst the pace exists to prevent
                if attempt.pending && attempt.confirmed && attempt.signed_in.is_some() && failure == Failure::GoneAway && !self.confirmed_redial_spent {
                    self.confirmed_redial = true;
                    self.confirmed_redial_spent = true;
                }
                if attempt.route == Route::Relay && attempt.signed_in.is_none() && self.paced() && !attempt.switch {
                    self.relay_failed(failure, now, unit);
                }
                if !attempt.switch {
                    // what was dialed to replace it carries on in its place
                    for other in self.attempts.iter_mut() {
                        other.switch = false;
                    }
                }
                self.settle(attempt, now, unit);
            }
        }
    }

    /// An attempt is gone: dial the relay, wait, or carry on with what is left.
    fn settle(&mut self, attempt: Attempt, now: Millis, unit: &mut dyn FnMut() -> f64) {
        if attempt.switch {
            if !self.switching() {
                self.direct_deadline = None;
                self.probe_at = Some(now + PROBE_EVERY_MS);
            }
            return;
        }
        if self.paced() {
            // the relay waits for its instant (or its dial is under way); the direct carriers are tried again with the backoff
            if self.attempts.iter().any(|other| other.proceeding || matches!(other.route, Route::Direct(_))) {
                return;
            }
            self.arm_relay();
            if self.direct > 0 && self.wait_until.is_none() {
                self.wait(now, unit());
            }
            return;
        }
        if !self.attempts.is_empty() {
            return;
        }
        if self.direct_deadline.is_some() && self.relay && !self.relay_dialed {
            // every direct carrier failed inside the budget: the relay now
            self.direct_deadline = None;
            self.relay_dialed = true;
            self.dial(Route::Relay, false);
            return;
        }
        self.wait(now, unit());
    }

    pub fn tick(&mut self, now: Millis, unit: &mut dyn FnMut() -> f64) {
        if self.stopped {
            return;
        }
        if self.wait_until.is_some_and(|until| now >= until) {
            self.wait_until = None;
            self.round(now, false);
        }
        if self.direct_deadline.is_some_and(|deadline| now >= deadline) {
            self.direct_deadline = None;
            let switching = self.switching();
            self.abandon(|attempt| attempt.proceeding || !matches!(attempt.route, Route::Direct(_)));
            if switching {
                if !self.switching() {
                    self.probe_at = Some(now + PROBE_EVERY_MS);
                }
            } else if self.paced() {
                self.arm_relay();
                if !self.attempts.iter().any(|attempt| attempt.proceeding || matches!(attempt.route, Route::Direct(_))) {
                    self.wait(now, unit());
                }
            } else if self.relay && !self.relay_dialed {
                self.relay_dialed = true;
                self.dial(Route::Relay, false);
            } else if self.attempts.is_empty() {
                self.wait(now, unit());
            }
        }
        if let Some((id, due)) = self.relay_deadline {
            // the controller answered once the handshake proved it (sign-in may wait in its queue)
            let answered = self.attempts.iter().any(|attempt| attempt.id == id && (attempt.proceeding || attempt.signed_in.is_some()));
            if answered || !self.attempts.iter().any(|attempt| attempt.id == id) {
                self.relay_deadline = None;
            } else if now >= due {
                // the controller did not answer within RELAY_ANSWER_MS: the next instant
                self.attempts.retain(|attempt| attempt.id != id);
                self.commands.push_back(Command::Abandon { id });
                self.last = Some(Failure::NotAnswering);
                self.relay_failed(Failure::NotAnswering, now, unit);
                if !self.attempts.iter().any(|attempt| attempt.proceeding || matches!(attempt.route, Route::Direct(_))) && self.direct > 0 && self.wait_until.is_none() {
                    self.wait(now, unit());
                }
            }
        }
        // an instant missed by more than the error bound (a process frozen, a machine asleep) is not dialed late: the
        // next one of the grid is, so a machine that wakes rejoins the common timeline without a burst
        if let (Some(at), Some(timeline)) = (self.relay_at, self.timeline) {
            if now > at + STALE_ERROR_MS && !self.relay_retried && !self.fresh && !self.confirmed_redial {
                self.relay_at = Some(timeline.next_dial_after(now));
            }
        }
        if self.relay_at.is_some_and(|at| now >= at) {
            let busy = self.attempts.iter().any(|attempt| attempt.proceeding || attempt.route == Route::Relay);
            if !busy {
                self.relay_at = None;
                self.relay_after = self.relay_after.max(now);
                self.relay_dials += 1;
                if self.fresh {
                    self.fresh = false;
                    self.fresh_used = true;
                }
                self.confirmed_redial = false;
                self.dial(Route::Relay, false);
                self.relay_deadline = Some((self.next_id, now + RELAY_ANSWER_MS));
            } else if self.attempts.iter().any(|attempt| attempt.signed_in.is_some()) {
                self.relay_at = None;
            }
        }
        if self.probe_at.is_some_and(|at| now >= at) {
            self.probe_at = None;
            let live: Vec<&Attempt> = self.attempts.iter().filter(|attempt| attempt.proceeding).collect();
            if live.len() == 1 && live[0].route == Route::Relay && live[0].signed_in.is_some() {
                self.round(now, true);
            }
        }
    }

    /// When `tick` next has something to do.
    pub fn next_deadline(&self) -> Option<Millis> {
        if self.stopped {
            return None;
        }
        [self.wait_until, self.direct_deadline, self.probe_at, self.relay_at, self.relay_deadline.map(|(_, due)| due)].into_iter().flatten().min()
    }

    pub fn state(&self) -> State {
        if self.stopped {
            State::Stopped
        } else if self.connected().is_some() {
            State::Connected
        } else if self.wait_until.is_some() || (self.relay_at.is_some() && self.attempts.is_empty()) {
            State::Waiting
        } else {
            State::Dialing
        }
    }

    /// The route of the session that carries new pipes.
    pub fn connected(&self) -> Option<Route> {
        self.attempts.iter().rev().find(|attempt| attempt.signed_in.is_some() && !attempt.retiring).map(|attempt| attempt.route)
    }

    /// The attempt id of the session that carries new pipes.
    pub fn connected_id(&self) -> Option<u64> {
        self.attempts.iter().rev().find(|attempt| attempt.signed_in.is_some() && !attempt.retiring).map(|attempt| attempt.id)
    }

    pub fn last_failure(&self) -> Option<Failure> {
        self.last
    }

    /// Sessions told to go on (HELLO) that have not ended: at most two, and two only during a switch.
    pub fn sessions(&self) -> usize {
        self.attempts.iter().filter(|attempt| attempt.proceeding).count()
    }

    /// Attempts under way, sessions included.
    pub fn attempts(&self) -> usize {
        self.attempts.len()
    }
}
