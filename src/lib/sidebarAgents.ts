import type { AgentInfo, HerdrPane, PaneInfo, SessionSnapshot, TabInfo, WorkspaceInfo } from "../../shared/protocol.ts";
import type { AgentRowTitle } from "./settings.ts";
import { customTabLabel, tabLabel } from "./tabName.ts";

export interface SidebarAgent {
  pane: HerdrPane;
  workspace: WorkspaceInfo;
  tab: TabInfo | null;
  agent: AgentInfo | null;
  canonicalAgent: string | null;
  agentLabel: string | null;
}

function nonblank(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

/**
 * The API's live agent roster, joined to the pane that owns its current state. OmO is also
 * recognized by the bridge's process-tree lookup, before herdr necessarily lists it as an
 * agent. A shell is never included just because it reports a working or blocked state.
 * Order follows the server's workspace, tab and pane order, independently of UI folds.
 */
export function sidebarAgents(snapshot: SessionSnapshot | null): SidebarAgent[] {
  if (!snapshot) return [];
  const agentByPane = new Map<string, AgentInfo>();
  for (const agent of snapshot.agents) {
    if (!agentByPane.has(agent.pane_id)) agentByPane.set(agent.pane_id, agent);
  }
  const workspaceById = new Map(snapshot.workspaces.map((workspace) => [workspace.workspace_id, workspace]));
  const workspaceOrder = new Map(snapshot.workspaces.map((workspace, index) => [workspace.workspace_id, index]));
  const tabById = new Map(snapshot.tabs.map((tab) => [tab.tab_id, tab]));
  const tabOrder = new Map(snapshot.tabs.map((tab, index) => [tab.tab_id, index]));
  const seen = new Set<string>();
  const rows: Array<{ row: SidebarAgent; paneOrder: number }> = [];
  snapshot.panes.forEach((pane, paneOrder) => {
    if (seen.has(pane.pane_id)) return;
    seen.add(pane.pane_id);
    const agent = agentByPane.get(pane.pane_id) ?? null;
    const workspace = workspaceById.get(pane.workspace_id);
    if (!workspace || (!agent && !nonblank(pane.agent))) return;
    const canonicalAgent = nonblank(pane.agent) ?? nonblank(agent?.agent);
    const tab = tabById.get(pane.tab_id);
    rows.push({
      paneOrder,
      row: {
        pane,
        workspace,
        tab: tab?.workspace_id === pane.workspace_id ? tab : null,
        agent,
        canonicalAgent,
        agentLabel: nonblank(agent?.display_agent) ?? nonblank(agent?.name)
          ?? nonblank(pane.display_agent) ?? canonicalAgent ?? nonblank(agent?.title),
      },
    });
  });
  return rows.sort((left, right) =>
    workspaceOrder.get(left.row.workspace.workspace_id)! - workspaceOrder.get(right.row.workspace.workspace_id)!
    || (tabOrder.get(left.row.tab?.tab_id ?? "") ?? snapshot.tabs.length) - (tabOrder.get(right.row.tab?.tab_id ?? "") ?? snapshot.tabs.length)
    || left.paneOrder - right.paneOrder,
  ).map(({ row }) => row);
}

/**
 * The mark a row draws for the pane it opens: that pane's agent, never another pane's.
 * A shell (no entry) has none; an agent herdr names without a kind falls back to its label.
 */
export function paneMark(entry: SidebarAgent | undefined): string | null {
  if (!entry) return null;
  return entry.canonicalAgent ?? entry.agentLabel ?? "";
}

/** Every agent a workspace runs, each name once, in the roster's order. */
export function workspaceAgentLabels(agents: readonly SidebarAgent[]): Map<string, string[]> {
  const byWorkspace = new Map<string, string[]>();
  for (const { workspace, agentLabel, canonicalAgent } of agents) {
    const label = agentLabel ?? canonicalAgent;
    if (!label) continue;
    const labels = byWorkspace.get(workspace.workspace_id) ?? [];
    if (!labels.includes(label)) labels.push(label);
    byWorkspace.set(workspace.workspace_id, labels);
  }
  return byWorkspace;
}

/**
 * A tab's place in its workspace's row, which herdr names it by until it is renamed. Its place, not
 * its number: herdr relabels the tab that moves up when the one before it closes, and keeps its number.
 */
function tabPlace(tab: TabInfo, workspaceTabs: readonly TabInfo[]): number {
  return workspaceTabs.findIndex((candidate) => candidate.tab_id === tab.tab_id) + 1 || tab.number;
}

/** The tab an agent row names, as herdr's agents panel does: only when its workspace has two or more tabs or the tab was renamed. */
export function agentTabName(tab: TabInfo | null | undefined, workspaceTabs: readonly TabInfo[], t: Parameters<typeof tabLabel>[1]): string | null {
  if (!tab) return null;
  const place = tabPlace(tab, workspaceTabs);
  return workspaceTabs.length > 1 || customTabLabel(tab, place) ? tabLabel(tab, t, place) : null;
}

/**
 * Settings → Agent row title → Tab name: the name someone gave an agent's tab titles its row and its
 * pane's header, as herdr's own agent rows lead with the tab (#2014). null under Agent, and for a
 * tab herdr still names by its place, which keeps the row's own title.
 */
export function tabRowTitle(setting: AgentRowTitle, tab: TabInfo | null | undefined, workspaceTabs: readonly TabInfo[]): string | null {
  return setting === "tab" && tab ? customTabLabel(tab, tabPlace(tab, workspaceTabs)) : null;
}

/** whether herdr reports an agent in this pane: only such a pane has a row (sidebarAgents), never a shell */
function hasAgent(snapshot: SessionSnapshot, pane: PaneInfo): boolean {
  return nonblank(pane.agent) !== null || snapshot.agents.some((agent) => agent.pane_id === pane.pane_id);
}

/**
 * The same for an agent's pane, its row and its header alike. A helper (an agent another agent started)
 * keeps its own title: its agent's row already names their tab, and a helper drawn under it has no
 * second line to move its own title to.
 */
export function paneTabRowTitle(setting: AgentRowTitle, snapshot: SessionSnapshot | null, pane: PaneInfo & Pick<HerdrPane, "parent_pane_id">): string | null {
  if (setting !== "tab" || !snapshot || !hasAgent(snapshot, pane)) return null;
  const parent = pane.parent_pane_id === undefined ? undefined : snapshot.panes.find((candidate) => candidate.pane_id === pane.parent_pane_id);
  if (parent !== undefined && parent.pane_id !== pane.pane_id && hasAgent(snapshot, parent)) return null;
  const tabs = snapshot.tabs.filter((tab) => tab.workspace_id === pane.workspace_id);
  return tabRowTitle(setting, tabs.find((tab) => tab.tab_id === pane.tab_id), tabs);
}

export interface AgentContextParts {
  agentLabel: string | null;
  /** the row's first line; an agent named like it is not said twice */
  title: string;
  /** what leads the second line once a tab titles the row (tabRowTitle): the row's own title, which the kind does not repeat either */
  lead?: string | null;
  /** the agent the row's mark draws, null for the generic mark: a kind the mark already says is not written again */
  markAgent: string | null;
  /** null with a single PC: herdr does not name a lone machine either */
  machineName: string | null;
  workspaceLabel: string;
  tabName: string | null;
}

/** An agent row's second line: who it is, then where it runs, without repeating a word the row already says. */
export function agentContext({ agentLabel, title, lead, markAgent, machineName, workspaceLabel, tabName }: AgentContextParts): string[] {
  const agent = nonblank(agentLabel);
  const tab = nonblank(tabName);
  return [
    agent && agent !== title.trim() && agent !== nonblank(lead) && agent.toLowerCase() !== markAgent?.toLowerCase() ? agent : null,
    nonblank(machineName),
    workspaceLabel,
    tab && tab !== workspaceLabel ? tab : null,
  ].filter((part): part is string => Boolean(part));
}
