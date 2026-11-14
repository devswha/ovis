//! One frame of the inbox.
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use unicode_width::UnicodeWidthStr;

use super::state::{Link, Page, State, Target};
use super::{Colors, card, help, hints, list, text};

pub struct Scene<'a> {
    pub state: &'a State,
    pub colors: &'a Colors,
    /// The keys that leave the terminal screen, as the user's herdr config binds them.
    pub terminal_key: &'a str,
}

/// Where a tap lands, as the last frame was drawn.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Hits {
    /// The list's columns: first and one past the last.
    list: (u16, u16),
    rows: Vec<(u16, String)>,
    back: Option<u16>,
    /// How far down the card or the help can be scrolled.
    pub scroll_max: usize,
}

impl Hits {
    #[must_use]
    pub fn at(&self, col: u16, row: u16) -> Option<Target> {
        if self.back == Some(row) {
            return Some(Target::Back);
        }
        if !self.over_list(col) {
            return None;
        }
        self.rows
            .iter()
            .find(|(y, _)| *y == row)
            .map(|(_, pane)| Target::Row(pane.clone()))
    }

    /// Whether a column belongs to the list: a wheel turned there moves the selection.
    #[must_use]
    pub fn over_list(&self, col: u16) -> bool {
        col >= self.list.0 && col < self.list.1
    }
}

/// A part of the screen being drawn into: lines are placed by their row inside it.
pub(super) struct Canvas<'a> {
    pub buf: &'a mut Buffer,
    pub area: Rect,
}

impl Canvas<'_> {
    pub fn line(&mut self, y: u16, line: &Line<'_>) {
        if y < self.area.height {
            self.buf
                .set_line(self.area.x, self.area.y + y, line, self.area.width);
        }
    }

    /// The lines from `scroll` down; a row at either end says when more lies beyond it. Returns
    /// how far down these lines can be scrolled.
    pub fn page(&mut self, lines: &[Line<'_>], colors: &Colors, scroll: usize) -> usize {
        let height = usize::from(self.area.height);
        let most = lines.len().saturating_sub(height);
        let from = scroll.min(most);
        for (y, line) in (0..self.area.height).zip(lines.iter().skip(from)) {
            self.line(y, line);
        }
        let dim = Style::new().fg(colors.dim);
        if from > 0 {
            self.mark(0, " ▴ more above (u)", dim);
        }
        if from < most && self.area.height > 0 {
            self.mark(self.area.height - 1, " ▾ more below (d)", dim);
        }
        most
    }

    fn mark(&mut self, y: u16, words: &'static str, style: Style) {
        let blank = " ".repeat(usize::from(self.area.width));
        self.fill(y, Style::new());
        self.line(y, &Line::raw(blank));
        self.line(y, &Line::styled(words, style));
    }

    pub fn fill(&mut self, y: u16, style: Style) {
        if y < self.area.height {
            let row = Rect {
                y: self.area.y + y,
                height: 1,
                ..self.area
            };
            self.buf.set_style(row, style);
        }
    }
}

/// Draws the frame and tells where its rows are.
pub fn draw(buf: &mut Buffer, area: Rect, scene: &Scene<'_>) -> Hits {
    let mut hits = Hits::default();
    if area.width < 20 || area.height < 6 {
        Canvas { buf, area }.line(0, &Line::raw("ovis: this window is too small"));
        return hits;
    }
    let state = scene.state;
    let dim = Style::new().fg(scene.colors.dim);
    let body = Rect {
        y: area.y + 2,
        height: area.height - 4,
        ..area
    };
    // with no agent to list there is no card either: what the list says takes the whole width
    let one_column = state.narrow() || state.groups.is_empty();
    match (state.page, one_column) {
        (Page::Help, _) => hits.scroll_max = help::draw(&mut Canvas { buf, area: body }, scene),
        (Page::Card, _) => {
            hits.back = Some(body.y);
            hits.scroll_max = card::draw(&mut Canvas { buf, area: body }, scene);
        }
        (Page::List, true) => {
            hits.list = (body.x, body.right());
            hits.rows = list::draw(&mut Canvas { buf, area: body }, scene);
        }
        (Page::List, false) => {
            let width = (body.width / 5).saturating_mul(2).clamp(30, 46);
            let left = Rect { width, ..body };
            let bar = body.x + width;
            let right = Rect {
                x: bar + 2,
                width: body.width.saturating_sub(width + 2),
                ..body
            };
            for y in body.y..body.bottom() {
                buf.set_stringn(bar, y, "│", 1, dim);
            }
            hits.list = (left.x, left.right());
            hits.rows = list::draw(
                &mut Canvas {
                    buf: &mut *buf,
                    area: left,
                },
                scene,
            );
            hits.scroll_max = card::draw(
                &mut Canvas {
                    buf: &mut *buf,
                    area: right,
                },
                scene,
            );
        }
    }
    let width = usize::from(area.width);
    let rule = "─".repeat(width);
    let mut frame = Canvas { buf, area };
    frame.line(0, &header(scene, width));
    frame.line(1, &Line::styled(rule.clone(), dim));
    let foot = match &state.notice {
        Some(notice) => Line::styled(
            format!(
                " {}",
                text::fit(&text::clean(notice), width.saturating_sub(2))
            ),
            Style::new().fg(scene.colors.accent),
        ),
        None => Line::styled(rule, dim),
    };
    frame.line(area.height - 2, &foot);
    let scrolls = hits.scroll_max > 0;
    frame.line(area.height - 1, &hints::line(scene, width, scrolls));
    hits
}

fn header(scene: &Scene<'_>, width: usize) -> Line<'static> {
    let colors = scene.colors;
    let state = scene.state;
    let bold = Style::new().add_modifier(Modifier::BOLD);
    let mut spans = vec![
        Span::styled(" ovis ", bold.fg(colors.text)),
        Span::styled(" inbox", Style::new().fg(colors.dim)),
    ];
    // a count is said only of agents that are listed: with none listed, nothing is known
    if !state.groups.is_empty() {
        spans.push(Span::styled(" · ", Style::new().fg(colors.dim)));
        spans.push(match state.needs_you() {
            0 => Span::styled("nobody waits", Style::new().fg(colors.dim)),
            1 => Span::styled("1 needs you", bold.fg(colors.needs_you)),
            count => Span::styled(format!("{count} need you"), bold.fg(colors.needs_you)),
        });
    }
    let (words, color) = link_words(state, colors);
    let used = Line::from(spans.clone()).width();
    let tail = words.chars().count() + 1;
    if used + tail < width {
        spans.push(Span::raw(" ".repeat(width - used - tail)));
        spans.push(Span::styled(words, Style::new().fg(color)));
    }
    Line::from(spans)
}

/// The Ovis server's state, in the header's corner.
fn link_words(state: &State, colors: &Colors) -> (&'static str, ratatui::style::Color) {
    match (&state.link, state.runtime.as_deref()) {
        (Link::Connecting, _) => ("ovis …", colors.dim),
        (Link::Up, Some(runtime)) if runtime != "herdr-core" => {
            ("ovis ● classic herdr", colors.working)
        }
        (Link::Up, _) => ("ovis ●", colors.idle),
        (Link::Down(_), _) => ("ovis ○ offline", colors.needs_you),
        (Link::Refused(_), _) => ("ovis ○ token", colors.needs_you),
    }
}

/// A drawn frame as text, one string per row, trailing blanks dropped.
#[must_use]
pub fn rows_of(buf: &Buffer) -> Vec<String> {
    let area = buf.area;
    (area.top()..area.bottom())
        .map(|y| {
            let mut row = String::new();
            // a wide character fills two cells: the second holds nothing of its own
            let mut covered = 0usize;
            for x in area.left()..area.right() {
                let symbol = buf[(x, y)].symbol();
                if covered == 0 {
                    row.push_str(symbol);
                }
                covered = covered.max(symbol.width()).saturating_sub(1);
            }
            row.trim_end().to_owned()
        })
        .collect()
}
