//! The inbox's public values: a row, its group, what it waits for, and a pushed status.

use super::rows::known;

/// A group of rows, in the order they are drawn (`AGENT_GROUPS`: blocked, working, done, idle).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Group {
    NeedsYou,
    Working,
    Done,
    Idle,
}

pub(crate) const GROUPS: [Group; 4] = [Group::NeedsYou, Group::Working, Group::Done, Group::Idle];

impl Group {
    /// The group a drawn state files a row under (`agentGroup`): background work is work, and a
    /// state nobody knows rests.
    #[must_use]
    pub fn of(status: &str) -> Group {
        match known(status) {
            "blocked" => Group::NeedsYou,
            "working" | "waiting" => Group::Working,
            "done" => Group::Done,
            _ => Group::Idle,
        }
    }

    pub(crate) fn rank(self) -> usize {
        match self {
            Group::NeedsYou => 0,
            Group::Working => 1,
            Group::Done => 2,
            Group::Idle => 3,
        }
    }
}

/// What a blocked agent waits for (the pane's `agent_kind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Waiting {
    Question,
    Permission,
    Auth,
    Other,
}

/// One row of the inbox.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
    pub pane_id: String,
    /// The agent's name as the Agents list says it, else its kind; empty when herdr names none.
    pub agent: String,
    pub title: String,
    /// The workspace's label.
    pub space: String,
    /// The tab, named only beside another tab of its workspace or once renamed; else empty.
    pub tab: String,
    /// The row's own group (a helper may be drawn in its agent's family's group).
    pub group: Group,
    /// The state the row draws.
    pub status: String,
    /// What it waits for, while its own group is [`Group::NeedsYou`].
    pub waiting: Option<Waiting>,
    pub message: Option<String>,
    pub progress: Option<u8>,
    /// The row this one is a helper of (`parent_pane_id`, when that pane is a row).
    pub helper_of: Option<String>,
}

/// A `pane-status` push, as [`crate::live::LiveEvent::PaneStatus`] carries it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusChange {
    pub pane_id: String,
    pub agent_status: String,
    pub finish_id: Option<u64>,
    pub finish_epoch: Option<String>,
}
