//! Sessions and rosters for the inbox tests.

use ovis_tui_client::api::Snapshot;
use ovis_tui_client::inbox::{Roster, Row, StatusChange};
use serde_json::{Value, json};

/// A one-workspace session whose panes are `(id, status, extra fields)`, each a claude agent.
pub fn snapshot(panes: &[(&str, &str, Value)]) -> Snapshot {
    let panes: Vec<Value> = panes
        .iter()
        .map(|(id, status, extra)| {
            let mut pane = json!({ "pane_id": id, "workspace_id": "w1", "tab_id": "w1:t1", "terminal_id": id,
                "agent_status": status, "agent": "claude", "terminal_title": "✳ Claude Code" });
            if let (Some(fields), Some(more)) = (pane.as_object_mut(), extra.as_object()) {
                fields.extend(more.clone());
            }
            pane
        })
        .collect();
    serde_json::from_value(json!({
        "finish_epoch": "e1", "agents": [], "panes": panes,
        "workspaces": [{ "workspace_id": "w1", "label": "api", "number": 1 }],
        "tabs": [{ "tab_id": "w1:t1", "workspace_id": "w1", "label": "1", "number": 1 }],
    }))
    .expect("snapshot")
}

pub fn roster(panes: &[(&str, &str, Value)]) -> Roster {
    let mut roster = Roster::new();
    roster.apply_snapshot(snapshot(panes));
    roster
}

pub fn status(pane_id: &str, agent_status: &str) -> StatusChange {
    StatusChange {
        pane_id: pane_id.to_owned(),
        agent_status: agent_status.to_owned(),
        finish_id: None,
        finish_epoch: Some("e1".to_owned()),
    }
}

pub fn row(roster: &Roster, pane_id: &str) -> Row {
    roster
        .groups()
        .into_iter()
        .flat_map(|(_, rows)| rows)
        .find(|row| row.pane_id == pane_id)
        .expect("a row")
}
