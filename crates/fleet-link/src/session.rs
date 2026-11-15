//! One machine session (docs/fleet-link.md sections 1 to 3), with no I/O of its own: mux frames
//! from the controller go in, frames for the controller and actions on the pipes' targets come
//! out, and the caller supplies the clock. It signs in (HELLO, AUTH `machine-key`, AUTH_OK, then
//! PIPE_ADVERT; a machine holding an invite sends ENROLL first and AUTH once ENROLL_OK came), answers each PIPE_OPEN by asking for a connection to a configured target or with
//! RESET `refused`, and copies bytes under the pipe windows: a target's next read waits until its
//! last chunk went out, and CREDIT follows only bytes written to the target.
//!
//! Sending follows the peer engine's limits (shared/relay-mux-engine.ts): the receipt budget (408
//! KiB of ordinary and 16 KiB of control frames until RECEIVED), and the frame rate. The engine
//! ends a session `resource_exhausted` past 4096 frames a second (a bucket of 8192); this side
//! never sends faster than 3072 a second after a burst of 2048, so carrier delays that bunch up to
//! two seconds of frames still arrive within the peer's bucket. A frame that would pass the rate
//! waits in its queue, and the pipe it belongs to reads nothing more from its target meanwhile.
//! The machine opens nothing, so the engine's 32 opens a second cannot be reached from here.
//!
//! Keepalive (docs/fleet-link.md section 5): once signed in, a session that has heard nothing from
//! the controller for 20 s sends PING, and ends `timeout` when its PONG has not come 60 s later, as
//! the PC keeps a device's session alive (docs/relay.md, "Keepalive"). A new advert replaces the
//! last one whole and resets every pipe whose target it changed `upstream_lost`.

use std::collections::{BTreeMap, VecDeque};
use std::fmt;

use zeroize::Zeroizing;

use crate::carrier;
use crate::invite::{enroll_message, InviteKey};
use crate::machine_key::MachineKey;
use crate::mux::{Advert, Cause, Endpoint, Enroll, GoAway, GoAwayCode, Incoming, Outgoing, PipeReset, Refusal, RelayPace, SessionError, MAX_PIPE_STREAMS, PIPE_WINDOW_BYTES};

pub type Millis = u64;

pub const SETUP_TIMEOUT_MS: Millis = 10_000;
/// Silence from the controller after which a signed-in session sends PING.
pub const KEEPALIVE_IDLE_MS: Millis = 20_000;
/// How long a PING waits for its PONG before the session ends `timeout`.
pub const PONG_TIMEOUT_MS: Millis = 60_000;
pub const SLOW_CONSUMER_MS: Millis = 30_000;
const FAIL_GRACE_MS: Millis = 5_000;
const GOAWAY_DRAIN_MS: u64 = 5_000;
pub const SEND_FRAMES_PER_SECOND: f64 = 3072.0;
pub const SEND_BURST_FRAMES: f64 = 2048.0;
const ORDINARY_FLIGHT_BYTES: usize = 408 * 1024;
const CONTROL_FLIGHT_BYTES: usize = 16 * 1024;
const CONTROL_STREAK: u32 = 8;
/// The engine's 64 KiB control queue, in frames of 16 bytes: a peer that floods PING ends the session.
const CONTROL_QUEUE_FRAMES: usize = 4096;

pub struct SessionConfig {
    pub key: MachineKey,
    /// The controller's id: 32 lowercase hex digits, signed as ASCII in AUTH.
    pub server_id: String,
    /// What PIPE_ADVERT names; a PIPE_OPEN for an endpoint it does not list is refused.
    pub advert: Option<Advert>,
    /// Whether the handshake selected binary ciphertext: what a frame costs on the wire.
    pub binary_ciphertext: bool,
    /// The invite this machine enrols with before its first AUTH (docs/fleet-link.md section 4), or None.
    pub enroll: Option<Enrolment>,
    /// The newest FLEET_STATE this machine kept (fleet.json `seen_state`): presented in AUTH as it came (todo 31).
    pub seen_state: Option<crate::mux::SeenState>,
}

/// An invite as ENROLL presents it: its id, its secret (wiped on drop, never formatted) and the machine's clock.
pub struct Enrolment {
    pub invite_id: String,
    pub secret: Zeroizing<[u8; 32]>,
    /// seconds since the epoch; advisory, the controller judges expiry by its own clock
    pub now: u64,
}

impl fmt::Debug for SessionConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SessionConfig").field("key", &self.key).field("server_id", &self.server_id).field("advert", &self.advert).finish_non_exhaustive()
    }
}

/// What the caller does to a pipe's target.
#[derive(Clone, PartialEq, Eq)]
pub enum Action {
    Connect { id: u32, endpoint: Endpoint },
    Write { id: u32, data: Vec<u8> },
    /// After every earlier write: the controller ended its direction.
    ShutdownWrite { id: u32 },
    /// The target's last chunk went out: read the next one.
    ReadMore { id: u32 },
    /// Close the target at once, both ways: a reset, a retired pipe or the session's end.
    Close { id: u32 },
}

impl fmt::Debug for Action {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Action::Connect { id, endpoint } => write!(f, "Connect({id}, {endpoint})"),
            Action::Write { id, data } => write!(f, "Write({id}, {} bytes)", data.len()),
            Action::ShutdownWrite { id } => write!(f, "ShutdownWrite({id})"),
            Action::ReadMore { id } => write!(f, "ReadMore({id})"),
            Action::Close { id } => write!(f, "Close({id})"),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum End {
    /// The controller ended it with SESSION_ERROR; `cause` when its message is one of section 1's.
    Peer { code: SessionError, cause: Option<Cause> },
    /// This end refused something and sent SESSION_ERROR.
    Local { code: SessionError },
    /// A GOAWAY's drain time passed, or the controller closed the carrier after its GOAWAY.
    Drained,
    /// As `Drained`, after the GOAWAY the controller sends once the owner confirmed this pending machine (reason
    /// `confirmed`): the one end after which the agent dials the relay at once.
    Confirmed,
    CarrierLost,
}

impl fmt::Display for End {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            End::Peer { code, cause: Some(cause) } => write!(f, "the controller ended the session: {code} ({cause})"),
            End::Peer { code, cause: None } => write!(f, "the controller ended the session: {code}"),
            End::Local { code } => write!(f, "the session was ended here: {code}"),
            End::Drained => f.write_str("the session drained after GOAWAY"),
            End::Confirmed => f.write_str("the owner confirmed this machine: the session drained after GOAWAY"),
            End::CarrierLost => f.write_str("the carrier was lost"),
        }
    }
}

#[derive(Default)]
struct Pipe {
    endpoint: Option<Endpoint>,
    connected: bool,
    accept_due: bool,
    /// PIPE_ACCEPT went out: both windows are open.
    accepted: bool,
    received: u64,
    granted: u64,
    consumed: u64,
    credit_due: bool,
    ended_in: bool,
    chunk: Option<Vec<u8>>,
    eof: bool,
    ended_out: bool,
    sent: u64,
    peer_consumed: u64,
    blocked_since: Option<Millis>,
}

struct Flight {
    through: u64,
    control: bool,
    wire: usize,
}

pub struct Session {
    key: MachineKey,
    server_id: String,
    binding: [u8; 32],
    advert: Option<Advert>,
    binary_ciphertext: bool,
    /// The invite, until ENROLL goes out; then the WELCOME nonce AUTH signs once ENROLL_OK came.
    enroll: Option<Enrolment>,
    enroll_nonce: Option<[u8; 32]>,
    /// ENROLL_OK came on this session and nobody has been told yet (take_enrolled).
    enrolled: bool,
    auth_sent: bool,
    signed_in: bool,
    /// The direct carriers the AUTH_OK named, until taken.
    carriers: Option<Vec<String>>,
    /// The newest FLEET_STATE held (presented in AUTH), and one that came on this session and was not taken yet.
    seen_state: Option<crate::mux::SeenState>,
    fresh_state: Option<crate::mux::SeenState>,
    /// AUTH_OK said `pending`: the controller waits for the owner to confirm this machine's batch.
    pending: bool,
    /// The newest relay pace (AUTH_OK's `relay_pace` or a PACE) and when it came, until taken.
    pace: Option<(RelayPace, Millis)>,
    max_pipes: u64,
    last_open_id: u32,
    goaway: bool,
    /// The controller sent GOAWAY: a carrier that closes after it is the controller going away as it said.
    peer_goaway: bool,
    /// That GOAWAY said the owner confirmed this machine (reason `confirmed`).
    confirmed: bool,
    setup_deadline: Option<Millis>,
    drain_deadline: Option<Millis>,
    fatal: Option<(SessionError, &'static str)>,
    fatal_deadline: Option<Millis>,
    end: Option<End>,
    pipes: BTreeMap<u32, Pipe>,
    control: VecDeque<Outgoing>,
    actions: VecDeque<Action>,
    submitted: u64,
    received_frames: u64,
    receipt_sent: u64,
    ledger: VecDeque<Flight>,
    ordinary_flight: usize,
    control_flight: usize,
    tokens: f64,
    refilled: Millis,
    streak: u32,
    cursor: u32,
    /// When the controller was last heard from, and the PING out with when it went (keepalive).
    heard: Millis,
    probe: Option<(u64, Millis)>,
    probes: u64,
}

impl fmt::Debug for Session {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Session")
            .field("machine_id", &self.key.machine_id())
            .field("signed_in", &self.signed_in)
            .field("pipes", &self.pipes.len())
            .field("end", &self.end)
            .finish_non_exhaustive()
    }
}

impl Session {
    /// A session on a channel whose binding is `binding`; HELLO is the first frame out.
    pub fn new(config: SessionConfig, binding: [u8; 32], now: Millis) -> Self {
        Session {
            key: config.key,
            server_id: config.server_id,
            binding,
            advert: config.advert,
            binary_ciphertext: config.binary_ciphertext,
            enroll: config.enroll,
            enroll_nonce: None,
            enrolled: false,
            auth_sent: false,
            signed_in: false,
            carriers: None,
            seen_state: config.seen_state,
            fresh_state: None,
            pending: false,
            pace: None,
            max_pipes: MAX_PIPE_STREAMS,
            last_open_id: 0,
            goaway: false,
            peer_goaway: false,
            confirmed: false,
            setup_deadline: Some(now + SETUP_TIMEOUT_MS),
            drain_deadline: None,
            fatal: None,
            fatal_deadline: None,
            end: None,
            pipes: BTreeMap::new(),
            control: VecDeque::from([Outgoing::Hello]),
            actions: VecDeque::new(),
            submitted: 0,
            received_frames: 0,
            receipt_sent: 0,
            ledger: VecDeque::new(),
            ordinary_flight: 0,
            control_flight: 0,
            tokens: SEND_BURST_FRAMES,
            refilled: now,
            streak: 0,
            cursor: 0,
            heard: now,
            probe: None,
            probes: 0,
        }
    }

    pub fn end(&self) -> Option<End> {
        self.end
    }
    pub fn signed_in(&self) -> bool {
        self.signed_in
    }
    /// Whether the AUTH_OK said the controller holds this machine `pending` (docs/fleet-link.md section 1.6).
    pub fn pending(&self) -> bool {
        self.pending
    }

    /// Whether ENROLL_OK came on this session, once: the invite's secret can go from fleet.json.
    pub fn take_enrolled(&mut self) -> bool {
        std::mem::take(&mut self.enrolled)
    }

    /// The direct carriers the controller named in AUTH_OK, once (None when it named none).
    pub fn take_carriers(&mut self) -> Option<Vec<String>> {
        self.carriers.take()
    }
    /// A FLEET_STATE newer than the one held, once: the agent saves it in fleet.json (todo 31).
    pub fn take_fleet_state(&mut self) -> Option<crate::mux::SeenState> {
        self.fresh_state.take()
    }
    /// The newest relay pace the controller sent and the moment it came (this session's clock), once.
    pub fn take_pace(&mut self) -> Option<(RelayPace, Millis)> {
        self.pace.take()
    }
    pub fn open_pipes(&self) -> usize {
        self.pipes.len()
    }
    pub fn machine_id(&self) -> &str {
        self.key.machine_id()
    }
    fn live(&self) -> bool {
        self.end.is_none() && self.fatal.is_none()
    }

    pub fn receive(&mut self, bytes: &[u8], now: Millis) {
        if !self.live() {
            return;
        }
        self.heard = self.heard.max(now);
        let result = crate::mux::read_incoming(bytes).and_then(|frame| {
            let counted = !matches!(frame, Incoming::Received(_));
            self.dispatch(frame, now).map(|()| counted)
        });
        match result {
            Ok(counted) => {
                if counted && self.live() {
                    self.received_frames += 1;
                }
            }
            Err(refusal) => self.fail(refusal.code, refusal.message, now),
        }
    }

    fn dispatch(&mut self, frame: Incoming, now: Millis) -> Result<(), Refusal> {
        let protocol = |condition: bool, message: &'static str| if condition { Ok(()) } else { Err(Refusal { code: SessionError::ProtocolError, message }) };
        match frame {
            Incoming::Welcome(welcome) => {
                protocol(!self.signed_in, "Unexpected setup frame")?;
                // a WELCOME may go out before HELLO is read, and another after it: one nonce per session
                if !self.auth_sent && self.enroll_nonce.is_none() {
                    self.max_pipes = welcome.limits.max_pipe_streams;
                    match self.enroll.take() {
                        // ENROLL first: AUTH follows on this session once ENROLL_OK came (section 4)
                        Some(enrolment) => {
                            let spki = self.key.spki();
                            let signature = InviteKey::derive(&enrolment.secret, &enrolment.invite_id).sign(&enroll_message(&self.binding, &spki, &enrolment.invite_id));
                            self.control.push_back(Outgoing::Enroll(Enroll { invite_id: enrolment.invite_id, machine_public_key: spki, signature, now: enrolment.now }));
                            self.enroll_nonce = Some(welcome.nonce);
                        }
                        None => self.send_auth(&welcome.nonce),
                    }
                }
            }
            Incoming::EnrollOk { machine_id } => {
                protocol(!self.auth_sent && self.enroll_nonce.is_some(), "Unexpected ENROLL_OK")?;
                protocol(machine_id == self.key.machine_id(), "ENROLL_OK for another machine")?;
                let nonce = self.enroll_nonce.take().expect("checked above");
                self.enrolled = true;
                self.send_auth(&nonce);
            }
            Incoming::AuthOk(ok) => {
                protocol(!self.signed_in && self.auth_sent, "Unexpected setup frame")?;
                protocol(ok.machine_id == self.key.machine_id(), "AUTH_OK for another machine")?;
                self.signed_in = true;
                self.carriers = ok.direct;
                self.pending = ok.pending;
                if let Some(pace) = ok.relay_pace {
                    self.pace = Some((pace, now));
                }
                self.setup_deadline = None;
                if let Some(advert) = &self.advert {
                    self.control.push_back(Outgoing::PipeAdvert(advert.clone()));
                }
            }
            Incoming::FleetState(state) => {
                protocol(self.signed_in, "Unexpected FLEET_STATE")?;
                // the newest is kept: a controller never lowers its generation, and an older one proves less
                if self.seen_state.as_ref().is_none_or(|held| state.generation >= held.generation) {
                    self.seen_state = Some(state.clone());
                    self.fresh_state = Some(state);
                }
            }
            Incoming::SessionError { code, message } => {
                self.close_all();
                self.end = Some(End::Peer { code, cause: Cause::parse(&message) });
            }
            Incoming::GoAway(goaway) => {
                protocol(goaway.last_open_id <= self.last_open_id, "Future GOAWAY watermark")?;
                self.goaway = true;
                self.peer_goaway = true;
                self.confirmed |= goaway.reason.as_deref() == Some(crate::mux::GOAWAY_CONFIRMED);
                let above: Vec<u32> = self.pipes.range(goaway.last_open_id + 1..).map(|(id, _)| *id).collect();
                for id in above {
                    self.drop_pipe(id, None);
                }
                let deadline = now + goaway.drain_ms;
                self.drain_deadline = Some(self.drain_deadline.map_or(deadline, |current| current.min(deadline)));
            }
            Incoming::Pace(pace) => {
                // docs/fleet-link.md section 3: a PACE before AUTH_OK breaks the contract
                protocol(self.signed_in, "Unexpected PACE")?;
                self.pace = Some((pace, now));
            }
            Incoming::Ping(probe) => {
                if self.control.len() >= CONTROL_QUEUE_FRAMES {
                    return Err(Refusal { code: SessionError::ResourceExhausted, message: "Control queue exhausted" });
                }
                self.control.push_back(Outgoing::Pong(probe));
            }
            Incoming::Pong(probe) => {
                if self.probe.is_some_and(|(sent, _)| sent == probe) {
                    self.probe = None;
                }
            }
            Incoming::Received(through) => {
                protocol(through <= self.submitted, "Receipt exceeds submitted frames")?;
                while self.ledger.front().is_some_and(|flight| flight.through <= through) {
                    let flight = self.ledger.pop_front().expect("checked above");
                    if flight.control {
                        self.control_flight -= flight.wire;
                    } else {
                        self.ordinary_flight -= flight.wire;
                    }
                }
            }
            Incoming::Credit { id, consumed } => {
                protocol(id <= self.last_open_id, "Frame for future stream")?;
                if let Some(pipe) = self.pipes.get_mut(&id) {
                    if consumed > pipe.sent {
                        return Err(Refusal { code: SessionError::FlowControlError, message: "CREDIT exceeds sent bytes" });
                    }
                    if consumed > pipe.peer_consumed {
                        pipe.peer_consumed = consumed;
                        pipe.blocked_since = None;
                    }
                }
            }
            Incoming::Reset { id, code } => {
                protocol(id <= self.last_open_id, "Frame for future stream")?;
                protocol(PipeReset::parse(code.as_str()).is_some(), "Invalid RESET code")?;
                self.drop_pipe(id, None);
            }
            Incoming::PipeOpen { id, endpoint } => {
                protocol(self.signed_in, "Unexpected OPEN")?;
                protocol(id == self.last_open_id + 2, "Nonconsecutive OPEN")?;
                self.last_open_id = id;
                let advertised = |endpoint: &Endpoint| self.advert.as_ref().is_some_and(|advert| advert.endpoints.contains(endpoint));
                let endpoint = Endpoint::parse(&endpoint).filter(advertised);
                match endpoint {
                    Some(endpoint) if !self.goaway && (self.pipes.len() as u64) < self.max_pipes => {
                        self.pipes.insert(id, Pipe { endpoint: Some(endpoint), ..Pipe::default() });
                        self.actions.push_back(Action::Connect { id, endpoint });
                    }
                    _ => self.control.push_back(Outgoing::Reset { id, code: PipeReset::Refused }),
                }
            }
            Incoming::PipeData { id, data } => {
                protocol(id <= self.last_open_id, "Frame for future stream")?;
                let Some(pipe) = self.pipes.get_mut(&id) else { return Ok(()) };
                protocol(pipe.accepted && !pipe.ended_in, "Unexpected DATA")?;
                let received = pipe.received + data.len() as u64;
                if received - pipe.granted > PIPE_WINDOW_BYTES {
                    return Err(Refusal { code: SessionError::FlowControlError, message: "DATA exceeds granted credit" });
                }
                pipe.received = received;
                self.actions.push_back(Action::Write { id, data });
            }
            Incoming::PipeEnd { id } => {
                protocol(id <= self.last_open_id, "Frame for future stream")?;
                let Some(pipe) = self.pipes.get_mut(&id) else { return Ok(()) };
                protocol(pipe.accepted && !pipe.ended_in, "Unexpected PIPE_END")?;
                pipe.ended_in = true;
                self.actions.push_back(Action::ShutdownWrite { id });
                self.retire(id);
            }
        }
        Ok(())
    }

    fn send_auth(&mut self, nonce: &[u8; 32]) {
        let signature = self.key.sign_auth(nonce, &self.server_id, &self.binding);
        let auth = crate::mux::Auth { machine_id: self.key.machine_id().to_owned(), signature, features: vec![crate::mux::PACE_FEATURE.to_owned(), crate::mux::FLEET_STATE_FEATURE.to_owned()], seen_state: self.seen_state.clone() };
        self.control.push_back(Outgoing::Auth(auth));
        self.auth_sent = true;
    }

    /// Ends the session with SESSION_ERROR `code`: every pipe is closed with no frame, and the
    /// error goes out as the last frame (dropped when it would pass the receipt budget).
    pub fn fail(&mut self, code: SessionError, message: &'static str, now: Millis) {
        if !self.live() {
            return;
        }
        self.close_all();
        self.control.clear();
        self.fatal = Some((code, message));
        self.fatal_deadline = Some(now + FAIL_GRACE_MS);
    }

    /// The carrier closed: every pipe ends with no frame (docs/fleet-link.md section 2).
    pub fn carrier_lost(&mut self) {
        if self.end.is_none() {
            self.close_all();
            // the controller closes the carrier when its drain ends, which can come before ours: still a drain
            self.end = Some(if self.confirmed { End::Confirmed } else if self.peer_goaway { End::Drained } else { End::CarrierLost });
        }
    }

    /// GOAWAY `shutdown`: no pipe opens on this session any more, and it ends after the drain.
    pub fn go_away(&mut self, now: Millis) {
        if !self.live() || self.goaway {
            return;
        }
        self.goaway = true;
        self.control.push_back(Outgoing::GoAway(GoAway { code: GoAwayCode::Shutdown, last_open_id: self.last_open_id, drain_ms: GOAWAY_DRAIN_MS, reason: None }));
        self.drain_deadline = Some(now + GOAWAY_DRAIN_MS);
    }

    /// A new advert (docs/fleet-link.md section 5): it replaces the last one whole, every open pipe
    /// whose target it changed ends `upstream_lost` (a runtime restart changes `boot_id` and
    /// `native_bearer`; a bridge restart its token; `moved` names targets now at another place), and
    /// once signed in it goes out as PIPE_ADVERT. `None` (no usable advert.json) sends nothing and
    /// ends every pipe: no PIPE_OPEN is taken until an advert comes back.
    pub fn replace_advert(&mut self, advert: Option<Advert>, moved: &[Endpoint]) {
        if !self.live() {
            return;
        }
        let old = self.advert.take();
        let changed = |endpoint: Endpoint| {
            let Some(new) = advert.as_ref().filter(|new| new.endpoints.contains(&endpoint)) else { return true };
            let Some(old) = old.as_ref() else { return true };
            moved.contains(&endpoint)
                || match endpoint {
                    Endpoint::Bridge => old.bridge_token != new.bridge_token,
                    Endpoint::Native => old.native_bearer != new.native_bearer || old.boot_id != new.boot_id || old.runtime_id != new.runtime_id,
                }
        };
        let reset: Vec<Endpoint> = Endpoint::ALL.iter().copied().filter(|endpoint| changed(*endpoint)).collect();
        let ids: Vec<u32> = self.pipes.iter().filter(|(_, pipe)| pipe.endpoint.is_some_and(|endpoint| reset.contains(&endpoint))).map(|(id, _)| *id).collect();
        for id in ids {
            self.drop_pipe(id, Some(PipeReset::UpstreamLost));
        }
        if let (true, Some(advert)) = (self.signed_in, &advert) {
            self.control.push_back(Outgoing::PipeAdvert(advert.clone()));
        }
        self.advert = advert;
    }

    fn close_all(&mut self) {
        let ids: Vec<u32> = self.pipes.keys().copied().collect();
        for id in ids {
            self.drop_pipe(id, None);
        }
    }

    /// Forgets a pipe and closes its target; with `reset`, tells the controller why.
    fn drop_pipe(&mut self, id: u32, reset: Option<PipeReset>) {
        if self.pipes.remove(&id).is_some() {
            self.actions.push_back(Action::Close { id });
            if let Some(code) = reset {
                self.control.push_back(Outgoing::Reset { id, code });
            }
        }
    }

    fn retire(&mut self, id: u32) {
        let done = self.pipes.get(&id).is_some_and(|pipe| pipe.ended_in && pipe.ended_out && pipe.chunk.is_none() && pipe.consumed == pipe.received);
        if done {
            self.drop_pipe(id, None);
        }
    }

    /// The target of pipe `id` accepted the connection; false when the pipe is gone (close it).
    pub fn target_connected(&mut self, id: u32) -> bool {
        if !self.live() {
            return false;
        }
        match self.pipes.get_mut(&id) {
            Some(pipe) if !pipe.connected => {
                pipe.connected = true;
                pipe.accept_due = true;
                true
            }
            _ => false,
        }
    }

    /// The target could not be reached: RESET `upstream_lost` (section 2, decision 13).
    pub fn target_failed(&mut self, id: u32) {
        if self.live() {
            self.drop_pipe(id, Some(PipeReset::UpstreamLost));
        }
    }

    /// The target sent `data` (1 ..= 16376 bytes); its next read waits for ReadMore.
    pub fn target_data(&mut self, id: u32, data: Vec<u8>) {
        if let Some(pipe) = self.pipes.get_mut(&id) {
            debug_assert!(pipe.chunk.is_none() && !data.is_empty() && data.len() <= crate::mux::PIPE_DATA_BYTES);
            pipe.chunk = Some(data);
        }
    }

    /// The target ended its direction: PIPE_END follows its last chunk.
    pub fn target_eof(&mut self, id: u32) {
        if let Some(pipe) = self.pipes.get_mut(&id) {
            pipe.eof = true;
        }
    }

    /// `bytes` the controller sent were written to the target: they are credited.
    pub fn target_written(&mut self, id: u32, bytes: u64) {
        if let Some(pipe) = self.pipes.get_mut(&id) {
            pipe.consumed += bytes;
            pipe.credit_due = true;
            self.retire(id);
        }
    }

    pub fn poll_action(&mut self) -> Option<Action> {
        self.actions.pop_front()
    }

    fn tick(&mut self, now: Millis) {
        if self.end.is_some() {
            return;
        }
        if self.fatal_deadline.is_some_and(|deadline| now >= deadline) {
            let code = self.fatal.map_or(SessionError::InternalError, |(code, _)| code);
            self.end = Some(End::Local { code });
            return;
        }
        if self.fatal.is_some() {
            return;
        }
        if self.setup_deadline.is_some_and(|deadline| now >= deadline) {
            self.fail(SessionError::Timeout, "Mux setup timed out", now);
            return;
        }
        if self.drain_deadline.is_some_and(|deadline| now >= deadline) {
            self.close_all();
            self.end = Some(if self.confirmed { End::Confirmed } else { End::Drained });
            return;
        }
        if self.signed_in {
            match self.probe {
                Some((_, sent)) if now >= sent + PONG_TIMEOUT_MS => {
                    self.fail(SessionError::Timeout, "PONG timed out", now);
                    return;
                }
                None if now >= self.heard + KEEPALIVE_IDLE_MS => {
                    self.probes += 1;
                    self.probe = Some((self.probes, now));
                    self.control.push_back(Outgoing::Ping(self.probes));
                }
                _ => {}
            }
        }
        let slow: Vec<u32> = self.pipes.iter().filter(|(_, pipe)| pipe.blocked_since.is_some_and(|since| now >= since + SLOW_CONSUMER_MS)).map(|(id, _)| *id).collect();
        for id in slow {
            self.drop_pipe(id, Some(PipeReset::SlowConsumer));
        }
    }

    fn refill(&mut self, now: Millis) {
        let elapsed = now.saturating_sub(self.refilled) as f64;
        self.tokens = (self.tokens + elapsed * SEND_FRAMES_PER_SECOND / 1000.0).min(SEND_BURST_FRAMES);
        self.refilled = self.refilled.max(now);
    }

    fn wire(&self, frame_bytes: usize) -> usize {
        carrier::wire_bytes(self.binary_ciphertext, frame_bytes)
    }

    /// The next frame for the controller, when the frame rate and the receipt budget allow one.
    pub fn poll_transmit(&mut self, now: Millis) -> Option<Vec<u8>> {
        self.tick(now);
        if self.end.is_some() {
            return None;
        }
        self.refill(now);
        if self.tokens < 1.0 {
            return None;
        }
        if let Some((code, message)) = self.fatal {
            let frame = Outgoing::SessionError { code, message: message.to_owned() };
            let bytes = frame.encode().ok().filter(|bytes| self.control_flight + self.wire(bytes.len()) <= CONTROL_FLIGHT_BYTES);
            self.end = Some(End::Local { code });
            self.tokens -= 1.0;
            return bytes;
        }
        let bytes = self.select(now)?;
        self.tokens -= 1.0;
        Some(bytes)
    }

    fn commit(&mut self, bytes: &[u8], control: bool) {
        let wire = self.wire(bytes.len());
        self.submitted += 1;
        self.ledger.push_back(Flight { through: self.submitted, control, wire });
        if control {
            self.control_flight += wire;
        } else {
            self.ordinary_flight += wire;
        }
    }

    fn encode(&mut self, frame: &Outgoing, now: Millis) -> Option<Vec<u8>> {
        match frame.encode() {
            Ok(bytes) => Some(bytes),
            Err(_) => {
                self.fail(SessionError::InternalError, "Frame could not be encoded", now);
                None
            }
        }
    }

    fn select(&mut self, now: Millis) -> Option<Vec<u8>> {
        let data_waiting = self.pipes.iter().any(|(_, pipe)| pipe.accept_due || (pipe.accepted && (pipe.chunk.is_some() || (pipe.eof && !pipe.ended_out))));
        if self.streak < CONTROL_STREAK || !data_waiting {
            if self.received_frames > self.receipt_sent {
                self.receipt_sent = self.received_frames;
                self.streak += 1;
                return self.encode(&Outgoing::Received(self.receipt_sent), now);
            }
            if let Some(frame) = self.control.front().cloned() {
                let bytes = self.encode(&frame, now)?;
                if self.control_flight + self.wire(bytes.len()) <= CONTROL_FLIGHT_BYTES {
                    self.control.pop_front();
                    self.commit(&bytes, true);
                    self.streak += 1;
                    return Some(bytes);
                }
            }
            let credit = self.pipes.iter().find(|(_, pipe)| pipe.credit_due).map(|(id, pipe)| (*id, pipe.consumed));
            if let Some((id, consumed)) = credit {
                let bytes = self.encode(&Outgoing::Credit { id, consumed }, now)?;
                if self.control_flight + self.wire(bytes.len()) <= CONTROL_FLIGHT_BYTES {
                    let pipe = self.pipes.get_mut(&id).expect("found above");
                    pipe.credit_due = false;
                    pipe.granted = consumed;
                    self.commit(&bytes, true);
                    self.streak += 1;
                    return Some(bytes);
                }
            }
        }
        let bytes = self.ordinary(now)?;
        self.streak = 0;
        Some(bytes)
    }

    /// The next pipe frame, round robin: PIPE_ACCEPT, then the target's chunk within the window,
    /// then PIPE_END once the target ended and its last chunk went out.
    fn ordinary(&mut self, now: Millis) -> Option<Vec<u8>> {
        let ids: Vec<u32> = self.pipes.range(self.cursor + 1..).chain(self.pipes.range(..=self.cursor)).map(|(id, _)| *id).collect();
        for id in ids {
            let pipe = self.pipes.get(&id).expect("listed above");
            let frame = if pipe.accept_due {
                Outgoing::PipeAccept { id }
            } else if !pipe.accepted {
                continue;
            } else if let Some(chunk) = &pipe.chunk {
                if pipe.sent - pipe.peer_consumed + chunk.len() as u64 > PIPE_WINDOW_BYTES {
                    self.pipes.get_mut(&id).expect("listed above").blocked_since.get_or_insert(now);
                    continue;
                }
                Outgoing::PipeData { id, data: chunk.clone() }
            } else if pipe.eof && !pipe.ended_out {
                Outgoing::PipeEnd { id }
            } else {
                continue;
            };
            let bytes = self.encode(&frame, now)?;
            if self.ordinary_flight + self.wire(bytes.len()) > ORDINARY_FLIGHT_BYTES {
                return None;
            }
            self.commit(&bytes, false);
            self.cursor = id;
            let pipe = self.pipes.get_mut(&id).expect("listed above");
            match frame {
                Outgoing::PipeAccept { .. } => {
                    pipe.accept_due = false;
                    pipe.accepted = true;
                }
                Outgoing::PipeData { data, .. } => {
                    pipe.sent += data.len() as u64;
                    pipe.chunk = None;
                    pipe.blocked_since = None;
                    self.actions.push_back(Action::ReadMore { id });
                }
                _ => {
                    pipe.ended_out = true;
                    self.retire(id);
                }
            }
            return Some(bytes);
        }
        None
    }

    /// When `poll_transmit` or a deadline next needs a call, if nothing else happens first.
    pub fn next_deadline(&self) -> Option<Millis> {
        if self.end.is_some() {
            return None;
        }
        let pending = self.fatal.is_some()
            || self.received_frames > self.receipt_sent
            || !self.control.is_empty()
            || self.pipes.values().any(|pipe| pipe.credit_due || pipe.accept_due || pipe.chunk.is_some() || (pipe.eof && !pipe.ended_out));
        let token = (pending && self.tokens < 1.0).then(|| self.refilled + ((1.0 - self.tokens) * 1000.0 / SEND_FRAMES_PER_SECOND).ceil() as Millis);
        let slow = self.pipes.values().filter_map(|pipe| pipe.blocked_since.map(|since| since + SLOW_CONSUMER_MS)).min();
        let keepalive = (self.signed_in && self.fatal.is_none()).then(|| self.probe.map_or(self.heard + KEEPALIVE_IDLE_MS, |(_, sent)| sent + PONG_TIMEOUT_MS));
        [self.fatal_deadline, self.setup_deadline, self.drain_deadline, token, slow, keepalive].into_iter().flatten().min()
    }

    #[cfg(test)]
    pub(crate) fn stats(&self) -> (u64, u64, usize, usize) {
        (self.submitted, self.received_frames, self.ordinary_flight, self.control_flight)
    }

    /// 2^30 opens cannot be fed: the watermark of the id-exhausted vector is set as they would leave it.
    #[cfg(test)]
    pub(crate) fn set_last_open_id_for_test(&mut self, id: u32) {
        self.last_open_id = id;
    }
}
