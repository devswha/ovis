/**
 * The Inbox is a projection of the existing all-PC Agents roster: only connected PCs and agent
 * panes whose authoritative shown state is `blocked`. It never guesses from transcript text or
 * cached offline snapshots. PC order stays the machine roster's; within each PC, the existing
 * Activity order keeps the most recently changed blocked pane first.
 */
import type { Machine } from "../../shared/machines.ts";
import type { AgentStatus, HerdrPane } from "../../shared/protocol.ts";
import { activityOrder } from "./sidebarOrder.ts";
import { sidebarAgents, type SidebarAgent } from "./sidebarAgents.ts";
import { knownStatus } from "./status.ts";

export interface AgentInboxSource {
  seqs(machineId: string): ReadonlyMap<string, number>;
  status(machineId: string, pane: Pick<HerdrPane, "pane_id" | "agent_status" | "background_wait" | "finish_id">): AgentStatus | undefined;
}

export interface AgentInboxItem {
  machine: Machine;
  entry: SidebarAgent;
}

export interface AgentInboxState {
  items: AgentInboxItem[];
  loading: boolean;
  offline: number;
}

export function agentInbox(machines: readonly Machine[], source: AgentInboxSource, loaded = true): AgentInboxState {
  const items: AgentInboxItem[] = [];
  let loading = !loaded || machines.length === 0;
  let offline = 0;

  for (const machine of machines) {
    if (machine.state !== "connected") {
      offline += 1;
      continue;
    }
    if (machine.snapshot === null) {
      loading = true;
      continue;
    }
    const ordered = activityOrder(sidebarAgents(machine.snapshot), (entry) => entry.pane, source.seqs(machine.id));
    for (const entry of ordered) {
      if (knownStatus(source.status(machine.id, entry.pane)) === "blocked") items.push({ machine, entry });
    }
  }

  return { items, loading, offline };
}
