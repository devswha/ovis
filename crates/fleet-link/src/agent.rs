//! Runs a [`Session`] on an open channel: carrier messages and target events arrive on one queue,
//! frames go out through a [`CarrierSink`], and each pipe's target is copied by two threads of its
//! own. A pipe's reader waits after each chunk until the session sent it (ReadMore), and its
//! writer reports each write so the session credits only what reached the target. Closing a pipe
//! shuts its socket both ways, which ends both threads; the carrier's loss closes every pipe.

use std::collections::{HashMap, VecDeque};
use std::io::{self, ErrorKind, Read, Write};
use std::net::Shutdown;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, SyncSender};
use std::thread;
use std::time::{Duration, Instant};

use zeroize::Zeroize;

use crate::carrier::{self, CarrierError, Message};
use crate::channel::Channel;
use crate::mux::{Advert, Endpoint, RelayPace, PIPE_DATA_BYTES};
use crate::session::{Action, End, Millis, Session};
use crate::target::{Stream, Targets};

pub enum Event {
    Carrier(Message),
    CarrierClosed,
    Connected { id: u32, stream: Stream },
    ConnectFailed { id: u32 },
    Data { id: u32, data: Vec<u8> },
    Eof { id: u32 },
    /// A read or write failed: the target closed without ending.
    Failed { id: u32 },
    Written { id: u32, bytes: u64 },
    /// advert.json changed (or went away): a new advert and the targets it names.
    Advert(Box<(Option<Advert>, Targets)>),
    /// A planned switch signed in elsewhere: this session sends GOAWAY and ends after the drain.
    GoAway,
    /// `ovis-link run`'s word to a carrier that proved the controller: sign in on it.
    Proceed,
    /// `ovis-link run`'s word to drop this carrier.
    Abandon,
}

pub trait CarrierSink {
    fn send(&mut self, message: Message) -> io::Result<()>;
}

enum WriteCommand {
    Data(Vec<u8>),
    Shutdown,
}

struct PipeIo {
    stream: Stream,
    writer: Sender<WriteCommand>,
    more: SyncSender<()>,
}

/// The session's clock: milliseconds since the agent started.
pub struct Clock(Instant);

impl Clock {
    pub fn start() -> Self {
        Clock(Instant::now())
    }
    pub fn now(&self) -> Millis {
        self.0.elapsed().as_millis() as Millis
    }
}

/// What runs once AUTH_OK has been read, given the direct carriers it named and whether it said `pending`.
type SignedIn<'a> = Box<dyn FnOnce(Option<Vec<String>>, bool) + 'a>;
/// What runs for each relay pace the controller sends (AUTH_OK's `relay_pace`, then every PACE).
type PaceHook<'a> = Box<dyn FnMut(RelayPace) + 'a>;

pub struct Agent<'a> {
    pub session: Session,
    pub channel: Channel,
    pub targets: Targets,
    pub sink: &'a mut dyn CarrierSink,
    pub events: Receiver<Event>,
    pub sender: Sender<Event>,
    pub clock: Clock,
    pipes: HashMap<u32, PipeIo>,
    signed_in: Option<SignedIn<'a>>,
    enrolled: Option<Box<dyn FnOnce() + 'a>>,
    fleet_state: Option<Box<dyn FnMut(crate::mux::SeenState) + 'a>>,
    pace: Option<PaceHook<'a>>,
    backlog: VecDeque<Event>,
}

impl<'a> Agent<'a> {
    pub fn new(session: Session, channel: Channel, targets: Targets, sink: &'a mut dyn CarrierSink, events: Receiver<Event>, sender: Sender<Event>, clock: Clock) -> Self {
        Agent { session, channel, targets, sink, events, sender, clock, pipes: HashMap::new(), signed_in: None, enrolled: None, fleet_state: None, pace: None, backlog: VecDeque::new() }
    }

    /// Events that arrived before the session existed (a WELCOME may come before HELLO): handled first.
    pub fn with_backlog(mut self, events: Vec<Event>) -> Self {
        self.backlog.extend(events);
        self
    }

    /// Called once, when AUTH_OK has been read, with the direct carriers it named and whether it said `pending`.
    pub fn on_signed_in(mut self, hook: impl FnOnce(Option<Vec<String>>, bool) + 'a) -> Self {
        self.signed_in = Some(Box::new(hook));
        self
    }

    /// Called with each FLEET_STATE newer than the one held (todo 31): fleet.json keeps it.
    pub fn on_fleet_state(mut self, hook: impl FnMut(crate::mux::SeenState) + 'a) -> Self {
        self.fleet_state = Some(Box::new(hook));
        self
    }

    /// Called once, when ENROLL_OK has been read: the invite's secret can go.
    pub fn on_enrolled(mut self, hook: impl FnOnce() + 'a) -> Self {
        self.enrolled = Some(Box::new(hook));
        self
    }

    /// Called with every relay pace the controller sends, as it comes.
    pub fn on_pace(mut self, hook: impl FnMut(RelayPace) + 'a) -> Self {
        self.pace = Some(Box::new(hook));
        self
    }

    /// Runs until the session ends. A carrier message that is not a valid record ends the
    /// channel at once: no frame can go out after it, so that is returned as an error.
    pub fn run(mut self) -> Result<End, CarrierError> {
        loop {
            let now = self.clock.now();
            while let Some(mut frame) = self.session.poll_transmit(now) {
                let sealed = carrier::seal(&mut self.channel, &frame);
                frame.zeroize();
                match sealed {
                    Ok(message) => {
                        if self.sink.send(message).is_err() {
                            self.session.carrier_lost();
                        }
                    }
                    Err(error) => return Err(self.abandon(error)),
                }
            }
            self.apply_actions();
            if self.session.take_enrolled() {
                if let Some(hook) = self.enrolled.take() {
                    hook();
                }
            }
            if let Some(state) = self.session.take_fleet_state() {
                if let Some(hook) = self.fleet_state.as_mut() {
                    hook(state);
                }
            }
            if self.session.signed_in() {
                if let Some(hook) = self.signed_in.take() {
                    let pending = self.session.pending();
                    hook(self.session.take_carriers(), pending);
                }
                if let Some((pace, _)) = self.session.take_pace() {
                    if let Some(hook) = self.pace.as_mut() {
                        hook(pace);
                    }
                }
            }
            if let Some(end) = self.session.end() {
                self.close_all();
                return Ok(end);
            }
            let event = match (self.backlog.pop_front(), self.session.next_deadline()) {
                (Some(event), _) => Ok(event),
                (None, Some(deadline)) => self.events.recv_timeout(Duration::from_millis(deadline.saturating_sub(self.clock.now()))),
                (None, None) => self.events.recv().map_err(|_| RecvTimeoutError::Disconnected),
            };
            match event {
                Ok(event) => {
                    if let Err(error) = self.handle(event) {
                        return Err(self.abandon(error));
                    }
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => self.session.carrier_lost(),
            }
        }
    }

    fn abandon(&mut self, error: CarrierError) -> CarrierError {
        self.session.carrier_lost();
        self.apply_actions();
        self.close_all();
        error
    }

    fn close_all(&mut self) {
        for (_, pipe) in self.pipes.drain() {
            let _ = pipe.stream.shutdown(Shutdown::Both);
        }
    }

    fn handle(&mut self, event: Event) -> Result<(), CarrierError> {
        let now = self.clock.now();
        match event {
            Event::Carrier(message) => {
                if let Some(mut frame) = carrier::open(&mut self.channel, &message)? {
                    self.session.receive(&frame, now);
                    frame.zeroize();
                }
            }
            Event::CarrierClosed => self.session.carrier_lost(),
            Event::Connected { id, stream } => {
                if self.session.target_connected(id) {
                    match self.start_copy(id, stream) {
                        Ok(pipe) => {
                            self.pipes.insert(id, pipe);
                        }
                        Err(_) => self.session.target_failed(id),
                    }
                } else {
                    let _ = stream.shutdown(Shutdown::Both);
                }
            }
            Event::ConnectFailed { id } | Event::Failed { id } => self.session.target_failed(id),
            Event::Data { id, data } => self.session.target_data(id, data),
            Event::Eof { id } => self.session.target_eof(id),
            Event::Written { id, bytes } => self.session.target_written(id, bytes),
            Event::Advert(update) => {
                let (advert, targets) = *update;
                let mut moved = Vec::new();
                if targets.bridge_port != self.targets.bridge_port {
                    moved.push(Endpoint::Bridge);
                }
                if targets.native_socket != self.targets.native_socket {
                    moved.push(Endpoint::Native);
                }
                self.session.replace_advert(advert, &moved);
                self.targets = targets;
            }
            Event::GoAway => self.session.go_away(now),
            Event::Proceed => {}
            Event::Abandon => self.session.carrier_lost(),
        }
        Ok(())
    }

    fn apply_actions(&mut self) {
        while let Some(action) = self.session.poll_action() {
            match action {
                Action::Connect { id, endpoint } => {
                    let targets = self.targets.clone();
                    let sender = self.sender.clone();
                    thread::spawn(move || {
                        let event = match targets.connect(endpoint) {
                            Ok(stream) => Event::Connected { id, stream },
                            Err(_) => Event::ConnectFailed { id },
                        };
                        let _ = sender.send(event);
                    });
                }
                Action::Write { id, data } => {
                    if let Some(pipe) = self.pipes.get(&id) {
                        let _ = pipe.writer.send(WriteCommand::Data(data));
                    }
                }
                Action::ShutdownWrite { id } => {
                    if let Some(pipe) = self.pipes.get(&id) {
                        let _ = pipe.writer.send(WriteCommand::Shutdown);
                    }
                }
                Action::ReadMore { id } => {
                    if let Some(pipe) = self.pipes.get(&id) {
                        let _ = pipe.more.try_send(());
                    }
                }
                Action::Close { id } => {
                    if let Some(pipe) = self.pipes.remove(&id) {
                        let _ = pipe.stream.shutdown(Shutdown::Both);
                    }
                }
            }
        }
    }

    fn start_copy(&self, id: u32, stream: Stream) -> io::Result<PipeIo> {
        let mut reader = stream.try_clone()?;
        let mut writer = stream.try_clone()?;
        let (more, wait) = mpsc::sync_channel::<()>(1);
        let (writes, queue) = mpsc::channel::<WriteCommand>();
        let events = self.sender.clone();
        thread::spawn(move || loop {
            let mut buffer = vec![0u8; PIPE_DATA_BYTES];
            match reader.read(&mut buffer) {
                Ok(0) => {
                    let _ = events.send(Event::Eof { id });
                    return;
                }
                Ok(read) => {
                    buffer.truncate(read);
                    if events.send(Event::Data { id, data: buffer }).is_err() || wait.recv().is_err() {
                        return;
                    }
                }
                Err(error) if error.kind() == ErrorKind::Interrupted => {}
                Err(_) => {
                    let _ = events.send(Event::Failed { id });
                    return;
                }
            }
        });
        let events = self.sender.clone();
        thread::spawn(move || {
            for write in queue {
                match write {
                    WriteCommand::Data(data) => {
                        if writer.write_all(&data).and_then(|()| writer.flush()).is_err() {
                            let _ = events.send(Event::Failed { id });
                            return;
                        }
                        if events.send(Event::Written { id, bytes: data.len() as u64 }).is_err() {
                            return;
                        }
                    }
                    WriteCommand::Shutdown => {
                        let _ = writer.shutdown(Shutdown::Write);
                    }
                }
            }
        });
        Ok(PipeIo { stream, writer: writes, more })
    }
}
