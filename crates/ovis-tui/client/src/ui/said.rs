//! What was said last in an agent's chat: the two messages its card shows.
use crate::api::{Conversation, Part, Role, Turn};

/// The user's last message and the agent's answer to it; the agent's is missing while it has
/// not answered yet.
pub(super) fn last(conversation: &Conversation) -> (Option<String>, Option<String>) {
    let turns = &conversation.turns;
    let Some(last_user) = turns.iter().rposition(|turn| turn.role == Role::User) else {
        let agent = turns.iter().rev().find_map(words);
        return (None, agent);
    };
    let you = turns.get(last_user).and_then(words);
    let agent = turns
        .iter()
        .skip(last_user + 1)
        .rev()
        .filter(|turn| turn.role == Role::Assistant)
        .find_map(words);
    (you, agent)
}

/// What a turn says: its final answer where one is marked, else the last thing it wrote (a
/// turn's earlier text is its notes along the way); a turn of tool calls alone names the last one.
fn words(turn: &Turn) -> Option<String> {
    let texts: Vec<(&str, Option<&str>)> = turn
        .parts
        .iter()
        .filter_map(|part| match part {
            Part::Text { text, phase } if !text.trim().is_empty() => {
                Some((text.as_str(), phase.as_deref()))
            }
            Part::Text { .. } | Part::Tool { .. } | Part::Other => None,
        })
        .collect();
    let said = texts
        .iter()
        .rev()
        .find(|(_, phase)| *phase == Some("final_answer"))
        .or(texts.last());
    if let Some((text, _)) = said {
        return Some((*text).to_owned());
    }
    turn.parts.iter().rev().find_map(|part| match part {
        Part::Tool { name, summary } => Some(format!("({name}: {summary})")),
        Part::Text { .. } | Part::Other => None,
    })
}
