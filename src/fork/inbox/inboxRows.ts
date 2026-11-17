import { nestRows, treeLines, type AgentGroup } from "../../lib/agentRoster.ts";
import { sidebarPinKey } from "../../lib/sidebarPins.ts";

interface InboxRow {
  machine: { id: string };
  entry: { pane: { pane_id: string; parent_pane_id?: string } };
}

const keyOf = (row: InboxRow) => sidebarPinKey(row.machine.id, row.entry.pane.pane_id);
const parentOf = (row: InboxRow) => row.entry.pane.parent_pane_id === undefined ? undefined : sidebarPinKey(row.machine.id, row.entry.pane.parent_pane_id);

/** A helper's place in the tree, as the sidebar marks its rows (AgentSidebar.css draws the line); none on an agent's row. */
export interface ForkTree {
  "data-depth"?: number;
  "data-more"?: "";
  "data-through"?: "";
}

/** The sidebar's family order, applied after inbox filtering so an absent conductor leaves no indent. */
export function forkInboxRows<T extends InboxRow>(rows: readonly T[], enabled: boolean): (T & { forkTree: ForkTree })[] {
  return forkInboxNesting(enabled ? nestRows(rows, keyOf, parentOf) : rows, enabled);
}

/**
 * The tree of the order actually drawn: a row is a helper only under its agent's family just above it, so a held
 * helper never connects across an unrelated row. Depth stops at 2, as the sidebar's does.
 */
export function forkInboxNesting<T extends InboxRow>(rows: readonly T[], enabled: boolean): (T & { forkTree: ForkTree })[] {
  const lineage: string[] = [];
  const depths = rows.map((row) => {
    const key = keyOf(row);
    const parent = parentOf(row);
    const at = !enabled || parent === undefined || parent === key ? -1 : lineage.lastIndexOf(parent);
    lineage.length = at + 1;
    lineage.push(key);
    return Math.min(2, at + 1);
  });
  return withTree(rows, depths);
}

/** Each row with its tree line, from its depth in the list: the lines join the rows given. */
function withTree<T extends InboxRow>(rows: readonly T[], depths: readonly number[]): (T & { forkTree: ForkTree })[] {
  const lines = treeLines(depths);
  return rows.map((row, index) => {
    const depth = depths[index]!;
    const { more, through } = lines[index]!;
    const forkTree: ForkTree = depth === 0 ? {} : { "data-depth": depth, ...more ? { "data-more": "" } : {}, ...through ? { "data-through": "" } : {} };
    return { ...row, forkTree };
  });
}

/** An agent's fold of its helpers (HelpersFace.tsx), on that agent's row. */
export interface ForkFold {
  /** the agent's pin key, which the device keeps open */
  key: string;
  open: boolean;
  /** how many helpers the fold hides */
  hidden: number;
}

/** How the list folds helpers: off, or the agents kept open, each row's state, and the rows that stay in sight. */
export interface ForkFolds<T extends InboxRow> {
  on: boolean;
  open: readonly string[];
  stateOf(row: T): AgentGroup;
  /** a row seen even under a fold: the open one */
  shown(row: T): boolean;
}

/**
 * Settings → Fold helpers under their agent, as the sidebar folds them: an agent's helpers fold into its row, except one that needs the reader and the open one, and the tree joins the rows in sight.
 */
export function forkInboxFolded<T extends InboxRow>(rows: readonly T[], enabled: boolean, folds: ForkFolds<T>): (T & { forkTree: ForkTree; forkFold?: ForkFold })[] {
  const nested = forkInboxNesting(rows, enabled);
  if (!enabled || !folds.on) return nested;
  // each agent's helpers, by its key: the rows under it down to the next agent's row
  const helpersOf = new Map<string, T[]>();
  const folded = new Set<string>();
  let agent: string | undefined;
  for (const row of nested) {
    if (row.forkTree["data-depth"] === undefined) { agent = keyOf(row); continue; }
    if (agent === undefined) continue;
    helpersOf.set(agent, [...helpersOf.get(agent) ?? [], row]);
    if (!folds.open.includes(agent) && !folds.shown(row) && folds.stateOf(row) !== "blocked") folded.add(keyOf(row));
  }
  // a row keeps its depth in the whole family (the open one stays under its agent), and the lines join the rows in sight
  const shown = nested.filter((row) => !folded.has(keyOf(row)));
  return withTree(shown, shown.map((row) => row.forkTree["data-depth"] ?? 0)).map((row) => {
    const key = keyOf(row);
    const helpers = helpersOf.get(key);
    if (helpers === undefined) return row;
    return { ...row, forkFold: { key, open: folds.open.includes(key), hidden: helpers.filter((helper) => folded.has(keyOf(helper))).length } };
  });
}
