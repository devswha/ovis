//! Runs without the test harness: it changes the process's environment, which only a process with
//! one thread may do.
use std::process::Command;

use ovis_tui_client::api::take_server_vars;

const TOKEN: &str = "t0ken-for-this-test";

fn main() {
    // SAFETY: this test's own process, before any thread exists
    unsafe {
        std::env::set_var("OVIS_TOKEN", TOKEN);
        std::env::set_var("OVIS_URL", "http://127.0.0.1:1");
    }
    // SAFETY: as above
    let vars = unsafe { take_server_vars() };
    assert_eq!(vars.get("OVIS_TOKEN").map(String::as_str), Some(TOKEN));
    assert_eq!(
        vars.get("OVIS_URL").map(String::as_str),
        Some("http://127.0.0.1:1")
    );
    let child = Command::new("env").output().expect("env runs");
    let seen = String::from_utf8_lossy(&child.stdout);
    assert!(!seen.contains(TOKEN), "a child saw the token:\n{seen}");
    assert!(!seen.contains("OVIS_URL="), "a child saw OVIS_URL:\n{seen}");
    println!("child_env: a child of the client sees neither OVIS_TOKEN nor OVIS_URL");
}
