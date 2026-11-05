/**
 * What the header says beyond the selected pane, on the same line: where its tab sits among its
 * workspace's tabs (n/m), how many sessions on the PC run, wait for an answer, or finished unseen,
 * and which waiting one a tap on that count opens next. The counts read each pane as the sidebar
 * draws it (lib/sidebarActivity.tsx): a finish looked at is ready again, not done.
 */
import type { AgentStatus, PaneInfo, SessionSnapshot } from "../../shared/protocol.ts";
import { rosterPanes } from "./dagPane.ts";
import { knownStatus } from "./status.ts";

type Roster = Pick<SessionSnapshot, "tabs" | "panes">;

export interface TabPosition {
  /** 1-based, in the tab strip's order */
  index: number;
  count: number;
}

/** The selected pane's tab among its workspace's tabs that have a pane to show; null with one tab, which says nothing. */
export function tabPosition(roster: Roster, selectedPaneId: string | null): TabPosition | null {
  const selected = roster.panes.find((pane) => pane.pane_id === selectedPaneId);
  if (!selected) return null;
  const panes = rosterPanes(roster.panes.filter((pane) => pane.workspace_id === selected.workspace_id), selectedPaneId);
  const tabs = roster.tabs.filter((tab) => tab.workspace_id === selected.workspace_id && panes.some((pane) => pane.tab_id === tab.tab_id));
  const index = tabs.findIndex((tab) => tab.tab_id === selected.tab_id);
  return tabs.length < 2 || index < 0 ? null : { index: index + 1, count: tabs.length };
}

export interface SessionCounts {
  working: number;
  /** waiting for the person: an approval, a question */
  waiting: number;
  /** finished and not looked at yet */
  done: number;
}

/** A turn that waits on its own background work is still running: it counts as working. */
export function sessionCounts<T extends PaneInfo>(panes: readonly T[], status: (pane: T) => AgentStatus | undefined): SessionCounts {
  const counts: SessionCounts = { working: 0, waiting: 0, done: 0 };
  for (const pane of rosterPanes(panes)) {
    const value = knownStatus(status(pane));
    if (value === "working" || value === "waiting") counts.working += 1;
    else if (value === "blocked") counts.waiting += 1;
    else if (value === "done") counts.done += 1;
  }
  return counts;
}

/** The waiting pane after the selected one in the roster's order, wrapping around; never the selected one itself. */
export function nextWaitingPane<T extends PaneInfo>(panes: readonly T[], status: (pane: T) => AgentStatus | undefined, selectedPaneId: string | null): string | null {
  const shown = rosterPanes(panes, selectedPaneId);
  const at = shown.findIndex((pane) => pane.pane_id === selectedPaneId);
  for (let step = 1; step <= shown.length; step += 1) {
    const pane = shown[(at + step + shown.length) % shown.length]!;
    if (pane.pane_id !== selectedPaneId && knownStatus(status(pane)) === "blocked") return pane.pane_id;
  }
  return null;
}
