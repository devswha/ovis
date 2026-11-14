//! What the inbox shows, and what it asks of the program around it.
use crate::inbox::{Group, Roster, Row};
use crate::net::Job;
use crate::resume::{Place, Spot};

use super::look::Front;
pub use super::types::{Card, Effect, Event, Intent, Link, Loaded, Page, Target};

pub struct Setup {
    pub origin: String,
    /// At this width or under it, one thing is shown at a time.
    pub narrow_at: u16,
    pub size: (u16, u16),
    pub resume: Option<Place>,
}

pub struct State {
    pub(super) roster: Roster,
    pub groups: Vec<(Group, Vec<Row>)>,
    pub link: Link,
    /// What the server serves ("herdr-core", "herdr"), once it said.
    pub runtime: Option<String>,
    pub page: Page,
    pub(super) under_help: Page,
    pub selected: Option<String>,
    pub card: Option<Card>,
    pub notice: Option<String>,
    /// How far down the card or the help is scrolled, in lines.
    pub scroll: usize,
    pub size: (u16, u16),
    pub narrow_at: u16,
    pub origin: String,
    pub(super) resume: Option<Place>,
}

impl State {
    #[must_use]
    pub fn new(setup: Setup) -> State {
        State {
            roster: Roster::new(),
            groups: Vec::new(),
            link: Link::Connecting,
            runtime: None,
            page: Page::List,
            under_help: Page::List,
            selected: None,
            card: None,
            notice: None,
            scroll: 0,
            size: setup.size,
            narrow_at: setup.narrow_at,
            origin: setup.origin,
            resume: setup.resume,
        }
    }

    /// The first reads of a run.
    #[must_use]
    pub fn start(&self) -> Vec<Effect> {
        Self::reads()
    }

    pub fn on(&mut self, event: Event) -> Vec<Effect> {
        match event {
            Event::Key(intent) => self.on_intent(intent),
            Event::Tap(target) => self.on_tap(target),
            Event::Resize { cols, rows } => {
                self.size = (cols, rows);
                if !self.narrow() && self.page == Page::Card {
                    self.page = Page::List;
                }
                Vec::new()
            }
            Event::Net(reply) => self.on_reply(reply),
            Event::TerminalClosed(error) => {
                self.notice = error.map(|error| format!("The terminal screen ended: {error}"));
                let mut effects = vec![self.remember()];
                effects.extend(self.reload());
                effects
            }
        }
    }

    /// After a frame: the scroll cannot be further down than what was drawn allows.
    pub fn drawn(&mut self, hits: &super::Hits) {
        self.scroll = self.scroll.min(hits.scroll_max);
    }

    #[must_use]
    pub fn narrow(&self) -> bool {
        self.size.0 <= self.narrow_at
    }

    pub fn rows(&self) -> impl Iterator<Item = &Row> {
        self.groups.iter().flat_map(|(_, rows)| rows.iter())
    }

    #[must_use]
    pub fn selected_row(&self) -> Option<&Row> {
        let selected = self.selected.as_deref()?;
        self.rows().find(|row| row.pane_id == selected)
    }

    #[must_use]
    pub fn needs_you(&self) -> usize {
        self.groups
            .iter()
            .filter(|(group, _)| *group == Group::NeedsYou)
            .map(|(_, rows)| rows.len())
            .sum()
    }

    /// What is in front of the user now: the agent whose card is on screen, and its finish while
    /// that is unread.
    #[must_use]
    pub fn front(&self) -> Front {
        let pane = self.selected.clone().filter(|_| self.card_on_screen());
        let unread = pane.as_deref().and_then(|pane| self.roster.finish_of(pane));
        Front { pane, unread }
    }

    /// The card is on screen now, so a digit may answer it.
    #[must_use]
    pub fn card_on_screen(&self) -> bool {
        match self.page {
            Page::Help => false,
            Page::Card => true,
            Page::List => !self.narrow(),
        }
    }

    /// How many of the card's options a digit answers here; none when it must be answered in the
    /// terminal (several picks, several questions) or there is no card.
    #[must_use]
    pub fn answerable(&self) -> usize {
        match self.card.as_ref().map(|card| &card.prompt) {
            Some(Loaded::Ready(Some(prompt))) if !prompt.multi_select && !prompt.has_steps => {
                prompt.options.len().min(9)
            }
            _ => 0,
        }
    }

    pub(super) fn reads() -> Vec<Effect> {
        vec![
            Effect::Ask(Job::Health),
            Effect::Ask(Job::Session),
            Effect::Ask(Job::Seen),
        ]
    }

    /// Everything read again, the selected agent's card with it.
    pub(super) fn reload(&self) -> Vec<Effect> {
        let mut effects = Self::reads();
        if let Some(pane) = &self.selected {
            effects.push(Effect::Ask(Job::Prompt(pane.clone())));
            effects.push(Effect::Ask(Job::Conversation(pane.clone())));
        }
        effects
    }

    pub(super) fn remember(&self) -> Effect {
        let page = match self.page {
            Page::Help => self.under_help,
            Page::List | Page::Card => self.page,
        };
        Effect::Remember {
            spot: match page {
                Page::Card => Spot::Card,
                Page::List | Page::Help => Spot::Inbox,
            },
            pane: self.selected.clone(),
        }
    }

    /// Moves the selection; the card of the new agent is read and its changes followed.
    pub(super) fn select(&mut self, pane: Option<String>) -> Vec<Effect> {
        if pane == self.selected {
            return Vec::new();
        }
        self.selected.clone_from(&pane);
        self.scroll = 0;
        self.card = pane.clone().map(Card::loading);
        if pane.is_none() && self.page == Page::Card {
            self.page = Page::List;
        }
        let mut effects = vec![Effect::Watch(pane.clone())];
        if let Some(pane) = pane {
            effects.push(Effect::Ask(Job::Prompt(pane.clone())));
            effects.push(Effect::Ask(Job::Conversation(pane)));
        }
        effects
    }
}
