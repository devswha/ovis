use std::io::{Stdout, Write};

use ratatui::backend::CrosstermBackend;
use ratatui::crossterm::event::{Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::crossterm::{execute, terminal};
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Clear, Paragraph};
use ratatui::{Frame, Terminal};
use serde_json::Value;
use unicode_width::UnicodeWidthChar;

use crate::model::{Entry, Model, Pending, Selector};

pub enum Action {
    Prompt(String),
    Cancel,
    Answer { key: String, option: Option<String> },
    SetMode(String),
    SetModel(String),
    Quit,
}

enum Popup {
    Help,
    Modes(usize),
    Models(usize),
    Resume,
    Quit,
}

#[derive(Default)]
struct View {
    input: Vec<char>,
    cursor: usize,
    history: Vec<String>,
    history_at: Option<usize>,
    scroll: usize,
    details: bool,
    popup: Option<Popup>,
    slash: usize,
    card_key: String,
    card_choice: usize,
    /// What the frame being drawn shows, and what the last frame that reached the terminal showed:
    /// keys act only on the latter.
    staged: Shown,
    shown: Shown,
    card_scroll: usize,
    card_hidden: bool,
    closed_elsewhere: Option<std::time::Instant>,
    flash: Option<String>,
    cache: Option<(u64, u16, bool, Vec<Line<'static>>)>,
}

/// The approval card on screen (its key, the highlighted choice, how many choices are visible) and
/// the highlighted picker option.
#[derive(Default, Clone)]
struct Shown {
    card: Option<(String, usize, usize)>,
    picker: Option<String>,
}

pub struct Screen {
    term: Terminal<CrosstermBackend<Stdout>>,
    view: View,
}

const HISTORY: usize = 200;

/// The card a key answers: the one last drawn, while it is still pending. A card that came (or moved
/// up because another side answered the one on screen) after the last frame is not answerable until
/// it has been drawn, so a key never answers an approval nobody saw.
fn shown_card<'m>(model: &'m Model, drawn: Option<&str>) -> Option<&'m Pending> {
    model.pending.first().filter(|p| Some(p.key.as_str()) == drawn)
}

pub fn restore_terminal() {
    let _ = terminal::disable_raw_mode();
    let _ = execute!(
        std::io::stdout(),
        ratatui::crossterm::event::DisableBracketedPaste,
        terminal::LeaveAlternateScreen,
        ratatui::crossterm::cursor::Show
    );
}

/// Control and invisible formatting characters become visible symbols, so an approval card can never
/// be rewritten by escape sequences or hide characters inside the command it shows.
pub fn clean(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        let code = c as u32;
        match c {
            '\t' => out.push_str("    "),
            _ if code < 0x20 => out.push(char::from_u32(0x2400 + code).unwrap_or('?')),
            '\u{7f}' => out.push('\u{2421}'),
            '\u{80}'..='\u{9f}' => out.push('\u{fffd}'),
            '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{feff}' => out.push_str(&format!("<U+{code:04X}>")),
            _ => out.push(c),
        }
    }
    out
}

fn width_of(c: char) -> usize {
    UnicodeWidthChar::width(c).unwrap_or(0)
}

/// Wraps one logical line by display width, character by character, so wide (Korean) characters never split.
fn wrap(parts: &[(String, Style)], width: u16, first: &str, rest: &str, prefix_style: Style) -> Vec<Line<'static>> {
    wrap_with(parts, width, first, rest, prefix_style, false)
}

/// With `mark_break_space` (literal text: an approval's command), a space that lands at the end of a
/// wrapped row is drawn as `␣` and a tab as `⇥`, so neither can pass for padding or plain spaces.
fn wrap_with(parts: &[(String, Style)], width: u16, first: &str, rest: &str, prefix_style: Style, mark_break_space: bool) -> Vec<Line<'static>> {
    let width = (width as usize).max(first.chars().map(width_of).sum::<usize>() + 2);
    let mut rows = vec![];
    let mut spans = vec![Span::styled(first.to_string(), prefix_style)];
    let mut used: usize = first.chars().map(width_of).sum();
    for (text, style) in parts {
        let mut buf = String::new();
        let text = if mark_break_space { text.replace('\t', "\u{21e5}") } else { text.clone() };
        for c in clean(&text).chars() {
            let w = width_of(c);
            if used + w > width && used > 0 {
                if mark_break_space && buf.ends_with(' ') {
                    buf.pop();
                    buf.push('\u{2423}');
                }
                if !buf.is_empty() {
                    spans.push(Span::styled(std::mem::take(&mut buf), *style));
                }
                rows.push(Line::from(std::mem::take(&mut spans)));
                spans.push(Span::styled(rest.to_string(), prefix_style));
                used = rest.chars().map(width_of).sum();
            }
            buf.push(c);
            used += w;
        }
        if !buf.is_empty() {
            spans.push(Span::styled(buf, *style));
        }
    }
    rows.push(Line::from(spans));
    rows
}

fn block(out: &mut Vec<Line<'static>>, text: &str, style: Style, width: u16, first: &str, rest: &str, prefix_style: Style) {
    for (n, line) in text.split('\n').enumerate() {
        out.extend(wrap(&[(line.to_string(), style)], width, if n == 0 { first } else { rest }, rest, prefix_style));
    }
}

fn status_style(status: &str) -> Style {
    match status {
        "completed" => Style::new().fg(Color::Green),
        "failed" => Style::new().fg(Color::Red),
        "in_progress" => Style::new().fg(Color::Yellow),
        _ => Style::new().fg(Color::DarkGray),
    }
}

fn status_word(status: &str) -> &'static str {
    match status {
        "completed" => "끝남",
        "failed" => "실패",
        "in_progress" => "도는 중",
        "pending" => "대기",
        _ => "?",
    }
}

fn chat(model: &Model, width: u16, details: bool) -> Vec<Line<'static>> {
    let mut out = vec![];
    let dim = Style::new().fg(Color::DarkGray);
    for entry in &model.entries {
        match entry {
            Entry::User(text) => block(
                &mut out,
                text,
                Style::new().fg(Color::Cyan),
                width,
                "❯ ",
                "  ",
                Style::new().fg(Color::Cyan).add_modifier(Modifier::BOLD),
            ),
            Entry::Agent(text) => block(&mut out, text.trim_end_matches('\n'), Style::new(), width, "● ", "  ", Style::new().fg(Color::Magenta)),
            Entry::Thought(text) => {
                let lines: Vec<&str> = text.trim_end().split('\n').collect();
                let shown = if details || lines.len() <= 3 {
                    lines.join("\n")
                } else {
                    format!("… {}줄 접힘\n{}", lines.len() - 3, lines[lines.len() - 3..].join("\n"))
                };
                block(&mut out, &shown, dim.add_modifier(Modifier::ITALIC), width, "∴ ", "  ", dim);
            }
            Entry::Tool(tool) => {
                let fold = if details { "▾" } else { "▸" };
                let head = vec![
                    (format!("[{}] ", tool.kind), Style::new().fg(Color::Blue)),
                    (if tool.title.is_empty() { tool.id.clone() } else { tool.title.clone() }, Style::new().add_modifier(Modifier::BOLD)),
                    (format!("  · {}", status_word(&tool.status)), status_style(&tool.status)),
                ];
                out.extend(wrap(&head, width, &format!("{fold} "), "  ", Style::new().fg(Color::Blue)));
                for diff in &tool.diffs {
                    let parts = vec![
                        (diff.path.clone(), Style::new()),
                        (format!("  +{}", diff.added), Style::new().fg(Color::Green)),
                        (format!(" -{}", diff.removed), Style::new().fg(Color::Red)),
                        (if diff.new_file { "  (새 파일)".into() } else { String::new() }, dim),
                    ];
                    out.extend(wrap(&parts, width, "    ± ", "      ", dim));
                }
                if details {
                    if let Some(command) = tool.raw_input.as_ref().and_then(crate::model::command_of) {
                        block(&mut out, &command, Style::new().fg(Color::Yellow), width, "    $ ", "      ", dim);
                    }
                    let lines: Vec<&str> = tool.text.split('\n').collect();
                    let shown = if lines.len() > 30 {
                        format!("{}\n… {}줄 더", lines[..30].join("\n"), lines.len() - 30)
                    } else {
                        tool.text.clone()
                    };
                    if !shown.is_empty() {
                        block(&mut out, &shown, dim, width, "    │ ", "    │ ", dim);
                    }
                } else if !tool.text.is_empty() {
                    let count = tool.text.split('\n').count();
                    out.extend(wrap(&[(format!("결과 {count}줄 (Ctrl+T 펼치기)"), dim)], width, "    ", "    ", dim));
                }
            }
            Entry::Plan(items) => {
                out.push(Line::from(Span::styled("# 계획", Style::new().fg(Color::Blue).add_modifier(Modifier::BOLD))));
                for (content, status) in items {
                    let mark = match status.as_str() {
                        "completed" => "[x] ",
                        "in_progress" => "[>] ",
                        _ => "[ ] ",
                    };
                    out.extend(wrap(&[(content.clone(), Style::new())], width, &format!("  {mark}"), "      ", dim));
                }
            }
            Entry::Note(text) => block(&mut out, text, dim, width, "· ", "  ", dim),
            Entry::Error(text) => block(&mut out, text, Style::new().fg(Color::Red), width, "✖ ", "  ", Style::new().fg(Color::Red)),
        }
        out.push(Line::default());
    }
    out
}

fn short(text: &str, max: usize) -> String {
    let mut out = String::new();
    let mut used = 0;
    for c in text.chars() {
        let w = width_of(c);
        if used + w > max {
            out.push('…');
            break;
        }
        out.push(c);
        used += w;
    }
    out
}

fn selector_name(selector: &Option<Selector>) -> String {
    selector
        .as_ref()
        .map(|s| {
            s.options
                .iter()
                .find(|(id, _)| *id == s.current)
                .map(|(_, name)| name.clone())
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| s.current.clone())
        })
        .unwrap_or_else(|| "-".into())
}

fn slash_matches(model: &Model, input: &[char]) -> Vec<(String, String)> {
    if input.first() != Some(&'/') || input.iter().any(|c| c.is_whitespace()) {
        return vec![];
    }
    let typed: String = input[1..].iter().collect();
    model.commands.iter().filter(|(name, _)| name.starts_with(&typed)).take(8).cloned().collect()
}

/// Clears a popup's area. A wide character under the popup's left edge would make ratatui skip the border cell
/// it covers, and a wide character cut by the right edge would leave half a glyph, so both are blanked first.
fn clear_popup(f: &mut Frame, r: Rect) {
    let buf = f.buffer_mut();
    for y in r.top()..r.bottom() {
        if r.x > 0 && buf[(r.x - 1, y)].symbol().chars().map(width_of).sum::<usize>() > 1 {
            buf[(r.x - 1, y)].set_symbol(" ");
        }
        if r.right() < buf.area.right() && buf[(r.right() - 1, y)].symbol().chars().map(width_of).sum::<usize>() > 1 {
            buf[(r.right(), y)].set_symbol(" ");
        }
    }
    f.render_widget(Clear, r);
}

fn centered(area: Rect, width: u16, height: u16) -> Rect {
    let width = width.min(area.width);
    let height = height.min(area.height);
    Rect::new(area.x + (area.width - width) / 2, area.y + (area.height - height) / 2, width, height)
}

fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_default()
}

fn card_lines(p: &Pending, width: u16, details: bool) -> Vec<Line<'static>> {
    let mut out = vec![];
    let label = Style::new().fg(Color::Yellow).add_modifier(Modifier::BOLD);
    let dim = Style::new().fg(Color::DarkGray);
    if p.method == "session/request_permission" {
        out.extend(wrap(&[(p.title.clone(), Style::new().add_modifier(Modifier::BOLD))], width, "도구  ", "      ", label));
        if let Some(command) = &p.command {
            out.push(Line::from(Span::styled("명령 (글자 그대로 · ┊ 화면 폭 때문에 이어진 줄 · 줄 끝 ␣ 빈칸):", label)));
            for line in command.split('\n') {
                out.extend(wrap_with(&[(line.to_string(), Style::new().fg(Color::White))], width, "│ ", "┊ ", dim, true));
            }
        }
        for path in &p.paths {
            out.extend(wrap(&[(path.clone(), Style::new())], width, "경로  ", "      ", label));
        }
        for diff in &p.diffs {
            let parts = vec![
                (diff.path.clone(), Style::new()),
                (format!("  +{}", diff.added), Style::new().fg(Color::Green)),
                (format!(" -{}", diff.removed), Style::new().fg(Color::Red)),
                (if diff.new_file { "  (새 파일)".into() } else { String::new() }, dim),
            ];
            out.extend(wrap(&parts, width, "바뀜  ", "      ", label));
        }
        if details || (p.command.is_none() && p.paths.is_empty() && p.diffs.is_empty()) {
            if let Some(raw) = &p.raw_input {
                out.push(Line::from(Span::styled("rawInput 원본:", label)));
                block(&mut out, &pretty(raw), dim, width, "  ", "  ", dim);
            }
        }
    } else {
        out.push(Line::from(Span::styled(format!("에이전트가 이 클라이언트가 모르는 요청을 보냈습니다: {}", p.method), label)));
        block(&mut out, &pretty(&p.params), dim, width, "  ", "  ", dim);
    }
    out.extend(wrap(&[(format!("toolCallId {} · 기록 번호 {}", p.tool_call_id, p.seq), dim)], width, "", "", dim));
    out
}

impl Screen {
    pub fn enter() -> std::io::Result<Screen> {
        terminal::enable_raw_mode()?;
        let mut out = std::io::stdout();
        execute!(out, terminal::EnterAlternateScreen, ratatui::crossterm::event::EnableBracketedPaste)?;
        let term = Terminal::new(CrosstermBackend::new(out))?;
        Ok(Screen { term, view: View::default() })
    }

    pub fn leave(&mut self) {
        restore_terminal();
    }

    pub fn draw(&mut self, model: &Model) {
        let view = &mut self.view;
        view.staged = Shown::default();
        let drawn = self.term.draw(|f| render(f, model, view)).is_ok();
        self.view.shown = if drawn { std::mem::take(&mut self.view.staged) } else { Shown::default() };
    }

    pub fn redraw_all(&mut self) {
        let _ = self.term.clear();
    }

    fn copy(&mut self, text: &str) {
        let encoded = base64(text.as_bytes());
        let mut out = std::io::stdout();
        let _ = write!(out, "\x1b]52;c;{encoded}\x07");
        let _ = out.flush();
    }

    pub fn event(&mut self, event: Event, model: &Model) -> Vec<Action> {
        match event {
            Event::Resize(..) => {
                let _ = self.term.autoresize();
                vec![]
            }
            Event::Paste(text) => {
                if self.card_active(model) || self.view.popup.is_some() {
                    return vec![];
                }
                let text = text.replace("\r\n", "\n").replace('\r', "\n");
                for c in text.chars() {
                    self.view.input.insert(self.view.cursor, c);
                    self.view.cursor += 1;
                }
                vec![]
            }
            Event::Key(key) if key.kind != KeyEventKind::Release => self.key(key, model),
            _ => vec![],
        }
    }

    fn card_active(&self, model: &Model) -> bool {
        !model.pending.is_empty() && !self.view.card_hidden
    }

    fn key(&mut self, key: KeyEvent, model: &Model) -> Vec<Action> {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        let alt = key.modifiers.contains(KeyModifiers::ALT);
        self.view.flash = None;
        if ctrl && key.code == KeyCode::Char('l') {
            self.redraw_all();
            return vec![];
        }
        if ctrl && key.code == KeyCode::Char('t') {
            self.view.details = !self.view.details;
            return vec![];
        }
        if let Some(popup) = self.view.popup.take() {
            return self.popup_key(popup, key, model);
        }
        if !model.pending.is_empty() && !self.view.card_hidden {
            let Some(p) = shown_card(model, self.view.shown.card.as_ref().map(|(key, _, _)| key.as_str())) else {
                self.view.flash = Some("새 승인 카드가 왔습니다. 카드를 보고 답하세요".into());
                return vec![];
            };
            let actions = self.card_key(p, key);
            if actions.iter().any(|a| matches!(a, Action::Answer { .. })) {
                self.view.card_key.clear();
            }
            return actions;
        }
        let late_answer = self.view.input.is_empty() && matches!(key.code, KeyCode::Enter | KeyCode::Char('y' | 'n' | '1'..='9'));
        if late_answer && self.view.closed_elsewhere.is_some_and(|at| at.elapsed() < std::time::Duration::from_millis(1500)) {
            self.view.flash = Some("다른 쪽이 먼저 답한 승인이라 이 키는 버렸습니다".into());
            return vec![];
        }
        let v = &mut self.view;
        match key.code {
            KeyCode::F(1) => v.popup = Some(Popup::Help),
            KeyCode::F(2) => {
                if model.modes.is_some() {
                    v.popup = Some(Popup::Modes(0));
                } else {
                    v.flash = Some("이 에이전트는 모드 바꾸기를 알려 주지 않았습니다".into());
                }
            }
            KeyCode::F(3) => {
                if model.models.is_some() {
                    v.popup = Some(Popup::Models(0));
                } else {
                    v.flash = Some("이 에이전트는 모델 바꾸기를 알려 주지 않았습니다".into());
                }
            }
            KeyCode::F(4) => v.popup = Some(Popup::Resume),
            KeyCode::F(5) => v.card_hidden = false,
            KeyCode::Char('q') if ctrl => v.popup = Some(Popup::Quit),
            KeyCode::Char('c') if ctrl => {
                if model.working {
                    return vec![Action::Cancel];
                }
                v.input.clear();
                v.cursor = 0;
                v.flash = Some("닫으려면 Ctrl+Q".into());
            }
            KeyCode::Esc => {
                if model.working {
                    return vec![Action::Cancel];
                }
            }
            KeyCode::Enter if alt => {
                v.input.insert(v.cursor, '\n');
                v.cursor += 1;
            }
            KeyCode::Char('j') if ctrl => {
                v.input.insert(v.cursor, '\n');
                v.cursor += 1;
            }
            KeyCode::Enter => {
                let matches = slash_matches(model, &v.input);
                if let Some((name, _)) = matches.get(v.slash.min(matches.len().saturating_sub(1))) {
                    let typed: String = v.input[1..].iter().collect();
                    if typed != *name {
                        v.input = format!("/{name} ").chars().collect();
                        v.cursor = v.input.len();
                        return vec![];
                    }
                }
                let text: String = v.input.iter().collect();
                if text.trim().is_empty() {
                    return vec![];
                }
                if model.working {
                    v.flash = Some("에이전트가 일하는 중입니다. 끝나면 보내거나 Esc로 취소하세요".into());
                    return vec![];
                }
                if v.history.len() >= HISTORY {
                    v.history.remove(0);
                }
                v.history.push(text.clone());
                v.history_at = None;
                v.input.clear();
                v.cursor = 0;
                v.scroll = 0;
                v.slash = 0;
                return vec![Action::Prompt(text)];
            }
            KeyCode::Tab => {
                let matches = slash_matches(model, &v.input);
                if let Some((name, _)) = matches.get(v.slash.min(matches.len().saturating_sub(1))) {
                    v.input = format!("/{name} ").chars().collect();
                    v.cursor = v.input.len();
                }
            }
            KeyCode::Backspace => {
                if v.cursor > 0 {
                    v.cursor -= 1;
                    v.input.remove(v.cursor);
                }
            }
            KeyCode::Delete => {
                if v.cursor < v.input.len() {
                    v.input.remove(v.cursor);
                }
            }
            KeyCode::Left => v.cursor = v.cursor.saturating_sub(1),
            KeyCode::Right => v.cursor = (v.cursor + 1).min(v.input.len()),
            KeyCode::Home => v.cursor = 0,
            KeyCode::End => v.cursor = v.input.len(),
            KeyCode::Char('a') if ctrl => v.cursor = 0,
            KeyCode::Char('e') if ctrl => v.cursor = v.input.len(),
            KeyCode::Char('u') if ctrl => {
                v.input.drain(..v.cursor);
                v.cursor = 0;
            }
            KeyCode::Char('w') if ctrl => {
                let mut at = v.cursor;
                while at > 0 && v.input[at - 1].is_whitespace() {
                    at -= 1;
                }
                while at > 0 && !v.input[at - 1].is_whitespace() {
                    at -= 1;
                }
                v.input.drain(at..v.cursor);
                v.cursor = at;
            }
            KeyCode::Up | KeyCode::Down if !slash_matches(model, &v.input).is_empty() => {
                let count = slash_matches(model, &v.input).len();
                v.slash = if key.code == KeyCode::Up { (v.slash + count - 1) % count } else { (v.slash + 1) % count };
            }
            KeyCode::Up => {
                if !v.history.is_empty() {
                    let at = v.history_at.map(|a| a.saturating_sub(1)).unwrap_or(v.history.len() - 1);
                    v.history_at = Some(at);
                    v.input = v.history[at].chars().collect();
                    v.cursor = v.input.len();
                }
            }
            KeyCode::Down => {
                if let Some(at) = v.history_at {
                    if at + 1 < v.history.len() {
                        v.history_at = Some(at + 1);
                        v.input = v.history[at + 1].chars().collect();
                    } else {
                        v.history_at = None;
                        v.input.clear();
                    }
                    v.cursor = v.input.len();
                }
            }
            KeyCode::PageUp => v.scroll += 10,
            KeyCode::PageDown => v.scroll = v.scroll.saturating_sub(10),
            KeyCode::Char(c) if !ctrl => {
                v.input.insert(v.cursor, c);
                v.cursor += 1;
                v.slash = 0;
            }
            _ => {}
        }
        vec![]
    }

    fn card_key(&mut self, p: &Pending, key: KeyEvent) -> Vec<Action> {
        let v = &mut self.view;
        let count = p.options.len().max(1);
        let (shown_choice, visible) = v.shown.card.as_ref().map(|(_, choice, visible)| (*choice, *visible)).unwrap_or((usize::MAX, 0));
        let pick = |index: usize| -> Vec<Action> {
            if index >= visible {
                return vec![];
            }
            if p.options.is_empty() {
                vec![Action::Answer { key: p.key.clone(), option: None }]
            } else {
                vec![Action::Answer {
                    key: p.key.clone(),
                    option: Some(p.options[index].id.clone()),
                }]
            }
        };
        let by_kind = |kind: &str| p.options.iter().position(|o| o.kind == kind);
        match key.code {
            KeyCode::Char(c @ '1'..='9') => {
                let index = c as usize - '1' as usize;
                if index < count {
                    return pick(index);
                }
            }
            KeyCode::Char('y') => {
                if let Some(index) = by_kind("allow_once") {
                    return pick(index);
                }
            }
            KeyCode::Char('n') => {
                if let Some(index) = by_kind("reject_once") {
                    return pick(index);
                }
            }
            KeyCode::Up => v.card_choice = (v.card_choice + count - 1) % count,
            KeyCode::Down => v.card_choice = (v.card_choice + 1) % count,
            KeyCode::Enter if v.card_choice == shown_choice => return pick(v.card_choice.min(count - 1)),
            KeyCode::PageUp => v.card_scroll = v.card_scroll.saturating_sub(5),
            KeyCode::PageDown => v.card_scroll += 5,
            KeyCode::Esc => {
                v.card_hidden = true;
                v.flash = Some("승인 카드를 접었습니다. F5로 다시 엽니다".into());
            }
            _ => {}
        }
        vec![]
    }

    fn popup_key(&mut self, popup: Popup, key: KeyEvent, model: &Model) -> Vec<Action> {
        let list_len = |s: &Option<Selector>| s.as_ref().map(|s| s.options.len()).unwrap_or(0).max(1);
        match popup {
            Popup::Modes(at) | Popup::Models(at) => {
                let is_mode = matches!(popup, Popup::Modes(_));
                let selector = if is_mode { &model.modes } else { &model.models };
                let count = list_len(selector);
                let next = match key.code {
                    KeyCode::Up => (at + count - 1) % count,
                    KeyCode::Down => (at + 1) % count,
                    KeyCode::Enter => {
                        let Some((id, _)) = selector.as_ref().and_then(|s| s.options.get(at)).cloned().filter(|(id, _)| self.view.shown.picker.as_ref() == Some(id)) else {
                            self.view.popup = Some(popup);
                            return vec![];
                        };
                        return vec![if is_mode { Action::SetMode(id) } else { Action::SetModel(id) }];
                    }
                    KeyCode::Esc => return vec![],
                    _ => at,
                };
                self.view.popup = Some(if is_mode { Popup::Modes(next) } else { Popup::Models(next) });
            }
            Popup::Resume => match key.code {
                KeyCode::Char('c') => {
                    if let Some(command) = model.resume.clone() {
                        self.copy(&command);
                        self.view.flash = Some("명령을 클립보드로 보냈습니다 (OSC 52)".into());
                    }
                }
                KeyCode::Esc | KeyCode::Enter | KeyCode::F(4) => {}
                _ => self.view.popup = Some(Popup::Resume),
            },
            Popup::Quit => {
                if key.code == KeyCode::Char('y') {
                    return vec![Action::Quit];
                }
            }
            Popup::Help => {}
        }
        vec![]
    }
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |acc, (i, b)| acc | (*b as u32) << (16 - 8 * i));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(TABLE[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn render(f: &mut Frame, model: &Model, v: &mut View) {
    let area = f.area();
    let input_rows = input_rows(&v.input, v.cursor, area.width.saturating_sub(2));
    let input_height = (input_rows.0.len() as u16).clamp(1, 6) + 2;
    let [head, body, input, foot] = Layout::vertical([Constraint::Length(1), Constraint::Min(1), Constraint::Length(input_height), Constraint::Length(1)]).areas(area);

    let mut spans = vec![
        Span::styled(" ACP 보관 ", Style::new().fg(Color::Black).bg(Color::Cyan).add_modifier(Modifier::BOLD)),
        Span::raw(format!(" {} ", model.agent)),
        Span::styled(
            format!("세션 {} ", model.session.as_deref().map(|s| short(s, 12)).unwrap_or_else(|| "-".into())),
            Style::new().fg(Color::DarkGray),
        ),
        Span::raw(format!("모드 {} · 모델 {} ", short(&selector_name(&model.modes), 18), short(&selector_name(&model.models), 24))),
        Span::styled(format!("클라이언트 {} ", model.clients), Style::new().fg(Color::DarkGray)),
    ];
    if let Some(usage) = &model.usage {
        spans.push(Span::styled(format!("{usage} "), Style::new().fg(Color::DarkGray)));
    }
    spans.push(if model.working {
        Span::styled("● 일하는 중 ", Style::new().fg(Color::Yellow))
    } else {
        Span::styled("○ 대기 ", Style::new().fg(Color::Green))
    });
    if !model.pending.is_empty() {
        spans.push(Span::styled(format!(" 승인 대기 {} ", model.pending.len()), Style::new().fg(Color::Black).bg(Color::Yellow)));
    }
    if let Some(gone) = &model.agent_gone {
        spans.push(Span::styled(format!(" {gone} "), Style::new().fg(Color::White).bg(Color::Red)));
    }
    f.render_widget(Paragraph::new(Line::from(spans)), head);

    let rows = match &v.cache {
        Some((rev, width, details, rows)) if *rev == model.revision && *width == body.width && *details == v.details => rows.clone(),
        _ => {
            let rows = chat(model, body.width, v.details);
            v.cache = Some((model.revision, body.width, v.details, rows.clone()));
            rows
        }
    };
    let height = body.height as usize;
    let max_scroll = rows.len().saturating_sub(height);
    v.scroll = v.scroll.min(max_scroll);
    let end = rows.len() - v.scroll;
    let start = end.saturating_sub(height);
    f.render_widget(Paragraph::new(rows[start..end].to_vec()), body);
    if v.scroll > 0 {
        let tag = format!(" ↑ {}줄 위 · PgDn ", v.scroll);
        let w = tag.chars().map(width_of).sum::<usize>() as u16;
        f.render_widget(
            Paragraph::new(Span::styled(tag, Style::new().fg(Color::Black).bg(Color::DarkGray))),
            Rect::new(body.right().saturating_sub(w), body.bottom() - 1, w.min(body.width), 1),
        );
    }

    let matches = slash_matches(model, &v.input);
    if !matches.is_empty() && v.popup.is_none() {
        let h = matches.len() as u16 + 2;
        let r = Rect::new(body.x, body.bottom().saturating_sub(h), body.width.min(80), h.min(body.height));
        let sel = v.slash.min(matches.len() - 1);
        let lines: Vec<Line> = matches
            .iter()
            .enumerate()
            .map(|(i, (name, desc))| {
                let style = if i == sel { Style::new().add_modifier(Modifier::REVERSED) } else { Style::new() };
                Line::from(vec![
                    Span::styled(format!("/{name}"), style.fg(Color::Cyan)),
                    Span::styled(format!("  {}", short(&clean(desc), 60)), style),
                ])
            })
            .collect();
        clear_popup(f, r);
        f.render_widget(Paragraph::new(lines).block(Block::bordered().title(" 슬래시 명령 · Tab 채우기 ")), r);
    }

    let title = if model.working {
        " 입력 · 일하는 중 (Esc 취소) "
    } else {
        " 입력 · Enter 보내기 · Alt+Enter 줄바꿈 "
    };
    let (lines, (cur_row, cur_col)) = input_rows;
    let visible = input_height as usize - 2;
    let first = (cur_row + 1).saturating_sub(visible);
    let shown: Vec<Line> = lines.into_iter().skip(first).take(visible).map(Line::from).collect();
    f.render_widget(
        Paragraph::new(shown).block(Block::bordered().title(title).border_style(Style::new().fg(if model.working { Color::Yellow } else { Color::Cyan }))),
        input,
    );

    let hint = v.flash.clone().unwrap_or_else(|| {
        if !model.pending.is_empty() && v.card_hidden {
            "승인 대기 중 · F5 카드 열기".into()
        } else {
            "F1 도움말 · F2 모드 · F3 모델 · F4 진짜 TUI로 · Ctrl+T 펼치기 · PgUp/PgDn 스크롤 · Ctrl+Q 닫기".into()
        }
    });
    f.render_widget(Paragraph::new(Span::styled(short(&hint, foot.width as usize), Style::new().fg(Color::DarkGray))), foot);

    let mut cursor = Some((input.x + 1 + cur_col as u16, input.y + 1 + (cur_row - first) as u16));

    if !v.card_key.is_empty() && !model.pending.iter().any(|p| p.key == v.card_key) {
        v.card_key.clear();
        v.closed_elsewhere = Some(std::time::Instant::now());
        v.flash = Some("다른 쪽이 먼저 답해서 승인 카드를 닫았습니다".into());
    }

    if let Some(p) = model.pending.first().filter(|_| !v.card_hidden) {
        cursor = None;
        if v.card_key != p.key {
            v.card_key = p.key.clone();
            v.card_choice = 0;
            v.card_scroll = 0;
        }
        let width = area.width.saturating_sub(4).min(110);
        let lines = card_lines(p, width.saturating_sub(2), v.details);
        let needed = (lines.len() + p.options.len().max(1) + 4) as u16;
        let r = centered(area, width, needed.clamp(8, area.height.saturating_sub(2).max(8)));
        let options: Vec<Line> = if p.options.is_empty() {
            vec![Line::from(Span::styled(
                "[1] 지원하지 않는 요청으로 답하기 (오류 -32601)",
                Style::new().add_modifier(Modifier::REVERSED),
            ))]
        } else {
            p.options
                .iter()
                .enumerate()
                .map(|(i, o)| {
                    let color = if o.kind.starts_with("allow") {
                        Color::Green
                    } else if o.kind.starts_with("reject") {
                        Color::Red
                    } else {
                        Color::White
                    };
                    let style = if i == v.card_choice {
                        Style::new().fg(color).add_modifier(Modifier::REVERSED | Modifier::BOLD)
                    } else {
                        Style::new().fg(color)
                    };
                    Line::from(Span::styled(format!("[{}] {}  ({})", i + 1, clean(&o.name), o.kind), style))
                })
                .collect()
        };
        let inner_height = r.height.saturating_sub(2) as usize;
        let content_height = inner_height.saturating_sub(options.len() + 2).max(1);
        v.card_scroll = v.card_scroll.min(lines.len().saturating_sub(content_height));
        let visible = inner_height.saturating_sub(content_height + 1).min(options.len());
        if v.popup.is_none() {
            v.staged.card = Some((p.key.clone(), v.card_choice, visible));
        }
        let more = lines.len() > v.card_scroll + content_height;
        let mut all: Vec<Line> = lines.into_iter().skip(v.card_scroll).take(content_height).collect();
        while all.len() < content_height {
            all.push(Line::default());
        }
        all.push(Line::from(Span::styled(if more { "──── ↓ 더 있음 (PgDn) ────" } else { "────" }, Style::new().fg(Color::DarkGray))));
        all.extend(options);
        all.push(Line::from(Span::styled(
            "1-9 또는 ↑↓ Enter 고르기 · y 허용 · n 거절 · PgUp/PgDn 내용 · Ctrl+T 원본 · Esc 접기",
            Style::new().fg(Color::DarkGray),
        )));
        let title = if p.method == "session/request_permission" {
            format!(" 승인 요청 1/{} · {} ", model.pending.len(), if p.kind.is_empty() { "?" } else { &p.kind })
        } else {
            format!(" 에이전트 요청 1/{} · {} ", model.pending.len(), p.method)
        };
        clear_popup(f, r);
        f.render_widget(Paragraph::new(all).block(Block::bordered().title(title).border_style(Style::new().fg(Color::Yellow))), r);
    }

    if let Some(popup) = &v.popup {
        cursor = None;
        let plain = Style::new();
        let (title, items): (String, Vec<(String, Style)>) = match popup {
            Popup::Help => (
                " 도움말 ".into(),
                [
                    "Enter 보내기 (session/prompt) · Alt+Enter 또는 Ctrl+J 줄바꿈",
                    "Esc / Ctrl+C 일하는 중이면 취소 (session/cancel)",
                    "/ 로 시작하면 에이전트의 슬래시 명령 목록 · Tab 채우기",
                    "F2 모드 바꾸기 · F3 모델 바꾸기 · F4 진짜 TUI로 이어 열기",
                    "승인 카드: 1-9, ↑↓ Enter, y 허용, n 거절, Esc 접기, F5 다시 열기",
                    "Ctrl+T 도구 결과·생각·원본 펼치기 · PgUp/PgDn 대화 스크롤",
                    "Ctrl+L 다시 그리기 · Ctrl+Q 닫기 (에이전트도 끝남)",
                    "같은 승인은 Ovis 쪽 클라이언트에도 보이고, 먼저 답한 쪽이 이깁니다",
                ]
                .iter()
                .map(|s| (s.to_string(), plain))
                .collect(),
            ),
            Popup::Modes(at) | Popup::Models(at) => {
                let (name, selector) = if matches!(popup, Popup::Modes(_)) {
                    (" 모드 ", &model.modes)
                } else {
                    (" 모델 ", &model.models)
                };
                let lines = selector
                    .as_ref()
                    .map(|s| {
                        s.options
                            .iter()
                            .enumerate()
                            .map(|(i, (id, label))| {
                                let mark = if *id == s.current { "● " } else { "  " };
                                let style = if i == *at { Style::new().add_modifier(Modifier::REVERSED) } else { Style::new() };
                                if i == *at {
                                    v.staged.picker = Some(id.clone());
                                }
                                (format!("{mark}{label} ({id})"), style)
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                (format!("{name}· ↑↓ Enter · Esc "), lines)
            }
            Popup::Resume => {
                let command = match &model.resume {
                    Some(command) => (format!("  {command}"), Style::new().fg(Color::Yellow).add_modifier(Modifier::BOLD)),
                    None => ("  (이 에이전트의 이어 열기 명령을 모릅니다. --resume 으로 알려 주세요)".into(), plain),
                };
                let items = vec![
                    ("이 세션을 에이전트의 진짜 TUI로 열려면, 같은 폴더와 환경의 다른 터미널에서:".into(), plain),
                    (String::new(), plain),
                    command,
                    (String::new(), plain),
                    (format!("폴더: {}", model.cwd), plain),
                    ("이 칸의 에이전트가 같은 세션을 잡고 있으므로, 진짜 TUI에서 이어 쓰기 전에 이 칸을 닫는 것이 안전합니다.".into(), plain),
                    (String::new(), plain),
                    ("c 명령 복사 (OSC 52) · Esc 닫기".into(), Style::new().fg(Color::DarkGray)),
                ];
                (" 진짜 TUI로 이어 열기 ".into(), items)
            }
            Popup::Quit => (" 닫기 ".into(), vec![("이 칸을 닫으면 에이전트도 끝납니다. 닫을까요? y 닫기 · 다른 키 취소".into(), plain)]),
        };
        let width = area.width.saturating_sub(4).min(100);
        let lines: Vec<Line> = items
            .iter()
            .flat_map(|(text, style)| wrap(&[(text.clone(), *style)], width.saturating_sub(2), "", "", *style))
            .collect();
        let height = (lines.len() as u16 + 2).min(area.height);
        let r = centered(area, width, height);
        clear_popup(f, r);
        f.render_widget(Paragraph::new(lines).block(Block::bordered().title(title).border_style(Style::new().fg(Color::Cyan))), r);
    }

    if let Some(at) = cursor {
        f.set_cursor_position(at);
    }
}

/// The input box rows by display width, and where the cursor lands (row, column).
fn input_rows(input: &[char], cursor: usize, width: u16) -> (Vec<String>, (usize, usize)) {
    let width = (width as usize).max(2);
    let mut rows = vec![String::new()];
    let mut used = 0;
    let mut at = (0, 0);
    for (i, c) in input.iter().enumerate() {
        if i == cursor {
            at = (rows.len() - 1, used);
        }
        if *c == '\n' {
            rows.push(String::new());
            used = 0;
            continue;
        }
        let shown = clean(&c.to_string());
        let w: usize = shown.chars().map(width_of).sum();
        if used + w > width {
            rows.push(String::new());
            used = 0;
            if i == cursor {
                at = (rows.len() - 1, 0);
            }
        }
        rows.last_mut().expect("one row").push_str(&shown);
        used += w;
    }
    if cursor >= input.len() {
        if used >= width {
            rows.push(String::new());
            used = 0;
        }
        at = (rows.len() - 1, used);
    }
    (rows, at)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_answers_only_the_card_on_screen() {
        let mut model = Model::default();
        let ask = |id: u64| serde_json::json!({"jsonrpc": "2.0", "id": id, "method": "session/request_permission", "params": {"options": []}});
        for id in [1, 2] {
            model.request(id.to_string(), serde_json::json!(id), id, ask(id).as_object().unwrap());
        }
        assert!(shown_card(&model, None).is_none(), "a card answered before it was drawn");
        assert_eq!(shown_card(&model, Some("1")).map(|p| p.key.as_str()), Some("1"));
        model.resolve("1");
        assert!(shown_card(&model, Some("1")).is_none(), "the next card took a key meant for the one answered elsewhere");
        assert_eq!(shown_card(&model, Some("2")).map(|p| p.key.as_str()), Some("2"));
    }

    #[test]
    fn wide_characters_wrap_whole() {
        let rows = wrap(&[("가나다라".into(), Style::new())], 5, "", "", Style::new());
        let text: Vec<String> = rows.iter().map(|l| l.spans.iter().map(|s| s.content.to_string()).collect()).collect();
        assert_eq!(text, vec!["가나", "다라"]);
    }

    #[test]
    fn popup_border_over_a_wide_character_is_drawn() {
        let mut term = Terminal::new(ratatui::backend::TestBackend::new(10, 3)).unwrap();
        let text = || Paragraph::new("가나다라마");
        term.draw(|f| f.render_widget(text(), f.area())).unwrap();
        term.draw(|f| {
            f.render_widget(text(), f.area());
            let r = Rect::new(3, 0, 5, 3);
            clear_popup(f, r);
            f.render_widget(Block::bordered(), r);
        })
        .unwrap();
        assert_eq!(term.backend().buffer()[(3, 0)].symbol(), "┌");
    }

    #[test]
    fn a_space_at_a_break_stays_visible() {
        let rows = wrap_with(&[("ab cd".into(), Style::new())], 5, "| ", "| ", Style::new(), true);
        let text: Vec<String> = rows.iter().map(|l| l.spans.iter().map(|s| s.content.to_string()).collect()).collect();
        assert_eq!(text, vec!["| ab\u{2423}", "| cd"]);
    }

    #[test]
    fn escapes_become_visible() {
        assert_eq!(clean("a\x1b[2Jb\u{202e}"), "a\u{241b}[2Jb<U+202E>");
    }

    #[test]
    fn base64_matches_reference() {
        assert_eq!(base64(b"hello"), "aGVsbG8=");
        assert_eq!(base64("한".as_bytes()), "7ZWc");
    }
}
