//! Where every message goes. The keeper is the agent's only ACP client: it sends `initialize` and
//! `session/new` (or `session/load`) itself, so the screen works with nobody else attached. A
//! client's request reaches the agent under an id of the keeper's own and its answer comes back to
//! that client alone (a `to-client` row), so clients that count ids alike never get each other's
//! answers. An agent request is pending until the first answer arrives from the screen or any
//! client; that answer alone goes to the agent, a `_keeper/resolved` note says who won, and a later
//! answer is dropped with a `_keeper/dropped` note.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Instant;

use serde_json::{json, Map, Value};
use tokio::sync::mpsc::UnboundedSender;

use crate::archive::{key_of, rpc, Archive, MAX_LINE};
use crate::model::Model;
use crate::ui::{Action, Screen};
use crate::Opts;

pub enum Ev {
    Agent(String),
    Client { conn: u64, line: String },
    Oversize { conn: Option<u64>, bytes: usize, id: Option<Value>, request: bool },
    Open,
    Gone,
    Term(ratatui::crossterm::event::Event),
}

/// A mode or model change from the screen or a client, shown in the header once the agent accepts it.
#[derive(Clone)]
enum Change {
    Mode(String),
    Model(String),
    Config { config: String, value: String },
}

impl Change {
    fn of(method: &str, params: &Value) -> Option<Change> {
        let field = |key: &str| params.get(key).and_then(Value::as_str).map(str::to_string);
        match method {
            "session/set_mode" => field("modeId").map(Change::Mode),
            "session/set_model" => field("modelId").map(Change::Model),
            "session/set_config_option" => Some(Change::Config {
                config: field("configId")?,
                value: field("value")?,
            }),
            _ => None,
        }
    }
}

enum Own {
    Initialize,
    NewSession,
    LoadSession { resumed: bool },
    Prompt,
    Change(Change),
}

struct Route {
    conn: u64,
    id: Value,
    change: Option<Change>,
}

pub fn note(archive: &Archive, method: &str, params: Value) {
    archive.append("keeper", &json!({"jsonrpc": "2.0", "method": method, "params": params}).to_string());
}

pub struct Hub {
    archive: Arc<Archive>,
    pub agent: Option<UnboundedSender<Vec<u8>>>,
    pub model: Model,
    pub screen: Option<Screen>,
    opts: Opts,
    resumed: bool,
    next: u64,
    own: HashMap<String, Own>,
    routes: HashMap<String, Route>,
    client_ids: HashSet<(u64, String)>,
    prompts: HashSet<String>,
    started: Instant,
    drew: bool,
    pub quit: bool,
}

impl Hub {
    /// `resumed`: the session to load came from the archive, so a failed load opens a new one.
    pub fn new(archive: Arc<Archive>, agent: UnboundedSender<Vec<u8>>, screen: Option<Screen>, opts: Opts, resumed: bool, started: Instant) -> Hub {
        Hub {
            archive,
            agent: Some(agent),
            model: Model::new(opts.name.clone(), opts.cwd.clone()),
            screen,
            opts,
            resumed,
            next: 0,
            own: HashMap::new(),
            routes: HashMap::new(),
            client_ids: HashSet::new(),
            prompts: HashSet::new(),
            started,
            drew: false,
            quit: false,
        }
    }

    pub fn note_row(&self, method: &str, params: Value) {
        note(&self.archive, method, params);
    }

    fn forward(&self, raw: &str) {
        self.archive.append("to-agent", raw);
        if let Some(agent) = &self.agent {
            let mut bytes = raw.as_bytes().to_vec();
            bytes.push(b'\n');
            let _ = agent.send(bytes);
        }
    }

    fn reply(&self, conn: u64, msg: &Value) {
        self.archive.append_for(conn, &msg.to_string());
    }

    fn request(&mut self, method: &str, params: Value, own: Own) -> String {
        self.next += 1;
        let id = Value::String(format!("keeper-{}", self.next));
        let key = key_of(&id);
        self.own.insert(key.clone(), own);
        self.forward(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}).to_string());
        key
    }

    pub fn start(&mut self) {
        self.request(
            "initialize",
            json!({"protocolVersion": 1, "clientCapabilities": {"fs": {"readTextFile": false, "writeTextFile": false}, "terminal": false}, "clientInfo": {"name": "acp-keeper", "version": env!("CARGO_PKG_VERSION")}}),
            Own::Initialize,
        );
    }

    fn new_session(&mut self) {
        let mut params = json!({"cwd": self.opts.cwd, "mcpServers": []});
        if let Some(meta) = &self.opts.session_meta {
            params["_meta"] = meta.clone();
        }
        self.request("session/new", params, Own::NewSession);
    }

    pub fn handle(&mut self, ev: Ev) {
        match ev {
            Ev::Agent(text) => self.on_agent(text),
            Ev::Client { conn, line } => self.on_client(conn, line),
            Ev::Oversize { conn, bytes, id, request } => self.oversize(conn, bytes, id, request),
            Ev::Open => {
                self.model.clients += 1;
                self.model.revision += 1;
            }
            Ev::Gone => {
                self.model.clients = self.model.clients.saturating_sub(1);
                self.model.revision += 1;
            }
            Ev::Term(event) => {
                let actions = match self.screen.as_mut() {
                    Some(screen) => screen.event(event, &self.model),
                    None => vec![],
                };
                for action in actions {
                    self.act(action);
                }
            }
        }
    }

    /// A line past MAX_LINE was dropped: say so in the archive, and answer whoever would otherwise
    /// wait for it forever (the client that sent a request, the agent that sent one, or the client
    /// whose request the dropped answer was for).
    fn oversize(&mut self, conn: Option<u64>, bytes: usize, id: Option<Value>, request: bool) {
        let dir = if conn.is_some() { "from-client" } else { "from-agent" };
        self.note_row("_keeper/oversize", json!({"dir": dir, "client": conn, "bytes": bytes, "limit": MAX_LINE, "id": id}));
        let message = format!("line too long: {bytes} bytes, the limit is {MAX_LINE}");
        match (conn, id) {
            (Some(conn), Some(id)) if request => self.reply(conn, &json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32600, "message": message}})),
            (None, Some(id)) if request => self.forward(&json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32600, "message": message}}).to_string()),
            (None, Some(id)) => {
                let answer = json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32603, "message": message}});
                if let Value::Object(answer) = answer {
                    self.agent_response(&key_of(&id), &answer);
                }
            }
            _ => {}
        }
        if conn.is_none() {
            self.model.error(format!("에이전트가 보낸 줄이 너무 길어 버렸습니다 ({bytes}바이트, 한도 {MAX_LINE})"));
        }
    }

    fn on_agent(&mut self, text: String) {
        let Some(msg) = rpc(&text) else { return };
        let seq = self.archive.append("from-agent", &text);
        let method = msg.get("method").and_then(Value::as_str).map(str::to_string);
        match (method, msg.get("id").cloned()) {
            (Some(method), Some(id)) => {
                if method.starts_with("fs/") || method.starts_with("terminal/") {
                    let raw = json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": "Method not found"}}).to_string();
                    self.forward(&raw);
                    self.note_row("_keeper/auto_answered", json!({"id": id, "method": method}));
                } else {
                    self.model.request(key_of(&id), id, seq, &msg);
                }
            }
            (Some(method), None) => {
                if method == "session/update" {
                    self.model.update(msg.get("params").unwrap_or(&Value::Null));
                }
            }
            (None, Some(id)) => self.agent_response(&key_of(&id), &msg),
            (None, None) => {}
        }
    }

    fn agent_response(&mut self, key: &str, msg: &Map<String, Value>) {
        let error = msg.get("error").map(|e| e.get("message").and_then(Value::as_str).unwrap_or("error").to_string());
        let result = msg.get("result").cloned().unwrap_or(Value::Null);
        if self.prompts.remove(key) {
            self.model.working = !self.prompts.is_empty();
            match &error {
                Some(e) => self.model.error(format!("턴 실패: {e}")),
                None => self.model.note(format!("턴 끝 ({})", result.get("stopReason").and_then(Value::as_str).unwrap_or("?"))),
            }
        }
        if let Some(route) = self.routes.remove(key) {
            self.client_ids.remove(&(route.conn, key_of(&route.id)));
            if let (None, Some(change)) = (&error, &route.change) {
                self.apply(change, &result);
            }
            let mut answer = msg.clone();
            answer.insert("id".into(), route.id);
            self.reply(route.conn, &Value::Object(answer));
            return;
        }
        let Some(own) = self.own.remove(key) else { return };
        match own {
            Own::Initialize => {
                if let Some(e) = error {
                    self.model.error(format!("initialize 실패: {e}"));
                    return;
                }
                let can_load = result.pointer("/agentCapabilities/loadSession") == Some(&Value::Bool(true));
                match self.opts.load.clone() {
                    Some(id) if can_load || !self.resumed => {
                        self.model.session = Some(id.clone());
                        self.request(
                            "session/load",
                            json!({"sessionId": id, "cwd": self.opts.cwd, "mcpServers": []}),
                            Own::LoadSession { resumed: self.resumed },
                        );
                    }
                    _ => self.new_session(),
                }
            }
            Own::NewSession | Own::LoadSession { .. } if error.is_some() => {
                let e = error.unwrap_or_default();
                if let Own::LoadSession { resumed: true } = own {
                    self.model.session = None;
                    self.model.note(format!("지난 세션을 이어 가지 못해 새 세션을 엽니다: {e}"));
                    self.new_session();
                    return;
                }
                let auth = msg.get("error").and_then(|e| e.get("code")).and_then(Value::as_i64) == Some(-32000);
                self.model.error(if auth {
                    format!("로그인이 필요합니다: {e}. 에이전트의 진짜 TUI나 로그인 명령으로 먼저 로그인하세요")
                } else {
                    format!("세션을 열지 못했습니다: {e}")
                });
            }
            Own::NewSession | Own::LoadSession { .. } => {
                if let Some(id) = result.get("sessionId").and_then(Value::as_str) {
                    self.model.session = Some(id.to_string());
                }
                self.model.session_result(&result);
                let session = self.model.session.clone().unwrap_or_default();
                self.model.resume = self.opts.resume.as_ref().map(|t| t.replace("{session}", &session));
                self.model.note(format!("세션 {session} 열림 · 폴더 {}", self.opts.cwd));
                self.note_row(
                    "_keeper/session",
                    json!({"sessionId": session, "cwd": self.opts.cwd, "agent": self.opts.name, "resume": self.model.resume}),
                );
            }
            Own::Prompt => {}
            Own::Change(change) => match error {
                Some(e) => self.model.error(format!("바꾸지 못했습니다: {e}")),
                None => self.apply(&change, &result),
            },
        }
    }

    fn apply(&mut self, change: &Change, result: &Value) {
        let (selector, value) = match change {
            Change::Mode(id) => (self.model.modes.as_mut(), id),
            Change::Model(id) => (self.model.models.as_mut(), id),
            Change::Config { config, value } => (
                [self.model.modes.as_mut(), self.model.models.as_mut()]
                    .into_iter()
                    .flatten()
                    .find(|s| s.config_id.as_deref() == Some(config)),
                value,
            ),
        };
        if let Some(selector) = selector {
            selector.current = value.clone();
        }
        if let Some(options) = result.get("configOptions") {
            self.model.config_options(options);
        }
        self.model.note(format!("{value}(으)로 바꿈"));
    }

    fn on_client(&mut self, conn: u64, line: String) {
        let Some(mut msg) = rpc(&line) else { return };
        let by = format!("client-{conn}");
        let method = msg.get("method").and_then(Value::as_str).map(str::to_string);
        match (method, msg.get("id").cloned()) {
            (None, Some(id)) => self.answer(&key_of(&id), &line, &by),
            (Some(method), Some(id)) => {
                if !self.client_ids.insert((conn, key_of(&id))) {
                    self.note_row("_keeper/rejected", json!({"id": id, "by": by, "reason": "id already in flight"}));
                    self.reply(conn, &json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32600, "message": "id already in flight"}}));
                    return;
                }
                self.next += 1;
                let routed = Value::String(format!("{by}-{}", self.next));
                let key = key_of(&routed);
                let params = msg.get("params").cloned().unwrap_or(Value::Null);
                if method == "session/prompt" && params.get("sessionId").and_then(Value::as_str) == self.model.session.as_deref() {
                    self.prompts.insert(key.clone());
                    self.model.working = true;
                    let text = Model::prompt_text(&params);
                    self.model.user(&format!("[{by}] {text}"), &text);
                }
                self.routes.insert(
                    key,
                    Route {
                        conn,
                        id,
                        change: Change::of(&method, &params),
                    },
                );
                msg.insert("id".into(), routed);
                self.forward(&Value::Object(msg).to_string());
            }
            (Some(method), None) => {
                self.forward(&line);
                if method == "session/cancel" {
                    let session = msg.get("params").and_then(|p| p.get("sessionId")).and_then(Value::as_str).map(str::to_string);
                    self.cancel_pending(session.as_deref(), &by);
                }
            }
            (None, None) => {}
        }
    }

    fn answer(&mut self, key: &str, raw: &str, by: &str) {
        let Some(pending) = self.model.resolve(key) else {
            let id: Value = serde_json::from_str(key).unwrap_or(Value::Null);
            self.note_row("_keeper/dropped", json!({"id": id, "by": by, "reason": "not pending (already answered or unknown)"}));
            return;
        };
        self.forward(raw);
        let option = serde_json::from_str::<Value>(raw)
            .ok()
            .and_then(|v| v.pointer("/result/outcome/optionId").and_then(Value::as_str).map(str::to_string));
        let outcome = serde_json::from_str::<Value>(raw)
            .ok()
            .and_then(|v| v.pointer("/result/outcome/outcome").and_then(Value::as_str).map(str::to_string));
        self.note_row("_keeper/resolved", json!({"id": pending.id, "by": by, "optionId": option, "outcome": outcome, "seq": pending.seq}));
        let chosen = pending
            .options
            .iter()
            .find(|o| Some(&o.id) == option.as_ref())
            .map(|o| o.name.clone())
            .or(outcome)
            .unwrap_or_else(|| "오류로 답함".into());
        let who = if by == "terminal" {
            "터미널".to_string()
        } else if by == "keeper-cancel" {
            "취소".to_string()
        } else {
            format!("클라이언트 {}", by.trim_start_matches("client-"))
        };
        self.model
            .note(format!("승인 답함 ({who}): {chosen} · {}", if pending.title.is_empty() { &pending.method } else { &pending.title }));
    }

    fn cancel_pending(&mut self, session: Option<&str>, by: &str) {
        let keys: Vec<(String, Value)> = self
            .model
            .pending
            .iter()
            .filter(|p| p.method == "session/request_permission" && p.params.get("sessionId").and_then(Value::as_str) == session)
            .map(|p| (p.key.clone(), p.id.clone()))
            .collect();
        for (key, id) in keys {
            let raw = json!({"jsonrpc": "2.0", "id": id, "result": {"outcome": {"outcome": "cancelled"}}}).to_string();
            self.answer(&key, &raw, "keeper-cancel");
        }
        self.model.note(format!("취소 보냄 ({by})"));
    }

    fn act(&mut self, action: Action) {
        let session = self.model.session.clone();
        match action {
            Action::Prompt(text) => {
                let Some(session) = session else {
                    self.model.error("세션이 아직 없습니다");
                    return;
                };
                let key = self.request("session/prompt", json!({"sessionId": session, "prompt": [{"type": "text", "text": text}]}), Own::Prompt);
                self.prompts.insert(key);
                self.model.working = true;
                self.model.user(&text, &text);
            }
            Action::Cancel => {
                if let Some(session) = session {
                    self.forward(&json!({"jsonrpc": "2.0", "method": "session/cancel", "params": {"sessionId": session}}).to_string());
                    self.cancel_pending(Some(&session), "terminal");
                }
            }
            Action::Answer { key, option } => {
                let Some(pending) = self.model.pending.iter().find(|p| p.key == key) else { return };
                let raw = match option {
                    Some(option) => json!({"jsonrpc": "2.0", "id": pending.id, "result": {"outcome": {"outcome": "selected", "optionId": option}}}),
                    None => json!({"jsonrpc": "2.0", "id": pending.id, "error": {"code": -32601, "message": "Method not supported by this client"}}),
                }
                .to_string();
                self.answer(&key, &raw, "terminal");
            }
            Action::SetMode(id) => self.set(true, id, session),
            Action::SetModel(id) => self.set(false, id, session),
            Action::Quit => self.quit = true,
        }
    }

    fn set(&mut self, mode: bool, id: String, session: Option<String>) {
        let Some(session) = session else { return };
        let selector = if mode { &self.model.modes } else { &self.model.models };
        match selector.as_ref().and_then(|s| s.config_id.clone()) {
            Some(config) => self.request(
                "session/set_config_option",
                json!({"sessionId": session, "configId": config, "value": id}),
                Own::Change(Change::Config { config, value: id }),
            ),
            None if mode => self.request("session/set_mode", json!({"sessionId": session, "modeId": id}), Own::Change(Change::Mode(id))),
            None => self.request("session/set_model", json!({"sessionId": session, "modelId": id}), Own::Change(Change::Model(id))),
        };
    }

    pub fn draw(&mut self) {
        if let Some(screen) = self.screen.as_mut() {
            screen.draw(&self.model);
            if !self.drew {
                self.drew = true;
                self.note_row("_keeper/first_frame", json!({"sinceStartMs": self.started.elapsed().as_secs_f64() * 1000.0}));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver};

    fn hub(dir: &std::path::Path) -> (Hub, UnboundedReceiver<Vec<u8>>) {
        let _ = std::fs::remove_dir_all(dir);
        std::fs::create_dir_all(dir).unwrap();
        let (archive, _) = Archive::open(dir.join("archive.jsonl")).unwrap();
        let (tx, rx) = unbounded_channel();
        let opts = crate::parse(vec!["keeper".into(), dir.display().to_string(), "--".into(), "agent".into()]).unwrap();
        (Hub::new(Arc::new(archive), tx, None, opts, false, Instant::now()), rx)
    }

    #[test]
    fn a_clients_mode_and_model_change_reaches_the_header() {
        let dir = std::env::temp_dir().join(format!("ak-unit-{}-change", std::process::id()));
        let (mut hub, mut sent) = hub(&dir);
        hub.model.session = Some("s".into());
        hub.model.session_result(&json!({
            "modes": {"currentModeId": "ask", "availableModes": [{"id": "ask", "name": "Ask"}, {"id": "code", "name": "Code"}]},
            "models": {"currentModelId": "m1", "availableModels": [{"modelId": "m1", "name": "One"}, {"modelId": "m2", "name": "Two"}]},
        }));
        let mut change = |hub: &mut Hub, id: u64, method: &str, params: Value| {
            hub.handle(Ev::Client {
                conn: 1,
                line: json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}).to_string(),
            });
            let forwarded: Value = serde_json::from_slice(&sent.try_recv().expect("forwarded to the agent")).unwrap();
            hub.handle(Ev::Agent(json!({"jsonrpc": "2.0", "id": forwarded["id"], "result": {}}).to_string()));
        };
        change(&mut hub, 5, "session/set_model", json!({"sessionId": "s", "modelId": "m2"}));
        change(&mut hub, 6, "session/set_mode", json!({"sessionId": "s", "modeId": "code"}));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(hub.model.models.as_ref().unwrap().current, "m2");
        assert_eq!(hub.model.modes.as_ref().unwrap().current, "code");
    }
}
