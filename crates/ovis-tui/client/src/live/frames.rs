//! The frames of `/ws` (shared/protocol.ts `ServerMessage`, `ClientMessage`).

use serde::Deserialize;

use super::LiveEvent;
use crate::api::Snapshot;

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum ServerFrame {
    Snapshot {
        snapshot: Box<Snapshot>,
    },
    PaneStatus {
        pane_id: String,
        agent_status: String,
        #[serde(default)]
        finish_id: Option<u64>,
        #[serde(default)]
        finish_epoch: Option<String>,
    },
    SessionChanged,
    PaneExited {
        pane_id: String,
    },
    PromptChanged {
        pane_id: String,
    },
    ConversationChanged {
        pane_id: String,
    },
    #[serde(other)]
    Unknown,
}

/// The event a text frame stands for; None for a frame of a type this client does not follow.
pub(crate) fn event(text: &str) -> Option<LiveEvent> {
    match serde_json::from_str::<ServerFrame>(text).ok()? {
        ServerFrame::Snapshot { snapshot } => Some(LiveEvent::Snapshot(snapshot)),
        ServerFrame::PaneStatus {
            pane_id,
            agent_status,
            finish_id,
            finish_epoch,
        } => Some(LiveEvent::PaneStatus {
            pane_id,
            agent_status,
            finish_id,
            finish_epoch,
        }),
        ServerFrame::SessionChanged => Some(LiveEvent::SessionChanged),
        ServerFrame::PaneExited { pane_id } => Some(LiveEvent::PaneExited(pane_id)),
        ServerFrame::PromptChanged { pane_id } => Some(LiveEvent::PromptChanged(pane_id)),
        ServerFrame::ConversationChanged { pane_id } => {
            Some(LiveEvent::ConversationChanged(pane_id))
        }
        ServerFrame::Unknown => None,
    }
}

/// The two frames that start or end following a pane. A conversation watch without an attached
/// pane must say `detached: true`, or the server refuses it with `not_attached`
/// (server/core/terminals.ts "conversation-watch").
pub(crate) fn watch_frames(pane_id: &str, enabled: bool) -> [String; 2] {
    [
        serde_json::json!({ "type": "prompt-watch", "pane_id": pane_id, "enabled": enabled }).to_string(),
        serde_json::json!({ "type": "conversation-watch", "pane_id": pane_id, "enabled": enabled, "detached": true })
            .to_string(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_frames_become_events_and_the_rest_are_ignored() {
        let cases: &[(&str, Option<LiveEvent>)] = &[
            (
                r#"{"type":"session-changed"}"#,
                Some(LiveEvent::SessionChanged),
            ),
            (
                r#"{"type":"pane-exited","pane_id":"w:1"}"#,
                Some(LiveEvent::PaneExited("w:1".to_owned())),
            ),
            (
                r#"{"type":"prompt-changed","pane_id":"w:1","signature":"s"}"#,
                Some(LiveEvent::PromptChanged("w:1".to_owned())),
            ),
            (
                r#"{"type":"conversation-changed","pane_id":"w:1","signature":"s"}"#,
                Some(LiveEvent::ConversationChanged("w:1".to_owned())),
            ),
            (
                r#"{"type":"pane-status","pane_id":"w:1","agent_status":"done","finish_id":4,"finish_epoch":"e","background_wait":true}"#,
                Some(LiveEvent::PaneStatus {
                    pane_id: "w:1".to_owned(),
                    agent_status: "done".to_owned(),
                    finish_id: Some(4),
                    finish_epoch: Some("e".to_owned()),
                }),
            ),
            (
                r#"{"type":"features","features":[],"connection":"c"}"#,
                None,
            ),
            (r#"{"type":"pty-data","pane_id":"w:1","data":"x"}"#, None),
            ("not json", None),
        ];
        for (text, expected) in cases {
            assert_eq!(&event(text), expected, "{text}");
        }
    }
}
