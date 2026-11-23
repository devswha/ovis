#![cfg(target_os = "linux")]

mod common;

use std::io::{Read, Write};
use std::os::fd::{FromRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Instant;

use common::*;
use serde_json::{json, Value};

/// The keeper on a pseudo-terminal of its own, as in a herdr-core pane: a session leader with the
/// pty as its controlling terminal, so it has job control and can hand the terminal to a real TUI.
struct Pane {
    child: Child,
    master: std::fs::File,
    screen: Arc<(Mutex<String>, Condvar)>,
}

impl Pane {
    fn start(root: &Root, resume: &Value) -> Pane {
        let (mut master, mut slave) = (0, 0);
        let size = libc::winsize { ws_row: 30, ws_col: 160, ws_xpixel: 0, ws_ypixel: 0 };
        assert_eq!(unsafe { libc::openpty(&mut master, &mut slave, std::ptr::null_mut(), std::ptr::null(), &size) }, 0, "openpty");
        let slave = unsafe { OwnedFd::from_raw_fd(slave) };
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_ovis-acp-keeper"));
        cmd.arg(&root.0)
            .arg("--resume")
            .arg(resume.to_string())
            .arg("--")
            .arg(fake_agent())
            .env("TERM", "xterm-256color")
            .stdin(Stdio::from(slave.try_clone().unwrap()))
            .stdout(Stdio::from(slave.try_clone().unwrap()))
            .stderr(Stdio::from(slave));
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() < 0 || libc::ioctl(0, libc::TIOCSCTTY, 0) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child = cmd.spawn().expect("keeper on a pty");
        let master = unsafe { std::fs::File::from_raw_fd(master) };
        let screen = Arc::new((Mutex::new(String::new()), Condvar::new()));
        let (mut reader, shared) = (master.try_clone().unwrap(), screen.clone());
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                shared.0.lock().unwrap().push_str(&String::from_utf8_lossy(&buf[..n]));
                shared.1.notify_all();
            }
        });
        let pane = Pane { child, master, screen };
        pane.shows("ACP로 실행 중", 0);
        pane
    }

    fn type_keys(&mut self, keys: &str) {
        self.master.write_all(keys.as_bytes()).expect("type into the pane");
    }

    /// Waits (bounded) until the pane has printed `text` since byte `from`; returns where it ends.
    fn shows(&self, text: &str, from: usize) -> usize {
        let deadline = Instant::now() + WAIT;
        let (lock, cv) = &*self.screen;
        let mut screen = lock.lock().unwrap();
        loop {
            if let Some(at) = screen.get(from..).and_then(|s| s.find(text)) {
                return from + at + text.len();
            }
            let left = deadline.saturating_duration_since(Instant::now());
            assert!(!left.is_zero(), "the pane never showed {text:?}; it showed {:?}", screen.get(from..).unwrap_or(""));
            screen = cv.wait_timeout(screen, left).unwrap().0;
        }
    }
}

impl Drop for Pane {
    fn drop(&mut self) {
        let pid = self.child.id() as i32;
        unsafe { libc::kill(pid, libc::SIGTERM) };
        if !wait_gone(pid) {
            unsafe { libc::kill(pid, libc::SIGKILL) };
        }
        let _ = self.child.wait();
    }
}

fn mode(row: &Value, mode: &str, phase: &str) -> bool {
    method(row) == Some("_keeper/mode") && row["msg"]["params"]["mode"] == mode && row["msg"]["params"]["phase"] == phase
}

#[test]
fn the_pane_shows_a_status_line_and_its_keys_never_answer_an_approval() {
    let root = Root::new("pane-keys");
    let mut pane = Pane::start(&root, &json!(["true"]));
    let mut client = Client::connect(&root);
    let session = client.session();
    client.send(&prompt(1, &session, "ask"));
    let ask = client.wait("the approval request", |r| r["dir"] == "from-agent" && method(r) == Some("session/request_permission"));
    pane.shows("승인 대기 1", 0);
    pane.type_keys("y1n\r\x1b[B\r");
    client.send(&json!({"jsonrpc": "2.0", "id": ask["msg"]["id"], "result": {"outcome": {"outcome": "selected", "optionId": "reject"}}}));
    let resolved = client.wait("the approval's answer", |r| method(r) == Some("_keeper/resolved"));
    assert_eq!(resolved["msg"]["params"]["by"], format!("client-{}", client.conn.unwrap()), "a key in the pane answered the approval");
    client.wait("the agent's word", |r| chunk_text(r) == Some("answered reject"));
}

#[test]
fn f4_hands_the_pane_to_the_real_tui_and_back_on_the_same_session() {
    let root = Root::new("pane-switch");
    let got = root.0.join("tui-got");
    let tui = json!(["sh", "-c", "printf 'REAL-TUI %s\\n' \"$1\"; IFS= read -r line; printf %s \"$line\" > \"$2\"", "sh", "{session}", got]);
    let mut pane = Pane::start(&root, &tui);
    let mut client = Client::connect(&root);
    let session = client.session();
    let seen = pane.shows("F4: 진짜 TUI로 열기", 0);

    client.send(&prompt(1, &session, "hold"));
    client.wait("the held prompt on its way", |r| r["dir"] == "to-agent" && method(r) == Some("session/prompt"));
    client.send(&json!({"jsonrpc": "2.0", "id": 2, "method": "_keeper/open_terminal"}));
    let refused = client.answer(json!(2));
    assert_eq!(refused["msg"]["error"]["message"], "a turn is running", "the switch went ahead during a turn");
    client.send(&prompt(3, &session, "release"));
    client.answer(json!(1));
    client.answer(json!(3));

    pane.type_keys("\x1bOS");
    client.wait("the real TUI in the pane", |r| mode(r, "terminal", "ready"));
    let seen = pane.shows(&format!("REAL-TUI {session}"), seen);
    client.send(&prompt(4, &session, "echo while the TUI has it"));
    let refused = client.answer(json!(4));
    assert!(refused["msg"]["error"].is_object(), "a prompt reached ACP while the real TUI had the conversation");

    pane.type_keys("typed in the tui\r");
    client.wait("ACP again", |r| mode(r, "acp", "start"));
    let load = client.wait("the same session loaded again", |r| r["dir"] == "to-agent" && method(r) == Some("session/load"));
    assert_eq!(load["msg"]["params"]["sessionId"], session.as_str());
    client.wait("ACP ready", |r| mode(r, "acp", "ready"));
    assert_eq!(std::fs::read_to_string(&got).expect("the TUI's input"), "typed in the tui", "the keys did not reach the real TUI");
    pane.shows("ACP로 실행 중", seen);

    client.send(&prompt(5, &session, "echo back"));
    client.wait("a turn after coming back", |r| chunk_text(r) == Some("echo bytes=9"));
}
