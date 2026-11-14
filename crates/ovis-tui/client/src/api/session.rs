//! `GET /api/health` and `GET /api/session` (shared/protocol.ts `SessionSnapshot`, `HerdrPane`;
//! shared/herdr-api.generated.ts `PaneInfo`, `TabInfo`, `WorkspaceInfo`, `AgentInfo`).

use std::collections::BTreeMap;

use serde::Deserialize;

/// `GET /api/health`, cut to what the terminal client reads.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(from = "RawHealth")]
pub struct Health {
    pub ok: bool,
    /// The server's own version; told only to a caller that got in.
    pub version: Option<String>,
    /// `"herdr-core"` or `"herdr"` (classic herdr's TUI server), from `herdr.runtime`
    /// (shared/machines.ts `HerdrIdentity.runtime`); None when the answer names no herdr.
    pub runtime: Option<String>,
}

#[derive(Deserialize)]
struct RawHealth {
    #[serde(default)]
    ok: bool,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    herdr: Option<RawHerdr>,
}

#[derive(Deserialize)]
struct RawHerdr {
    #[serde(default)]
    runtime: Option<String>,
}

impl From<RawHealth> for Health {
    fn from(raw: RawHealth) -> Health {
        Health {
            ok: raw.ok,
            version: raw.version,
            runtime: raw
                .herdr
                .map(|herdr| herdr.runtime.unwrap_or_else(|| "herdr".to_owned())),
        }
    }
}

/// The session as the server read it.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct Snapshot {
    #[serde(default)]
    pub panes: Vec<Pane>,
    #[serde(default)]
    pub tabs: Vec<Tab>,
    #[serde(default)]
    pub workspaces: Vec<Workspace>,
    /// herdr's agent roster: a pane it lists here is an agent's even before the pane names one.
    #[serde(default)]
    pub agents: Vec<AgentInfo>,
    #[serde(default)]
    pub finish_epoch: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct Pane {
    pub pane_id: String,
    #[serde(default)]
    pub workspace_id: String,
    #[serde(default)]
    pub tab_id: String,
    #[serde(default)]
    pub terminal_id: String,
    /// herdr's open-ended `AgentStatus`, kept as sent.
    #[serde(default)]
    pub agent_status: String,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub display_agent: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub terminal_title: Option<String>,
    #[serde(default)]
    pub terminal_title_stripped: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    /// What a blocked agent waits for: `permission`, `question`, `auth` (herdr-core only).
    #[serde(default)]
    pub agent_kind: Option<String>,
    #[serde(default)]
    pub agent_message: Option<String>,
    /// 0 to 100; a number of any shape, as the server sends a JSON number.
    #[serde(default)]
    pub agent_progress: Option<f64>,
    #[serde(default)]
    pub parent_pane_id: Option<String>,
    #[serde(default)]
    pub finish_id: Option<u64>,
    /// At rest while work its turn started still runs: drawn as working.
    #[serde(default)]
    pub background_wait: Option<bool>,
    /// herdr plugin tokens (`role=background` files a pane as a background agent).
    #[serde(default)]
    pub tokens: Option<BTreeMap<String, serde_json::Value>>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct Tab {
    pub tab_id: String,
    #[serde(default)]
    pub workspace_id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub number: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct Workspace {
    pub workspace_id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub number: u32,
    #[serde(default)]
    pub worktree: Option<Worktree>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct Worktree {
    #[serde(default)]
    pub is_linked_worktree: bool,
}

/// One entry of herdr's agent roster, cut to the names and tokens a row reads.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct AgentInfo {
    pub pane_id: String,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub display_agent: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub tokens: Option<BTreeMap<String, serde_json::Value>>,
}
