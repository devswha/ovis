//! The keys that act now, most wanted first: on a phone only the first few fit.
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use unicode_width::UnicodeWidthStr;

use super::draw::Scene;
use super::state::{Page, State};

/// The keys and what each does, in the order they are kept when the line is short. `scrolls`:
/// what is on screen is taller than the screen.
pub(super) fn wanted(state: &State, scrolls: bool) -> Vec<(String, &'static str)> {
    let answer = match state.answerable() {
        _ if !state.card_on_screen() => None,
        0 => None,
        1 => Some(("1".to_owned(), "answer")),
        count => Some((format!("1-{count}"), "answer")),
    };
    let scroll = scrolls.then(|| ("d/u".to_owned(), "scroll"));
    let fixed: &[(&str, &str)] = match (state.page, state.narrow()) {
        (Page::Help, _) => &[("b", "back")],
        (Page::List | Page::Card, _) if state.groups.is_empty() => &[
            ("enter", "terminals"),
            ("r", "retry"),
            ("?", "help"),
            ("q", "quit"),
        ],
        (Page::List, true) => &[
            ("enter", "open"),
            ("j/k", "move"),
            ("m", "read"),
            ("q", "quit"),
            ("?", "help"),
        ],
        (Page::Card, _) => &[
            ("enter", "terminal"),
            ("b", "back"),
            ("m", "read"),
            ("?", "help"),
        ],
        (Page::List, false) => &[
            ("enter", "terminal"),
            ("j/k", "move"),
            ("m", "read"),
            ("r", "refresh"),
            ("?", "help"),
            ("q", "quit"),
        ],
    };
    let mut fixed = fixed.iter().map(|(key, does)| ((*key).to_owned(), *does));
    let mut hints: Vec<_> = answer.into_iter().collect();
    // the way on and the way back stay ahead of the scroll keys: what scrolls names those itself
    hints.extend(fixed.by_ref().take(2));
    hints.extend(scroll);
    hints.extend(fixed);
    hints
}

/// As many whole hints as fit the width; none is ever cut in two.
pub(super) fn line(scene: &Scene<'_>, width: usize, scrolls: bool) -> Line<'static> {
    let key = Style::new()
        .fg(scene.colors.accent)
        .add_modifier(Modifier::BOLD);
    let does = Style::new().fg(scene.colors.dim);
    let mut spans = Vec::new();
    let mut used = 0;
    for (name, what) in wanted(scene.state, scrolls) {
        let gap = if spans.is_empty() { 0 } else { 2 };
        let cost = gap + name.width() + 1 + what.width();
        if used + cost > width {
            break;
        }
        spans.push(Span::raw(" ".repeat(gap)));
        spans.push(Span::styled(name, key));
        spans.push(Span::styled(format!(" {what}"), does));
        used += cost;
    }
    Line::from(spans)
}
