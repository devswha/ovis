//! ovis-acp-keeper: holds one ACP agent on pipes for any number of clients and a shared terminal
//! screen. Every JSON-RPC line in either direction, plus the keeper's own `_keeper/*` notes, is
//! numbered into ROOT/archive.jsonl; clients on ROOT/acp.sock (a named pipe on Windows) replay from
//! any row and then follow live. Routing and approvals are in `hub`, the agent's process tree in
//! `agent`. A keeper started again in the same ROOT numbers on, expires the approvals the dead
//! agent asked, and loads the last session.

mod agent;
mod archive;
mod hub;
mod model;
mod ui;

use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};

use agent::Agent;
use archive::{pump, Archive, Framed, Framer, MAX_LINE, PUSH};
use hub::{Ev, Hub};
use ui::Screen;

pub struct Opts {
    pub root: PathBuf,
    pub cwd: String,
    pub name: String,
    pub resume: Option<String>,
    pub session_meta: Option<Value>,
    pub load: Option<String>,
    pub headless: bool,
    pub command: String,
    pub args: Vec<String>,
}

/// At most one frame per `gap`: a burst of agent output costs one frame, not one per message, so
/// drawing never holds up reading the agent.
struct Pace {
    gap: Duration,
    last: Option<Instant>,
    dirty: bool,
}

impl Pace {
    fn new(gap: Duration) -> Pace {
        Pace { gap, last: None, dirty: true }
    }

    /// `Ok` to draw now; otherwise when to look again (`None`: nothing changed).
    fn due(&mut self, now: Instant) -> Result<(), Option<Instant>> {
        if !self.dirty {
            return Err(None);
        }
        match self.last {
            Some(last) if now < last + self.gap => Err(Some(last + self.gap)),
            _ => {
                self.last = Some(now);
                self.dirty = false;
                Ok(())
            }
        }
    }
}

const FRAME: Duration = Duration::from_millis(33);

async fn serve_client<S: AsyncRead + AsyncWrite + Unpin + Send + 'static>(conn: u64, archive: Arc<Archive>, pid: u32, tx: UnboundedSender<Ev>, stream: S) {
    let (mut input, output) = tokio::io::split(stream);
    let mut framer = Framer::new(MAX_LINE);
    let mut chunk = vec![0u8; PUSH];
    let mut pumping: Option<tokio::task::JoinHandle<()>> = None;
    let mut output = Some(output);
    let _ = tx.send(Ev::Open(conn));
    while let Ok(n) = input.read(&mut chunk).await {
        if n == 0 {
            break;
        }
        for item in framer.push(&chunk[..n]) {
            let line = match item {
                Framed::Line(line) => line,
                Framed::Oversize { bytes, id, request } => {
                    if pumping.is_some() {
                        let _ = tx.send(Ev::Oversize { conn: Some(conn), bytes, id, request });
                    }
                    continue;
                }
            };
            let Ok(text) = String::from_utf8(line) else { continue };
            if pumping.is_none() {
                let Ok(Value::Object(request)) = serde_json::from_str::<Value>(&text) else { continue };
                let Some(n) = request.get("replay").and_then(Value::as_u64) else { continue };
                let Some((cursor, boundary, through)) = archive.replay_from(n) else { continue };
                let (archive, mut out) = (archive.clone(), output.take().expect("one replay per connection"));
                pumping = Some(tokio::spawn(async move {
                    let _ = pump(&archive, &mut out, cursor, boundary, through, pid, conn).await;
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
async fn listen(root: &Path, archive: Arc<Archive>, pid: u32, tx: UnboundedSender<Ev>, mut conn: u64) -> std::io::Result<impl std::future::Future<Output = ()>> {
    let path = root.join("acp.sock");
    match std::fs::remove_file(&path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e),
        _ => {}
    }
    let listener = tokio::net::UnixListener::bind(path)?;
    Ok(async move {
        while let Ok((stream, _)) = listener.accept().await {
            conn += 1;
            tokio::spawn(serve_client(conn, archive.clone(), pid, tx.clone(), stream));
        }
    })
}

#[cfg(windows)]
async fn listen(root: &Path, archive: Arc<Archive>, pid: u32, tx: UnboundedSender<Ev>, mut conn: u64) -> std::io::Result<impl std::future::Future<Output = ()>> {
    use tokio::net::windows::named_pipe::ServerOptions;
    let name = format!(r"\\.\pipe\acp-keeper-{}", std::process::id());
    std::fs::write(root.join("acp.pipe"), &name)?;
    let mut server = ServerOptions::new().first_pipe_instance(true).create(&name)?;
    Ok(async move {
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

const USAGE: &str = "Usage: ovis-acp-keeper ROOT [--cwd DIR] [--name NAME] [--resume 'CMD {session}'] [--session-meta JSON] [--load SESSION] [--headless] -- AGENT [ARGS...]";

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

pub(crate) fn parse(args: Vec<String>) -> Result<Opts, String> {
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

/// Holds ROOT for this keeper's lifetime; the lock goes with the process, however it ends.
#[cfg(unix)]
fn lock(root: &Path) -> Result<File, String> {
    use std::os::unix::fs::OpenOptionsExt;
    use std::os::unix::io::AsRawFd;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(root.join("keeper.lock"))
        .map_err(|e| format!("keeper.lock: {e}"))?;
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err("another keeper is running in ROOT".into());
    }
    Ok(file)
}

#[cfg(windows)]
fn lock(root: &Path) -> Result<File, String> {
    use std::os::windows::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .share_mode(0)
        .open(root.join("keeper.lock"))
        .map_err(|_| "another keeper is running in ROOT".to_string())
}

async fn run(mut opts: Opts) -> i32 {
    let started = Instant::now();
    if let Err(message) = check_root(&opts.root) {
        eprintln!("{message}");
        return 1;
    }
    let _lock = match lock(&opts.root) {
        Ok(lock) => lock,
        Err(message) => {
            eprintln!("{message}");
            return 1;
        }
    };
    let root = opts.root.clone();
    let (archive, previous) = match Archive::open(root.join("archive.jsonl")) {
        Ok((archive, previous)) => (Arc::new(archive), previous),
        Err(e) => {
            eprintln!("archive: {e}");
            return 1;
        }
    };
    for (id, seq) in &previous.pending {
        hub::note(&archive, "_keeper/expired", json!({"id": id, "seq": seq, "reason": "the agent that asked it is gone"}));
    }
    let resumed = opts.load.is_none() && previous.session.is_some();
    if resumed {
        opts.load = previous.session.clone();
    }
    let stderr = match archive::append_file(&root.join("agent.stderr")) {
        Ok(file) => file,
        Err(e) => {
            eprintln!("agent.stderr: {e}");
            return 1;
        }
    };
    let mut agent = match Agent::spawn(&opts.command, &opts.args, &opts.cwd, stderr, &root).await {
        Ok(agent) => agent,
        Err(e) => {
            eprintln!("{}: {e}", opts.command);
            return 1;
        }
    };
    let child_pid = agent.pid;
    let (tx, mut rx) = unbounded_channel::<Ev>();
    let (agent_tx, mut agent_rx) = unbounded_channel::<Vec<u8>>();
    let mut stdin = agent.child.stdin.take().expect("piped stdin");
    tokio::spawn(async move {
        while let Some(bytes) = agent_rx.recv().await {
            if stdin.write_all(&bytes).await.is_err() {
                break;
            }
        }
    });
    let mut stdout = agent.child.stdout.take().expect("piped stdout");
    let agent_lines = tx.clone();
    let reader = tokio::spawn(async move {
        let mut framer = Framer::new(MAX_LINE);
        let mut chunk = vec![0u8; PUSH];
        while let Ok(n) = stdout.read(&mut chunk).await {
            if n == 0 {
                break;
            }
            for item in framer.push(&chunk[..n]) {
                let ev = match item {
                    Framed::Line(line) => match String::from_utf8(line) {
                        Ok(text) => Ev::Agent(text),
                        Err(_) => continue,
                    },
                    Framed::Oversize { bytes, id, request } => Ev::Oversize { conn: None, bytes, id, request },
                };
                let _ = agent_lines.send(ev);
            }
        }
    });
    let accept = match listen(&root, archive.clone(), child_pid, tx.clone(), previous.last_client).await {
        Ok(accept) => accept,
        Err(e) => {
            eprintln!("listen: {e}");
            let _ = agent.stop(Duration::ZERO).await;
            return 1;
        }
    };
    let accepting = tokio::spawn(accept);
    let _ = std::fs::write(root.join("process.json"), json!({"keeper": std::process::id(), "child": child_pid, "scope": agent.scope}).to_string());

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
                let _ = agent.stop(Duration::ZERO).await;
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
    let mut hub = Hub::new(archive.clone(), agent_tx, screen, opts, resumed, started);
    hub.note_row("_keeper/ready", json!({"sinceStartMs": started.elapsed().as_secs_f64() * 1000.0, "keeper": std::process::id(), "child": child_pid, "tui": tui, "scope": agent.scope, "resumed": resumed, "expired": previous.pending.len()}));
    hub.start();
    if !tui {
        println!("KEEPER_READY");
    }

    let signal = shutdown_signal();
    tokio::pin!(signal);
    let mut exited: Option<std::io::Result<std::process::ExitStatus>> = None;
    let mut by_signal = false;
    let mut pace = Pace::new(FRAME);
    let mut wake: Option<Instant>;
    loop {
        match pace.due(Instant::now()) {
            Ok(()) => {
                hub.draw();
                wake = None;
            }
            Err(next) => wake = next,
        }
        if hub.quit {
            break;
        }
        tokio::select! {
            ev = rx.recv() => {
                let Some(ev) = ev else { break };
                hub.handle(ev);
                while let Ok(ev) = rx.try_recv() {
                    hub.handle(ev);
                }
            }
            status = agent.child.wait(), if exited.is_none() => {
                let text = match &status {
                    Ok(s) => format!("에이전트 끝남 ({s})"),
                    Err(e) => format!("에이전트 끝남 ({e})"),
                };
                hub.note_row("_keeper/agent_exit", json!({"status": text}));
                hub.model.agent_gone = Some(text.clone());
                hub.model.note(format!("{text}. Ctrl+Q로 닫으세요"));
                hub.agent_gone();
                exited = Some(status);
                // Now, while the reaped agent's group number cannot have been handed out again: a
                // screen left open for hours must not signal whatever holds that number later.
                agent.sweep().await;
                if !tui {
                    break;
                }
            }
            _ = tokio::time::sleep_until(tokio::time::Instant::from_std(wake.unwrap_or_else(Instant::now))), if wake.is_some() => {}
            _ = &mut signal => {
                by_signal = true;
                break;
            }
        }
        pace.dirty = true;
    }
    hub.agent = None;
    let status = match exited {
        Some(status) => status,
        None => agent.stop(Duration::from_millis(1500)).await,
    };
    let _ = tokio::time::timeout(Duration::from_millis(500), reader).await;
    while let Ok(ev) = rx.try_recv() {
        if matches!(ev, Ev::Agent(_) | Ev::Oversize { conn: None, .. }) {
            hub.handle(ev);
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pace_draws_a_burst_once_per_frame() {
        let start = Instant::now();
        let mut pace = Pace::new(FRAME);
        assert_eq!(pace.due(start), Ok(()));
        assert_eq!(pace.due(start), Err(None));
        pace.dirty = true;
        assert_eq!(pace.due(start + FRAME / 3), Err(Some(start + FRAME)));
        pace.dirty = true;
        assert_eq!(pace.due(start + FRAME / 2), Err(Some(start + FRAME)));
        assert_eq!(pace.due(start + FRAME), Ok(()));
        assert_eq!(pace.due(start + FRAME * 3), Err(None));
    }
}
