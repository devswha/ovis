import type { ForkPaneFields } from "./pane.ts";

/** Only the runner's known roles cross the wire; arbitrary labels remain private. */
export function forkPaneFields(labels: Readonly<Record<string, string>> | undefined): ForkPaneFields {
  const role = labels?.["role"];
  return {
    ...(role === "implement" || role === "review" || role === "explore" ? { agent_role: role } : {}),
    ...(hiddenTerminal(labels) ? { ovis_hidden: true as const } : {}),
  };
}

/** `ovis.view=work`: job runners and assistants keep running in hc but belong in no Ovis list, count or alert, not even the Hidden filter. */
export function backgroundTerminal(labels: Readonly<Record<string, string>> | undefined): boolean {
  return labels?.["ovis.view"] === "work";
}

/** `ovis.view=hidden`: an agent that alerts like any other but is listed only under the inbox's Hidden filter (`ovis_hidden`, shared/fork/pane.ts). */
export function hiddenTerminal(labels: Readonly<Record<string, string>> | undefined): boolean {
  return labels?.["ovis.view"] === "hidden";
}
