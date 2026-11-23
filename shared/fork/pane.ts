import type { SessionSnapshot } from "../protocol.ts";

/** Fork metadata; omitted by herdr and older bridges. */
export interface ForkPaneFields {
  agent_role?: "implement" | "review" | "explore";
  /** A terminal labelled `ovis.view=hidden`: only the inbox's Hidden filter lists it. */
  ovis_hidden?: true;
}

/** The workspace that holds every hidden pane (a tab each), so none rolls up into a workspace the reader sees. */
export const HIDDEN_WORKSPACE_ID = "ovis-hidden";

/** The snapshot as every reader but the Hidden filter sees it. `keep` is a hidden pane the reader has open: it stays, with its tab and workspace. */
export function withoutHidden<T extends SessionSnapshot>(snapshot: T, keep: string | null = null): T {
  if (!snapshot.workspaces.some((workspace) => workspace.workspace_id === HIDDEN_WORKSPACE_ID)) return snapshot;
  const gone = new Set(snapshot.panes.filter((pane) => pane.ovis_hidden === true && pane.pane_id !== keep).map((pane) => pane.pane_id));
  const tabs = snapshot.tabs.filter((tab) => tab.workspace_id !== HIDDEN_WORKSPACE_ID || snapshot.panes.some((pane) => pane.tab_id === tab.tab_id && !gone.has(pane.pane_id)));
  const kept = keep === null ? 0 : tabs.filter((tab) => tab.workspace_id === HIDDEN_WORKSPACE_ID).length;
  return {
    ...snapshot,
    panes: snapshot.panes.filter((pane) => !gone.has(pane.pane_id)),
    tabs,
    layouts: snapshot.layouts.filter((layout) => tabs.some((tab) => tab.tab_id === layout.tab_id)),
    agents: snapshot.agents.filter((agent) => !gone.has(agent.pane_id)),
    workspaces: snapshot.workspaces.flatMap((workspace) => workspace.workspace_id !== HIDDEN_WORKSPACE_ID ? [workspace] : kept > 0 ? [{ ...workspace, pane_count: kept, tab_count: kept }] : []),
  };
}

/** The hidden panes alone, with their tabs and workspace: what the Hidden filter lists. */
export function onlyHidden<T extends SessionSnapshot>(snapshot: T): T {
  const tabs = snapshot.tabs.filter((tab) => tab.workspace_id === HIDDEN_WORKSPACE_ID);
  const panes = snapshot.panes.filter((pane) => pane.workspace_id === HIDDEN_WORKSPACE_ID);
  return {
    ...snapshot,
    panes,
    tabs,
    layouts: snapshot.layouts.filter((layout) => tabs.some((tab) => tab.tab_id === layout.tab_id)),
    agents: snapshot.agents.filter((agent) => panes.some((pane) => pane.pane_id === agent.pane_id)),
    workspaces: snapshot.workspaces.filter((workspace) => workspace.workspace_id === HIDDEN_WORKSPACE_ID),
  };
}
