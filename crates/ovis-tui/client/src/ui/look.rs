//! When a finish counts as looked at. An agent's card that has been in front of the user for a
//! moment was read: the server is told, and every device of that server draws the finish as
//! read. Keys held down pass over rows without resting on them, and those stay unread.
use std::time::{Duration, Instant};

use crate::api::{Presented, SeenFinish};

/// How long a card is in front of the user before its finish counts as looked at.
pub const REST: Duration = Duration::from_secs(1);

/// What is in front of the user: the agent whose card is on screen, and its finish while that is
/// still unread.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Front {
    pub pane: Option<String>,
    pub unread: Option<SeenFinish>,
}

#[derive(Debug, Default)]
pub struct Looker {
    pane: Option<String>,
    /// The finish waiting out its moment, how it came in front, and when the moment ends.
    waiting: Option<(SeenFinish, Presented, Instant)>,
    /// The finish told since its agent came in front: it is told once per look.
    told: Option<SeenFinish>,
}

impl Looker {
    /// Takes what is in front now. A finish whose agent just came in front was looked at anew;
    /// one that arrived under an agent already in front was only held there.
    pub fn see(&mut self, front: &Front, now: Instant) {
        let arrived = front.pane != self.pane;
        self.pane.clone_from(&front.pane);
        if arrived {
            self.told = None;
        }
        let Some(finish) = front
            .unread
            .as_ref()
            .filter(|finish| self.told.as_ref() != Some(*finish))
        else {
            self.waiting = None;
            return;
        };
        let waits = self
            .waiting
            .as_ref()
            .is_some_and(|(held, ..)| held == finish);
        if arrived || !waits {
            let presented = if arrived {
                Presented::New
            } else {
                Presented::Held
            };
            self.waiting = Some((finish.clone(), presented, now + REST));
        }
    }

    /// Nothing of the inbox is in front any more (the terminal screen took over).
    pub fn away(&mut self) {
        *self = Looker::default();
    }

    /// When the finish in front will have rested long enough.
    #[must_use]
    pub fn due(&self) -> Option<Instant> {
        self.waiting.as_ref().map(|(_, _, due)| *due)
    }

    /// The finish to tell the server, once its moment is over.
    pub fn rested(&mut self, now: Instant) -> Option<(SeenFinish, Presented)> {
        if self.due().is_none_or(|due| due > now) {
            return None;
        }
        let (finish, presented, _) = self.waiting.take()?;
        self.told = Some(finish.clone());
        Some((finish, presented))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn finish(pane: &str, id: u64) -> SeenFinish {
        SeenFinish {
            pc: "local".into(),
            epoch: "e".into(),
            pane: pane.into(),
            id,
            answer: None,
        }
    }

    fn front(pane: &str, unread: Option<u64>) -> Front {
        Front {
            pane: Some(pane.into()),
            unread: unread.map(|id| finish(pane, id)),
        }
    }

    #[test]
    fn a_finish_is_told_as_new_once_its_card_has_rested_in_front() {
        let start = Instant::now();
        let mut looker = Looker::default();
        looker.see(&front("t1", Some(3)), start);
        assert_eq!(looker.due(), Some(start + REST));
        assert_eq!(looker.rested(start + REST / 2), None);
        assert_eq!(
            looker.rested(start + REST),
            Some((finish("t1", 3), Presented::New))
        );
        assert_eq!(looker.due(), None);
    }

    #[test]
    fn rows_passed_over_with_a_held_key_stay_unread() {
        let start = Instant::now();
        let mut looker = Looker::default();
        looker.see(&front("t1", Some(3)), start);
        looker.see(&front("t2", Some(5)), start + REST / 2);
        assert_eq!(looker.rested(start + REST), None);
        assert_eq!(
            looker.rested(start + REST / 2 + REST),
            Some((finish("t2", 5), Presented::New))
        );
    }

    #[test]
    fn a_finish_that_arrives_under_a_card_already_in_front_is_told_as_held() {
        let start = Instant::now();
        let mut looker = Looker::default();
        looker.see(&front("t1", None), start);
        looker.see(&front("t1", Some(4)), start + REST);
        assert_eq!(
            looker.rested(start + REST * 2),
            Some((finish("t1", 4), Presented::Held))
        );
    }

    #[test]
    fn the_moment_runs_from_when_the_card_came_in_front_not_from_each_later_change() {
        let start = Instant::now();
        let mut looker = Looker::default();
        looker.see(&front("t1", Some(3)), start);
        looker.see(&front("t1", Some(3)), start + REST / 2);
        assert_eq!(looker.due(), Some(start + REST));
    }

    #[test]
    fn a_finish_is_told_once_per_look_and_again_after_the_card_left_and_came_back() {
        let start = Instant::now();
        let mut looker = Looker::default();
        looker.see(&front("t1", Some(3)), start);
        assert!(looker.rested(start + REST).is_some());
        // the server has not answered yet: the finish still reads as unread
        looker.see(&front("t1", Some(3)), start + REST);
        assert_eq!(looker.due(), None);
        looker.see(&Front::default(), start + REST * 2);
        looker.see(&front("t1", Some(3)), start + REST * 3);
        assert_eq!(
            looker.rested(start + REST * 4),
            Some((finish("t1", 3), Presented::New))
        );
    }

    #[test]
    fn coming_back_from_the_terminal_screen_is_a_new_look() {
        let start = Instant::now();
        let mut looker = Looker::default();
        looker.see(&front("t1", None), start);
        looker.away();
        looker.see(&front("t1", Some(2)), start + REST);
        assert_eq!(
            looker.rested(start + REST * 2),
            Some((finish("t1", 2), Presented::New))
        );
    }
}
