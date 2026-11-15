//! The relay pace of docs/fleet-link.md (todo 37) on the machine: one dial schedule for the whole
//! fleet, read on the controller's clock. A PACE (or AUTH_OK's `relay_pace`) gives the machine its
//! slot, the span and the dials a minute, and `controller_ms`, the controller's wall clock when the
//! frame left; the machine keeps `offset = controller_ms - its monotonic clock at receipt`, whose
//! error is at most `rtt_ms` (a frame's one-way delay is at most the round trip). It dials the relay
//! only at the instants `(slot + k * span) * 60000 / per_minute` of that timeline that come after its
//! own loss, so machines that lost their sessions at different moments still dial one per spacing.
//! No clock is shared in advance: every PACE starts the timeline again.

use crate::mux::RelayPace;
use crate::supervisor::Millis;

/// Before its first PACE a machine dials at 24 a minute over a span of 100 (the hosted profile).
pub const DEFAULT_PER_MINUTE: u64 = 24;
pub const DEFAULT_SPAN: u64 = 100;
/// A machine whose error bound passes this is stale: it still dials once a cycle, on its own guess.
pub const STALE_ERROR_MS: u64 = 1_000;
/// A relay dial gets this long for the controller to answer (the app gives 15 s: relay/core.ts).
pub const RELAY_ANSWER_MS: Millis = 5_000;
/// The longest a machine waits for its next relay instant, whatever the pace says: a PACE within its ranges can make a
/// cycle of days (1 a minute over 4096 slots); past an hour the machine dials at the hour instead.
pub const MAX_RELAY_WAIT_MS: Millis = 60 * 60_000;
/// The fallback pace's cycle (100 slots at 24 a minute): how long the fresh machine's one unpaced dial is remembered.
pub const FALLBACK_CYCLE_MS: u64 = DEFAULT_SPAN * 60_000 / DEFAULT_PER_MINUTE;

/// The slot before any PACE: the machine id's first four hex digits, mod 100.
pub fn default_slot(machine_id: &str) -> u64 {
    machine_id.get(..4).and_then(|digits| u64::from_str_radix(digits, 16).ok()).unwrap_or(0) % DEFAULT_SPAN
}

/// The first instant of `slot` strictly after `after` on the controller's clock (ms): the least
/// `n * 60000 / per_minute` above `after` with `n = slot + k * span`. It depends on nothing else.
pub fn next_instant(slot: u64, span: u64, per_minute: u64, after: u64) -> u64 {
    let (span, per_minute) = (u128::from(span.max(1)), u128::from(per_minute.max(1)));
    let slot = u128::from(slot) % span;
    // the least n whose instant n * 60000 / per_minute passes `after`
    let least = u128::from(after) * per_minute / 60_000 + 1;
    let mut n = least - least % span + slot;
    if n < least {
        n += span;
    }
    loop {
        let instant = n * 60_000 / per_minute;
        if instant > u128::from(after) {
            return u64::try_from(instant).unwrap_or(u64::MAX);
        }
        n += span;
    }
}

/// The controller's timeline as one PACE gave it, against this machine's monotonic and wall clocks
/// at receipt (both ms).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Timeline {
    pub pace: RelayPace,
    received_mono: Millis,
    received_wall: u64,
    /// No PACE yet: the controller's clock is guessed from this machine's wall clock.
    guessed: bool,
}

impl Timeline {
    pub fn received(pace: RelayPace, mono: Millis, wall: u64) -> Self {
        Timeline { pace, received_mono: mono, received_wall: wall, guessed: false }
    }

    /// The pace fleet.json kept from an earlier run: its fields hold, its offset does not (this run's monotonic clock
    /// started again), so the controller's clock is guessed from the wall clock and the machine is stale.
    pub fn saved(pace: RelayPace, mono: Millis, wall: u64) -> Self {
        Timeline { pace: RelayPace { controller_ms: wall, ..pace }, received_mono: mono, received_wall: wall, guessed: true }
    }

    /// Before any PACE: 24 a minute, span 100, the default slot, and the wall clock for the controller's.
    pub fn fallback(machine_id: &str, mono: Millis, wall: u64) -> Self {
        let pace = RelayPace { generation: 0, per_minute: DEFAULT_PER_MINUTE, burst: 0, slot: default_slot(machine_id), span: DEFAULT_SPAN, controller_ms: wall, rtt_ms: 0 };
        Timeline { pace, received_mono: mono, received_wall: wall, guessed: true }
    }

    /// No PACE of this run: the controller's clock is a guess (the fallback, or a pace saved by an earlier run).
    pub fn guessed(&self) -> bool {
        self.guessed
    }

    /// The controller's clock at this machine's monotonic `mono`.
    pub fn controller_at(&self, mono: Millis) -> u64 {
        if mono >= self.received_mono {
            self.pace.controller_ms.saturating_add(mono - self.received_mono)
        } else {
            self.pace.controller_ms.saturating_sub(self.received_mono - mono)
        }
    }

    /// This machine's monotonic clock at the controller's `controller`.
    fn mono_at(&self, controller: u64) -> Millis {
        if controller >= self.pace.controller_ms {
            self.received_mono.saturating_add(controller - self.pace.controller_ms)
        } else {
            self.received_mono.saturating_sub(self.pace.controller_ms - controller)
        }
    }

    /// The machine's next relay dial after a loss (or the last dial) at monotonic `mono`, on its own clock.
    pub fn next_dial_after(&self, mono: Millis) -> Millis {
        self.mono_at(next_instant(self.pace.slot, self.pace.span, self.pace.per_minute, self.controller_at(mono))).min(mono.saturating_add(MAX_RELAY_WAIT_MS))
    }

    /// How far the wall clock moved beyond the monotonic one since receipt: a suspend the monotonic
    /// clock did not count (a process merely frozen moves both alike).
    fn drift(&self, mono: Millis, wall: u64) -> u64 {
        let by_wall = i128::from(wall) - i128::from(self.received_wall);
        let by_mono = i128::from(mono) - i128::from(self.received_mono);
        u64::try_from((by_wall - by_mono).unsigned_abs()).unwrap_or(u64::MAX)
    }

    /// Stale: no PACE yet, an error bound above 1 s, or clocks that drifted apart by more (a sleep).
    pub fn stale(&self, mono: Millis, wall: u64) -> bool {
        self.guessed || self.pace.rtt_ms > STALE_ERROR_MS || self.drift(mono, wall) > STALE_ERROR_MS
    }

    /// After a sleep the monotonic clock missed: the timeline goes on from the wall clock, stale until the next PACE.
    pub fn rebase(&mut self, mono: Millis, wall: u64) -> bool {
        let drifted = self.drift(mono, wall) > STALE_ERROR_MS;
        if drifted {
            self.pace.controller_ms = self.controller_at(self.received_mono).saturating_add(wall.saturating_sub(self.received_wall));
            self.received_mono = mono;
            self.received_wall = wall;
            self.guessed = true;
        }
        drifted
    }
}
