//! The order rows are drawn in (src/lib/agentRoster.ts `nestRows`, `groupAgentRows`).

use std::cmp::Ordering;
use std::collections::HashMap;

/// A row as ordering sees it: its pane and the pane of the agent that started it.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Node<'a> {
    pub id: &'a str,
    pub parent: Option<&'a str>,
}

/// A row with its own group's place in the drawing order and its state-change counter.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Ranked<'a> {
    pub node: Node<'a>,
    pub rank: usize,
    pub seq: Option<u64>,
}

struct Nesting {
    helpers: Vec<Vec<usize>>,
    placed: Vec<bool>,
    ordered: Vec<usize>,
}

impl Nesting {
    fn add(&mut self, index: usize) {
        if self.placed.get(index).copied().unwrap_or(true) {
            return;
        }
        if let Some(slot) = self.placed.get_mut(index) {
            *slot = true;
        }
        self.ordered.push(index);
        let helpers = self.helpers.get(index).cloned().unwrap_or_default();
        for helper in helpers {
            self.add(helper);
        }
    }
}

/// The indices of `nodes` with each helper right under the agent that started it, after that
/// agent's earlier helpers; an agent and its helpers stand where the first of them stands. A row
/// whose parent is not a row, or that names itself, stays where it is; a loop keeps its order.
pub(crate) fn nest(nodes: &[Node<'_>]) -> Vec<usize> {
    let by_id: HashMap<&str, usize> = nodes
        .iter()
        .enumerate()
        .map(|(index, node)| (node.id, index))
        .collect();
    let parent_of = |index: usize| -> Option<usize> {
        let node = nodes.get(index)?;
        node.parent
            .filter(|parent| *parent != node.id)
            .and_then(|parent| by_id.get(parent).copied())
    };
    let mut nesting = Nesting {
        helpers: vec![Vec::new(); nodes.len()],
        placed: vec![false; nodes.len()],
        ordered: Vec::new(),
    };
    for index in 0..nodes.len() {
        if let Some(helpers) = parent_of(index).and_then(|parent| nesting.helpers.get_mut(parent)) {
            helpers.push(index);
        }
    }
    let root_of = |index: usize| -> usize {
        let mut passed = vec![index];
        let mut root = index;
        while let Some(up) = parent_of(root) {
            if passed.contains(&up) {
                return index;
            }
            passed.push(up);
            root = up;
        }
        root
    };
    for index in 0..nodes.len() {
        nesting.add(root_of(index));
    }
    for index in 0..nodes.len() {
        nesting.add(index);
    }
    nesting.ordered
}

/// A row with no counter yet sorts after the counted ones; the smaller counter (the longest in
/// its state) first.
fn by_wait(left: Option<u64>, right: Option<u64>) -> Ordering {
    match (left, right) {
        (Some(left), Some(right)) => left.cmp(&right),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    }
}

/// The rows (indices into `rows`) in runs of one group each, as `(rank, rows)`: by group, then
/// the longest wait, then the given order; each helper under its agent, and every row of such a
/// family in the group of the member that needs the reader most.
pub(crate) fn grouped(rows: &[Ranked<'_>]) -> Vec<(usize, Vec<usize>)> {
    let mut sorted: Vec<usize> = (0..rows.len()).collect();
    let field = |index: usize| rows.get(index).map(|row| (row.rank, row.seq));
    sorted.sort_by(|&left, &right| match (field(left), field(right)) {
        (Some((left_rank, left_seq)), Some((right_rank, right_seq))) => left_rank
            .cmp(&right_rank)
            .then_with(|| by_wait(left_seq, right_seq))
            .then_with(|| left.cmp(&right)),
        _ => left.cmp(&right),
    });
    let nodes: Vec<Node<'_>> = sorted
        .iter()
        .filter_map(|&index| rows.get(index).map(|row| row.node))
        .collect();
    let nested: Vec<usize> = nest(&nodes)
        .into_iter()
        .filter_map(|at| sorted.get(at).copied())
        .collect();
    let position: HashMap<&str, usize> = nested
        .iter()
        .filter_map(|&index| rows.get(index).map(|row| (row.node.id, index)))
        .collect();
    let mut groups: Vec<(usize, Vec<usize>)> = Vec::new();
    let mut placed: Vec<usize> = Vec::new();
    let mut family_rank = usize::MAX;
    for (at, &index) in nested.iter().enumerate() {
        let Some(row) = rows.get(index) else { continue };
        let parent = row
            .node
            .parent
            .filter(|parent| *parent != row.node.id)
            .and_then(|parent| position.get(parent));
        if parent.is_none_or(|parent| !placed.contains(parent)) {
            family_rank = family(rows, nested.get(at..).unwrap_or_default(), &position)
                .into_iter()
                .filter_map(|member| rows.get(member).map(|row| row.rank))
                .min()
                .unwrap_or(row.rank);
        }
        placed.push(index);
        match groups.last_mut() {
            Some((rank, members)) if *rank == family_rank => members.push(index),
            _ => groups.push((family_rank, vec![index])),
        }
    }
    groups
}

/// The first row of `from` and the rows right after it nested under it.
fn family(rows: &[Ranked<'_>], from: &[usize], position: &HashMap<&str, usize>) -> Vec<usize> {
    let mut members: Vec<usize> = from.first().copied().into_iter().collect();
    for &index in from.iter().skip(1) {
        let parent = rows
            .get(index)
            .and_then(|row| row.node.parent)
            .and_then(|parent| position.get(parent));
        match parent {
            Some(parent) if members.contains(parent) => members.push(index),
            _ => break,
        }
    }
    members
}
