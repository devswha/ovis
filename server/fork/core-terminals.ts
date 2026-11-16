import type { ForkPaneFields } from "../../shared/fork/pane.ts";

/** Only the runner's known roles cross the wire; arbitrary labels remain private. */
export function forkPaneFields(labels: Readonly<Record<string, string>> | undefined): ForkPaneFields {
  const role = labels?.["role"];
  return role === "implement" || role === "review" || role === "explore" ? { agent_role: role } : {};
}

/** Job runners and assistants keep running in hc but belong in no Ovis list or alert. */
export function hiddenTerminal(labels: Readonly<Record<string, string>> | undefined): boolean {
  return labels?.["ovis.view"] === "work";
}
