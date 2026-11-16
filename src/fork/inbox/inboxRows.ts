import { nestRows, treeLines } from "../../lib/agentRoster.ts";
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
  const lines = treeLines(depths);
  return rows.map((row, index) => {
    const depth = depths[index]!;
    const { more, through } = lines[index]!;
    const forkTree: ForkTree = depth === 0 ? {} : { "data-depth": depth, ...more ? { "data-more": "" } : {}, ...through ? { "data-through": "" } : {} };
    return { ...row, forkTree };
  });
}
