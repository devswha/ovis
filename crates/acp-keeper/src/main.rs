//! acp-keeper: the plan 13.2 keeper with a shared terminal screen.
//!
//! The agent runs as a child on pipes and the keeper is its only ACP client: it sends `initialize` and
//! `session/new` itself, so the screen works with nobody else attached. Every JSON-RPC line in either
//! direction, plus the keeper's own `_keeper/*` notes, is numbered into ROOT/archive.jsonl. Clients on
//! ROOT/acp.sock (a named pipe on Windows) replay from any row and may send requests, notifications and
//! answers. An agent request is pending until the first answer arrives from the screen or any client;
//! that answer alone goes to the agent, a `_keeper/resolved` note says who won, and any later answer is
//! dropped with a `_keeper/dropped` note.

mod archive;
mod model;
mod ui;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};

use archive::{pump, rpc, Archive, Framer, PUSH};
use model::Model;
use ui::{Action, Screen};

enum Ev {
    Agent(String),
    Client { conn: u64, line: String },
    Open,
    Gone,
    Term(ratatui::crossterm::event::Event),
}

enum Own {
    Initialize,
    NewSession,
    LoadSession,
    Prompt,
    SetMode(String),
    SetModel(String),
}

struct Opts {
    root: PathBuf,
    cwd: String,
    name: String,
    resume: Option<String>,
    session_meta: Option<Value>,
    load: Option<String>,
    headless: bool,
    command: String,
    args: Vec<String>,
}

struct Hub {
    archive: Arc<Archive>,
    agent: Option<UnboundedSender<Vec<u8>>>,
    model: Model,
    screen: Option<Screen>,
    opts: Opts,
    next: u64,
    own: HashMap<String, Own>,
    inflight: HashSet<String>,
    prompts: HashSet<String>,
    started: Instant,
    drew: bool,
    quit: bool,
}

fn key_of(id: &Value) -> String {
    serde_json::to_string(id).unwrap_or_default()
}

impl Hub {
    fn note_row(&self, method: &str, params: Value) {
        let raw = json!({"jsonrpc": "2.0", "method": method, "params": params}).to_string();
        self.archive.append("keeper", &raw);
    }

    fn forward(&self, raw: &str) {
        self.archive.append("to-agent", raw);
        if let Some(agent) = &self.agent {
            let mut bytes = raw.as_bytes().to_vec();
            bytes.push(b'\n');
            let _ = agent.send(bytes);
        }
    }

    fn request(&mut self, method: &str, params: Value, own: Own) -> String {
        self.next += 1;
        let id = Value::String(format!("keeper-{}", self.next));
        let key = key_of(&id);
        self.own.insert(key.clone(), own);
        self.forward(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}).to_string());
        key
    }

    fn start(&mut self) {
        self.request(
            "initialize",
            json!({"protocolVersion": 1, "clientCapabilities": {"fs": {"readTextFile": false, "writeTextFile": false}, "terminal": false}, "clientInfo": {"name": "acp-keeper", "version": env!("CARGO_PKG_VERSION")}}),
            Own::Initialize,
        );
    }

    fn handle(&mut self, ev: Ev) {
        match ev {
            Ev::Agent(text) => self.from_agent(text),
            Ev::Client { conn, line } => self.from_client(conn, line),
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

    fn from_agent(&mut self, text: String) {
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
        self.inflight.remove(key);
        let Some(own) = self.own.remove(key) else { return };
        match own {
            Own::Initialize => {
                if let Some(e) = error {
                    self.model.error(format!("initialize 실패: {e}"));
                    return;
                }
                if let Some(id) = self.opts.load.clone() {
                    self.model.session = Some(id.clone());
                    self.request("session/load", json!({"sessionId": id, "cwd": self.opts.cwd, "mcpServers": []}), Own::LoadSession);
                } else {
                    let mut params = json!({"cwd": self.opts.cwd, "mcpServers": []});
                    if let Some(meta) = &self.opts.session_meta {
                        params["_meta"] = meta.clone();
                    }
                    self.request("session/new", params, Own::NewSession);
                }
            }
            Own::NewSession | Own::LoadSession => {
                if let Some(e) = error {
                    let auth = msg.get("error").and_then(|e| e.get("code")).and_then(Value::as_i64) == Some(-32000);
                    self.model.error(if auth { format!("로그인이 필요합니다: {e}. 에이전트의 진짜 TUI나 로그인 명령으로 먼저 로그인하세요") } else { format!("세션을 열지 못했습니다: {e}") });
                    return;
                }
                if let Some(id) = result.get("sessionId").and_then(Value::as_str) {
                    self.model.session = Some(id.to_string());
                }
                self.model.session_result(&result);
                let session = self.model.session.clone().unwrap_or_default();
                self.model.resume = self.opts.resume.as_ref().map(|t| t.replace("{session}", &session));
                self.model.note(format!("세션 {session} 열림 · 폴더 {}", self.opts.cwd));
                self.note_row("_keeper/session", json!({"sessionId": session, "cwd": self.opts.cwd, "agent": self.opts.name, "resume": self.model.resume}));
            }
            Own::Prompt => {}
            Own::SetMode(id) | Own::SetModel(id) => match error {
                Some(e) => self.model.error(format!("바꾸지 못했습니다: {e}")),
                None => {
                    for selector in [&mut self.model.modes, &mut self.model.models].into_iter().flatten() {
                        if selector.options.iter().any(|(o, _)| *o == id) {
                            selector.current = id.clone();
                        }
                    }
                    if let Some(options) = result.get("configOptions") {
                        self.model.config_options(options);
                    }
                    self.model.note(format!("{id}(으)로 바꿈"));
                }
            },
        }
    }

    fn from_client(&mut self, conn: u64, line: String) {
        let Some(msg) = rpc(&line) else { return };
        let by = format!("client-{conn}");
        let method = msg.get("method").and_then(Value::as_str).map(str::to_string);
        match (method, msg.get("id").cloned()) {
            (None, Some(id)) => self.answer(&key_of(&id), &line, &by),
            (Some(method), Some(id)) => {
                let key = key_of(&id);
                if self.inflight.contains(&key) || self.own.contains_key(&key) {
                    self.note_row("_keeper/rejected", json!({"id": id, "by": by, "reason": "id already in flight"}));
                    return;
                }
                let params = msg.get("params").cloned().unwrap_or(Value::Null);
                if method == "session/prompt" && params.get("sessionId").and_then(Value::as_str) == self.model.session.as_deref() {
                    self.prompts.insert(key.clone());
                    self.model.working = true;
                    let text = Model::prompt_text(&params);
                    self.model.user(&format!("[{by}] {text}"), &text);
                }
                self.inflight.insert(key);
                self.forward(&line);
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
        let option = serde_json::from_str::<Value>(raw).ok().and_then(|v| v.pointer("/result/outcome/optionId").and_then(Value::as_str).map(str::to_string));
        let outcome = serde_json::from_str::<Value>(raw).ok().and_then(|v| v.pointer("/result/outcome/outcome").and_then(Value::as_str).map(str::to_string));
        self.note_row("_keeper/resolved", json!({"id": pending.id, "by": by, "optionId": option, "outcome": outcome, "seq": pending.seq}));
        let chosen = pending.options.iter().find(|o| Some(&o.id) == option.as_ref()).map(|o| o.name.clone()).or(outcome).unwrap_or_else(|| "오류로 답함".into());
        let who = if by == "terminal" { "터미널".to_string() } else if by == "keeper-cancel" { "취소".to_string() } else { format!("클라이언트 {}", by.trim_start_matches("client-")) };
        self.model.note(format!("승인 답함 ({who}): {chosen} · {}", if pending.title.is_empty() { &pending.method } else { &pending.title }));
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
            Action::SetMode(id) => self.set("mode", id, session),
            Action::SetModel(id) => self.set("model", id, session),
            Action::Quit => self.quit = true,
        }
    }

    fn set(&mut self, what: &str, id: String, session: Option<String>) {
        let Some(session) = session else { return };
        let selector = if what == "mode" { &self.model.modes } else { &self.model.models };
        let config = selector.as_ref().and_then(|s| s.config_id.clone());
        match (config, what) {
            (Some(config), _) => {
                self.request("session/set_config_option", json!({"sessionId": session, "configId": config, "value": id}), if what == "mode" { Own::SetMode(id) } else { Own::SetModel(id) });
            }
            (None, "mode") => {
                self.request("session/set_mode", json!({"sessionId": session, "modeId": id}), Own::SetMode(id));
            }
            (None, _) => {
                self.request("session/set_model", json!({"sessionId": session, "modelId": id}), Own::SetModel(id));
            }
        }
    }

    fn draw(&mut self) {
        if let Some(screen) = self.screen.as_mut() {
            screen.draw(&self.model);
            if !self.drew {
                self.drew = true;
                self.note_row("_keeper/first_frame", json!({"sinceStartMs": self.started.elapsed().as_secs_f64() * 1000.0}));
            }
        }
    }
}

async fn serve_client<S: AsyncRead + AsyncWrite + Unpin + Send + 'static>(conn: u64, archive: Arc<Archive>, pid: u32, tx: UnboundedSender<Ev>, stream: S) {
    let (mut input, output) = tokio::io::split(stream);
    let mut framer = Framer::new();
    let mut chunk = vec![0u8; PUSH];
    let mut pumping: Option<tokio::task::JoinHandle<()>> = None;
    let mut output = Some(output);
    let _ = tx.send(Ev::Open);
    while let Ok(n) = input.read(&mut chunk).await {
        if n == 0 {
            break;
        }
        for line in framer.push(&chunk[..n]) {
            let Ok(text) = String::from_utf8(line) else { continue };
            if pumping.is_none() {
                let Ok(Value::Object(request)) = serde_json::from_str::<Value>(&text) else { continue };
                let Some(n) = request.get("replay").and_then(Value::as_u64) else { continue };
                let Some((cursor, boundary, through)) = archive.replay_from(n) else { continue };
                let (archive, mut out) = (archive.clone(), output.take().expect("one replay per connection"));
                pumping = Some(tokio::spawn(async move {
                    let _ = pump(&archive, &mut out, cursor, boundary, through, pid).await;
                    let _ = out.shutdown().await;
                }));
            } else {
                let _ = tx.send(Ev::Client { conn, line: text });
            }
        }
        if pumping.as_ref().is_some_and(|task| task.is_finished()) {
            break;
        }
    }
    if let Some(task) = pumping {
        task.abort();
    }
    let _ = tx.send(Ev::Gone);
}

#[cfg(unix)]
fn check_root(root: &Path) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;
    let meta = std::fs::metadata(root).map_err(|e| e.to_string())?;
    if !meta.is_dir() || meta.uid() != unsafe { libc::getuid() } || meta.mode() & 0o077 != 0 {
        return Err("ROOT must be owned by this user and private (0700)".into());
    }
    unsafe { libc::umask(0o077) };
    Ok(())
}

#[cfg(windows)]
fn check_root(root: &Path) -> Result<(), String> {
    if std::fs::metadata(root).map_err(|e| e.to_string())?.is_dir() {
        Ok(())
    } else {
        Err("ROOT must be a directory".into())
    }
}

#[cfg(unix)]
async fn listen(root: &Path, archive: Arc<Archive>, pid: u32, tx: UnboundedSender<Ev>) -> std::io::Result<impl std::future::Future<Output = ()>> {
    let listener = tokio::net::UnixListener::bind(root.join("acp.sock"))?;
    Ok(async move {
        let mut conn = 0;
        while let Ok((stream, _)) = listener.accept().await {
            conn += 1;
            tokio::spawn(serve_client(conn, archive.clone(), pid, tx.clone(), stream));
        }
    })
}

#[cfg(windows)]
async fn listen(root: &Path, archive: Arc<Archive>, pid: u32, tx: UnboundedSender<Ev>) -> std::io::Result<impl std::future::Future<Output = ()>> {
    use tokio::net::windows::named_pipe::ServerOptions;
    let name = format!(r"\\.\pipe\acp-keeper-{}", std::process::id());
    std::fs::write(root.join("acp.pipe"), &name)?;
    let mut server = ServerOptions::new().first_pipe_instance(true).create(&name)?;
    Ok(async move {
        let mut conn = 0;
        loop {
            if server.connect().await.is_err() {
                return;
            }
            let Ok(next) = ServerOptions::new().create(&name) else { return };
            let stream = std::mem::replace(&mut server, next);
            conn += 1;
            tokio::spawn(serve_client(conn, archive.clone(), pid, tx.clone(), stream));
        }
    })
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut hup = signal(SignalKind::hangup()).expect("SIGHUP handler");
        let mut int = signal(SignalKind::interrupt()).expect("SIGINT handler");
        let mut term = signal(SignalKind::terminate()).expect("SIGTERM handler");
        tokio::select! { _ = hup.recv() => {}, _ = int.recv() => {}, _ = term.recv() => {} }
    }
    #[cfg(windows)]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

const USAGE: &str = "Usage: acp-keeper ROOT [--cwd DIR] [--name NAME] [--resume 'CMD {session}'] [--session-meta JSON] [--load SESSION] [--headless] -- AGENT [ARGS...]";

fn default_resume(command: &str, args: &[String]) -> Option<String> {
    let base = |s: &str| Path::new(s).file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
    let words: Vec<String> = std::iter::once(base(command)).chain(args.iter().map(|a| base(a))).collect();
    let has = |name: &str| words.iter().any(|w| w == name || w.starts_with(&format!("{name}.")));
    if has("gjc") {
        Some("gjc --resume {session}".into())
    } else if has("agy") {
        Some("agy --conversation {session}".into())
    } else if words.iter().any(|w| w.contains("claude")) {
        Some("claude --resume {session}".into())
    } else if has("hermes") {
        Some("hermes --tui --resume {session}".into())
    } else if has("opencode") {
        Some("opencode --session {session}".into())
    } else {
        None
    }
}

fn parse(args: Vec<String>) -> Result<Opts, String> {
    let split = args.iter().position(|a| a == "--").ok_or(USAGE)?;
    let (head, tail) = args.split_at(split);
    let tail = &tail[1..];
    let (command, rest) = tail.split_first().ok_or(USAGE)?;
    let mut head = head.iter().skip(1);
    let root = PathBuf::from(head.next().ok_or(USAGE)?);
    let mut opts = Opts {
        root,
        cwd: std::env::current_dir().map(|d| d.to_string_lossy().into_owned()).unwrap_or_else(|_| ".".into()),
        name: Path::new(command).file_name().and_then(|n| n.to_str()).unwrap_or(command).to_string(),
        resume: default_resume(command, rest),
        session_meta: None,
        load: None,
        headless: false,
        command: command.clone(),
        args: rest.to_vec(),
    };
    while let Some(flag) = head.next() {
        let mut value = || head.next().cloned().ok_or_else(|| format!("{flag} needs a value"));
        match flag.as_str() {
            "--cwd" => opts.cwd = value()?,
            "--name" => opts.name = value()?,
            "--resume" => opts.resume = Some(value()?),
            "--session-meta" => opts.session_meta = Some(serde_json::from_str(&value()?).map_err(|e| format!("--session-meta: {e}"))?),
            "--load" => opts.load = Some(value()?),
            "--headless" => opts.headless = true,
            other => return Err(format!("unknown option {other}\n{USAGE}")),
        }
    }
    Ok(opts)
}

fn main() {
    let opts = match parse(std::env::args().collect()) {
        Ok(opts) => opts,
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(2);
        }
    };
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("tokio runtime");
    std::process::exit(runtime.block_on(run(opts)));
}

fn is_terminal() -> bool {
    use std::io::IsTerminal;
    std::io::stdout().is_terminal() && std::io::stdin().is_terminal()
}

async fn run(opts: Opts) -> i32 {
    let started = Instant::now();
    if let Err(message) = check_root(&opts.root) {
        eprintln!("{message}");
        return 1;
    }
    let root = opts.root.clone();
    let archive = match Archive::create(root.join("archive.jsonl")) {
        Ok(archive) => Arc::new(archive),
        Err(e) => {
            eprintln!("archive: {e}");
            return 1;
        }
    };
    let stderr = match archive::create(&root.join("agent.stderr")) {
        Ok(file) => file,
        Err(e) => {
            eprintln!("agent.stderr: {e}");
            return 1;
        }
    };
    let mut child = match Command::new(&opts.command).args(&opts.args).current_dir(&opts.cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(stderr).kill_on_drop(true).spawn() {
        Ok(child) => child,
        Err(e) => {
            eprintln!("{}: {e}", opts.command);
            return 1;
        }
    };
    let child_pid = child.id().unwrap_or(0);
    let (tx, mut rx) = unbounded_channel::<Ev>();
    let (agent_tx, mut agent_rx) = unbounded_channel::<Vec<u8>>();
    let mut stdin = child.stdin.take().expect("piped stdin");
    tokio::spawn(async move {
        while let Some(bytes) = agent_rx.recv().await {
            if stdin.write_all(&bytes).await.is_err() {
                break;
            }
        }
    });
    let mut stdout = child.stdout.take().expect("piped stdout");
    let agent_lines = tx.clone();
    let reader = tokio::spawn(async move {
        let mut framer = Framer::new();
        let mut chunk = vec![0u8; PUSH];
        while let Ok(n) = stdout.read(&mut chunk).await {
            if n == 0 {
                break;
            }
            for line in framer.push(&chunk[..n]) {
                if let Ok(text) = String::from_utf8(line) {
                    let _ = agent_lines.send(Ev::Agent(text));
                }
            }
        }
    });
    let accept = match listen(&root, archive.clone(), child_pid, tx.clone()).await {
        Ok(accept) => accept,
        Err(e) => {
            eprintln!("listen: {e}");
            return 1;
        }
    };
    let accepting = tokio::spawn(accept);
    let _ = std::fs::write(root.join("process.json"), format!("{{\"keeper\":{},\"child\":{child_pid}}}", std::process::id()));

    let tui = !opts.headless && is_terminal();
    let screen = if tui {
        std::panic::set_hook(Box::new(|info| {
            ui::restore_terminal();
            eprintln!("{info}");
        }));
        match Screen::enter() {
            Ok(screen) => Some(screen),
            Err(e) => {
                eprintln!("terminal: {e}");
                return 1;
            }
        }
    } else {
        None
    };
    if tui {
        let keys = tx.clone();
        std::thread::spawn(move || {
            while let Ok(event) = ratatui::crossterm::event::read() {
                if keys.send(Ev::Term(event)).is_err() {
                    break;
                }
            }
        });
    } else {
        std::thread::spawn(|| {
            let mut sink = [0u8; 4096];
            let mut stdin = std::io::stdin();
            while std::io::Read::read(&mut stdin, &mut sink).is_ok_and(|n| n > 0) {}
        });
    }
    let mut hub = Hub {
        archive: archive.clone(),
        agent: Some(agent_tx),
        model: Model::new(opts.name.clone(), opts.cwd.clone()),
        screen,
        opts,
        next: 0,
        own: HashMap::new(),
        inflight: HashSet::new(),
        prompts: HashSet::new(),
        started,
        drew: false,
        quit: false,
    };
    hub.note_row("_keeper/ready", json!({"sinceStartMs": started.elapsed().as_secs_f64() * 1000.0, "keeper": std::process::id(), "child": child_pid, "tui": tui}));
    hub.start();
    hub.draw();
    if !tui {
        println!("KEEPER_READY");
    }

    let signal = shutdown_signal();
    tokio::pin!(signal);
    let mut exited: Option<std::io::Result<std::process::ExitStatus>> = None;
    let mut by_signal = false;
    loop {
        tokio::select! {
            ev = rx.recv() => {
                let Some(ev) = ev else { break };
                hub.handle(ev);
                while let Ok(ev) = rx.try_recv() {
                    hub.handle(ev);
                }
            }
            status = child.wait(), if exited.is_none() => {
                let text = match &status {
                    Ok(s) => format!("에이전트 끝남 ({s})"),
                    Err(e) => format!("에이전트 끝남 ({e})"),
                };
                hub.note_row("_keeper/agent_exit", json!({"status": text}));
                hub.model.agent_gone = Some(text.clone());
                hub.model.note(format!("{text}. Ctrl+Q로 닫으세요"));
                hub.agent = None;
                exited = Some(status);
                if !tui {
                    break;
                }
            }
            _ = &mut signal => {
                by_signal = true;
                break;
            }
        }
        hub.draw();
        if hub.quit {
            break;
        }
    }
    hub.agent = None;
    let status = match exited {
        Some(status) => status,
        None => match tokio::time::timeout(Duration::from_millis(1500), child.wait()).await {
            Ok(status) => status,
            Err(_) => {
                let _ = child.kill().await;
                child.wait().await
            }
        },
    };
    let _ = tokio::time::timeout(Duration::from_millis(500), reader).await;
    accepting.abort();
    #[cfg(unix)]
    let _ = std::fs::remove_file(root.join("acp.sock"));
    if let Some(screen) = hub.screen.as_mut() {
        screen.leave();
    }
    match status {
        Ok(status) if status.success() || by_signal || hub.quit => 0,
        _ => 1,
    }
}
