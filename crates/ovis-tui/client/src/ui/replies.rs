//! What an answer of the server changes.
use crate::api::{AnswerOutcome, ApiError, Conversation, Prompt, Snapshot};
use crate::inbox::StatusChange;
use crate::live::LiveEvent;
use crate::net::{Job, Reply};
use crate::resume::Spot;

use super::state::{Effect, Link, Loaded, Page, State};

impl State {
    pub(super) fn on_reply(&mut self, reply: Reply) -> Vec<Effect> {
        match reply {
            Reply::Live(event) => self.on_live(event),
            Reply::Health(Ok(health)) => {
                self.runtime = health.runtime;
                Vec::new()
            }
            Reply::Session(Ok(snapshot)) => self.take_snapshot(snapshot),
            Reply::Session(Err(error)) => {
                self.failed(&error);
                self.resume_without_rows()
            }
            Reply::Seen(Ok(finishes)) => {
                self.roster.apply_seen(finishes);
                self.rows_changed()
            }
            Reply::Health(Err(error)) | Reply::Seen(Err(error)) => {
                self.failed(&error);
                Vec::new()
            }
            Reply::Prompt { pane_id, result } => self.take_prompt(&pane_id, result),
            Reply::Conversation { pane_id, result } => self.take_conversation(&pane_id, result),
            Reply::Answered { answer, result } => {
                if let Some(card) = self
                    .card
                    .as_mut()
                    .filter(|card| card.pane_id == answer.pane_id)
                {
                    card.sending = None;
                    // an answer that arrived, or a question that changed, leaves the options
                    // drawn here stale: they are off the screen until the card is read again
                    if matches!(
                        result,
                        Ok(AnswerOutcome::Sent | AnswerOutcome::PromptChanged)
                    ) {
                        card.prompt = Loaded::Loading;
                    }
                }
                self.answered(result);
                vec![Effect::Ask(Job::Prompt(answer.pane_id))]
            }
            Reply::MarkedSeen { finish, result } => match result {
                Ok(()) => {
                    self.roster.apply_seen(vec![finish]);
                    self.rows_changed()
                }
                Err(error) => {
                    self.notice = Some(format!("Not marked read: {error}"));
                    self.failed(&error);
                    Vec::new()
                }
            },
        }
    }

    fn on_live(&mut self, event: LiveEvent) -> Vec<Effect> {
        match event {
            LiveEvent::Up => Self::reads(),
            LiveEvent::Snapshot(snapshot) => self.take_snapshot(*snapshot),
            LiveEvent::PaneStatus {
                pane_id,
                agent_status,
                finish_id,
                finish_epoch,
            } => {
                self.roster.apply_status(&StatusChange {
                    pane_id: pane_id.clone(),
                    agent_status,
                    finish_id,
                    finish_epoch,
                });
                let mut effects = self.rows_changed();
                if self.selected.as_deref() == Some(pane_id.as_str()) {
                    effects.push(Effect::Ask(Job::Prompt(pane_id)));
                }
                effects
            }
            LiveEvent::SessionChanged => vec![Effect::Ask(Job::Session)],
            LiveEvent::PaneExited(pane_id) => {
                self.roster.remove(&pane_id);
                self.rows_changed()
            }
            LiveEvent::PromptChanged(pane_id) => self.again(pane_id, Job::Prompt),
            LiveEvent::ConversationChanged(pane_id) => self.again(pane_id, Job::Conversation),
            LiveEvent::Down(reason) => {
                if matches!(self.link, Link::Up | Link::Connecting) {
                    self.link = Link::Down(reason);
                }
                Vec::new()
            }
        }
    }

    fn again(&self, pane_id: String, job: fn(String) -> Job) -> Vec<Effect> {
        if self.selected.as_deref() == Some(pane_id.as_str()) {
            vec![Effect::Ask(job(pane_id))]
        } else {
            Vec::new()
        }
    }

    /// The link and the notice a failed call leaves behind.
    fn failed(&mut self, error: &ApiError) {
        match error {
            ApiError::Unreachable(reason) => self.link = Link::Down(reason.clone()),
            ApiError::Unauthorized(reason) => self.link = Link::Refused(reason.clone()),
            ApiError::Status { .. } | ApiError::Decode(_) => self.notice = Some(error.to_string()),
        }
    }

    fn take_snapshot(&mut self, snapshot: Snapshot) -> Vec<Effect> {
        self.link = Link::Up;
        self.roster.apply_snapshot(snapshot);
        let Some(place) = self.resume.take() else {
            return self.rows_changed();
        };
        // the place a cut-off run left: its agent is selected again when it is still listed
        self.groups = self.roster.groups();
        let listed = place
            .pane
            .filter(|pane| self.rows().any(|row| &row.pane_id == pane));
        let found = listed.is_some();
        let mut effects = match listed {
            Some(pane) => self.select(Some(pane)),
            None => self.rows_changed(),
        };
        match place.spot {
            Spot::Inbox => {}
            Spot::Card => {
                if found && self.narrow() {
                    self.page = Page::Card;
                }
            }
            Spot::Terminal => {
                // the run may have moved on inside the terminal screen: that screen's own layout
                // remembers where, so it is not told where to go
                effects.push(Effect::OpenTerminal(None));
            }
        }
        effects
    }

    /// With no server to list the agents, a run that was cut off inside a terminal still goes
    /// back to it: herdr-core alone knows that terminal.
    fn resume_without_rows(&mut self) -> Vec<Effect> {
        match self.resume.take() {
            Some(place) if place.spot == Spot::Terminal => vec![Effect::OpenTerminal(None)],
            _ => Vec::new(),
        }
    }

    /// After the roster changed: the rows are laid out again, and a selection that left the list
    /// moves to the first row.
    pub(super) fn rows_changed(&mut self) -> Vec<Effect> {
        self.groups = self.roster.groups();
        if self.selected_row().is_some() {
            return Vec::new();
        }
        let first = self.rows().next().map(|row| row.pane_id.clone());
        self.select(first)
    }

    fn take_prompt(
        &mut self,
        pane_id: &str,
        result: Result<Option<Prompt>, ApiError>,
    ) -> Vec<Effect> {
        let loaded = match &result {
            Ok(prompt) => Loaded::Ready(prompt.clone()),
            Err(error) => Loaded::Failed(error.to_string()),
        };
        if let Some(card) = self.card.as_mut().filter(|card| card.pane_id == pane_id) {
            card.prompt = loaded;
        }
        if let Err(error) = &result {
            self.failed(error);
        }
        Vec::new()
    }

    fn take_conversation(
        &mut self,
        pane_id: &str,
        result: Result<Conversation, ApiError>,
    ) -> Vec<Effect> {
        let error = result.as_ref().err().cloned();
        let loaded = match result {
            Ok(conversation) => Loaded::Ready(conversation),
            Err(error) => Loaded::Failed(error.to_string()),
        };
        if let Some(card) = self.card.as_mut().filter(|card| card.pane_id == pane_id) {
            card.conversation = loaded;
        }
        if let Some(error) = error {
            self.failed(&error);
        }
        Vec::new()
    }

    fn answered(&mut self, result: Result<AnswerOutcome, ApiError>) {
        match result {
            Ok(AnswerOutcome::Sent) => self.notice = Some("Answer sent.".into()),
            Ok(AnswerOutcome::PromptChanged) => {
                self.notice =
                    Some("The question changed first, so nothing was sent. Read it again.".into());
            }
            Ok(AnswerOutcome::Refused(message)) => {
                self.notice = Some(format!("Not sent: {message}"))
            }
            Err(error) => {
                self.failed(&error);
                // a call that timed out may still have arrived: the card read after it tells
                self.notice = Some(format!("The answer may not have arrived: {error}"));
            }
        }
    }
}
