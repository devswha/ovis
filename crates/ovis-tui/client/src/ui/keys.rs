//! What a key or a tap changes.
use crate::api::{Answer, Presented};
use crate::net::Job;
use crate::resume::Spot;

use super::state::{Effect, Intent, Link, Loaded, Page, State, Target};

enum Verdict {
    Ignore,
    Say(&'static str),
    Send(Answer),
}

impl State {
    pub(super) fn on_intent(&mut self, intent: Intent) -> Vec<Effect> {
        self.notice = None;
        if self.page == Page::Help {
            return self.on_help(intent);
        }
        match intent {
            Intent::Up => self.step(-1),
            Intent::Down => self.step(1),
            Intent::Top => self.step(isize::MIN),
            Intent::Bottom => self.step(isize::MAX),
            Intent::ScrollUp => self.scroll_by(false),
            Intent::ScrollDown => self.scroll_by(true),
            Intent::Open => self.open(),
            Intent::Terminal => self.terminal(),
            Intent::Back => self.back(),
            Intent::Answer(digit) => self.answer(digit),
            Intent::MarkRead => self.mark_read(),
            Intent::Refresh => {
                if self.link != Link::Up {
                    self.link = Link::Connecting;
                }
                self.reload()
            }
            Intent::Help => {
                self.under_help = self.page;
                self.page = Page::Help;
                self.scroll = 0;
                Vec::new()
            }
            Intent::Quit => vec![self.remember(), Effect::Quit],
        }
    }

    /// On the help page: it scrolls, and any of the keys that leave a page leaves it.
    fn on_help(&mut self, intent: Intent) -> Vec<Effect> {
        match intent {
            Intent::Help | Intent::Back | Intent::Open | Intent::Quit => {
                self.page = self.under_help;
                self.scroll = 0;
                Vec::new()
            }
            Intent::Up | Intent::ScrollUp => self.scroll_by(false),
            Intent::Down | Intent::ScrollDown => self.scroll_by(true),
            Intent::Top
            | Intent::Bottom
            | Intent::Terminal
            | Intent::Answer(_)
            | Intent::MarkRead
            | Intent::Refresh => Vec::new(),
        }
    }

    pub(super) fn on_tap(&mut self, target: Target) -> Vec<Effect> {
        self.notice = None;
        match target {
            Target::Back => self.back(),
            Target::Row(pane) => {
                let mut effects = self.select(Some(pane));
                if self.narrow() && self.page == Page::List {
                    effects.extend(self.open());
                } else {
                    effects.push(self.remember());
                }
                effects
            }
        }
    }

    /// The selection moved by `delta` rows, stopping at either end.
    fn step(&mut self, delta: isize) -> Vec<Effect> {
        let panes: Vec<String> = self.rows().map(|row| row.pane_id.clone()).collect();
        let Some(last) = panes.len().checked_sub(1) else {
            return Vec::new();
        };
        let at = self
            .selected
            .as_ref()
            .and_then(|selected| panes.iter().position(|pane| pane == selected));
        let to = match at {
            Some(at) => at.saturating_add_signed(delta).min(last),
            None => 0,
        };
        let mut effects = self.select(panes.get(to).cloned());
        if !effects.is_empty() {
            effects.push(self.remember());
        }
        effects
    }

    /// Enter: on the list of a narrow screen it opens the card; anywhere else the card is already
    /// in view, and it goes on to the terminal.
    fn open(&mut self) -> Vec<Effect> {
        if !(self.narrow() && self.page == Page::List) || self.selected.is_none() {
            return self.terminal();
        }
        self.page = Page::Card;
        self.scroll = 0;
        vec![self.remember()]
    }

    fn terminal(&mut self) -> Vec<Effect> {
        // hc-tui draws herdr-core's terminals; a classic herdr's panes are not among them
        if self.selected.is_some() && self.runtime.as_deref() == Some("herdr") {
            self.notice = Some(
                "This Ovis server runs classic herdr: its terminals open in herdr itself.".into(),
            );
            return Vec::new();
        }
        vec![
            Effect::Remember {
                spot: Spot::Terminal,
                pane: self.selected.clone(),
            },
            Effect::OpenTerminal(self.selected.clone()),
        ]
    }

    fn back(&mut self) -> Vec<Effect> {
        if self.page == Page::Card {
            self.page = Page::List;
            self.scroll = 0;
            return vec![self.remember()];
        }
        Vec::new()
    }

    fn answer(&mut self, digit: u8) -> Vec<Effect> {
        match self.verdict(digit) {
            Verdict::Ignore => Vec::new(),
            Verdict::Say(words) => {
                self.notice = Some(words.into());
                Vec::new()
            }
            Verdict::Send(answer) => {
                if let Some(card) = self.card.as_mut() {
                    card.sending = Some(answer.option_index);
                }
                vec![Effect::Ask(Job::Answer(answer))]
            }
        }
    }

    /// Whether a digit answers the card: only a card that is on screen, with one pick to make,
    /// and never twice.
    fn verdict(&self, digit: u8) -> Verdict {
        if !self.card_on_screen() {
            return Verdict::Ignore;
        }
        let Some(card) = &self.card else {
            return Verdict::Ignore;
        };
        let Loaded::Ready(Some(prompt)) = &card.prompt else {
            return Verdict::Ignore;
        };
        if prompt.multi_select || prompt.has_steps {
            return Verdict::Say(
                "This card takes more than one pick: answer it in the terminal (t).",
            );
        }
        let Some(index) = usize::from(digit)
            .checked_sub(1)
            .filter(|index| *index < prompt.options.len())
        else {
            return Verdict::Say("The card has no option with that number.");
        };
        if prompt.custom_option_index == Some(index) {
            return Verdict::Say("That option asks for typed text: answer it in the terminal (t).");
        }
        if card.sending.is_some() {
            return Verdict::Say("The last answer is still on its way.");
        }
        Verdict::Send(Answer {
            pane_id: card.pane_id.clone(),
            prompt_id: prompt.id.clone(),
            option_index: index,
        })
    }

    /// Asked for by its key: the finish is told to the server at once, as a look.
    fn mark_read(&mut self) -> Vec<Effect> {
        let finish = self
            .selected
            .as_deref()
            .and_then(|pane| self.roster.finish_of(pane));
        match finish {
            Some(finish) => vec![Effect::Ask(Job::MarkSeen(finish, Presented::New))],
            None => {
                if self.selected.is_some() {
                    self.notice = Some("Nothing unread here.".into());
                }
                Vec::new()
            }
        }
    }

    /// Half a screen up or down in what scrolls here: the card, or the help.
    fn scroll_by(&mut self, down: bool) -> Vec<Effect> {
        let step = usize::from(self.size.1.saturating_sub(4) / 2).max(1);
        self.scroll = if down {
            self.scroll.saturating_add(step)
        } else {
            self.scroll.saturating_sub(step)
        };
        Vec::new()
    }
}
