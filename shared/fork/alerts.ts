/** The fork's settings every browser of a server shares (shared/preferences.ts SHARED_SETTING_KEYS): the server reads them too. */
export const FORK_SHARED_SETTING_KEYS = ["muteSubAgents"] as const;

/**
 * Settings → Fork features → Mute sub-agents: a helper (a pane another agent started, herdr-core's `parent_pane_id`)
 * tells nothing on any channel, push, in-app, chime or notification. The agent that started it tells for it.
 * On unless turned off: a browser sends a shared setting only once it is changed, so the server's document holds
 * none until then, and the server must read that as the browsers' default.
 */
export function helperAlertsMuted(muteSubAgents: unknown, pane: { parent_pane_id?: string } | undefined): boolean {
  return muteSubAgents !== false && Boolean(pane?.parent_pane_id);
}
