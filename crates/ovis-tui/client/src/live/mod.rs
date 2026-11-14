//! The WebSocket subscription to the local server (`/ws`), run on a thread of its own.

mod frames;
mod socket;

use std::sync::mpsc::{self, Sender};
use std::thread::JoinHandle;

use crate::api;

/// What the socket tells, in the order it tells it.
#[derive(Debug, Clone, PartialEq)]
pub enum LiveEvent {
    /// The socket is open.
    Up,
    /// `{ type: "snapshot" }`.
    Snapshot(Box<api::Snapshot>),
    /// `{ type: "pane-status" }`: one pane's state, pushed whether or not anything watches it.
    PaneStatus {
        pane_id: String,
        agent_status: String,
        finish_id: Option<u64>,
        finish_epoch: Option<String>,
    },
    /// Panes came or went: refetch `/api/session`.
    SessionChanged,
    PaneExited(String),
    /// The prompt on the watched pane's screen opened, closed or changed: read it again.
    PromptChanged(String),
    /// The watched pane's conversation changed: read it again.
    ConversationChanged(String),
    /// The socket ended or could not open: the reason, in words.
    Down(String),
}

pub(crate) enum Command {
    Watch(Option<String>),
    Stop,
}

/// The running subscription; [`Live::stop`] ends it.
pub struct Live {
    commands: Sender<Command>,
    thread: JoinHandle<()>,
}

impl Live {
    /// Starts the thread. It connects `ws://<host>/ws`, with `Authorization: Bearer <token>` when a
    /// token is set, reports [`LiveEvent::Up`], and forwards each frame it knows as an event.
    /// After a drop it reports [`LiveEvent::Down`] and reconnects with a delay of 250 ms doubling to
    /// 8 s. An `https` origin is not supported yet: it reports `Down` once and waits for `stop`.
    /// `sink` is called on that thread.
    #[must_use]
    pub fn start(server: api::Server, sink: Box<dyn Fn(LiveEvent) + Send>) -> Live {
        let (commands, inbox) = mpsc::channel();
        let thread = std::thread::spawn(move || socket::run(&server, sink.as_ref(), &inbox));
        Live { commands, thread }
    }

    /// Which pane's prompt and conversation changes to hear about (None: none). The watch is moved
    /// from the old pane to the new one, and sent again after each reconnect.
    pub fn watch(&self, pane_id: Option<&str>) {
        // a send fails only once the thread has ended, when there is nothing left to watch
        drop(
            self.commands
                .send(Command::Watch(pane_id.map(str::to_owned))),
        );
    }

    /// Stops the thread and joins it; it sees the request within about 250 ms. A panic of the sink
    /// on that thread goes on in the caller.
    pub fn stop(self) {
        drop(self.commands.send(Command::Stop));
        if let Err(panic) = self.thread.join() {
            std::panic::resume_unwind(panic);
        }
    }
}
