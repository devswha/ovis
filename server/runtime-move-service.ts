import { randomUUID } from "node:crypto";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import type { HerdrRuntimeFacts } from "../shared/machines.ts";
import type { MovePlan, MovePlanResponse, MoveStatus } from "../shared/runtime-move.ts";
import { agentLaunch } from "./agent-launch.ts";
import { freeAgentName } from "./agent-name.ts";
import { claudeInputEmpty } from "./claude-input.ts";
import { claudeBoxReads } from "./core/composer.ts";
import { agentStart, HerdrError, herdrRpc, paneGet, paneProcessInfo, paneRename, paneSendText, sessionSnapshot, tabRename } from "./herdr/client.ts";
import { MOVE_LABEL, startHerdrCoreAdapter } from "./herdr-core/adapter.ts";
import { HcConnection, spawnHcConnect } from "./herdr-core/connection.ts";
import { findHc } from "./herdr-core/discovery.ts";
import { hcEnv } from "./herdr-core/runtime.ts";
import { LAYOUT_DOC } from "./herdr-core/snapshot.ts";
import { moveUnavailable, planMove, storeResume, type MoveFacts } from "./runtime-move.ts";
import { journalStatus, runMove, setAsideJournal, settleJournal, type MoveDestination, type MoveSource } from "./runtime-move-run.ts";
import type { SessionHistoryOptions } from "./session-history.ts";

/** How often a waiting move looks whether every pane is done. */
const WAIT_LOOK_MS = 2_000;

export interface MoveServiceOptions {
  stateDir: string;
  port: number;
  serving: () => "herdr" | "herdr-core";
  facts: () => HerdrRuntimeFacts | undefined;
  stores: SessionHistoryOptions;
  holdsPending: (paneId: string) => boolean;
  /** asks the launcher to switch to herdr-core; an error message when it refuses */
  switchRuntime: () => string | null;
}

export interface MoveService {
  read: () => Promise<MovePlanResponse>;
  /** starts the move, or waits for every pane to be done first; an error code when it cannot */
  start: (revision: string) => Promise<"plan_changed" | "unavailable" | "already_moving" | null>;
  cancel: () => void;
  /** a move waits or runs: no other runtime switch meanwhile */
  busy: () => boolean;
  stop: () => void;
}

async function inputEmpty(paneId: string, agent: string): Promise<boolean | null> {
  if (agent !== "claude") return null;
  try { return claudeInputEmpty(...await claudeBoxReads(paneId)); } catch { return false; }
}

/** herdr, through the server's own HERDR_SOCKET (a herdr-mode server's is herdr's). */
export function herdrSource(holdsPending: (paneId: string) => boolean): MoveSource {
  return {
    pane: async (paneId) => {
      try {
        const pane = await paneGet(paneId);
        const info = await paneProcessInfo(paneId).catch(() => undefined);
        const shellInFront = info?.shell_pid == null || info.foreground_process_group_id == null ? null : info.foreground_process_group_id === info.shell_pid;
        return { agent: pane.agent ?? null, status: pane.agent_status, session: pane.agent_session?.value ?? null, shellInFront };
      } catch { return null; }
    },
    holdsPending,
    inputEmpty,
    // one write: no key of anyone else's can land between the command and its Enter
    sendExit: async (paneId, command) => { await paneSendText(paneId, `${command}\r`); },
    runsConversation: async (agent, session) => (await sessionSnapshot()).panes.some((pane) => pane.agent === agent && pane.agent_session?.value === session),
    start: async (paneId, argv) => {
      const started = await agentLaunch(paneId, { kind: argv[0]!, args: argv.slice(1) });
      if (!started.agent_started) throw new Error(started.error.message);
    },
  };
}

/**
 * herdr-core through an adapter of the move's own, on a socket in the state folder: herdr's API as a
 * herdr-core server answers it, while this server still serves herdr. Every call names that socket.
 */
export async function coreDestination(stateDir: string, id: string): Promise<MoveDestination & { close: () => void }> {
  // the core the server reaches once it serves herdr-core: the hc startRuntime finds, run in hcEnv (runtime.ts)
  const env = hcEnv();
  const found = await findHc();
  if (found === null) throw new Error("no herdr-core found");
  const hc = new HcConnection(() => spawnHcConnect(found.bin, env));
  const socket = join(stateDir, `move-${id.slice(0, 8)}.sock`);
  const adapter = await startHerdrCoreAdapter(hc, socket);
  if (process.platform !== "win32") chmodSync(socket, 0o600);
  const rpc = <T>(method: string, params: Record<string, unknown>) => herdrRpc<T>(method, params, socket);
  return {
    appArranged: async () => { const doc = await hc.call("doc.get", { name: LAYOUT_DOC }); return doc.value !== null && doc.value !== undefined; },
    createWorkspace: async (move, cwd, name) => {
      const made = await rpc<{ workspace: { workspace_id: string }; tab: { tab_id: string }; root_pane: { pane_id: string } }>("workspace.create", { ...(cwd ? { cwd } : {}), label: name, focus: false, move });
      return { workspaceId: made.workspace.workspace_id, tabId: made.tab.tab_id, paneId: made.root_pane.pane_id };
    },
    createTab: async (move, workspaceId, cwd, name) => {
      const made = await rpc<{ tab: { tab_id: string }; root_pane: { pane_id: string } }>("tab.create", { workspace_id: workspaceId, ...(cwd ? { cwd } : {}), label: name, focus: false, move });
      return { tabId: made.tab.tab_id, paneId: made.root_pane.pane_id };
    },
    renameTab: (tabId, name) => tabRename(tabId, name, socket),
    split: async (move, paneId, direction, cwd) => (await rpc<{ pane: { pane_id: string } }>("pane.split", { target_pane_id: paneId, direction, focus: false, ...(cwd ? { cwd } : {}), move })).pane.pane_id,
    setRatio: async (tabId, path, ratio) => { await rpc("layout.set_split_ratio", { tab_id: tabId, path, ratio }); },
    renamePane: (paneId, name) => paneRename(paneId, name, socket),
    start: async (paneId, argv) => {
      // a shell started a moment ago may not be up yet (`agent_pane_busy`), as agent-launch.ts waits for it
      for (const deadline = Date.now() + 10_000; ;) {
        const names = (await sessionSnapshot(socket)).agents.map((agent) => agent.name);
        try {
          await agentStart({ name: freeAgentName(argv[0]!, names), kind: argv[0]!, paneId, args: argv.slice(1), timeoutMs: 60_000 }, socket);
          return;
        } catch (error) {
          if (!(error instanceof HerdrError && error.code === "agent_pane_busy" && Date.now() < deadline)) throw error;
          await Bun.sleep(250);
        }
      }
    },
    endMove: async (move) => {
      for (let round = 0; round < 10; round++) {
        const { terminals } = await hc.call("terminal.list", { labels: { [MOVE_LABEL]: move }, all: true });
        const live = terminals.filter((terminal) => terminal.state === "live");
        if (live.length === 0) return;
        await Promise.all(live.map((terminal) => hc.call("terminal.kill", { terminal: terminal.address })));
      }
      throw new Error("terminals of the move are still running on herdr-core");
    },
    close: () => { adapter.stop(); hc.close(); },
  };
}

/**
 * The move of herdr's whole session to herdr-core (runtime-move-run.ts), one at a time per server:
 * started now when every pane is done, else waiting and looking every WAIT_LOOK_MS until it is (or
 * the wait is cancelled). The plan it runs is read afresh at that moment.
 */
export function moveService(options: MoveServiceOptions): MoveService {
  let status: MoveStatus = journalStatus(settleJournal(options.stateDir, options.port, options.serving())) ?? { state: "idle" };
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  /** a start between its first check and its plan: a second one, or a runtime switch, waits for none */
  let starting = false;
  /** each wait's own: a look a cancelled wait left behind does nothing */
  let generation = 0;
  /** what the person was shown when they asked to wait */
  let confirmed: MovePlan | null = null;
  const facts: MoveFacts = {
    findResume: storeResume(options.stores),
    processInfo: async (paneId) => { try { return await paneProcessInfo(paneId); } catch { return undefined; } },
    inputEmpty,
    holdsPending: options.holdsPending,
  };
  const plan = async (): Promise<MovePlan> => planMove(await sessionSnapshot(), facts);
  const go = async (current: MovePlan): Promise<void> => {
    running = true;
    const id = randomUUID();
    let destination: Awaited<ReturnType<typeof coreDestination>> | null = null;
    try {
      status = { state: "moving", step: "ending_agents", done: 0, total: 0 };
      destination = await coreDestination(options.stateDir, id);
      // read again right before the first exit: anything changed while herdr-core was reached stops it
      if ((await plan()).revision !== current.revision) { status = { state: "rolled_back", reason: "plan_changed", left: [] }; return; }
      const journal = await runMove(options.stateDir, options.port, id, current, herdrSource(options.holdsPending), destination, {
        switchRuntime: options.switchRuntime,
        onStep: (step) => { status = step; },
      });
      status = journalStatus(journal) ?? { state: "idle" };
    } catch (error) {
      status = { state: "rolled_back", reason: `failed: ${error instanceof Error ? error.message : String(error)}`, left: [] };
    } finally {
      destination?.close();
      running = false;
    }
  };
  const look = async (wait: number): Promise<void> => {
    timer = null;
    if (wait !== generation || status.state !== "waiting") return;
    try {
      // the PC may have lost herdr-core, or got the Herdr app, while it waited
      if (moveUnavailable(options.serving(), options.facts()) !== null) { status = { state: "idle" }; return; }
      const current = await plan();
      if (wait !== generation || status.state !== "waiting") return;
      if (current.ready) {
        // only what was shown moves: a pane, tab or conversation that is new or changed asks again
        if (confirmed && !sameShape(confirmed, current)) { status = { state: "rolled_back", reason: "plan_changed", left: [] }; return; }
        await go(current);
        return;
      }
    } catch { /* herdr did not answer this look: the next one asks again */ }
    if (wait === generation && status.state === "waiting") timer = setTimeout(() => void look(wait), WAIT_LOOK_MS);
  };
  return {
    read: async () => {
      const reason = moveUnavailable(options.serving(), options.facts());
      if (reason !== null) return { available: false, reason, status };
      return { available: true, plan: await plan(), status };
    },
    start: async (revision) => {
      if (moveUnavailable(options.serving(), options.facts()) !== null) return "unavailable";
      if (starting || running || status.state === "moving" || status.state === "waiting") return "already_moving";
      starting = true;
      // a new start after a move a stopped server left: the person has seen it; it is set aside, never deleted
      if (status.state === "interrupted" || status.state === "rolled_back") { setAsideJournal(options.stateDir, options.port); status = { state: "idle" }; }
      try {
        const current = await plan();
        if (current.revision !== revision) return "plan_changed";
        if (current.ready) { void go(current); return null; }
        confirmed = current;
        const wait = ++generation;
        status = { state: "waiting", revision };
        timer = setTimeout(() => void look(wait), WAIT_LOOK_MS);
        return null;
      } finally {
        starting = false;
      }
    },
    cancel: () => {
      if (status.state === "interrupted") {
        // set aside, never deleted: it names the agents and terminals the person may still want back
        setAsideJournal(options.stateDir, options.port);
        status = { state: "idle" };
        return;
      }
      if (status.state !== "waiting") return;
      generation++;
      if (timer) clearTimeout(timer);
      timer = null;
      confirmed = null;
      status = { state: "idle" };
    },
    busy: () => starting || running || status.state === "waiting" || status.state === "moving",
    stop: () => { if (timer) clearTimeout(timer); timer = null; },
  };
}

/** The same workspaces, tabs, panes and splits, and each pane that was not busy then the same now. */
export function sameShape(shown: MovePlan, now: MovePlan): boolean {
  if (JSON.stringify(shown.workspaces) !== JSON.stringify(now.workspaces)) return false;
  const before = new Map(shown.panes.map((pane) => [pane.pane_id, pane]));
  return now.panes.length === shown.panes.length && now.panes.every((pane) => {
    const was = before.get(pane.pane_id);
    if (!was) return false;
    // a pane that was busy may be anything now that it is done; any other one is as it was shown
    return was.verdict.kind === "busy" || was.verdict.kind === "needs_you" || JSON.stringify(was.verdict) === JSON.stringify(pane.verdict);
  });
}
