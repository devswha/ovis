mod roster_fixture;

use ovis_tui_client::api::SeenFinish;
use ovis_tui_client::inbox::{Group, Roster, StatusChange, Waiting};
use roster_fixture::{roster, row, status};
use serde_json::{Value, json};

/// sidebarOrder.test.ts "accepts stale lower finish ids within the epoch, never future or absent ids" and
/// "never draws working, blocked, or question as ready and keeps background-wait precedence".
#[test]
fn a_read_finish_draws_as_idle() {
    let read = |pane: &str, id: u64| SeenFinish {
        pc: "local".to_owned(),
        epoch: "e1".to_owned(),
        pane: pane.to_owned(),
        id,
        answer: None,
    };
    let cases: &[(&str, Value, &str)] = &[
        ("done", json!({ "finish_id": 2 }), "idle"),
        ("done", json!({ "finish_id": 1 }), "idle"),
        ("done", json!({ "finish_id": 3 }), "done"),
        ("done", json!({ "finish_id": 0 }), "done"),
        ("done", json!({}), "done"),
        ("working", json!({ "finish_id": 2 }), "working"),
        ("blocked", json!({ "finish_id": 2 }), "blocked"),
        (
            "done",
            json!({ "finish_id": 2, "background_wait": true }),
            "waiting",
        ),
        (
            "blocked",
            json!({ "finish_id": 2, "background_wait": true }),
            "blocked",
        ),
    ];
    for (state, extra, drawn) in cases {
        let mut roster = roster(&[("a", state, extra.clone())]);
        roster.apply_seen(vec![
            read("a", 2),
            SeenFinish {
                pc: "remote".to_owned(),
                ..read("a", 9)
            },
        ]);
        assert_eq!(row(&roster, "a").status, *drawn, "{state} {extra}");
    }
}

/// snapshot.test.ts (applyPaneStatus): a new finish epoch drops the finishes of the old one.
#[test]
fn finish_of_names_an_unread_done_pane_until_it_is_read() {
    let mut roster = roster(&[
        ("a", "done", json!({ "finish_id": 3 })),
        ("b", "working", json!({})),
    ]);
    let finish = SeenFinish {
        pc: "local".to_owned(),
        epoch: "e1".to_owned(),
        pane: "a".to_owned(),
        id: 3,
        answer: None,
    };
    assert_eq!(roster.finish_of("a"), Some(finish.clone()));
    assert_eq!(roster.finish_of("b"), None);
    roster.apply_seen(vec![finish]);
    assert_eq!(
        (roster.finish_of("a"), row(&roster, "a").group),
        (None, Group::Idle)
    );

    let mut restarted = roster_with_unread();
    restarted.apply_status(&StatusChange {
        finish_epoch: Some("e2".to_owned()),
        ..status("b", "idle")
    });
    assert_eq!(
        (
            restarted.finish_of("a"),
            row(&restarted, "a").status.as_str()
        ),
        (None, "done")
    );
}

fn roster_with_unread() -> Roster {
    roster(&[
        ("a", "done", json!({ "finish_id": 3 })),
        ("b", "working", json!({})),
    ])
}

/// The HerdrPane doc comment (shared/protocol.ts): agent_kind, agent_message and agent_progress; and
/// AgentSidebar.tsx agentRowTitle: a title that only names the agent gives way to the workspace.
#[test]
fn a_row_draws_what_the_agent_reports() {
    let roster = roster(&[
        (
            "q",
            "blocked",
            json!({ "agent_kind": "question", "agent_message": " Which file? ", "agent_progress": 41.6 }),
        ),
        ("p", "blocked", json!({ "agent_kind": "permission" })),
        ("u", "blocked", json!({})),
        (
            "l",
            "working",
            json!({ "label": "Fix login", "agent_kind": "auth" }),
        ),
    ]);
    let q = row(&roster, "q");
    assert_eq!(
        (
            q.waiting,
            q.message.as_deref(),
            q.progress,
            q.title.as_str()
        ),
        (
            Some(Waiting::Question),
            Some("Which file?"),
            Some(42),
            "api"
        )
    );
    assert_eq!(
        (row(&roster, "p").waiting, row(&roster, "u").waiting),
        (Some(Waiting::Permission), Some(Waiting::Other))
    );
    let l = row(&roster, "l");
    assert_eq!(
        (
            l.waiting,
            l.title.as_str(),
            l.space.as_str(),
            l.tab.as_str()
        ),
        (None, "Fix login", "api", "")
    );
}
