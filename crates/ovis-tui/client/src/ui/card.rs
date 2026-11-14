//! The selected agent: what it asks, the options a digit answers, and its last turn of chat.
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

use crate::api::Prompt;
use crate::inbox::{Group, Row, Waiting};

use super::draw::{Canvas, Scene};
use super::state::{Card, Loaded, Page};
use super::{Colors, list, said, text};

/// How many lines of the user's own last message are shown above the agent's answer.
const YOUR_LINES: usize = 3;
/// How many lines a prompt's body and an option's description may take.
const BODY_LINES: usize = 6;
const DESCRIPTION_LINES: usize = 2;

struct Pen<'a> {
    colors: &'a Colors,
    width: usize,
}

impl Pen<'_> {
    /// `words` wrapped under an indent, at most `limit` lines, every line in one style.
    fn para(&self, words: &str, indent: usize, style: Style) -> Vec<Line<'static>> {
        text::wrap(words, self.width.saturating_sub(indent + 1).max(1))
            .into_iter()
            .map(|line| {
                Line::from(vec![
                    Span::raw(" ".repeat(indent)),
                    Span::styled(line, style),
                ])
            })
            .collect()
    }

    fn ink(&self) -> Style {
        Style::new().fg(self.colors.text)
    }

    fn dim(&self) -> Style {
        Style::new().fg(self.colors.dim)
    }
}

fn capped(mut lines: Vec<Line<'static>>, limit: usize) -> Vec<Line<'static>> {
    if lines.len() > limit {
        lines.truncate(limit);
        if let Some(last) = lines.last_mut() {
            last.spans.push(Span::raw(" …"));
        }
    }
    lines
}

/// Draws the card and returns how far down it can be scrolled.
pub(super) fn draw(canvas: &mut Canvas<'_>, scene: &Scene<'_>) -> usize {
    let state = scene.state;
    let (Some(row), Some(card)) = (state.selected_row(), state.card.as_ref()) else {
        return 0;
    };
    let pen = Pen {
        colors: scene.colors,
        width: usize::from(canvas.area.width),
    };
    let mut lines = title(&pen, row, state.page == Page::Card);
    lines.push(Line::raw(""));
    let asked = prompt(&pen, card, row);
    if !asked.is_empty() {
        lines.extend(asked);
        lines.push(Line::raw(""));
    }
    let rule = "─".repeat(pen.width.saturating_sub(13));
    lines.push(Line::styled(format!(" ── last turn {rule}"), pen.dim()));
    lines.extend(chat(&pen, card, row));
    canvas.page(&lines, scene.colors, state.scroll)
}

fn title(pen: &Pen<'_>, row: &Row, own_page: bool) -> Vec<Line<'static>> {
    let bold = pen.ink().add_modifier(Modifier::BOLD);
    let lead = if own_page { "‹ " } else { " " };
    let name = if row.agent.is_empty() {
        "-"
    } else {
        &row.agent
    };
    let what = if row.title.is_empty() {
        &row.space
    } else {
        &row.title
    };
    let words = text::clean(&format!("{name} · {what}"));
    let room = pen.width.saturating_sub(lead.chars().count() + 1);
    let mut state = list::group_words(row.group).to_owned();
    match (row.group, row.waiting, row.progress) {
        (Group::NeedsYou, Some(Waiting::Question), _) => state.push_str(" · question"),
        (Group::NeedsYou, Some(Waiting::Permission), _) => state.push_str(" · permission"),
        (Group::NeedsYou, Some(Waiting::Auth), _) => state.push_str(" · sign-in"),
        (Group::Working, _, Some(progress)) => state.push_str(&format!(" · {progress}%")),
        (Group::NeedsYou | Group::Working | Group::Done | Group::Idle, _, _) => {}
    }
    let place = [row.space.as_str(), row.tab.as_str()]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" / ");
    let place = text::fit(
        &text::clean(&format!("  {place}  {}", row.pane_id)),
        pen.width.saturating_sub(state.chars().count() + 3),
    );
    vec![
        Line::from(vec![
            Span::styled(lead, Style::new().fg(pen.colors.accent)),
            Span::styled(text::fit(&words, room), bold),
        ]),
        Line::from(vec![
            Span::raw(" ".repeat(lead.chars().count())),
            Span::styled(
                state,
                Style::new()
                    .fg(list::group_color(row.group, pen.colors))
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(place, pen.dim()),
        ]),
    ]
}

fn prompt(pen: &Pen<'_>, card: &Card, row: &Row) -> Vec<Line<'static>> {
    match &card.prompt {
        Loaded::Loading if row.group == Group::NeedsYou => {
            vec![Line::styled(" Reading the card …", pen.dim())]
        }
        Loaded::Loading => Vec::new(),
        Loaded::Failed(reason) => pen.para(
            &format!("The card could not be read: {reason}"),
            1,
            Style::new().fg(pen.colors.needs_you),
        ),
        Loaded::Ready(Some(asked)) => options(pen, card, asked),
        Loaded::Ready(None) if row.group == Group::NeedsYou => {
            let said = row
                .message
                .as_deref()
                .unwrap_or("It waits for you in its terminal.");
            let mut lines = pen.para(said, 1, pen.ink().add_modifier(Modifier::BOLD));
            lines.push(Line::raw(""));
            lines.extend(pen.para(
                "There is no card to answer here: open the terminal (t).",
                1,
                pen.dim(),
            ));
            lines
        }
        Loaded::Ready(None) => Vec::new(),
    }
}

fn options(pen: &Pen<'_>, card: &Card, asked: &Prompt) -> Vec<Line<'static>> {
    let question = if asked.question.is_empty() {
        &asked.title
    } else {
        &asked.question
    };
    let mut lines = pen.para(question, 1, pen.ink().add_modifier(Modifier::BOLD));
    if let Some(body) = asked.body.as_deref().filter(|body| !body.trim().is_empty()) {
        lines.extend(capped(pen.para(body, 1, pen.dim()), BODY_LINES));
    }
    lines.push(Line::raw(""));
    let by_digit = !asked.multi_select && !asked.has_steps;
    let key = Style::new()
        .fg(pen.colors.accent)
        .add_modifier(Modifier::BOLD);
    for (index, option) in asked.options.iter().enumerate() {
        let typed = asked.custom_option_index == Some(index);
        let badge = if by_digit && !typed && index < 9 {
            Span::styled(format!("{} ", index + 1), key)
        } else {
            Span::styled("· ", pen.dim())
        };
        let mut label = pen.para(&option.label, 4, pen.ink());
        if let Some(first) = label.first_mut() {
            first.spans[0] = Span::raw("  ");
            first.spans.insert(1, badge);
            if card.sending == Some(index) {
                first.spans.push(Span::styled("  sending …", pen.dim()));
            } else if typed {
                first
                    .spans
                    .push(Span::styled("  (typed in the terminal)", pen.dim()));
            }
        }
        lines.extend(label);
        if let Some(more) = option
            .description
            .as_deref()
            .filter(|more| !more.trim().is_empty())
        {
            lines.extend(capped(pen.para(more, 4, pen.dim()), DESCRIPTION_LINES));
        }
    }
    if !by_digit {
        lines.push(Line::raw(""));
        lines.extend(pen.para(
            "This card takes more than one pick: answer it in the terminal (t).",
            1,
            Style::new().fg(pen.colors.accent),
        ));
    }
    lines
}

fn chat(pen: &Pen<'_>, card: &Card, row: &Row) -> Vec<Line<'static>> {
    match &card.conversation {
        Loaded::Loading => vec![Line::styled(" …", pen.dim())],
        Loaded::Failed(reason) => pen.para(
            &format!("The chat could not be read: {reason}"),
            1,
            pen.dim(),
        ),
        Loaded::Ready(conversation) => {
            let (you, agent) = said::last(conversation);
            if you.is_none() && agent.is_none() {
                return vec![Line::styled(" No chat to show for this agent.", pen.dim())];
            }
            let name = if row.agent.is_empty() {
                "agent"
            } else {
                &row.agent
            };
            let mut lines = Vec::new();
            if let Some(you) = you {
                lines.extend(capped(
                    spoken(pen, ("you", pen.colors.you), &you),
                    YOUR_LINES + 1,
                ));
            }
            match agent {
                Some(agent) => lines.extend(spoken(pen, (name, pen.colors.agent), &agent)),
                None => lines.push(Line::styled(" (no answer yet)", pen.dim())),
            }
            lines
        }
    }
}

/// One speaker's words under their name.
fn spoken(pen: &Pen<'_>, who: (&str, ratatui::style::Color), words: &str) -> Vec<Line<'static>> {
    let mut lines = vec![Line::styled(
        format!(" {}", text::clean(who.0)),
        Style::new().fg(who.1).add_modifier(Modifier::BOLD),
    )];
    lines.extend(pen.para(words, 1, pen.ink()));
    lines
}
