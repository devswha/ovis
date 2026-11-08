/**
 * The status of a Letta Code pane that no report gives one (herdr-core: Letta sends no OSC 7501),
 * read from Letta's own local record of the conversation the pane shows.
 *
 * Letta's transcript is written only when a turn ends, so it cannot say a turn runs. Its local
 * backend appends each message to the conversation's `messages.jsonl` as the turn goes, in the
 * shape gjc's transcript has (letta-code 0.34.44): a user prompt, a tool result or an assistant
 * message that stopped for a tool means work; one that stopped for good is rest, one that errored
 * or was aborted a rest after a failure. A cloud conversation keeps its messages on the server:
 * its status stays unknown. A pane a report gives a status keeps it.
 */
import type { AgentStatus } from "../shared/herdr-api.generated.ts";
import type { HerdrPane } from "../shared/protocol.ts";
import { titleStatus } from "./agent-identity.ts";
import { gjcTurnAfter } from "./gjc-status.ts";
import { lettaMessagesPath, resolveLettaTranscript } from "./letta-store.ts";
import { OmoStatus, type OmoPane, type OmoStatusDeps } from "./omo-status.ts";

/** Letta's local messages share gjc's record shape: one reducer reads both. */
export const lettaTurnAfter = gjcTurnAfter;

/** The conversation a pane shows (letta-store.ts resolveLettaTranscript) and when its letta process started. */
type Bound = { store: string; agent: string; conversation: string; startedAt: number };

export interface LettaDiscovery {
  resolve?: (pane: HerdrPane, panes: readonly HerdrPane[]) => Promise<Bound | null>;
}

/**
 * The Letta panes of a snapshot that no report gives a status, with the messages file of the
 * conversation each shows (null when it cannot be told, or is kept on the server) and when its
 * letta process started, so a turn a resumed conversation left unfinished is not taken for work.
 */
export async function lettaPanes(panes: HerdrPane[], deps: LettaDiscovery = {}): Promise<Map<string, OmoPane>> {
  const resolve = deps.resolve ?? ((pane: HerdrPane, all: readonly HerdrPane[]) => resolveLettaTranscript(pane, all).catch(() => null));
  const found = new Map<string, OmoPane>();
  await Promise.all(panes.filter((pane) => pane.agent === "letta" && pane.agent_status === "unknown").map(async (pane) => {
    const bound = await resolve(pane, panes);
    found.set(pane.pane_id, bound === null ? { path: null, startedAt: null } : { path: lettaMessagesPath(bound.store, bound.agent, bound.conversation), startedAt: bound.startedAt });
  }));
  return found;
}

/**
 * A Letta pane still without a status once its local messages had their say (a cloud conversation,
 * whose messages are on the server, or one not bound): Letta's own title, which carries a spinner
 * while a turn runs. Only where no report gave a status and no messages file is tracked. Returns
 * the panes whose title status changed since `last` saw them, which keeps each pane's last one.
 */
export function lettaTitleStatus(snapshot: { panes: HerdrPane[]; agents?: { pane_id: string; agent_status: AgentStatus }[] }, tracks: (paneId: string) => boolean, last: Map<string, AgentStatus>, newest = true): { paneId: string; status: AgentStatus }[] {
  const { panes } = snapshot;
  // a read older than one already applied shows what the newest said, and changes nothing it keeps
  if (!newest) {
    for (const pane of panes) if (pane.agent === "letta" && pane.agent_status === "unknown" && !tracks(pane.pane_id)) pane.agent_status = last.get(pane.pane_id) ?? pane.agent_status;
    syncAgents(snapshot);
    return [];
  }
  const changed: { paneId: string; status: AgentStatus }[] = [];
  const titled = new Set<string>();
  for (const pane of panes) {
    if (pane.agent !== "letta") continue;
    if (tracks(pane.pane_id)) {
      // the messages file speaks: what it said is where the title goes on from if the file stops
      if (pane.agent_status === "working" || pane.agent_status === "idle" || pane.agent_status === "done") {
        last.set(pane.pane_id, pane.agent_status === "working" ? "working" : "idle");
        titled.add(pane.pane_id);
      }
      continue;
    }
    if (pane.agent_status !== "unknown") continue;
    const status = titleStatus(pane.agent, pane.terminal_title ?? pane.title);
    if (status === null) continue;
    pane.agent_status = status;
    titled.add(pane.pane_id);
    // a pane first found at rest tells nobody; one found at work does, so that its end is a finish
    const before = last.get(pane.pane_id);
    if (before === undefined ? status === "working" : before !== status) changed.push({ paneId: pane.pane_id, status });
    last.set(pane.pane_id, status);
  }
  for (const paneId of [...last.keys()]) if (!titled.has(paneId)) last.delete(paneId);
  syncAgents(snapshot);
  return changed;
}

/** The snapshot's agents list says what its panes say. */
function syncAgents(snapshot: { panes: HerdrPane[]; agents?: { pane_id: string; agent_status: AgentStatus }[] }): void {
  const status = new Map(snapshot.panes.map((pane) => [pane.pane_id, pane.agent_status]));
  for (const agent of snapshot.agents ?? []) agent.agent_status = status.get(agent.pane_id) ?? agent.agent_status;
}

/**
 * The tracker's Letta composition, as GJC's: no aliases, no background counts, an unfinished turn
 * of a process that is gone told as a failed rest, and a status only once a whole turn record was read.
 */
export function createLettaStatus(deps: Omit<OmoStatusDeps, "agent" | "aliases" | "turnAfter" | "ready" | "background" | "staleIsFailure" | "refreshMs">): OmoStatus {
  return new OmoStatus({
    ...deps,
    // a /new or /resume moves the pane to another conversation: found again within a second
    refreshMs: 1000,
    agent: "letta",
    aliases: [],
    turnAfter: lettaTurnAfter,
    ready: ({ turn, available, complete }) => turn.status !== null && available && complete,
    background: () => new Map(),
    staleIsFailure: true,
  });
}
