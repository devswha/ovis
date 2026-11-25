import type { AgentStatus } from "../shared/protocol.ts";
import type { RecognizedConversation } from "./conversation.ts";

/**
 * Most agents write no session until the first message (Codex its rollout, Claude its session id,
 * OpenCode its session row), so nothing ties such a pane to a transcript and its chat would read as
 * unavailable.
 *
 * Until the agent was seen at rest its status is its startup's: Codex reports `working` while it
 * draws, Claude `blocked` at its folder question.
 */
const SOURCES: Record<string, RecognizedConversation["source"]> = {
  agy: "agy-transcript", claude: "claude-transcript", codex: "codex-transcript", devin: "devin-transcript",
  gjc: "gjc-transcript", grok: "grok-transcript", hermes: "hermes-transcript", omo: "omo-transcript",
  omp: "omp-transcript", opencode: "opencode-transcript", pi: "pi-transcript",
};

export const STARTUP_MS = 30_000;

interface Launch { source: RecognizedConversation["source"]; serial: number; at: number; rested: boolean }

export class LaunchedAgents {
  private readonly panes = new Map<string, Launch>();
  /** every pane this server started an agent in, of any kind, for as long as an agent runs there (`startedPanes`) */
  private readonly started = new Set<string>();
  private serial = 0;

  launched(paneId: string, kind: string, now = Date.now()): void {
    this.started.add(paneId);
    const source = Object.hasOwn(SOURCES, kind) ? SOURCES[kind] : undefined;
    if (source === undefined) { this.panes.delete(paneId); return; }
    this.serial += 1;
    this.panes.set(paneId, { source, serial: this.serial, at: now, rested: false });
  }

  notBegun(paneId: string, status: AgentStatus | undefined, now = Date.now()): { source: RecognizedConversation["source"]; historyId: string } | null {
    const launch = this.panes.get(paneId);
    if (launch === undefined) return null;
    const busy = status === "working" || status === "blocked";
    if (!busy && (status === "idle" || status === "done")) launch.rested = true;
    if (busy && (launch.rested || now - launch.at > STARTUP_MS)) { this.panes.delete(paneId); return null; }
    return { source: launch.source, historyId: `unwritten:launch:${paneId}:${launch.serial}` };
  }

  /**
   * Before the first turn there is no work and no finish: an agent drawing its start screen reads
   * `working` and then `done` (Codex, live 2026-10-14), which showed DONE on a pane nobody had asked
   * anything of. A question it asks (Claude's folder question) is a question all the same.
   */
  settle(paneId: string, status: AgentStatus, now = Date.now()): AgentStatus {
    const unbegun = this.notBegun(paneId, status, now) !== null;
    return unbegun && (status === "working" || status === "done") ? "idle" : status;
  }

  /**
   * Of these panes, the ones whose agent this server started (for the anonymous usage counts). A pane seen with no agent,
   * or no longer listed, is forgotten: an agent started there later by hand is not this server's. Not kept across a
   * restart, so an agent started before it counts as another's.
   */
  startedPanes(panes: readonly { pane_id: string; agent: string | null | undefined }[]): Set<string> {
    const listed = new Set(panes.map((pane) => pane.pane_id));
    for (const paneId of this.started) if (!listed.has(paneId)) this.started.delete(paneId);
    for (const pane of panes) if (!pane.agent) this.started.delete(pane.pane_id);
    return new Set(panes.filter((pane) => this.started.has(pane.pane_id)).map((pane) => pane.pane_id));
  }

  forget(paneId: string): void { this.panes.delete(paneId); }
  clear(): void { this.panes.clear(); this.started.clear(); }
}

export const launchedAgents = new LaunchedAgents();
