//! What the screen draws, kept up to date from the ACP traffic the keeper sees in both directions.

use std::collections::HashMap;

use serde_json::{Map, Value};

pub struct Diff {
    pub path: String,
    pub added: usize,
    pub removed: usize,
    pub new_file: bool,
}

pub struct Tool {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub status: String,
    pub raw_input: Option<Value>,
    pub text: String,
    pub diffs: Vec<Diff>,
    pub locations: Vec<String>,
}

pub enum Entry {
    User(String),
    Agent(String),
    Thought(String),
    Tool(Tool),
    Plan(Vec<(String, String)>),
    Note(String),
    Error(String),
}

pub struct Choice {
    pub id: String,
    pub name: String,
    pub kind: String,
}

pub struct Pending {
    pub key: String,
    pub id: Value,
    pub seq: u64,
    pub method: String,
    pub title: String,
    pub kind: String,
    pub tool_call_id: String,
    pub command: Option<String>,
    pub paths: Vec<String>,
    pub diffs: Vec<Diff>,
    pub raw_input: Option<Value>,
    pub params: Value,
    pub options: Vec<Choice>,
}

pub struct Selector {
    pub current: String,
    pub options: Vec<(String, String)>,
    pub config_id: Option<String>,
}

#[derive(Default)]
pub struct Model {
    pub agent: String,
    pub cwd: String,
    pub session: Option<String>,
    pub resume: Option<String>,
    pub entries: Vec<Entry>,
    tools: HashMap<String, usize>,
    pub commands: Vec<(String, String)>,
    pub modes: Option<Selector>,
    pub models: Option<Selector>,
    pub title: Option<String>,
    pub usage: Option<String>,
    pub working: bool,
    pub pending: Vec<Pending>,
    pub clients: usize,
    pub agent_gone: Option<String>,
    pub revision: u64,
    echo: Option<(String, String)>,
}

pub fn text_of(block: &Value) -> String {
    match block.get("type").and_then(Value::as_str) {
        Some("text") => block.get("text").and_then(Value::as_str).unwrap_or("").to_string(),
        Some("image") => "[image]".into(),
        Some("audio") => "[audio]".into(),
        Some("resource_link") => format!("[{}]", block.get("uri").and_then(Value::as_str).unwrap_or("link")),
        Some("resource") => {
            let resource = block.get("resource").unwrap_or(&Value::Null);
            resource.get("text").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| format!("[{}]", resource.get("uri").and_then(Value::as_str).unwrap_or("resource")))
        }
        _ => String::new(),
    }
}

pub fn command_of(raw: &Value) -> Option<String> {
    for key in ["command", "CommandLine", "commandLine", "cmd", "script"] {
        match raw.get(key) {
            Some(Value::String(s)) => return Some(s.clone()),
            Some(Value::Array(parts)) if parts.iter().all(Value::is_string) => {
                return Some(parts.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" "));
            }
            _ => {}
        }
    }
    None
}

fn paths_of(raw: &Value) -> Vec<String> {
    ["file_path", "filePath", "path", "Path", "notebook_path", "TargetFile"]
        .iter()
        .filter_map(|key| raw.get(*key).and_then(Value::as_str).map(str::to_string))
        .collect()
}

/// Lines added and removed, by longest common subsequence on whole lines; past 4M cells it counts
/// lines that appear on one side only, which can undercount moved lines.
pub fn line_changes(old: &str, new: &str) -> (usize, usize) {
    let a: Vec<&str> = if old.is_empty() { vec![] } else { old.lines().collect() };
    let b: Vec<&str> = if new.is_empty() { vec![] } else { new.lines().collect() };
    if a.len().saturating_mul(b.len()) > 4_000_000 {
        let mut count: HashMap<&str, i64> = HashMap::new();
        for line in &a {
            *count.entry(line).or_default() -= 1;
        }
        for line in &b {
            *count.entry(line).or_default() += 1;
        }
        let added = count.values().filter(|v| **v > 0).sum::<i64>() as usize;
        let removed = count.values().filter(|v| **v < 0).map(|v| -v).sum::<i64>() as usize;
        return (added, removed);
    }
    let mut row = vec![0usize; b.len() + 1];
    for x in &a {
        let mut diag = 0;
        for (j, y) in b.iter().enumerate() {
            let up = row[j + 1];
            row[j + 1] = if x == y { diag + 1 } else { up.max(row[j]) };
            diag = up;
        }
    }
    let common = row[b.len()];
    (b.len() - common, a.len() - common)
}

fn diffs_of(content: &Value) -> Vec<Diff> {
    content
        .as_array()
        .into_iter()
        .flatten()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("diff"))
        .map(|item| {
            let old = item.get("oldText").and_then(Value::as_str);
            let (added, removed) = line_changes(old.unwrap_or(""), item.get("newText").and_then(Value::as_str).unwrap_or(""));
            Diff { path: item.get("path").and_then(Value::as_str).unwrap_or("?").to_string(), added, removed, new_file: old.is_none() }
        })
        .collect()
}

fn texts_of(content: &Value) -> String {
    content
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| match item.get("type").and_then(Value::as_str) {
            Some("content") => Some(text_of(item.get("content").unwrap_or(&Value::Null))),
            Some("terminal") => Some(format!("[terminal {}]", item.get("terminalId").and_then(Value::as_str).unwrap_or("?"))),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn locations_of(value: Option<&Value>) -> Vec<String> {
    value.and_then(Value::as_array).into_iter().flatten().filter_map(|l| l.get("path").and_then(Value::as_str).map(str::to_string)).collect()
}

fn str_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

impl Model {
    pub fn new(agent: String, cwd: String) -> Model {
        Model { agent, cwd, ..Model::default() }
    }

    fn touch(&mut self) {
        self.revision += 1;
    }

    pub fn note(&mut self, text: impl Into<String>) {
        self.entries.push(Entry::Note(text.into()));
        self.touch();
    }

    pub fn error(&mut self, text: impl Into<String>) {
        self.entries.push(Entry::Error(text.into()));
        self.touch();
    }

    fn append(&mut self, text: &str, same: fn(&Entry) -> bool, make: fn(String) -> Entry) {
        if let Some(last) = self.entries.last_mut() {
            if same(last) {
                match last {
                    Entry::User(s) | Entry::Agent(s) | Entry::Thought(s) => s.push_str(text),
                    _ => {}
                }
                self.touch();
                return;
            }
        }
        self.entries.push(make(text.to_string()));
        self.touch();
    }

    pub fn user(&mut self, text: &str, sent: &str) {
        self.entries.push(Entry::User(text.to_string()));
        self.echo = Some((sent.to_string(), String::new()));
        self.touch();
    }

    /// Agents that echo the prompt back as user_message_chunk would draw it twice; the echo of what was just sent is dropped.
    fn swallow_echo(&mut self, chunk: &str) -> bool {
        let Some((sent, seen)) = self.echo.as_mut() else { return false };
        let mut next = seen.clone();
        next.push_str(chunk);
        if sent.starts_with(&next) {
            *seen = next;
            if seen.len() == sent.len() {
                self.echo = None;
            }
            return true;
        }
        self.echo = None;
        false
    }

    pub fn prompt_text(params: &Value) -> String {
        params.get("prompt").and_then(Value::as_array).into_iter().flatten().map(text_of).collect::<Vec<_>>().join("")
    }

    pub fn update(&mut self, params: &Value) {
        if self.session.is_some() && params.get("sessionId").and_then(Value::as_str) != self.session.as_deref() {
            return;
        }
        let Some(update) = params.get("update") else { return };
        match update.get("sessionUpdate").and_then(Value::as_str).unwrap_or("") {
            "user_message_chunk" => {
                let text = text_of(update.get("content").unwrap_or(&Value::Null));
                if !self.swallow_echo(&text) {
                    self.append(&text, |e| matches!(e, Entry::User(_)), Entry::User);
                }
            }
            "agent_message_chunk" => self.append(&text_of(update.get("content").unwrap_or(&Value::Null)), |e| matches!(e, Entry::Agent(_)), Entry::Agent),
            "agent_thought_chunk" => self.append(&text_of(update.get("content").unwrap_or(&Value::Null)), |e| matches!(e, Entry::Thought(_)), Entry::Thought),
            "tool_call" => {
                let id = str_field(update, "toolCallId").unwrap_or_default();
                let tool = Tool {
                    id: id.clone(),
                    title: str_field(update, "title").unwrap_or_default(),
                    kind: str_field(update, "kind").unwrap_or_else(|| "other".into()),
                    status: str_field(update, "status").unwrap_or_else(|| "pending".into()),
                    raw_input: update.get("rawInput").cloned(),
                    text: texts_of(update.get("content").unwrap_or(&Value::Null)),
                    diffs: diffs_of(update.get("content").unwrap_or(&Value::Null)),
                    locations: locations_of(update.get("locations")),
                };
                self.tools.insert(id, self.entries.len());
                self.entries.push(Entry::Tool(tool));
                self.touch();
            }
            "tool_call_update" => {
                let id = str_field(update, "toolCallId").unwrap_or_default();
                let at = match self.tools.get(&id) {
                    Some(at) => *at,
                    None => {
                        self.tools.insert(id.clone(), self.entries.len());
                        self.entries.push(Entry::Tool(Tool { id, title: String::new(), kind: "other".into(), status: "pending".into(), raw_input: None, text: String::new(), diffs: vec![], locations: vec![] }));
                        self.entries.len() - 1
                    }
                };
                if let Some(Entry::Tool(tool)) = self.entries.get_mut(at) {
                    if let Some(v) = str_field(update, "title") {
                        tool.title = v;
                    }
                    if let Some(v) = str_field(update, "kind") {
                        tool.kind = v;
                    }
                    if let Some(v) = str_field(update, "status") {
                        tool.status = v;
                    }
                    if let Some(v) = update.get("rawInput") {
                        tool.raw_input = Some(v.clone());
                    }
                    if let Some(content) = update.get("content").filter(|c| !c.is_null()) {
                        tool.text = texts_of(content);
                        tool.diffs = diffs_of(content);
                    }
                    if update.get("locations").is_some() {
                        tool.locations = locations_of(update.get("locations"));
                    }
                }
                self.touch();
            }
            "plan" => {
                let entries = update
                    .get("entries")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .map(|e| (str_field(e, "content").unwrap_or_default(), str_field(e, "status").unwrap_or_default()))
                    .collect();
                if let Some(Entry::Plan(old)) = self.entries.last_mut() {
                    *old = entries;
                } else {
                    self.entries.push(Entry::Plan(entries));
                }
                self.touch();
            }
            "available_commands_update" => {
                self.commands = update
                    .get("availableCommands")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .map(|c| (str_field(c, "name").unwrap_or_default(), str_field(c, "description").unwrap_or_default()))
                    .collect();
                self.touch();
            }
            "current_mode_update" => {
                if let (Some(modes), Some(id)) = (self.modes.as_mut(), str_field(update, "currentModeId")) {
                    modes.current = id;
                }
                self.touch();
            }
            "config_option_update" => {
                if let Some(options) = update.get("configOptions") {
                    self.config_options(options);
                }
            }
            "session_info_update" => {
                if let Some(title) = str_field(update, "title") {
                    self.title = Some(title);
                    self.touch();
                }
            }
            "usage_update" => {
                let used = update.get("used").and_then(Value::as_u64);
                let size = update.get("size").and_then(Value::as_u64);
                if let (Some(used), Some(size)) = (used, size) {
                    self.usage = Some(format!("{}k/{}k", used / 1000, size / 1000));
                    self.touch();
                }
            }
            _ => {}
        }
    }

    pub fn session_result(&mut self, result: &Value) {
        if let Some(modes) = result.get("modes").filter(|m| m.is_object()) {
            self.modes = Some(Selector {
                current: str_field(modes, "currentModeId").unwrap_or_default(),
                options: modes.get("availableModes").and_then(Value::as_array).into_iter().flatten().map(|m| (str_field(m, "id").unwrap_or_default(), str_field(m, "name").unwrap_or_default())).collect(),
                config_id: None,
            });
        }
        if let Some(models) = result.get("models").filter(|m| m.is_object()) {
            self.models = Some(Selector {
                current: str_field(models, "currentModelId").unwrap_or_default(),
                options: models.get("availableModels").and_then(Value::as_array).into_iter().flatten().map(|m| (str_field(m, "modelId").unwrap_or_default(), str_field(m, "name").unwrap_or_default())).collect(),
                config_id: None,
            });
        }
        if let Some(options) = result.get("configOptions") {
            self.config_options(options);
        }
        self.touch();
    }

    /// Session config options (the newer ACP form) take over the mode and model pickers when they carry those categories.
    pub fn config_options(&mut self, options: &Value) {
        for option in options.as_array().into_iter().flatten() {
            let id = str_field(option, "id").unwrap_or_default();
            let category = str_field(option, "category").unwrap_or_else(|| id.clone());
            let slot = match category.as_str() {
                "mode" => &mut self.modes,
                "model" => &mut self.models,
                _ => continue,
            };
            let mut choices = vec![];
            for item in option.get("options").and_then(Value::as_array).into_iter().flatten() {
                if let Some(group) = item.get("options").and_then(Value::as_array) {
                    choices.extend(group.iter().map(|o| (str_field(o, "value").unwrap_or_default(), str_field(o, "name").unwrap_or_default())));
                } else {
                    choices.push((str_field(item, "value").unwrap_or_default(), str_field(item, "name").unwrap_or_default()));
                }
            }
            *slot = Some(Selector { current: str_field(option, "currentValue").unwrap_or_default(), options: choices, config_id: Some(id) });
        }
        self.touch();
    }

    pub fn request(&mut self, key: String, id: Value, seq: u64, msg: &Map<String, Value>) {
        let method = msg.get("method").and_then(Value::as_str).unwrap_or("").to_string();
        let params = msg.get("params").cloned().unwrap_or(Value::Null);
        let call = params.get("toolCall").cloned().unwrap_or(Value::Null);
        let tool_call_id = str_field(&call, "toolCallId").unwrap_or_default();
        let known = self.tools.get(&tool_call_id).and_then(|at| match &self.entries[*at] {
            Entry::Tool(tool) => Some(tool),
            _ => None,
        });
        let raw_input = call.get("rawInput").cloned().or_else(|| known.and_then(|t| t.raw_input.clone()));
        let mut paths = locations_of(call.get("locations"));
        if paths.is_empty() {
            paths = known.map(|t| t.locations.clone()).unwrap_or_default();
        }
        if let Some(raw) = &raw_input {
            for path in paths_of(raw) {
                if !paths.contains(&path) {
                    paths.push(path);
                }
            }
        }
        let mut diffs = diffs_of(call.get("content").unwrap_or(&Value::Null));
        if diffs.is_empty() {
            if let Some(tool) = known {
                diffs = tool.diffs.iter().map(|d| Diff { path: d.path.clone(), added: d.added, removed: d.removed, new_file: d.new_file }).collect();
            }
        }
        let options = params
            .get("options")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|o| Choice { id: str_field(o, "optionId").unwrap_or_default(), name: str_field(o, "name").unwrap_or_default(), kind: str_field(o, "kind").unwrap_or_default() })
            .collect();
        self.pending.push(Pending {
            key,
            id,
            seq,
            method,
            title: str_field(&call, "title").or_else(|| known.map(|t| t.title.clone())).unwrap_or_default(),
            kind: str_field(&call, "kind").or_else(|| known.map(|t| t.kind.clone())).unwrap_or_default(),
            tool_call_id,
            command: raw_input.as_ref().and_then(command_of),
            paths,
            diffs,
            raw_input,
            params,
            options,
        });
        self.touch();
    }

    pub fn resolve(&mut self, key: &str) -> Option<Pending> {
        let at = self.pending.iter().position(|p| p.key == key)?;
        self.touch();
        Some(self.pending.remove(at))
    }
}

#[cfg(test)]
mod tests {
    use super::line_changes;

    #[test]
    fn counts_lines_like_a_diff() {
        assert_eq!(line_changes("", "a\nb\n"), (2, 0));
        assert_eq!(line_changes("a\nb\nc", "a\nx\nc\nd"), (2, 1));
        assert_eq!(line_changes("a\nb", "a\nb"), (0, 0));
    }
}
