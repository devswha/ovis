//! The inbox's hold on the terminal: hc-tui's own terminal guard and input reader, so that the
//! two screens set the same modes and read keys the same way, and so that the hand-over is
//! exact: dropping this joins the reader before hc-tui starts its own.
use std::io::Stdout;

use hc_tui::app::{MouseButton, MouseEventKind, UiEvent};
use hc_tui::reader::Reader;
use hc_tui::term::TermGuard;
use hc_vt::{Action, Key, KeyInput, Mods};
use ovis_tui_client::ui::{self, Event, Hits, Intent, Scene};
use ratatui::Terminal;
use ratatui::backend::CrosstermBackend;

use crate::keymap;

/// Fields drop in this order: the drawing surface, the reader (stopped and joined), then the
/// guard, which gives the terminal back as it was.
pub struct Screen {
    terminal: Terminal<CrosstermBackend<Stdout>>,
    reader: Reader,
    _guard: TermGuard,
}

impl Screen {
    pub fn enter(mouse: bool) -> Result<Screen, String> {
        let guard = TermGuard::enter(mouse).map_err(|error| format!("terminal setup: {error}"))?;
        let mut terminal = Terminal::new(CrosstermBackend::new(std::io::stdout()))
            .map_err(|error| format!("terminal: {error}"))?;
        terminal
            .clear()
            .map_err(|error| format!("terminal: {error}"))?;
        let reader = hc_tui::reader::spawn_reader(256, mouse, false, false)
            .map_err(|error| format!("input reader: {error}"))?;
        Ok(Screen {
            terminal,
            reader,
            _guard: guard,
        })
    }

    pub fn size(&self) -> Result<(u16, u16), String> {
        self.terminal
            .size()
            .map(|size| (size.width, size.height))
            .map_err(|error| format!("terminal size: {error}"))
    }

    pub fn draw(&mut self, scene: &Scene<'_>) -> Result<Hits, String> {
        let mut hits = Hits::default();
        self.terminal
            .draw(|frame| {
                let area = frame.area();
                hits = ui::draw(frame.buffer_mut(), area, scene);
            })
            .map_err(|error| format!("draw: {error}"))?;
        Ok(hits)
    }

    /// The next input; none once the terminal is gone (an SSH connection that dropped).
    pub async fn next(&mut self) -> Option<UiEvent> {
        loop {
            tokio::select! {
                input = self.reader.ui.recv() => return input,
                // the inbox asks the host terminal nothing, so an answer is of no use to it
                Some(_) = self.reader.replies.recv() => {}
            }
        }
    }
}

/// What an input asks of the inbox, with `hits` telling what a tap landed on.
pub fn event(input: UiEvent, hits: &Hits) -> Option<Event> {
    match input {
        UiEvent::Key(key) => keymap::intent(&key.input).map(Event::Key),
        UiEvent::Text(text) => {
            let mut chars = text.chars();
            let (Some(only), None) = (chars.next(), chars.next()) else {
                return None;
            };
            let typed = KeyInput {
                key: Key::Char(only),
                mods: Mods::NONE,
                action: Action::Press,
            };
            keymap::intent(&typed).map(Event::Key)
        }
        UiEvent::Resize { cols, rows } => Some(Event::Resize { cols, rows }),
        UiEvent::Mouse(mouse) => match mouse.kind {
            MouseEventKind::Down(MouseButton::Left) => {
                hits.at(mouse.col, mouse.row).map(Event::Tap)
            }
            MouseEventKind::ScrollUp => Some(Event::Key(wheel(hits, mouse.col, false))),
            MouseEventKind::ScrollDown => Some(Event::Key(wheel(hits, mouse.col, true))),
            MouseEventKind::Down(MouseButton::Middle | MouseButton::Right)
            | MouseEventKind::Up(_)
            | MouseEventKind::Drag(_)
            | MouseEventKind::Moved
            | MouseEventKind::ScrollLeft
            | MouseEventKind::ScrollRight => None,
        },
        UiEvent::Paste(_)
        | UiEvent::Focus(_)
        | UiEvent::Unsupported
        | UiEvent::InputRejected(_) => None,
    }
}

/// A wheel turned over the list moves the selection; anywhere else it scrolls what is there.
fn wheel(hits: &Hits, col: u16, down: bool) -> Intent {
    match (hits.over_list(col), down) {
        (true, false) => Intent::Up,
        (true, true) => Intent::Down,
        (false, false) => Intent::ScrollUp,
        (false, true) => Intent::ScrollDown,
    }
}
