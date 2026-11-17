import type { PaneInfo } from "../../shared/protocol.ts";
import { knownStatus } from "./status.ts";

export function isDagViewerPane(pane: PaneInfo): boolean {
  if (pane.agent) return false;
  const status = knownStatus(pane.agent_status);
  if (status === "working" || status === "blocked") return false;
  return (typeof pane.label === "string" && pane.label.startsWith("DAG · "))
    || pane.terminal_title === "OmO DAG" || pane.terminal_title_stripped === "OmO DAG";
}

export function rosterPanes<T extends PaneInfo>(panes: readonly T[], keep?: string | null): T[] {
  return panes.filter((pane) => pane.pane_id === keep || !isDagViewerPane(pane)
    || !panes.some((other) => other.tab_id === pane.tab_id && !isDagViewerPane(other)));
}
