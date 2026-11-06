import type { PaneInfo, PaneLayoutSnapshot, PaneProcessInfo, SessionSnapshot } from "../shared/herdr-api.generated.ts";
import type { HerdrRuntimeFacts } from "../shared/machines.ts";
import type { MoveNode, MovePane, MovePlan, MoveUnavailable, MoveVerdict, MoveWorkspace } from "../shared/runtime-move.ts";
import type { SessionHistoryAgent } from "../shared/session-history.ts";
import { isSessionHistoryAgent, listSessions, type SessionHistoryOptions } from "./session-history.ts";

export const RUNTIME_MOVE_PATH = "/api/runtime/move";

/**
 * The command each agent ends itself with, as its own built-in command list names it
 * (server/skills/<agent>.ts). An agent not listed is ended by the person (`needs_you`).
 */
export const EXIT_COMMANDS: Readonly<Record<string, string>> = {
  claude: "/exit", codex: "/quit", opencode: "/exit", pi: "/quit", omo: "/quit", omp: "/exit",
  gjc: "/exit", cmd: "/quit", hermes: "/quit", grok: "/exit", agy: "/exit",
};

/** What the plan reads of this PC beside herdr's snapshot; each is answered fresh. */
export interface MoveFacts {
  /** the session's resume argv when this PC's stores list it in the folder, else null */
  findResume: (agent: SessionHistoryAgent, sessionId: string, cwd: string) => Promise<string[] | null>;
  /** what runs in the pane's terminal; undefined when herdr could not tell */
  processInfo: (paneId: string) => Promise<PaneProcessInfo | undefined>;
  /** true: the agent's input line reads empty; false: something is typed there; null: Ovis cannot read it for this agent */
  inputEmpty: (paneId: string, agent: string) => Promise<boolean | null>;
  /** a message sent through Ovis still waits for the pane */
  holdsPending: (paneId: string) => boolean;
}

type Split = PaneLayoutSnapshot["splits"][number];
type LayoutPane = PaneLayoutSnapshot["panes"][number];

const startOf = (rect: LayoutPane["rect"], direction: "right" | "down"): number => direction === "right" ? rect.x : rect.y;
const endOf = (rect: LayoutPane["rect"], direction: "right" | "down"): number => direction === "right" ? rect.x + rect.width : rect.y + rect.height;

/**
 * herdr names each split after its place in the tab's tree (`split_<n>_root`, `split_<n>_0110`: 0 the
 * first side, 1 the second), so the tree comes back from those paths and the panes' rects.
 */
function build(panes: readonly LayoutPane[], rect: LayoutPane["rect"], splits: ReadonlyMap<string, Split>, path: string): MoveNode | null {
  if (panes.length === 1) return { pane: panes[0]!.pane_id };
  const split = splits.get(path);
  const direction = split?.direction === "right" ? "right" : split?.direction === "down" ? "down" : null;
  if (!split || direction === null) return null;
  const line = startOf(rect, direction) + Math.round((direction === "right" ? rect.width : rect.height) * split.ratio);
  const firstPanes = panes.filter((pane) => endOf(pane.rect, direction) <= line);
  const secondPanes = panes.filter((pane) => startOf(pane.rect, direction) >= line);
  if (firstPanes.length === 0 || secondPanes.length === 0 || firstPanes.length + secondPanes.length !== panes.length) return null;
  const firstRect = direction === "right" ? { ...rect, width: line - rect.x } : { ...rect, height: line - rect.y };
  const secondRect = direction === "right" ? { ...rect, x: line, width: rect.x + rect.width - line } : { ...rect, y: line, height: rect.y + rect.height - line };
  const first = build(firstPanes, firstRect, splits, `${path}0`);
  const second = build(secondPanes, secondRect, splits, `${path}1`);
  return first && second ? { split: direction, ratio: split.ratio, first, second } : null;
}

/** The tab's split tree; panes side by side, in herdr's order, when its splits do not describe one. */
export function tabTree(layout: PaneLayoutSnapshot | undefined, paneIds: readonly string[]): MoveNode {
  const splits = new Map<string, Split>();
  for (const split of layout?.splits ?? []) {
    const path = /^split_\d+_(root|[01]+)$/.exec(split.id)?.[1];
    if (path !== undefined) splits.set(path === "root" ? "" : path, split);
  }
  const panes = layout?.panes.filter((pane) => paneIds.includes(pane.pane_id)) ?? [];
  const built = layout && panes.length === paneIds.length && panes.length > 0 ? build(panes, layout.area, splits, "") : null;
  if (built) return built;
  const [first, ...rest] = paneIds;
  return rest.reduce<MoveNode>((tree, pane, index) => ({ split: "right", ratio: (index + 1) / (index + 2), first: tree, second: { pane } }), { pane: first! });
}

/** The command a shell runs in front, or null when the shell itself is in front; unknown counts as running. */
function commandInFront(info: PaneProcessInfo | undefined): string | null {
  if (!info || info.shell_pid == null || info.foreground_process_group_id == null) return "?";
  if (info.foreground_process_group_id === info.shell_pid) return null;
  const front = info.foreground_processes?.find((entry) => entry.pid !== info.shell_pid);
  return front?.name ?? "?";
}

async function verdictOf(pane: PaneInfo, facts: MoveFacts, claimed: Set<string>): Promise<MoveVerdict> {
  const agent = pane.agent;
  if (!agent) {
    const command = commandInFront(await facts.processInfo(pane.pane_id));
    return command === null ? { kind: "shell" } : { kind: "busy", reason: "command_running", agent: null, command };
  }
  if (pane.agent_status === "blocked") return { kind: "busy", reason: "agent_waiting", agent, command: null };
  // unknown is not idle: only an agent herdr says is done with its turn is ended
  if (pane.agent_status !== "idle" && pane.agent_status !== "done") return { kind: "busy", reason: "agent_working", agent, command: null };
  if (facts.holdsPending(pane.pane_id)) return { kind: "busy", reason: "agent_working", agent, command: null };
  if (!Object.hasOwn(EXIT_COMMANDS, agent)) return { kind: "needs_you", agent };
  const empty = await facts.inputEmpty(pane.pane_id, agent);
  // something typed and not sent is the person's: never ended over it
  if (empty === false) return { kind: "needs_you", agent };
  const input_unchecked = empty === null;
  const session = pane.agent_session;
  if (session && session.kind === "id" && session.agent === agent && isSessionHistoryAgent(agent) && pane.cwd) {
    const key = `${agent}\0${session.value}`;
    const argv = claimed.has(key) ? null : await facts.findResume(agent, session.value, pane.cwd);
    // one conversation reopens in one pane: a second pane naming it starts new
    if (argv) { claimed.add(key); return { kind: "resume", agent, session_id: session.value, argv, input_unchecked }; }
  }
  return { kind: "fresh", agent, input_unchecked };
}

/**
 * What a move of herdr's whole session to herdr-core does with each pane, read from one snapshot.
 * Nothing here stops or starts anything; a plan with any `busy` or `needs_you` pane is not `ready`.
 */
export async function planMove(snapshot: SessionSnapshot, facts: MoveFacts): Promise<MovePlan> {
  const claimed = new Set<string>();
  const panes: MovePane[] = [];
  // one at a time: a conversation is claimed by the first pane, in herdr's order
  for (const pane of snapshot.panes) panes.push({ pane_id: pane.pane_id, cwd: pane.cwd ?? null, name: pane.label ?? null, verdict: await verdictOf(pane, facts, claimed) });
  const workspaces: MoveWorkspace[] = snapshot.workspaces.map((workspace) => ({
    workspace_id: workspace.workspace_id,
    name: workspace.label,
    tabs: snapshot.tabs
      .filter((tab) => tab.workspace_id === workspace.workspace_id)
      .sort((a, b) => a.number - b.number)
      .map((tab) => ({
        tab_id: tab.tab_id,
        name: tab.label,
        root: tabTree(snapshot.layouts.find((layout) => layout.tab_id === tab.tab_id), snapshot.panes.filter((pane) => pane.tab_id === tab.tab_id).map((pane) => pane.pane_id)),
      })),
  }));
  const ready = panes.every((pane) => pane.verdict.kind !== "busy" && pane.verdict.kind !== "needs_you");
  const shown = { workspaces, panes, ready };
  return { ...shown, revision: Bun.hash(JSON.stringify(shown)).toString(36) };
}

/** Why this server offers no move to herdr-core, or null when it does. */
export function moveUnavailable(serving: "herdr" | "herdr-core", facts: HerdrRuntimeFacts | undefined): MoveUnavailable | null {
  if (serving !== "herdr") return "not_herdr";
  if (!facts || facts.locked !== null) return "runtime_locked";
  if (facts.switch_to !== "herdr-core") return "no_herdr_core";
  // the Herdr app arranges a core it runs in a document of its own, which Ovis never writes
  if (facts.app_installed) return "herdr_app";
  return null;
}

/** The session's resume argv when this PC's stores list it in the folder, as Earlier sessions lists it. */
export function storeResume(stores: SessionHistoryOptions): MoveFacts["findResume"] {
  return async (agent, sessionId, cwd) => {
    try {
      const rows = await listSessions(agent, cwd, stores);
      return rows.find((row) => row.id === sessionId)?.resume?.argv ?? null;
    } catch {
      return null;
    }
  };
}
