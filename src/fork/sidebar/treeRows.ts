import { forkFamiliesFolded, type ForkFold, type ForkTree } from "../inbox/inboxRows.ts";

/** What the fork adds to a workspace tree's agent row: its place in its agent's family, and an agent's fold. */
export interface ForkTreeMarks {
  forkTree?: ForkTree;
  forkFold?: ForkFold;
}

/**
 * Settings → Fold helpers under their agent together with Agents under workspaces: the workspace tree then lists and
 * folds each agent's helpers itself, so the Agents list below it would only repeat it (MachineSidebar.tsx).
 */
export function forkTreeOn(settings: { foldHelpers: boolean; sidebarAgentTree: boolean }): boolean {
  return settings.foldHelpers && settings.sidebarAgentTree;
}

/** A workspace's agents with their helpers under them, folded as the Agents list and the agent inbox fold them. */
export function forkTreeRows<T extends { pane: { pane_id: string; parent_pane_id?: string } }>(machineId: string, entries: readonly T[], folds: {
  /** off under a filter: what it found stays in sight */
  fold: boolean;
  /** the agents kept open on this device (AgentSidebar.tsx's HELPERS_OPEN_KEY) */
  open: readonly string[];
  blocked(entry: T): boolean;
  selectedPaneId: string | null;
}): (T & ForkTreeMarks)[] {
  const rows = entries.map((entry) => ({ machine: { id: machineId }, entry }));
  return forkFamiliesFolded(rows, {
    on: folds.fold, open: folds.open,
    stateOf: (row) => folds.blocked(row.entry) ? "blocked" : "idle",
    shown: (row) => row.entry.pane.pane_id === folds.selectedPaneId,
  }).map(({ entry, forkTree, forkFold }) => ({ ...entry, forkTree, forkFold }));
}

/** A tree agent row's tab name: its workspace row already places it, so the row says only its agent while the folds are on. */
export function forkTreeTab(on: boolean, tabName: string | null): string | null {
  return on ? null : tabName;
}
