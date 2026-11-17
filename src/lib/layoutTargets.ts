import { HC_OTHER_WORKSPACE_ID } from "../../shared/machines.ts";
import type { HerdrPane, HerdrWorkspace } from "../../shared/protocol.ts";

export const renamesWorkspace = (workspaceId: string): boolean => workspaceId !== HC_OTHER_WORKSPACE_ID;

export const moveDestinations = (workspaces: readonly HerdrWorkspace[], pane: HerdrPane | undefined, from: string): HerdrWorkspace[] =>
  workspaces.filter((entry) => entry.workspace_id !== from && !(entry.workspace_id === HC_OTHER_WORKSPACE_ID && pane?.parent_pane_id !== undefined));
