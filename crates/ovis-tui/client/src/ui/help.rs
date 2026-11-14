//! Every key on one page.
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

use super::draw::{Canvas, Scene};
use super::text;

const KEYS: [(&str, &str); 10] = [
    ("j k ↑ ↓", "move"),
    ("enter", "open: the card, then the terminal"),
    ("1-9", "answer the card on screen"),
    ("d u", "scroll a long card"),
    ("t", "terminal"),
    ("m", "mark read"),
    ("r", "read everything again"),
    ("b esc", "back"),
    ("?", "this page"),
    ("q", "quit"),
];

/// Draws the page and returns how far down it can be scrolled.
pub(super) fn draw(canvas: &mut Canvas<'_>, scene: &Scene<'_>) -> usize {
    let colors = scene.colors;
    let key = Style::new().fg(colors.accent).add_modifier(Modifier::BOLD);
    let ink = Style::new().fg(colors.text);
    let dim = Style::new().fg(colors.dim);
    let room = usize::from(canvas.area.width).saturating_sub(2).max(1);
    let mut lines: Vec<Line<'static>> = KEYS
        .iter()
        .map(|(name, does)| {
            Line::from(vec![
                Span::styled(format!(" {}", text::cell(name, 9)), key),
                Span::styled(text::fit(does, room.saturating_sub(9)), ink),
            ])
        })
        .collect();
    let notes = [
        (
            format!("In a terminal, {} comes back here.", scene.terminal_key),
            ink,
        ),
        ("Q question  P permission  A sign-in".to_owned(), dim),
        (
            "Terminals: hc-tui (Apache-2.0), unofficial.".to_owned(),
            dim,
        ),
    ];
    for (index, (note, style)) in notes.iter().enumerate() {
        if index < 2 {
            lines.push(Line::raw(""));
        }
        lines.extend(
            text::wrap(note, room)
                .into_iter()
                .map(|line| Line::styled(format!(" {line}"), *style)),
        );
    }
    canvas.page(&lines, colors, scene.state.scroll)
}
