//! A pane's prompt and conversation, and the read finishes of `/api/seen`
//! (shared/protocol.ts `InteractivePrompt`, `ConversationResponse`; shared/seen.ts `SeenFinish`).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct PromptOption {
    pub label: String,
    #[serde(default)]
    pub description: Option<String>,
}

/// The interactive menu on a pane's screen; `id` is what an answer names.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(from = "RawPrompt")]
pub struct Prompt {
    pub id: String,
    pub title: String,
    pub question: String,
    pub body: Option<String>,
    pub options: Vec<PromptOption>,
    pub multi_select: bool,
    pub custom_option_index: Option<usize>,
    /// A form that asks several questions at once (`steps` present and non-empty).
    pub has_steps: bool,
}

#[derive(Deserialize)]
struct RawPrompt {
    id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    question: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    options: Vec<PromptOption>,
    #[serde(default)]
    multi_select: bool,
    #[serde(default)]
    custom_option_index: Option<usize>,
    #[serde(default)]
    steps: Option<Vec<serde_json::Value>>,
}

impl From<RawPrompt> for Prompt {
    fn from(raw: RawPrompt) -> Prompt {
        Prompt {
            has_steps: raw.steps.is_some_and(|steps| !steps.is_empty()),
            id: raw.id,
            title: raw.title,
            question: raw.question,
            body: raw.body,
            options: raw.options,
            multi_select: raw.multi_select,
            custom_option_index: raw.custom_option_index,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct Conversation {
    #[serde(default)]
    pub turns: Vec<Turn>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Turn {
    pub role: Role,
    #[serde(default)]
    pub parts: Vec<Part>,
}

/// A part of a turn; every `kind` besides text and tool reads as `Other`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Part {
    Text {
        text: String,
        #[serde(default)]
        phase: Option<String>,
    },
    Tool {
        name: String,
        #[serde(default)]
        summary: String,
    },
    #[serde(other)]
    Other,
}

/// A finish some client presented, so every client of this server draws it as read.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct SeenFinish {
    pub pc: String,
    pub epoch: String,
    pub pane: String,
    pub id: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answer: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_steps_decode() {
        let prompt: Prompt = serde_json::from_str(
            r#"{"id":"p1","agent":"claude","kind":"survey","title":"t","question":"q?","body":null,
               "options":[{"label":"Yes","description":null}],"multi_select":false,
               "custom_option_index":null,"steps":[{"label":"a","answered":false,"current":true}],"extra":1}"#,
        )
        .expect("prompt decodes");
        assert!(prompt.has_steps);
        let empty: Prompt =
            serde_json::from_str(r#"{"id":"p","kind":"approval","options":[],"steps":[]}"#)
                .expect("decodes");
        assert!(!empty.has_steps);
    }

    #[test]
    fn conversation_parts_of_unknown_kind_read_as_other() {
        let conversation: Conversation = serde_json::from_str(
            r#"{"source":"claude-transcript","turns":[{"role":"assistant","ts":null,"parts":[
                {"kind":"text","text":"hi","phase":"final_answer"},
                {"kind":"tool","name":"bash","summary":"ls","input":"","output":""},
                {"kind":"thinking","text":"hm"},{"kind":"goal_wait","due_at":"x","waiting_on":{}}]}]}"#,
        )
        .expect("conversation decodes");
        let parts = &conversation.turns[0].parts;
        assert_eq!(
            parts,
            &vec![
                Part::Text {
                    text: "hi".to_owned(),
                    phase: Some("final_answer".to_owned())
                },
                Part::Tool {
                    name: "bash".to_owned(),
                    summary: "ls".to_owned()
                },
                Part::Other,
                Part::Other,
            ]
        );
    }
}
