/** The fork's settings every browser of a server shares (shared/preferences.ts SHARED_SETTING_KEYS): the server reads them too. */
export const FORK_SHARED_SETTING_KEYS = ["muteSubAgents"] as const;

/**
 * Settings → Fork features → Mute sub-agents: a helper (a pane another agent started, herdr-core's `parent_pane_id`)
 * tells nothing on any channel, push, in-app, chime or notification. The agent that started it tells for it.
 */
export function helperAlertsMuted(muteSubAgents: unknown, pane: { parent_pane_id?: string } | undefined): boolean {
  return muteSubAgents === true && Boolean(pane?.parent_pane_id);
}
