//! Starting the agent and ending everything it starts. The agent leads its own process group, so
//! the keeper can end the group with it. On Linux it also dies with the keeper (`PR_SET_PDEATHSIG`,
//! even when the keeper is killed outright), and where the user's systemd is reachable it runs in a
//! transient scope named after ROOT: helpers that leave the group (a broker that calls `setsid`)
//! stay in the scope, which the keeper stops when it ends and, before starting the agent, when an
//! earlier keeper in the same ROOT died without stopping it.

use std::path::Path;
use std::process::{ExitStatus, Stdio};
use std::time::Duration;

use tokio::process::{Child, Command};

pub struct Agent {
    pub child: Child,
    pub pid: u32,
    pub scope: Option<String>,
}

impl Agent {
    pub async fn spawn(command: &str, args: &[String], cwd: &str, stderr: std::fs::File, root: &Path) -> std::io::Result<Agent> {
        let scope = scope_for(root).await;
        let mut cmd = match &scope {
            Some(unit) => {
                let mut cmd = Command::new("systemd-run");
                cmd.args(["--user", "--scope", "--quiet", "--collect", "--property=TimeoutStopSec=2"])
                    .arg(format!("--unit={unit}"))
                    .arg("--")
                    .arg(command);
                cmd
            }
            None => Command::new(command),
        };
        cmd.args(args).current_dir(cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(stderr).kill_on_drop(true);
        #[cfg(unix)]
        cmd.process_group(0);
        #[cfg(target_os = "linux")]
        {
            let keeper = std::process::id() as libc::pid_t;
            unsafe {
                cmd.pre_exec(move || {
                    if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    if libc::getppid() != keeper {
                        return Err(std::io::Error::other("the keeper ended before the agent started"));
                    }
                    Ok(())
                });
            }
        }
        let child = cmd.spawn()?;
        let pid = child.id().unwrap_or(0);
        Ok(Agent { child, pid, scope })
    }

    /// Ends the agent and everything it started: SIGTERM to its group, SIGKILL after `grace`.
    pub async fn stop(&mut self, grace: Duration) -> std::io::Result<ExitStatus> {
        self.signal_group(Signal::Term);
        let status = match tokio::time::timeout(grace, self.child.wait()).await {
            Ok(status) => status,
            Err(_) => {
                self.signal_group(Signal::Kill);
                let _ = self.child.start_kill();
                self.child.wait().await
            }
        };
        self.sweep().await;
        status
    }

    /// After the agent ended: whatever it left behind in its group and its scope.
    pub async fn sweep(&self) {
        self.signal_group(Signal::Kill);
        if let Some(unit) = &self.scope {
            stop_scope(unit).await;
        }
    }

    #[cfg(unix)]
    fn signal_group(&self, signal: Signal) {
        let signal = match signal {
            Signal::Term => libc::SIGTERM,
            Signal::Kill => libc::SIGKILL,
        };
        if self.pid > 0 {
            unsafe { libc::kill(-(self.pid as libc::pid_t), signal) };
        }
    }

    #[cfg(not(unix))]
    fn signal_group(&self, _signal: Signal) {}
}

enum Signal {
    Term,
    Kill,
}

fn quiet(cmd: &mut Command) -> &mut Command {
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
}

#[cfg(target_os = "linux")]
async fn scope_for(root: &Path) -> Option<String> {
    let usable = quiet(Command::new("systemd-run").args(["--user", "--scope", "--quiet", "--collect", "true"]))
        .status()
        .await
        .is_ok_and(|s| s.success());
    if !usable {
        return None;
    }
    let root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let hash = root.to_string_lossy().bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ b as u64).wrapping_mul(0x100000001b3));
    let unit = format!("acp-keeper-{hash:016x}");
    stop_scope(&unit).await;
    Some(unit)
}

#[cfg(not(target_os = "linux"))]
async fn scope_for(_root: &Path) -> Option<String> {
    None
}

async fn stop_scope(unit: &str) {
    let _ = quiet(Command::new("systemctl").args(["--user", "stop"]).arg(format!("{unit}.scope"))).status().await;
}
