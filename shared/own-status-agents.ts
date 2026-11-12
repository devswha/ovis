/**
 * The agents whose state Ovis reads from their own session files in place of herdr's: the identities
 * of server/omo-status.ts's trackers (OmO, and GJC and Letta built on it). herdr goes on calling such
 * a pane what it took it for, so its `state_change_seq` stands still while the agent works, waits and
 * rests, and nothing that goes by that counter may trust it for them (src/lib/agentStateSince.ts).
 * A tracker's identity is one of these by type, so a new tracker is named here first.
 *
 * Its own file: the browser imports the value, and shared/protocol.ts reads `process.env` as it loads.
 */
export const OWN_STATUS_AGENTS = ["omo", "gjc", "letta"] as const;
export type OwnStatusAgent = (typeof OWN_STATUS_AGENTS)[number];
