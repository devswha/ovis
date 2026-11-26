import type { AgentStatus, PaneInfo } from "../../../shared/protocol.ts";
import { agentGroup } from "../../lib/agentRoster.ts";
import { useSettings } from "../../lib/settings.ts";
import { useSidebarFilter } from "../../lib/sidebarFilterContext.ts";
import type { SidebarAgent } from "../../lib/sidebarAgents.ts";
import { ForkFoldCount, ForkHelpersFace } from "../inbox/HelpersFace.tsx";
import { useForkOpenHelpers } from "../inbox/HelpersFold.tsx";
import { forkTreeOn, forkTreeRows, forkTreeTab, type ForkTreeMarks } from "./treeRows.ts";

/** A workspace tree's agent row (Sidebar.tsx), with what the fork marks on it. */
export type ForkTreeAgent = SidebarAgent & ForkTreeMarks;

/**
 * Settings → Fold helpers under their agent with Agents under workspaces: each workspace's agents list their helpers
 * under them and fold them into the agent's picture, sharing which agents are open with the Agents list and the
 * agent inbox. With either setting off, the rows are upstream's.
 */
export function useForkTree(machineId: string, selectedPaneId: string | null, statusOf: (pane: PaneInfo) => AgentStatus | undefined) {
  const { settings } = useSettings();
  const { filter } = useSidebarFilter();
  const helpers = useForkOpenHelpers();
  const on = forkTreeOn(settings);
  return {
    rows: <T extends SidebarAgent>(entries: readonly T[]): readonly (T & ForkTreeMarks)[] => on ? forkTreeRows(machineId, entries, {
      fold: !filter.active, open: helpers.open, selectedPaneId, blocked: (entry) => agentGroup(statusOf(entry.pane)) === "blocked",
    }) : entries,
    tab: (tabName: string | null): string | null => forkTreeTab(on, tabName),
    face: (entry: ForkTreeAgent, title: string) => entry.forkFold && <ForkHelpersFace open={entry.forkFold.open} agentTitle={title} onToggle={() => helpers.toggle(entry.forkFold!.key)} />,
    count: (entry: ForkTreeAgent) => <ForkFoldCount count={entry.forkFold?.hidden ?? 0} />,
  };
}
