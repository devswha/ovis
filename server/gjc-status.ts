/**
 * The status of a GJC pane, read from gjc's own transcript.
 *
 * herdr follows the pane's provider child, not the gjc parent: a turn gjc finished keeps
 * reading `working` for what the child does, and the sidebar holds RUN with no done alert.
 * The transcript the pane's gjc extension reports (gjc-runtime.ts finds exactly that file, never a
 * newest file by cwd) tells the parent turn instead: a user prompt, a tool result or an
 * assistant message that stopped for a tool means work; one that stopped for good (`stop`,
 * `length`) is rest, and one that errored or was aborted is rest after a failure — READY, not
 * DONE (#687's rule holds here too). gjc wakes the agent with a custom message when work it
 * asked for lands elsewhere — a background job's `async-result`, a monitor's
 * `task-notification`, a timer's `cron-fire` — displayed or not: that begins a new parent
 * turn. Everything else gjc writes (custom bookkeeping, model notices) is no turn's business.
 * A tool call named `ask` holds a question for the user open until its result arrives, an
 * error result included: while one is open the pane reads INPUT, whatever the turn does.
 *
 * The status replaces herdr's for the pane only once a turn record was actually read and the
 * read is current: an empty, missing, unreadable or half-written transcript proves nothing,
 * so herdr's `working` stands rather than a rest no one saw. The machinery is omo-status.ts's,
 * composed with the `gjc` identity and this file's reducer. gjc keeps no background-task records
 * outside the transcript, so its background work is read there too (`gjcJobsAfter`). A turn the process holding the session now could not have run (it started
 * after the record was written) is another process's unfinished work: an interruption, told as
 * a failed rest, never a finish.
 */
import type { HerdrPane, SessionSnapshot } from "../shared/protocol.ts";
import { paneProcessInfo } from "./herdr/client.ts";
import { gjcPidUnderShell, gjcTranscriptForPane, isGjcProcess, type GjcProcess } from "./gjc-runtime.ts";
import type { OmoAsks } from "./omo-ask.ts";
import { processStartedAtAsync } from "./process-start.ts";
import type { OmoDetachedCell } from "./omo-detached.ts";
import { OmoStatus, type OmoLine, type OmoPane, type OmoStatusDeps, type OmoTurn } from "./omo-status.ts";

/** the custom messages gjc wakes the parent turn with, displayed or not */
const WAKE_TYPES = new Set(["async-result", "task-notification", "cron-fire"]);

interface GjcEntry {
  type?: unknown;
  customType?: unknown;
  timestamp?: unknown;
  details?: unknown;
  message?: { role?: unknown; stopReason?: unknown; content?: unknown; toolCallId?: unknown; toolName?: unknown; details?: unknown };
}

/** the states gjc's `job` and `subagent` tools report a job in once it no longer runs (a paused one waits on nobody) */
const ENDED = new Set(["completed", "failed", "cancelled", "paused", "not_found", "already_completed", "already_cancelled"]);
const record = (value: unknown): Record<string, unknown> | null => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
const list = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.flatMap((item) => { const found = record(item); return found ? [found] : []; }) : [];
const text = (content: unknown): string => list(content).flatMap((part) => part["type"] === "text" && typeof part["text"] === "string" ? [part["text"]] : []).join("\n");

/**
 * The background jobs a gjc session started and has not heard the end of: a turn that ends while
 * one runs waits on it (background-wait.ts), and its end wakes the session. A job starts with a
 * `task` or `bash` result whose `details.async.state` is `running`: a bash job is that result's
 * `jobId`, a task batch lists each job on a line of its own, ``- `<id>` (job `<id>`) — <description>``
 * (its details name only the first; the description is the model's, and names no job). It ends
 * with the `async-result` that delivers it, or a `job` or `subagent` result that reports it no
 * longer running, paused included (an await or a cancel acknowledges it, and no delivery follows).
 */
export function gjcJobsAfter(open: readonly OmoDetachedCell[], entry: GjcEntry): readonly OmoDetachedCell[] {
  const ended = (ids: string[]): readonly OmoDetachedCell[] => {
    const gone = new Set(ids);
    return gone.size > 0 && open.some((job) => gone.has(job.id)) ? open.filter((job) => !gone.has(job.id)) : open;
  };
  if (entry.type === "custom_message") {
    if (entry.customType !== "async-result") return open;
    return ended(list(record(entry.details)?.["jobs"]).flatMap((job) => typeof job["jobId"] === "string" ? [job["jobId"]] : []));
  }
  const message = entry.message;
  if (entry.type !== "message" || message?.role !== "toolResult") return open;
  const details = record(message.details);
  if (message.toolName === "job") {
    return ended([
      ...list(details?.["jobs"]).flatMap((job) => typeof job["id"] === "string" && typeof job["status"] === "string" && ENDED.has(job["status"]) ? [job["id"]] : []),
      ...list(details?.["cancelled"]).flatMap((job) => typeof job["id"] === "string" ? [job["id"]] : []),
    ]);
  }
  if (message.toolName === "subagent") {
    return ended(list(details?.["subagents"]).flatMap((agent) => typeof agent["jobId"] === "string" && typeof agent["status"] === "string" && ENDED.has(agent["status"]) ? [agent["jobId"]] : []));
  }
  const async = record(details?.["async"]);
  if (async?.["state"] !== "running" || typeof async["jobId"] !== "string") return open;
  const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
  if (!Number.isFinite(at)) return open;
  const ids = message.toolName === "task" ? [...text(message.content).matchAll(/^- `[^`]*` \(job `([^`]+)`\)/gm)].map((match) => match[1]!)
    : message.toolName === "bash" ? [async["jobId"]] : [];
  const started = ids.filter((id, i) => ids.indexOf(id) === i && !open.some((job) => job.id === id));
  return started.length > 0 ? [...open, ...started.map((id) => ({ id, at }))] : open;
}

function gjcAsksAfter(open: OmoAsks, entry: GjcEntry): OmoAsks {
  if (entry.type !== "message") return open;
  const message = entry.message;
  if (message?.role === "assistant" && message.stopReason === "toolUse") {
    const calls = (Array.isArray(message.content) ? message.content as Record<string, unknown>[] : [])
      .filter((part) => part?.["type"] === "toolCall" && part["name"] === "ask" && typeof part["id"] === "string" && part["id"] !== "" && part["incomplete"] !== true)
      .map((part) => ({ id: part["id"] as string, wait: true, args: part["arguments"] }));
    const ids = new Set(calls.map((call) => call.id));
    return calls.length > 0 ? [...open.filter((call) => !ids.has(call.id)), ...calls] : open;
  }
  if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
    return open.filter((call) => call.id !== message.toolCallId);
  }
  return open;
}

/**
 * One transcript record applied to the parent turn so far, from a whole line or a projected
 * record's complete JSON (never its text: a record too long to hold says nothing).
 */
export function gjcTurnAfter(turn: OmoTurn, line: OmoLine): OmoTurn {
  const text = "text" in line ? line.text : line.record;
  if (text === undefined) return turn;
  let entry: GjcEntry;
  try { entry = JSON.parse(text); } catch { return turn; }
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return turn;
  const parsed = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
  const at = Number.isFinite(parsed) ? parsed : turn.at;
  const asks = gjcAsksAfter(turn.asks, entry);
  const jobs = gjcJobsAfter(turn.detached ?? [], entry);
  const detached = jobs.length > 0 || turn.detached !== undefined ? { detached: jobs } : {};
  if (entry.type === "custom_message") {
    return typeof entry.customType === "string" && WAKE_TYPES.has(entry.customType) ? { status: "working", at, asks, ...detached } : { ...turn, asks, ...detached };
  }
  if (entry.type !== "message") return { ...turn, asks };
  const role = entry.message?.role;
  const stopReason = entry.message?.stopReason;
  if (role === "user" || role === "toolResult") return { status: "working", at, asks, ...detached };
  if (role !== "assistant") return { ...turn, asks, ...detached };
  if (stopReason === "toolUse") return { status: "working", at, asks, ...detached };
  if (stopReason === "stop" || stopReason === "length") return { status: "idle", at, asks, ...detached };
  if (stopReason === "error" || stopReason === "aborted") return { status: "idle", failed: true, at, asks, ...detached };
  return { ...turn, asks, ...detached };
}

type ProcessInfo = { process_info?: { shell_pid?: unknown; foreground_processes?: { pid?: unknown; argv?: unknown }[] } } | null;

export interface GjcDiscovery {
  processInfo?: (paneId: string) => Promise<ProcessInfo>;
  transcript?: (paneId: string, cwd: string) => Promise<string | null>;
  startedAt?: (pid: number) => number | null | Promise<number | null>;
  underShell?: (shellPid: unknown) => Promise<GjcProcess | null | undefined>;
  platform?: string;
}

/**
 * The panes of a snapshot herdr labels `gjc`, with the exact transcript each holds (null when
 * it cannot be told: herdr's status stands for the pane) and when its native foreground gjc
 * process started, so a turn a resumed session left unfinished is not taken for running work.
 * On Windows herdr names only the pane's shell: the gjc under it, and its start, is the PC's
 * process table's answer. `agent_session` is never consulted: it may name the provider child,
 * not the gjc parent. The transcript is bound at the pane's current runtime cwd — what the
 * foreground process runs in now, not where the pane started — the same cwd the chat binds by.
 */
export async function gjcPanes(panes: HerdrPane[], deps: GjcDiscovery = {}): Promise<Map<string, OmoPane>> {
  const processInfo = deps.processInfo ?? ((paneId: string) => paneProcessInfo(paneId).then((process_info) => ({ process_info }), () => null));
  const transcript = deps.transcript ?? ((paneId: string, cwd: string) => gjcTranscriptForPane(paneId, cwd).catch(() => null));
  // awaited: every snapshot a pending message is checked against runs this, and macOS reads a start with `ps` (#1545)
  const startedAt = deps.startedAt ?? processStartedAtAsync;
  const underShell = deps.underShell ?? ((shellPid: unknown) => gjcPidUnderShell(shellPid, deps.platform));
  const found = new Map<string, OmoPane>();
  await Promise.all(panes.filter((pane) => pane.agent === "gjc").map(async (pane) => {
    const info = await processInfo(pane.pane_id);
    const starts = (await Promise.all((info?.process_info?.foreground_processes ?? [])
      .filter((process) => typeof process.pid === "number" && Array.isArray(process.argv) && isGjcProcess(process.argv.map(String)))
      .map((process) => startedAt(process.pid as number))))
      .filter((start): start is number => start !== null);
    let started = starts.length > 0 ? Math.min(...starts) : null;
    if (started === null) {
      const native = await underShell(info?.process_info?.shell_pid).catch(() => undefined);
      if (native) started = native.started;
    }
    const path = await transcript(pane.pane_id, pane.foreground_cwd || pane.cwd || "");
    found.set(pane.pane_id, { path, startedAt: started });
  }));
  return found;
}

/**
 * The tracker's GJC composition: the `gjc` identity (herdr gives it no other name, so no
 * aliases), this file's reducer (whose open jobs are the pane's background count; gjc keeps no
 * task records elsewhere for `background`), an unfinished turn of a process that is
 * gone told as the failed rest it is, and the readiness gate that releases a transcript
 * nothing — or not everything — was read from back to herdr's status.
 */
export function createGjcStatus(deps: Omit<OmoStatusDeps, "agent" | "aliases" | "turnAfter" | "ready" | "background" | "staleIsFailure">, nativeOmo?: OmoStatus): OmoStatus {
  return new OmoStatus({
    ...deps,
    discover: async (panes) => {
      const found = await deps.discover(panes.filter((pane) => !nativeOmo?.runs(pane.pane_id)));
      for (const paneId of found.keys()) if (nativeOmo?.runs(paneId)) found.delete(paneId);
      return found;
    },
    onFound: (paneId, again) => { if (!nativeOmo?.runs(paneId)) deps.onFound?.(paneId, again); },
    onChange: (...change) => { if (!nativeOmo?.runs(change[0])) deps.onChange(...change); },
    agent: "gjc",
    aliases: [],
    turnAfter: gjcTurnAfter,
    ready: ({ turn, available, complete }) => turn.status !== null && available && complete,
    background: () => new Map(),
    staleIsFailure: true,
  });
}

export async function readOmoSnapshot(snapshot: OmoStatusDeps["snapshot"], omo: OmoStatus): Promise<SessionSnapshot> {
  const raw = await snapshot();
  await omo.refresh(raw.panes);
  return omo.apply(raw);
}

/** Provider labels cannot revoke native OmO; only discovery can. */
export function reconcileProviderStatus(omo: OmoStatus, gjc: OmoStatus, pane: Pick<HerdrPane, "pane_id" | "agent">): boolean {
  const native = omo.runs(pane.pane_id);
  const leftOmo = !native && omo.named(pane.pane_id, pane.agent ?? null);
  const leftGjc = gjc.named(pane.pane_id, native ? "omo" : pane.agent ?? null);
  return !native && (leftGjc || (leftOmo && !gjc.runs(pane.pane_id)));
}
