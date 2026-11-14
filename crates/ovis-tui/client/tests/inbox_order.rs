mod roster_fixture;

use ovis_tui_client::api::Snapshot;
use ovis_tui_client::inbox::{Group, Roster};
use roster_fixture::{roster, row, status};
use serde_json::{Value, json};

fn ids(roster: &Roster) -> Vec<(Group, Vec<String>)> {
    roster
        .groups()
        .into_iter()
        .map(|(group, rows)| (group, rows.into_iter().map(|row| row.pane_id).collect()))
        .collect()
}

fn ids_of(groups: &[(Group, &[&str])]) -> Vec<(Group, Vec<String>)> {
    groups
        .iter()
        .map(|(group, rows)| (*group, rows.iter().map(|id| (*id).to_owned()).collect()))
        .collect()
}

/// agentRoster.test.ts "lists needs-you, working, done, then idle, each PC's longest wait first; BG works,
/// unknown and an away PC rest" (its local PC), with the counters made by state changes in the order b, c, d, e, a, f, g.
#[test]
fn groups_in_drawing_order_with_the_longest_wait_first() {
    let names = ["a", "b", "c", "d", "e", "f", "g"];
    let panes: Vec<(&str, &str, Value)> =
        names.iter().map(|id| (*id, "unknown", json!({}))).collect();
    let mut roster = roster(&panes);
    for (id, state) in [
        ("b", "working"),
        ("c", "blocked"),
        ("d", "done"),
        ("e", "idle"),
        ("a", "blocked"),
        ("f", "waiting"),
        ("g", "mystery"),
    ] {
        roster.apply_status(&status(id, state));
    }
    let expected = ids_of(&[
        (Group::NeedsYou, &["c", "a"]),
        (Group::Working, &["b", "f"]),
        (Group::Done, &["d"]),
        (Group::Idle, &["e", "g"]),
    ]);
    assert_eq!(ids(&roster), expected);
}

/// agentRoster.test.ts "keeps a helper under its agent, in the group of the one of them that needs the reader most"
/// and "draws each helper right under the agent that started it" (f names a pane that is no row).
#[test]
fn helpers_stand_under_their_agent_in_the_family_group() {
    type Case<'a> = (Vec<(&'a str, &'a str, Value)>, Vec<(Group, Vec<String>)>);
    let cases: Vec<Case<'_>> = vec![
        (
            vec![
                ("a", "working", json!({})),
                ("b", "blocked", json!({ "parent_pane_id": "a" })),
                ("c", "done", json!({})),
                ("d", "idle", json!({ "parent_pane_id": "c" })),
            ],
            ids_of(&[(Group::NeedsYou, &["a", "b"]), (Group::Done, &["c", "d"])]),
        ),
        (
            vec![
                ("a", "working", json!({})),
                ("b", "idle", json!({})),
                ("c", "blocked", json!({ "parent_pane_id": "a" })),
                ("d", "working", json!({ "parent_pane_id": "a" })),
                ("e", "done", json!({ "parent_pane_id": "c" })),
                ("f", "blocked", json!({ "parent_pane_id": "gone" })),
            ],
            ids_of(&[
                (Group::NeedsYou, &["a", "c", "e", "d", "f"]),
                (Group::Idle, &["b"]),
            ]),
        ),
        (
            vec![
                ("x", "idle", json!({ "parent_pane_id": "y" })),
                ("y", "idle", json!({ "parent_pane_id": "x" })),
                ("z", "idle", json!({ "parent_pane_id": "z" })),
            ],
            ids_of(&[(Group::Idle, &["x", "y", "z"])]),
        ),
    ];
    for (panes, expected) in cases {
        assert_eq!(ids(&roster(&panes)), expected, "{panes:?}");
    }
    let nested = roster(&[
        ("a", "working", json!({})),
        ("b", "blocked", json!({ "parent_pane_id": "a" })),
        ("f", "idle", json!({ "parent_pane_id": "gone" })),
    ]);
    assert_eq!(row(&nested, "b").helper_of.as_deref(), Some("a"));
    assert_eq!(row(&nested, "f").helper_of, None);
}

/// sidebarAgents.test.ts "uses the API roster and excludes ordinary shells regardless of their status" and
/// "honors API display and named identities before the canonical provider".
#[test]
fn only_agents_are_rows_named_as_herdr_names_them() {
    let session: Snapshot = serde_json::from_value(json!({
        "workspaces": [{ "workspace_id": "w1", "label": "api", "number": 1 }],
        "panes": [
            { "pane_id": "shell", "workspace_id": "w1", "tab_id": "t", "agent_status": "working" },
            { "pane_id": "waiting-shell", "workspace_id": "w1", "tab_id": "t", "agent_status": "blocked" },
            { "pane_id": "named", "workspace_id": "w1", "tab_id": "t", "agent_status": "idle" },
            { "pane_id": "codex", "workspace_id": "w1", "tab_id": "t", "agent_status": "idle", "agent": "codex" },
            { "pane_id": "orphan", "workspace_id": "gone", "tab_id": "t", "agent_status": "idle", "agent": "claude" },
        ],
        "agents": [{ "pane_id": "named", "name": "reviewer" }, { "pane_id": "codex", "display_agent": " ", "name": "reviewer" }],
    }))
    .expect("snapshot");
    let mut roster = Roster::new();
    roster.apply_snapshot(session);
    let rows: Vec<(String, String)> = roster
        .groups()
        .into_iter()
        .flat_map(|(_, rows)| rows)
        .map(|row| (row.pane_id, row.agent))
        .collect();
    assert_eq!(
        rows,
        vec![
            ("named".to_owned(), "reviewer".to_owned()),
            ("codex".to_owned(), "reviewer".to_owned())
        ]
    );
}

/// agentRoster.test.ts "moves panes tagged role=background, and the helpers they started" and
/// "keeps a blocked background agent with the people's rows, so its question is never folded away".
#[test]
fn background_agents_are_told_apart_unless_blocked() {
    let background = json!({ "tokens": { "role": "background" } });
    let roster = roster(&[
        ("a", "idle", json!({})),
        ("w1", "working", background.clone()),
        ("h", "working", json!({ "parent_pane_id": "w1" })),
        ("hb", "blocked", json!({ "parent_pane_id": "w1" })),
        (
            "w2",
            "done",
            json!({ "tokens": { "role": " Background " } }),
        ),
        ("w3", "blocked", background),
        ("c", "idle", json!({ "tokens": { "role": "lead" } })),
    ]);
    let split: Vec<(&str, bool)> = ["a", "w1", "h", "hb", "w2", "w3", "c"]
        .into_iter()
        .map(|id| (id, roster.is_background(id)))
        .collect();
    assert_eq!(
        split,
        vec![
            ("a", false),
            ("w1", true),
            ("h", true),
            ("hb", false),
            ("w2", true),
            ("w3", false),
            ("c", false)
        ]
    );
}
