//! What goes into the inbox's state and what comes out of it.
use crate::api::{Conversation, Prompt};
use crate::net::{Job, Reply};
use crate::resume::Spot;

/// What a key asks for. Every action is one plain letter, digit or arrow.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Intent {
    Up,
    Down,
    Top,
    Bottom,
    /// Half a screen up or down in a card or a help page longer than the screen.
    ScrollUp,
    ScrollDown,
    Open,
    Terminal,
    Back,
    /// The digit pressed, 1 to 9.
    Answer(u8),
    MarkRead,
    Refresh,
    Help,
    Quit,
}

/// What a tap landed on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    Row(String),
    Back,
}

/// The Ovis server, as far as this run knows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Link {
    Connecting,
    Up,
    /// Nothing answers at the origin.
    Down(String),
    /// It answers and lets this client in no further: a token is asked for, or is wrong.
    Refused(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Page {
    List,
    /// The selected agent's card on a screen of its own: only where the list and the card do not
    /// fit side by side.
    Card,
    Help,
}

#[derive(Debug, PartialEq)]
pub enum Loaded<T> {
    Loading,
    Ready(T),
    Failed(String),
}

/// What is known of the selected agent beyond its row.
#[derive(Debug, PartialEq)]
pub struct Card {
    pub pane_id: String,
    pub prompt: Loaded<Option<Prompt>>,
    pub conversation: Loaded<Conversation>,
    /// The option an answer is on its way for.
    pub sending: Option<usize>,
}

impl Card {
    pub(super) fn loading(pane_id: String) -> Card {
        Card {
            pane_id,
            prompt: Loaded::Loading,
            conversation: Loaded::Loading,
            sending: None,
        }
    }
}

#[derive(Debug)]
pub enum Event {
    Key(Intent),
    Tap(Target),
    Resize {
        cols: u16,
        rows: u16,
    },
    Net(Reply),
    /// The terminal screen closed; the error it ended on, if any.
    TerminalClosed(Option<String>),
}

#[derive(Debug, PartialEq)]
pub enum Effect {
    Ask(Job),
    /// Which pane's card to hear changes of.
    Watch(Option<String>),
    /// Leave for the terminal screen: on this pane when one is named, else where hc-tui's own
    /// shared layout last had its focus.
    OpenTerminal(Option<String>),
    /// Where the user is now, for the next run.
    Remember {
        spot: Spot,
        pane: Option<String>,
    },
    Quit,
}
