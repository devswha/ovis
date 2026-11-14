//! The inbox's rows in their groups, as the web's agent inbox computes them
//! (src/lib/agentInbox.ts `inboxOrder`, src/lib/agentRoster.ts `groupAgentRows`).

mod model;
mod order;
mod rows;
mod title;

use std::collections::BTreeMap;

use crate::api::{LOCAL_PC, SeenFinish, Snapshot};
use model::GROUPS;
pub use model::{Group, Row, StatusChange, Waiting};
use order::{Node, Ranked, grouped};
use rows::{Entry, entries, known, row, shown_status, tagged_background};

/// The latest snapshot, this PC's read finishes, and a state-change counter per pane.
#[derive(Debug, Default)]
pub struct Roster {
    snapshot: Option<Snapshot>,
    /// The greatest read finish per `(epoch, pane)` of this PC.
    read: BTreeMap<(String, String), u64>,
    /// Per pane: the state it drew when its counter was last given, and that counter.
    counters: BTreeMap<String, (String, u64)>,
    last_counter: u64,
}

impl Roster {
    #[must_use]
    pub fn new() -> Roster {
        Roster::default()
    }

    pub fn apply_snapshot(&mut self, snapshot: Snapshot) {
        self.snapshot = Some(snapshot);
        self.restamp();
    }

    /// Merges a pushed status into the snapshot (src/lib/snapshot.ts `applyPaneStatus`): a new
    /// finish epoch drops every other pane's finish, which belonged to the old one.
    pub fn apply_status(&mut self, change: &StatusChange) {
        let Some(snapshot) = self.snapshot.as_mut() else {
            return;
        };
        let epoch_changed = snapshot.finish_epoch != change.finish_epoch;
        for pane in &mut snapshot.panes {
            if pane.pane_id == change.pane_id {
                pane.agent_status.clone_from(&change.agent_status);
                pane.finish_id = change.finish_id;
            } else if epoch_changed {
                pane.finish_id = None;
            }
        }
        snapshot.finish_epoch.clone_from(&change.finish_epoch);
        self.restamp();
    }

    /// Takes read finishes (`GET /api/seen`, or one this client just posted); the greatest wins.
    pub fn apply_seen(&mut self, finishes: Vec<SeenFinish>) {
        for finish in finishes.into_iter().filter(|finish| finish.pc == LOCAL_PC) {
            let held = self.read.entry((finish.epoch, finish.pane)).or_insert(0);
            *held = (*held).max(finish.id);
        }
        self.restamp();
    }

    pub fn remove(&mut self, pane_id: &str) {
        if let Some(snapshot) = self.snapshot.as_mut() {
            snapshot.panes.retain(|pane| pane.pane_id != pane_id);
            snapshot.agents.retain(|agent| agent.pane_id != pane_id);
        }
        self.counters.remove(pane_id);
    }

    /// The rows in their groups, in drawing order; a group with no row is left out. Within a group
    /// the longest in its state comes first, and each helper stands under its agent.
    #[must_use]
    pub fn groups(&self) -> Vec<(Group, Vec<Row>)> {
        let Some(snapshot) = &self.snapshot else {
            return Vec::new();
        };
        let listed = entries(snapshot);
        let nodes: Vec<Node<'_>> = listed.iter().map(node).collect();
        let roster: Vec<&Entry<'_>> = order::nest(&nodes)
            .into_iter()
            .filter_map(|index| listed.get(index))
            .collect();
        let statuses: Vec<String> = roster
            .iter()
            .map(|entry| self.drawn(snapshot, entry.pane))
            .collect();
        let ranked: Vec<Ranked<'_>> = roster
            .iter()
            .zip(&statuses)
            .map(|(entry, status)| Ranked {
                node: node(entry),
                rank: Group::of(status).rank(),
                seq: self.counters.get(&entry.pane.pane_id).map(|(_, seq)| *seq),
            })
            .collect();
        grouped(&ranked)
            .into_iter()
            .filter_map(|(rank, members)| {
                let group = GROUPS.get(rank).copied()?;
                let drawn = members
                    .into_iter()
                    .filter_map(|index| {
                        Some(row(snapshot, roster.get(index)?, statuses.get(index)?))
                    })
                    .collect();
                Some((group, drawn))
            })
            .collect()
    }

    /// What to POST to `/api/seen` for a pane now drawn as done; None otherwise.
    #[must_use]
    pub fn finish_of(&self, pane_id: &str) -> Option<SeenFinish> {
        let snapshot = self.snapshot.as_ref()?;
        let pane = snapshot.panes.iter().find(|pane| pane.pane_id == pane_id)?;
        let epoch = snapshot.finish_epoch.clone()?;
        let id = pane.finish_id.filter(|id| *id > 0)?;
        (known(&self.drawn(snapshot, pane)) == "done").then(|| SeenFinish {
            pc: LOCAL_PC.to_owned(),
            epoch,
            pane: pane.pane_id.clone(),
            id,
            answer: None,
        })
    }

    /// Whether a row belongs with the background agents (`splitBackgroundRows`): tagged
    /// `role=background`, or a helper started by one, and not blocked.
    #[must_use]
    pub fn is_background(&self, pane_id: &str) -> bool {
        let Some(snapshot) = &self.snapshot else {
            return false;
        };
        let listed = entries(snapshot);
        let find = |id: &str| listed.iter().find(|entry| entry.pane.pane_id == id);
        let Some(start) = find(pane_id) else {
            return false;
        };
        let mut passed: Vec<&str> = Vec::new();
        let mut up = Some(start);
        let mut tagged = false;
        while let Some(entry) = up.filter(|entry| !passed.contains(&entry.pane.pane_id.as_str())) {
            if tagged_background(entry) {
                tagged = true;
                break;
            }
            passed.push(&entry.pane.pane_id);
            up = entry.pane.parent_pane_id.as_deref().and_then(find);
        }
        tagged && known(&self.drawn(snapshot, start.pane)) != "blocked"
    }

    fn drawn(&self, snapshot: &Snapshot, pane: &crate::api::Pane) -> String {
        let read = snapshot.finish_epoch.as_ref().and_then(|epoch| {
            self.read
                .get(&(epoch.clone(), pane.pane_id.clone()))
                .copied()
        });
        shown_status(pane, read)
    }

    /// Gives a pane a new, larger counter when first seen and each time the state it draws changes.
    fn restamp(&mut self) {
        let Some(snapshot) = &self.snapshot else {
            return;
        };
        let drawn: Vec<(String, String)> = snapshot
            .panes
            .iter()
            .map(|pane| (pane.pane_id.clone(), self.drawn(snapshot, pane)))
            .collect();
        for (pane_id, status) in &drawn {
            if self
                .counters
                .get(pane_id)
                .is_some_and(|(before, _)| before == status)
            {
                continue;
            }
            self.last_counter = self.last_counter.saturating_add(1);
            self.counters
                .insert(pane_id.clone(), (status.clone(), self.last_counter));
        }
        self.counters
            .retain(|pane_id, _| drawn.iter().any(|(id, _)| id == pane_id));
    }
}

fn node<'a>(entry: &Entry<'a>) -> Node<'a> {
    Node {
        id: &entry.pane.pane_id,
        parent: entry.pane.parent_pane_id.as_deref(),
    }
}
