//! The screen's turn without threads: for a single frame, and for tests.
use std::collections::VecDeque;

use crate::api::Client;
use crate::net::perform;

use super::state::{Effect, Event, State};

/// Makes the calls `effects` ask for, one after another, and those their answers ask for, until
/// none is left. What is not a call to the server is handed back in its order.
pub fn settle(state: &mut State, client: &Client, effects: Vec<Effect>) -> Vec<Effect> {
    let mut queue: VecDeque<Effect> = effects.into();
    let mut rest = Vec::new();
    while let Some(effect) = queue.pop_front() {
        match effect {
            Effect::Ask(job) => queue.extend(state.on(Event::Net(perform(client, job)))),
            Effect::Watch(_) | Effect::OpenTerminal(_) | Effect::Remember { .. } | Effect::Quit => {
                rest.push(effect);
            }
        }
    }
    rest
}
