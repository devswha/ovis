//! The agents in their groups: who needs you first.
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use unicode_width::UnicodeWidthStr;

use crate::inbox::{Group, Row, Waiting};

use super::draw::{Canvas, Scene};
use super::state::Link;
use super::{Colors, text};

enum Entry<'a> {
    Gap,
    Head(Group, usize),
    Agent(&'a Row),
}

/// Draws the list and returns each drawn agent's screen row.
pub(super) fn draw(canvas: &mut Canvas<'_>, scene: &Scene<'_>) -> Vec<(u16, String)> {
    let state = scene.state;
    let height = usize::from(canvas.area.height);
    let entries = entries(scene, height);
    if entries.is_empty() {
        canvas.page(
            &empty(scene, usize::from(canvas.area.width)),
            scene.colors,
            0,
        );
        return Vec::new();
    }
    let selected = entries.iter().position(|entry| {
        matches!(entry, Entry::Agent(row) if state.selected.as_deref() == Some(row.pane_id.as_str()))
    });
    let first = first_shown(selected, entries.len(), height);
    let mut rows = Vec::new();
    for (y, (at, entry)) in (0..canvas.area.height).zip(entries.iter().enumerate().skip(first)) {
        match entry {
            Entry::Gap => {}
            Entry::Head(group, count) => canvas.line(y, &head(*group, *count, scene.colors)),
            Entry::Agent(row) => {
                let chosen = Some(at) == selected;
                if chosen {
                    canvas.fill(y, Style::new().bg(scene.colors.selected));
                }
                let width = usize::from(canvas.area.width);
                canvas.line(y, &agent(&Look { row, chosen, width }, scene.colors));
                rows.push((canvas.area.y + y, row.pane_id.clone()));
            }
        }
    }
    rows
}

/// The groups' heads and rows, with a blank line between groups where the list has room for them.
fn entries<'a>(scene: &Scene<'a>, height: usize) -> Vec<Entry<'a>> {
    let groups = &scene.state.groups;
    let rows: usize = groups.iter().map(|(_, rows)| rows.len() + 1).sum();
    let airy = rows + groups.len().saturating_sub(1) <= height;
    let mut entries = Vec::new();
    for (index, (group, rows)) in groups.iter().enumerate() {
        if airy && index > 0 {
            entries.push(Entry::Gap);
        }
        entries.push(Entry::Head(*group, rows.len()));
        entries.extend(rows.iter().map(Entry::Agent));
    }
    entries
}

/// The first entry drawn, so that the selected one is in view.
fn first_shown(selected: Option<usize>, total: usize, height: usize) -> usize {
    match selected {
        Some(selected) if total > height => selected.saturating_sub(height / 2).min(total - height),
        _ => 0,
    }
}

pub(super) fn group_color(group: Group, colors: &Colors) -> Color {
    match group {
        Group::NeedsYou => colors.needs_you,
        Group::Working => colors.working,
        Group::Done => colors.done,
        Group::Idle => colors.idle,
    }
}

pub(super) fn group_words(group: Group) -> &'static str {
    match group {
        Group::NeedsYou => "needs you",
        Group::Working => "working",
        Group::Done => "done",
        Group::Idle => "idle",
    }
}

fn head(group: Group, count: usize, colors: &Colors) -> Line<'static> {
    let dot = match group {
        Group::NeedsYou | Group::Working | Group::Done => "●",
        Group::Idle => "○",
    };
    let color = group_color(group, colors);
    Line::from(vec![
        Span::styled(
            format!("{dot} {}", group_words(group).to_uppercase()),
            Style::new().fg(color).add_modifier(Modifier::BOLD),
        ),
        Span::styled(format!("  {count}"), Style::new().fg(colors.dim)),
    ])
}

struct Look<'a> {
    row: &'a Row,
    chosen: bool,
    width: usize,
}

/// What the row's right edge says: what a waiting agent waits for, how far a working one is.
fn tag(row: &Row) -> String {
    match (row.group, row.waiting, row.progress) {
        (Group::NeedsYou, Some(Waiting::Question), _) => "Q".into(),
        (Group::NeedsYou, Some(Waiting::Permission), _) => "P".into(),
        (Group::NeedsYou, Some(Waiting::Auth), _) => "A".into(),
        (Group::NeedsYou, Some(Waiting::Other) | None, _) => "!".into(),
        (Group::Working, _, Some(progress)) => format!("{progress}%"),
        (Group::Working | Group::Done | Group::Idle, _, _) => String::new(),
    }
}

fn agent(look: &Look<'_>, colors: &Colors) -> Line<'static> {
    let row = look.row;
    let name_width = if look.width >= 40 { 8 } else { 6 };
    let indent = if row.helper_of.is_some() { 2 } else { 0 };
    let tag = tag(row);
    let tag_width = if tag.is_empty() { 0 } else { tag.width() + 1 };
    let middle = look
        .width
        .saturating_sub(2 + indent + name_width + 1 + tag_width);
    let name = text::clean(if row.agent.is_empty() {
        "-"
    } else {
        &row.agent
    });
    let title = text::clean(if row.title.is_empty() {
        &row.space
    } else {
        &row.title
    });
    let place = text::clean(&row.space);
    let title = text::fit(&title, middle);
    let left = middle.saturating_sub(title.width());
    let place = if place.is_empty() || place == title || left < 6 {
        String::new()
    } else {
        text::fit(&format!("  {place}"), left)
    };
    let pad = left.saturating_sub(place.width());
    let weight = if look.chosen {
        Modifier::BOLD
    } else {
        Modifier::empty()
    };
    let ink = if row.group == Group::Idle {
        colors.dim
    } else {
        colors.text
    };
    let mut spans = vec![
        Span::styled(
            if look.chosen { "› " } else { "  " },
            Style::new().fg(colors.accent),
        ),
        Span::raw(" ".repeat(indent)),
        Span::styled(
            text::cell(&name, name_width),
            Style::new().fg(ink).add_modifier(weight),
        ),
        Span::raw(" "),
        Span::styled(title, Style::new().fg(ink).add_modifier(weight)),
        Span::styled(place, Style::new().fg(colors.dim)),
        Span::raw(" ".repeat(pad)),
    ];
    if !tag.is_empty() {
        spans.push(Span::styled(
            format!(" {tag}"),
            Style::new()
                .fg(group_color(row.group, colors))
                .add_modifier(Modifier::BOLD),
        ));
    }
    Line::from(spans)
}

/// What the list says when it has no row: why, and what to do next.
pub(super) fn empty(scene: &Scene<'_>, width: usize) -> Vec<Line<'static>> {
    let origin = &scene.state.origin;
    let (said, next): (String, &str) = match &scene.state.link {
        Link::Connecting => (format!("Asking the Ovis server at {origin} …"), ""),
        Link::Up => (
            "No agent runs here yet.".into(),
            "Start one in herdr-core and it shows here. Enter opens the terminals.",
        ),
        Link::Down(_) => (
            format!("The inbox needs this PC's Ovis server, and none answers at {origin}."),
            "Start it (ovis start), then press r. Enter opens the terminals of herdr-core, which work without it.",
        ),
        Link::Refused(_) => (
            format!("The Ovis server at {origin} asks for its token."),
            "Run this through the ovis command, which passes the token, or set OVIS_TOKEN. Enter opens the terminals of herdr-core, which work without it.",
        ),
    };
    let room = width.saturating_sub(2).max(1);
    let mut lines = vec![Line::raw("")];
    let paint = |words: &str, style: Style| -> Vec<Line<'static>> {
        text::wrap(words, room)
            .into_iter()
            .map(|line| Line::styled(format!(" {line}"), style))
            .collect()
    };
    lines.extend(paint(&said, Style::new().fg(scene.colors.text)));
    if !next.is_empty() {
        lines.push(Line::raw(""));
        lines.extend(paint(next, Style::new().fg(scene.colors.dim)));
    }
    lines
}
