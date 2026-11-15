//! `ovis-link run --state <dir>`, `status` and `rejoin` (docs/fleet-link.md section 5): the
//! supervisor of crate::supervisor on the real clock, one thread per carrier attempt, and the files
//! of the state folder. advert.json is looked at every [`POLL_MS`] (a `stat`, and a read only when
//! it changed): no file-watching API is the same on Linux and macOS, and a bounded poll costs one
//! system call a second at most. Nothing here listens on a port.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::advert_file::{self, AdvertFile};
use crate::agent::{Agent, CarrierSink, Clock, Event};
use crate::carrier::{self, CarrierError, Message};
use crate::channel::ClientHandshake;
use crate::dial::{self, Target, CLOSE_TRY_AGAIN};
use crate::exit;
use crate::fleet::{self, Fleet};
use crate::machine_key::MachineKey;
use crate::mux::{Advert, RelayPace, SessionError};
use crate::pace::{Timeline, FALLBACK_CYCLE_MS};
use crate::session::{End, Enrolment, Session, SessionConfig};
use crate::status::{self, Status, StopChange, StopGate, STATUS_FILE, STOPPED_FILE};
use crate::supervisor::{first_dial_delay, Failure, Input, Millis, Route, State, Supervisor, DIRECT_BUDGET_MS, FIRST_DIAL_SPREAD_MS};
use crate::target::{self, Targets};
use crate::Error;

pub const FLEET_FILE: &str = "fleet.json";
pub const ADVERT_FILE: &str = "advert.json";
/// What `ovis-link status` says while the session carrying new pipes signed in `pending` (docs/fleet-link.md section
/// 1.6): connected, but the controller opens no pipe until the owner confirms the machine's batch.
pub const PENDING_STATE: &str = "pending-confirmation";
/// When a machine that never held a PACE used its one unpaced relay dial (wall ms): a restart within one fallback cycle
/// finds it and stays on the grid, so a crash loop cannot turn the first dial into a stream of them.
pub const FIRST_DIAL_FILE: &str = "first-relay-dial";
/// How often advert.json and the stop mark are looked at.
pub const POLL_MS: Millis = 1_000;
/// How often the bridge port is tried while advert.json stays the same.
pub const BRIDGE_CHECK_MS: Millis = 30_000;
const BRIDGE_CONNECT_MS: u64 = 500;
/// TCP, TLS, upgrade and `assigned` on the relay.
const RELAY_CONNECT_MS: u64 = 10_000;
/// From `assigned` to the controller's `e2ee_ready`; the hello goes again every HELLO_REPEAT_MS meanwhile.
const HANDSHAKE_MS: u64 = 10_000;
const HELLO_REPEAT_MS: u64 = 1_000;

fn unix_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_secs())
}

/// How long `ovis-link run` waits before its first dial: a random part of `window` while fleet.json still holds the
/// invite (a machine that has not enrolled yet), none once it enrolled.
pub fn start_delay(fleet: &Fleet, window: Millis, unit: f64) -> Millis {
    first_dial_delay(fleet.invite.is_some(), window, unit)
}

/// The window a fresh machine's first dial is spread over: [`FIRST_DIAL_SPREAD_MS`], or `OVIS_LINK_FIRST_DIAL_SPREAD_MS`
/// (whole milliseconds, at most 60000; 0 dials at once) for tests and for a machine known to join alone.
fn spread_window() -> Millis {
    std::env::var("OVIS_LINK_FIRST_DIAL_SPREAD_MS").ok().and_then(|text| text.parse::<Millis>().ok()).filter(|ms| *ms <= 60_000).unwrap_or(FIRST_DIAL_SPREAD_MS)
}

/// A draw in `0.0..=1.0` from the OS's random source.
fn unit() -> f64 {
    let mut bytes = [0u8; 8];
    if getrandom::fill(&mut bytes).is_err() {
        return 1.0;
    }
    (u64::from_be_bytes(bytes) >> 11) as f64 / (1u64 << 53) as f64
}

/// What advert.json makes now: the advert and its targets.
#[derive(Clone)]
struct Snapshot {
    advert: Option<Advert>,
    targets: Targets,
}

struct AdvertWatch {
    path: PathBuf,
    stamp: Option<(u64, i128, u64)>,
    file: Option<AdvertFile>,
    bridge_up: bool,
    checked: Option<Millis>,
    snapshot: Snapshot,
    note: String,
}

fn stamp(path: &Path) -> Option<(u64, i128, u64)> {
    let metadata = fs::symlink_metadata(path).ok()?;
    let modified = metadata.modified().ok().and_then(|time| time.duration_since(UNIX_EPOCH).ok()).map_or(0, |since| since.as_nanos() as i128);
    #[cfg(unix)]
    let inode = std::os::unix::fs::MetadataExt::ino(&metadata);
    #[cfg(not(unix))]
    let inode = 0;
    Some((metadata.len(), modified, inode))
}

fn bridge_accepts(port: u16) -> bool {
    TcpStream::connect_timeout(&SocketAddr::from((Ipv4Addr::LOCALHOST, port)), Duration::from_millis(BRIDGE_CONNECT_MS)).is_ok()
}

impl AdvertWatch {
    fn new(path: PathBuf) -> Self {
        AdvertWatch { path, stamp: None, file: None, bridge_up: false, checked: None, snapshot: Snapshot { advert: None, targets: Targets::default() }, note: "missing".into() }
    }

    /// Looks again; true when the advert or its targets changed.
    fn poll(&mut self, now: Millis) -> bool {
        let stamp = stamp(&self.path);
        let reloaded = stamp != self.stamp || self.checked.is_none();
        if reloaded {
            self.stamp = stamp;
            self.file = match stamp.map(|_| advert_file::load(&self.path)) {
                None => {
                    self.note = "missing".into();
                    None
                }
                Some(Ok(file)) => {
                    self.note = "ok".into();
                    Some(file)
                }
                Some(Err(error)) => {
                    self.note = error.to_string();
                    None
                }
            };
        }
        let port = self.file.as_ref().and_then(|file| file.bridge.as_ref().map(|(port, _)| *port));
        if reloaded || self.checked.is_none_or(|at| now >= at + BRIDGE_CHECK_MS) {
            self.checked = Some(now);
            self.bridge_up = port.is_some_and(bridge_accepts);
        }
        let advert = self.file.as_ref().map(|file| file.advert(self.bridge_up, unix_now()));
        let targets = self.file.as_ref().map_or_else(Targets::default, |file| file.targets(|| target::runtime_socket(|name| std::env::var_os(name))));
        let same = |old: &Option<Advert>, new: &Option<Advert>| match (old, new) {
            (Some(old), Some(new)) => Advert { now: 0, ..old.clone() } == Advert { now: 0, ..new.clone() },
            (None, None) => true,
            _ => false,
        };
        let changed = !same(&self.snapshot.advert, &advert) || self.snapshot.targets != targets;
        if changed {
            self.snapshot = Snapshot { advert, targets };
        }
        changed
    }
}

struct Context {
    fleet: Fleet,
}

/// What an attempt tells the daemon: the supervisor's input, the direct carriers its AUTH_OK named, that its AUTH_OK
/// said `pending`, that its session ended after the owner's confirmation, that ENROLL_OK came for the invite of that id,
/// or a relay pace.
enum Report {
    Input(Input),
    Carriers(Vec<String>),
    Pending,
    /// The session ended after the GOAWAY of the owner's confirmation (sent before its `Input::Ended`).
    Confirmed,
    Enrolled(String),
    FleetState(crate::mux::SeenState),
    Pace(RelayPace),
}

/// The wall clock in ms since the epoch.
fn wall_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis() as u64)
}

/// Why a carrier closed: the relay's or a controller's 1013 (with the controller's retry hint, if it gave one), else `other`.
fn closed_by(close: &dial::CloseCodeCell, other: Failure) -> Failure {
    match (close.get(), close.retry_after_ms()) {
        (CLOSE_TRY_AGAIN, Some(retry_after_ms)) => Failure::ControllerBusy { retry_after_ms },
        (CLOSE_TRY_AGAIN, None) => Failure::RelayBusy,
        _ => other,
    }
}

/// One carrier attempt, from the dial to the session's end, on a thread of its own.
fn attempt(id: u64, route: Route, context: Arc<Context>, report: Sender<(u64, Report)>, sender: Sender<Event>, events: Receiver<Event>, mut snapshot: Snapshot) {
    let send = |input: Input| {
        let _ = report.send((id, Report::Input(input)));
    };
    let fleet = &context.fleet;
    let (target, budget) = match route {
        Route::Direct(index) => {
            let place = &fleet.direct[index];
            (Target { place, tls: false, direct: true, url: Fleet::direct_url(place) }, DIRECT_BUDGET_MS)
        }
        Route::Relay => {
            let Some(relay) = fleet.relay.as_ref() else { return send(Input::Failed { id, failure: Failure::Unreachable }) };
            (Target { place: &relay.place, tls: relay.tls, direct: false, url: relay.url(&fleet.server_id) }, RELAY_CONNECT_MS)
        }
    };
    let socket = match dial::connect(&target, Instant::now() + Duration::from_millis(budget)) {
        Ok(socket) => socket,
        Err(failure) => return send(Input::Failed { id, failure }),
    };
    let Ok((mut sink, close_code)) = dial::spawn(socket, sender.clone()) else { return send(Input::Failed { id, failure: Failure::Unreachable }) };
    let Ok((handshake, message1)) = ClientHandshake::start(&fleet.server_key) else { return send(Input::Failed { id, failure: Failure::KeyMismatch }) };
    let hello = carrier::hello(&message1);
    if sink.send(Message::Text(hello.clone())).is_err() {
        return send(Input::Failed { id, failure: Failure::HandshakeRefused });
    }
    let deadline = Instant::now() + Duration::from_millis(HANDSHAKE_MS);
    let mut repeat = Instant::now() + Duration::from_millis(HELLO_REPEAT_MS);
    let closed = |_: u16| closed_by(&close_code, Failure::HandshakeRefused);
    let message2 = loop {
        let now = Instant::now();
        if now >= deadline {
            return send(Input::Failed { id, failure: Failure::NotAnswering });
        }
        if now >= repeat {
            // secure-channel.ts sends its hello again every second until the ready comes
            if sink.send(Message::Text(hello.clone())).is_err() {
                return send(Input::Failed { id, failure: closed(close_code.get()) });
            }
            repeat = now + Duration::from_millis(HELLO_REPEAT_MS);
        }
        match events.recv_timeout(deadline.min(repeat).saturating_duration_since(now)) {
            Ok(Event::Carrier(Message::Text(text))) => match carrier::ready(&text) {
                Ok(Some(message2)) => break message2,
                Ok(None) => {}
                Err(_) => return send(Input::Failed { id, failure: Failure::Protocol }),
            },
            Ok(Event::CarrierClosed) => return send(Input::Failed { id, failure: closed(close_code.get()) }),
            Ok(Event::Abandon) | Err(RecvTimeoutError::Disconnected) => return,
            Ok(Event::Advert(update)) => snapshot = Snapshot { advert: update.0, targets: update.1 },
            Ok(_) | Err(RecvTimeoutError::Timeout) => {}
        }
    };
    let channel = match carrier::finish(handshake, &message2) {
        Ok(channel) => channel,
        Err(CarrierError::Handshake(Error::AuthenticationFailed)) => return send(Input::Failed { id, failure: Failure::KeyMismatch }),
        Err(_) => return send(Input::Failed { id, failure: Failure::Protocol }),
    };
    send(Input::Proved { id });
    let mut backlog = Vec::new();
    loop {
        match events.recv() {
            Ok(Event::Proceed) => break,
            Ok(Event::Abandon) | Err(_) => return,
            Ok(Event::Advert(update)) => snapshot = Snapshot { advert: update.0, targets: update.1 },
            Ok(event) => backlog.push(event),
        }
    }
    let key = match MachineKey::load(&fleet.machine_key_file) {
        Ok(key) => key,
        Err(_) => return send(Input::Ended { id, failure: Failure::MachineKey }),
    };
    if let Some(advert) = snapshot.advert.as_mut() {
        advert.now = unix_now();
    }
    let clock = Clock::start();
    // while fleet.json holds an invite, this machine enrols before its first AUTH (docs/fleet-link.md section 4)
    let enroll = fleet.invite.as_ref().map(|invite| Enrolment { invite_id: invite.id.clone(), secret: invite.secret.clone(), now: unix_now() });
    let invite_id = fleet.invite.as_ref().map(|invite| invite.id.clone());
    let config = SessionConfig { key, server_id: fleet.server_id.clone(), advert: snapshot.advert, binary_ciphertext: channel.binary_ciphertext(), enroll, seen_state: fleet.seen_state.clone() };
    let session = Session::new(config, channel.binding(), clock.now());
    let signed_in = std::cell::Cell::new(false);
    let result = Agent::new(session, channel, snapshot.targets, &mut sink as &mut dyn CarrierSink, events, sender, clock)
        .with_backlog(backlog)
        .on_fleet_state(|state| {
            let _ = report.send((id, Report::FleetState(state)));
        })
        .on_enrolled(|| {
            if let Some(invite) = invite_id {
                let _ = report.send((id, Report::Enrolled(invite)));
            }
        })
        .on_signed_in(|carriers, pending| {
            signed_in.set(true);
            if let Some(carriers) = carriers {
                let _ = report.send((id, Report::Carriers(carriers)));
            }
            if pending {
                let _ = report.send((id, Report::Pending));
            }
            send(Input::SignedIn { id });
        })
        .on_pace(|pace| {
            let _ = report.send((id, Report::Pace(pace)));
        })
        .run();
    let failure = match result {
        Ok(End::Peer { code, cause }) => Failure::Refused { code, cause },
        Ok(End::Local { code: SessionError::Timeout }) if signed_in.get() => Failure::KeepaliveTimeout,
        Ok(End::Local { code: SessionError::Timeout }) => Failure::NotAnswering,
        Ok(End::Local { .. }) | Err(_) => Failure::Protocol,
        Ok(End::Drained) => Failure::GoneAway,
        Ok(End::Confirmed) => {
            // the owner confirmed this machine: the supervisor may dial the relay at once (it is told before the end)
            let _ = report.send((id, Report::Confirmed));
            Failure::GoneAway
        }
        Ok(End::CarrierLost) => closed_by(&close_code, Failure::CarrierLost),
    };
    drop(sink);
    send(Input::Ended { id, failure });
}

struct Daemon {
    dir: PathBuf,
    context: Arc<Context>,
    supervisor: Supervisor,
    attempts: HashMap<u64, Sender<Event>>,
    /// Attempts whose AUTH_OK said `pending`, until they end.
    pending: HashSet<u64>,
    advert: AdvertWatch,
    status: Status,
    written: Option<Status>,
    stop: StopGate,
}

impl Daemon {
    fn stop_mark(&self) -> Option<String> {
        fs::read_to_string(self.dir.join(STOPPED_FILE)).ok()
    }

    fn write_stop_mark(&self) -> std::io::Result<()> {
        let text = self.supervisor.last_failure().map_or_else(String::new, |failure| failure.to_string());
        status::write_private(&self.dir, STOPPED_FILE, text.as_bytes(), true)
    }

    fn publish(&mut self, now: Millis) {
        let state = self.supervisor.state();
        let named = match state {
            State::Connected if self.supervisor.connected_id().is_some_and(|id| self.pending.contains(&id)) => PENDING_STATE,
            _ => state.as_str(),
        };
        let next_relay_dial = if state == State::Connected { None } else { self.supervisor.next_relay_dial().map(|at| unix_now() + at.saturating_sub(now).div_ceil(1000)) };
        let path = self.supervisor.connected().map(|route| if matches!(route, Route::Direct(_)) { "direct" } else { "relay" }.to_owned());
        let error = match state {
            State::Connected => None,
            _ => self.supervisor.last_failure().map(|failure| failure.to_string()),
        };
        let error = error.or_else(|| if state == State::Stopped { self.stop_mark().map(|text| text.trim().to_owned()) } else { None });
        let error = match (error, self.stop.unrecorded()) {
            (Some(error), Some(why)) => Some(format!("{error}; could not record it: {why}")),
            (error, _) => error,
        };
        let changed = self.status.state != named || self.status.path != path || self.status.error != error;
        self.status.next_relay_dial = next_relay_dial;
        if changed {
            self.status.since = unix_now();
        }
        self.status.state = named.to_owned();
        self.status.path = path;
        self.status.error = error;
        self.status.advert = Some(self.advert.note.clone());
        if self.written.as_ref() != Some(&self.status) {
            if status::write_private(&self.dir, STATUS_FILE, self.status.to_json().as_bytes(), false).is_err() {
                eprintln!("ovis-link: status.json cannot be written");
            }
            self.written = Some(self.status.clone());
        }
    }

    /// The carriers an AUTH_OK named: dialed from now on and saved as fleet.json `controller.direct`, so a restart
    /// keeps them. Only from a session that proved the pinned controller; a fleet.json that cannot take them (another
    /// controller's by now, or a write that fails) is left as it is, and the carriers hold until the agent restarts.
    fn carriers(&mut self, carriers: Vec<String>, now: Millis) {
        let Some(places) = carriers.iter().map(|carrier| fleet::direct(carrier)).collect::<Option<Vec<_>>>() else { return };
        if places == self.context.fleet.direct {
            return;
        }
        let path = self.dir.join(FLEET_FILE);
        match fleet::with_direct(&path, &self.context.fleet, &carriers) {
            Ok(bytes) => {
                if status::write_private(&self.dir, FLEET_FILE, &bytes, true).is_err() {
                    eprintln!("ovis-link: fleet.json cannot be written; the controller's new carriers hold until the agent restarts");
                }
            }
            Err(why) => {
                eprintln!("ovis-link: the controller's new carriers are not saved: {why}");
                if why == "fleet.json names another controller now" {
                    return;
                }
            }
        }
        let mut fleet = self.context.fleet.clone();
        fleet.direct = places;
        self.supervisor.set_direct(fleet.direct.len(), now);
        self.context = Arc::new(Context { fleet });
    }

    /// A FLEET_STATE newer than the one held (todo 31): presented as `seen_state` at every later sign-in, and saved in
    /// fleet.json (0600, synced) so a restart presents it too. A write that fails keeps it in memory only.
    fn fleet_state(&mut self, state: crate::mux::SeenState) {
        if self.context.fleet.seen_state.as_ref().is_some_and(|held| held.generation > state.generation) {
            return;
        }
        match fleet::with_seen_state(&self.dir.join(FLEET_FILE), &self.context.fleet, &state) {
            Ok(bytes) => {
                if status::write_private(&self.dir, FLEET_FILE, &bytes, true).is_err() {
                    eprintln!("ovis-link: fleet.json cannot be written; the controller's fleet state holds until the agent restarts");
                }
            }
            Err(why) => eprintln!("ovis-link: the controller's fleet state is not saved: {why}"),
        }
        let mut fleet = self.context.fleet.clone();
        fleet.seen_state = Some(state);
        self.context = Arc::new(Context { fleet });
    }

    /// ENROLL_OK came for invite `invite_id`: no session of this agent enrols again, and the secret leaves fleet.json
    /// (0600, synced, one rename), every other key kept. A write that fails leaves the file as it was; a restart then
    /// presents the same invite with the same key, which the controller answers as before.
    fn enrolled(&mut self, invite_id: &str) {
        if self.context.fleet.invite.as_ref().is_none_or(|invite| invite.id != invite_id) {
            return;
        }
        match fleet::without_invite(&self.dir.join(FLEET_FILE), &self.context.fleet, invite_id) {
            Ok(bytes) => {
                if status::write_private(&self.dir, FLEET_FILE, &bytes, true).is_err() {
                    eprintln!("ovis-link: enrolled; fleet.json cannot be written, so its invite stays until it can be");
                }
            }
            Err(why) => eprintln!("ovis-link: enrolled; the invite is not removed from fleet.json: {why}"),
        }
        let mut fleet = self.context.fleet.clone();
        fleet.invite = None;
        self.context = Arc::new(Context { fleet });
    }

    /// A relay pace from the controller: the timeline from now on, and saved in fleet.json (its offset is not: a
    /// restarted agent's monotonic clock starts again, so it is stale until the next PACE).
    fn pace(&mut self, pace: RelayPace, now: Millis) {
        self.supervisor.set_timeline(Timeline::received(pace, now, wall_ms()));
        if self.context.fleet.relay_pace == Some(pace) {
            return;
        }
        match fleet::with_pace(&self.dir.join(FLEET_FILE), &self.context.fleet, &pace) {
            Ok(bytes) => {
                if status::write_private(&self.dir, FLEET_FILE, &bytes, true).is_err() {
                    eprintln!("ovis-link: fleet.json cannot be written; the relay pace holds until the agent restarts");
                }
            }
            Err(why) => eprintln!("ovis-link: the relay pace is not saved: {why}"),
        }
        let mut fleet = self.context.fleet.clone();
        fleet.relay_pace = Some(pace);
        self.context = Arc::new(Context { fleet });
    }

    fn command(&mut self, report: &Sender<(u64, Report)>) {
        while let Some(command) = self.supervisor.poll() {
            match command {
                crate::supervisor::Command::Dial { id, route } => {
                    let (sender, events) = mpsc::channel();
                    self.attempts.insert(id, sender.clone());
                    let context = self.context.clone();
                    let report = report.clone();
                    let snapshot = self.advert.snapshot.clone();
                    thread::spawn(move || attempt(id, route, context, report, sender, events, snapshot));
                }
                crate::supervisor::Command::Proceed { id } => {
                    if let Some(sender) = self.attempts.get(&id) {
                        let _ = sender.send(Event::Proceed);
                    }
                }
                crate::supervisor::Command::Abandon { id } => {
                    if let Some(sender) = self.attempts.remove(&id) {
                        let _ = sender.send(Event::Abandon);
                    }
                }
                crate::supervisor::Command::Retire { id } => {
                    if let Some(sender) = self.attempts.get(&id) {
                        let _ = sender.send(Event::GoAway);
                    }
                }
            }
        }
    }

    fn run(mut self) -> u8 {
        let clock = Instant::now();
        let now = || clock.elapsed().as_millis() as Millis;
        let (report, reports) = mpsc::channel::<(u64, Report)>();
        self.advert.poll(now());
        // the relay pace before the first dial: a starting agent (a reboot of every machine at once) is paced too
        let machine_id = self.status.machine_id.clone().unwrap_or_default();
        // a machine that never held a PACE dials the relay once at once; the mark keeps it to once a fallback cycle
        if self.context.fleet.relay_pace.is_none() {
            let used = fs::read_to_string(self.dir.join(FIRST_DIAL_FILE)).ok().and_then(|text| text.trim().parse::<u64>().ok());
            self.supervisor.set_fresh(used.is_none_or(|at| wall_ms().saturating_sub(at) >= FALLBACK_CYCLE_MS));
        }
        self.supervisor.set_timeline(match self.context.fleet.relay_pace {
            Some(pace) => Timeline::saved(pace, now(), wall_ms()),
            None => Timeline::fallback(&machine_id, now(), wall_ms()),
        });
        self.stop = StopGate::at_start(self.stop_mark().is_some());
        if self.stop.stopped() {
            self.supervisor.stop(None);
        } else {
            // a fresh machine (fleet.json still holds its invite) waits a random part of the spread window first
            self.supervisor.start_after(now(), start_delay(&self.context.fleet, spread_window(), unit()));
        }
        let mut next_poll = now() + POLL_MS;
        loop {
            if self.supervisor.take_fresh_dial() && status::write_private(&self.dir, FIRST_DIAL_FILE, wall_ms().to_string().as_bytes(), true).is_err() {
                eprintln!("ovis-link: the first relay dial cannot be recorded; a restart may dial once more");
            }
            self.command(&report);
            self.publish(now());
            let wake = self.supervisor.next_deadline().map_or(next_poll, |deadline| deadline.min(next_poll));
            match reports.recv_timeout(Duration::from_millis(wake.saturating_sub(now()))) {
                Ok((_, Report::Carriers(carriers))) => self.carriers(carriers, now()),
                Ok((id, Report::Pending)) => {
                    self.pending.insert(id);
                    self.supervisor.mark_pending(id);
                }
                Ok((id, Report::Confirmed)) => self.supervisor.mark_confirmed(id),
                Ok((_, Report::Enrolled(invite_id))) => self.enrolled(&invite_id),
                Ok((_, Report::FleetState(state))) => self.fleet_state(state),
                Ok((_, Report::Pace(pace))) => self.pace(pace, now()),
                Ok((id, Report::Input(input))) => {
                    if matches!(input, Input::Failed { .. } | Input::Ended { .. }) {
                        self.attempts.remove(&id);
                        self.pending.remove(&id);
                    }
                    let before = self.supervisor.state();
                    self.supervisor.input(input, now(), &mut unit);
                    if before != State::Stopped && self.supervisor.state() == State::Stopped {
                        self.stop.refused(self.write_stop_mark());
                        if let Some(why) = self.stop.unrecorded() {
                            eprintln!("ovis-link: stopped: authorization revoked; could not record it: {why}");
                        }
                    }
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return exit::OK,
            }
            // a sleep the monotonic clock missed: the timeline goes on from the wall clock, stale until the next PACE
            if let Some(mut timeline) = self.supervisor.timeline().copied() {
                if timeline.rebase(now(), wall_ms()) {
                    self.supervisor.set_timeline(timeline);
                }
            }
            self.supervisor.tick(now(), &mut unit);
            if now() >= next_poll {
                next_poll = now() + POLL_MS;
                if self.advert.poll(now()) {
                    for sender in self.attempts.values() {
                        let _ = sender.send(Event::Advert(Box::new((self.advert.snapshot.advert.clone(), self.advert.snapshot.targets.clone()))));
                    }
                }
                if self.stop.unrecorded().is_some() {
                    let recorded = self.write_stop_mark();
                    self.stop.recorded(recorded);
                }
                match self.stop.look(self.stop_mark().is_some()) {
                    Some(StopChange::Stop) => self.supervisor.stop(None),
                    Some(StopChange::Resume) => self.supervisor.resume(now()),
                    None => {}
                }
            }
        }
    }
}

/// `ovis-link run --state <dir>`: runs until killed. Returns only when it cannot start.
pub fn run(dir: &Path) -> u8 {
    let Ok(lock) = status::open_lock(dir) else {
        eprintln!("ovis-link: the state folder cannot be used");
        return exit::CONFIG;
    };
    if lock.try_lock().is_err() {
        eprintln!("ovis-link: another ovis-link runs on this state folder");
        return exit::RUNNING;
    }
    let mut status = Status { state: State::Stopped.as_str().into(), since: unix_now(), ..Status::default() };
    let refuse = |status: &mut Status, text: String| {
        eprintln!("ovis-link: {text}");
        status.error = Some(text);
        let _ = status::write_private(dir, STATUS_FILE, status.to_json().as_bytes(), false);
        exit::CONFIG
    };
    let fleet = match fleet::load(&dir.join(FLEET_FILE)) {
        Ok(fleet) => fleet,
        Err(error) => return refuse(&mut status, error.to_string()),
    };
    status.peer = Some(fleet.server_id.clone());
    match MachineKey::load(&fleet.machine_key_file) {
        Ok(key) => status.machine_id = Some(key.machine_id().to_owned()),
        Err(error) => return refuse(&mut status, error.to_string()),
    }
    let supervisor = Supervisor::new(fleet.direct.len(), fleet.relay.is_some());
    let daemon = Daemon {
        dir: dir.to_owned(),
        context: Arc::new(Context { fleet }),
        supervisor,
        attempts: HashMap::new(),
        pending: HashSet::new(),
        advert: AdvertWatch::new(dir.join(ADVERT_FILE)),
        status,
        written: None,
        stop: StopGate::default(),
    };
    let code = daemon.run();
    drop(lock);
    code
}

/// `ovis-link status --state <dir> [--json]`.
pub fn print_status(dir: &Path, json: bool) -> u8 {
    if !dir.is_dir() {
        eprintln!("ovis-link: the state folder cannot be read");
        return exit::STATE;
    }
    let mut status = fs::read(dir.join(STATUS_FILE)).ok().and_then(|bytes| Status::from_json(&bytes)).unwrap_or_default();
    if !status::running(dir) {
        status.state = "not_running".into();
        status.path = None;
    }
    if json {
        println!("{}", status.to_json());
    } else {
        let route = status.path.as_deref().map_or(String::new(), |path| format!(" ({path})"));
        let error = status.error.as_deref().map_or(String::new(), |error| format!(": {error}"));
        let next = match status.next_relay_dial {
            Some(at) if status.state != "connected" => format!(" (next relay dial in {} s)", at.saturating_sub(unix_now())),
            _ => String::new(),
        };
        println!("{}{route}{error}{next}", status.state);
    }
    exit::OK
}

/// `ovis-link leave --state <dir>`: this machine leaves its fleet (todo 31): its machine key and fleet.json are deleted,
/// and the status and stop mark with them. Refused while an `ovis-link run` holds the folder (stop its service first),
/// so a running agent never keeps a key that is gone from disk. The controller is not told: remove the machine there.
pub fn leave(dir: &Path) -> u8 {
    if !dir.is_dir() {
        eprintln!("ovis-link: the state folder cannot be read");
        return exit::STATE;
    }
    if status::running(dir) {
        eprintln!("ovis-link: an ovis-link runs on this state folder; stop it first");
        return exit::RUNNING;
    }
    let path = dir.join(FLEET_FILE);
    // the key file fleet.json names; a fleet.json that cannot be read names none, and the default name is tried
    let key = fleet::load(&path).map(|fleet| fleet.machine_key_file).unwrap_or_else(|_| dir.join("machine.key"));
    let mut failed = false;
    for file in [key, path, dir.join(STATUS_FILE), dir.join(STOPPED_FILE)] {
        match fs::remove_file(&file) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => {
                eprintln!("ovis-link: {} cannot be removed", file.display());
                failed = true;
            }
        }
    }
    if failed {
        return exit::STATE;
    }
    println!("ovis-link: left the fleet: the machine key and fleet.json are deleted");
    exit::OK
}

/// `ovis-link rejoin --state <dir>`: clears the stop an `auth_revoked` refusal left.
pub fn rejoin(dir: &Path) -> u8 {
    if !dir.is_dir() {
        eprintln!("ovis-link: the state folder cannot be read");
        return exit::STATE;
    }
    match fs::remove_file(dir.join(STOPPED_FILE)) {
        Ok(()) => println!("ovis-link: dialing resumes"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => println!("ovis-link: dialing was not stopped"),
        Err(_) => {
            eprintln!("ovis-link: the stop mark cannot be removed");
            return exit::STATE;
        }
    }
    exit::OK
}
