import { nestRows } from "../../lib/agentRoster.ts";
import { sidebarPinKey } from "../../lib/sidebarPins.ts";

interface InboxRow {
  machine: { id: string };
  entry: { pane: { pane_id: string; parent_pane_id?: string } };
}

const keyOf = (row: InboxRow) => sidebarPinKey(row.machine.id, row.entry.pane.pane_id);
const parentOf = (row: InboxRow) => row.entry.pane.parent_pane_id === undefined ? undefined : sidebarPinKey(row.machine.id, row.entry.pane.parent_pane_id);

/** The sidebar's family order, applied after inbox filtering so an absent conductor leaves no indent. */
export function forkInboxRows<T extends InboxRow>(rows: readonly T[], enabled: boolean): (T & { forkNested: boolean })[] {
  return forkInboxNesting(enabled ? nestRows(rows, keyOf, parentOf) : rows, enabled);
}

/** Decorate the order actually drawn: a held helper must not connect across an unrelated row. */
export function forkInboxNesting<T extends InboxRow>(rows: readonly T[], enabled: boolean): (T & { forkNested: boolean })[] {
  const lineage: string[] = [];
  return rows.map((row) => {
    const key = keyOf(row);
    const parent = parentOf(row);
    const at = parent === undefined || parent === key ? -1 : lineage.lastIndexOf(parent);
    const forkNested = enabled && at >= 0;
    lineage.length = forkNested ? at + 1 : 0;
    lineage.push(key);
    return { ...row, forkNested };
  });
}
