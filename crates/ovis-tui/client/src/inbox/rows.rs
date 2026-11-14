//! Which panes are rows and what each draws (src/lib/sidebarAgents.ts `sidebarAgents`;
//! src/lib/sidebarOrder.ts `shownStatus`; src/lib/status.ts; src/lib/agentRoster.ts).

use std::collections::{BTreeMap, HashSet};

use super::model::{Group, Row, Waiting};
use super::title::{Named, nonblank, row_title, tab_name};
use crate::api::{AgentInfo, Pane, Snapshot, Tab, Workspace};

/// A pane the inbox lists, joined to its workspace, tab and herdr agent entry.
pub(crate) struct Entry<'a> {
    pub pane: &'a Pane,
    pub workspace: &'a Workspace,
    pub tab: Option<&'a Tab>,
    pub agent: Option<&'a AgentInfo>,
    pub canonical: Option<&'a str>,
    pub label: Option<&'a str>,
}

impl<'a> Entry<'a> {
    pub(crate) fn named(&self) -> Named<'a> {
        Named {
            pane: self.pane,
            agent: self.agent,
            workspace: self.workspace,
            canonical: self.canonical,
            label: self.label,
        }
    }
}

/// The agents' panes, each once, in the server's workspace, tab and pane order. A shell is never a
/// row; an agent herdr lists, or a pane that names its agent, is.
pub(crate) fn entries(snapshot: &Snapshot) -> Vec<Entry<'_>> {
    let mut agents: BTreeMap<&str, &AgentInfo> = BTreeMap::new();
    for agent in &snapshot.agents {
        agents.entry(agent.pane_id.as_str()).or_insert(agent);
    }
    let tab_count = snapshot.tabs.len();
    let mut seen = HashSet::new();
    let mut rows: Vec<(usize, usize, usize, Entry<'_>)> = Vec::new();
    for (pane_order, pane) in snapshot.panes.iter().enumerate() {
        if !seen.insert(pane.pane_id.as_str()) {
            continue;
        }
        let agent = agents.get(pane.pane_id.as_str()).copied();
        let Some((workspace_order, workspace)) = snapshot
            .workspaces
            .iter()
            .enumerate()
            .find(|(_, workspace)| workspace.workspace_id == pane.workspace_id)
        else {
            continue;
        };
        if agent.is_none() && nonblank(pane.agent.as_deref()).is_none() {
            continue;
        }
        let tab = snapshot
            .tabs
            .iter()
            .enumerate()
            .find(|(_, tab)| tab.tab_id == pane.tab_id)
            .filter(|(_, tab)| tab.workspace_id == pane.workspace_id);
        let canonical = nonblank(pane.agent.as_deref())
            .or_else(|| nonblank(agent.and_then(|agent| agent.agent.as_deref())));
        let label = nonblank(agent.and_then(|agent| agent.display_agent.as_deref()))
            .or_else(|| nonblank(agent.and_then(|agent| agent.name.as_deref())))
            .or_else(|| nonblank(pane.display_agent.as_deref()))
            .or(canonical)
            .or_else(|| nonblank(agent.and_then(|agent| agent.title.as_deref())));
        let entry = Entry {
            pane,
            workspace,
            tab: tab.map(|(_, tab)| tab),
            agent,
            canonical,
            label,
        };
        rows.push((
            workspace_order,
            tab.map_or(tab_count, |(order, _)| order),
            pane_order,
            entry,
        ));
    }
    rows.sort_by_key(|(workspace, tab, pane, _)| (*workspace, *tab, *pane));
    rows.into_iter().map(|(_, _, _, entry)| entry).collect()
}

/// The state words the web knows; any other reads as unknown (src/lib/status.ts `knownStatus`).
pub(crate) fn known(status: &str) -> &str {
    match status {
        "idle" | "working" | "blocked" | "done" | "waiting" => status,
        _ => "unknown",
    }
}

/// The state a pane draws: one at rest while its turn's background work runs is waiting (drawn as
/// working), and a finish this server's clients have already presented is read, so idle.
pub(crate) fn shown_status(pane: &Pane, read_up_to: Option<u64>) -> String {
    let known = known(&pane.agent_status);
    if pane.background_wait == Some(true) {
        return if known == "working" || known == "blocked" {
            known.to_owned()
        } else {
            "waiting".to_owned()
        };
    }
    let read = known == "done"
        && pane
            .finish_id
            .is_some_and(|finish| finish > 0 && read_up_to.is_some_and(|read| read >= finish));
    if read {
        "idle".to_owned()
    } else {
        pane.agent_status.clone()
    }
}

/// Whether a launcher tagged the pane `role=background` (shared/pane-tokens.ts `isBackgroundRole`).
pub(crate) fn tagged_background(entry: &Entry<'_>) -> bool {
    let tokens = entry
        .pane
        .tokens
        .as_ref()
        .or_else(|| entry.agent.and_then(|agent| agent.tokens.as_ref()));
    tokens
        .and_then(|tokens| tokens.get("role"))
        .and_then(serde_json::Value::as_str)
        .is_some_and(|role| role.trim().eq_ignore_ascii_case("background"))
}

/// A whole percentage 0 to 100.
fn percent(progress: Option<f64>) -> Option<u8> {
    let rounded = progress.filter(|value| value.is_finite())?.round();
    (0..=100u8).find(|step| (f64::from(*step) - rounded).abs() < 0.5)
}

/// The row an entry draws in its drawn state.
pub(crate) fn row(snapshot: &Snapshot, entry: &Entry<'_>, status: &str) -> Row {
    let pane = entry.pane;
    let group = Group::of(status);
    let workspace_tabs: Vec<_> = snapshot
        .tabs
        .iter()
        .filter(|tab| tab.workspace_id == entry.workspace.workspace_id)
        .collect();
    let waiting =
        (group == Group::NeedsYou).then(|| match pane.agent_kind.as_deref().map(str::trim) {
            Some("question") => Waiting::Question,
            Some("permission") => Waiting::Permission,
            Some("auth") => Waiting::Auth,
            _ => Waiting::Other,
        });
    let helper_of = pane
        .parent_pane_id
        .as_ref()
        .filter(|parent| {
            **parent != pane.pane_id
                && entries(snapshot)
                    .iter()
                    .any(|other| other.pane.pane_id == **parent)
        })
        .cloned();
    Row {
        pane_id: pane.pane_id.clone(),
        agent: entry
            .label
            .or(entry.canonical)
            .unwrap_or_default()
            .to_owned(),
        title: row_title(&entry.named()),
        space: entry.workspace.label.clone(),
        tab: tab_name(entry.tab, &workspace_tabs).unwrap_or_default(),
        group,
        status: status.to_owned(),
        waiting,
        message: nonblank(pane.agent_message.as_deref()).map(str::to_owned),
        progress: percent(pane.agent_progress),
        helper_of,
    }
}
