import { nestRows } from "../lib/agentRoster.ts";
import { sidebarPinKey } from "../lib/sidebarPins.ts";

interface InboxRow {
  machine: { id: string };
  pane: { pane_id: string; parent_pane_id?: string };
}

/** The sidebar's family order, applied after inbox filtering so an absent conductor leaves no indent. */
export function forkInboxRows<T extends InboxRow>(rows: readonly T[], enabled: boolean): (T & { forkNested: boolean })[] {
  const keyOf = (row: T) => sidebarPinKey(row.machine.id, row.pane.pane_id);
  const parentOf = (row: T) => row.pane.parent_pane_id === undefined ? undefined : sidebarPinKey(row.machine.id, row.pane.parent_pane_id);
  const keys = new Set(rows.map(keyOf));
  return (enabled ? nestRows(rows, keyOf, parentOf) : rows).map((row) => {
    const parent = parentOf(row);
    return { ...row, forkNested: enabled && parent !== undefined && parent !== keyOf(row) && keys.has(parent) };
  });
}
