import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { HerdrPane, OmoTask } from "../shared/protocol.ts";
import { plain, readLines, remember } from "./claude-subagents.ts";

/**
 * The subagents of an omp session, for the pane's count of background tasks and the list behind it (GET /api/pane/omo-tasks),
 * read from their own transcripts (checked against the 240 real ones of omp 18.19 to 19.1 on one PC).
 *
 * Where: beside the session's transcript `<store>/<cwd>/<session>.jsonl` omp keeps a folder `<session>/` with one transcript
 * `<Name>.jsonl` for each subagent the session's `task` calls spawned (`Name` is the name the call gave it, or one omp made up). A
 * subagent's own subagents are in `<session>/<Name>/<Name>.<Child>.jsonl`, and not listed here. The folder holds other files too:
 * `changes.jsonl` (the commit tool's journal), `<Name>.md` (the text of a turn's last answer, written when the turn ends and kept),
 * `.<Name>.jsonl.lock.os`, `blobs/`, `local/`. A subagent is a `.jsonl` whose first record, after a `title` omp pads to rewrite it in
 * place, is a `session` header naming its `parentSession`.
 *
 * What the head says, read once: the start (the header's timestamp), the model (`model_change`, `provider/id`: the chat's own
 * name for it is the id) and the agent type (`session_init`'s `agent`: `task`, `scout`, `code-reviewer`...). Its name is the file's.
 *
 * What the end says (the last of the records below decides, never the `.md`, which stays from the first turn):
 * - an assistant record whose `stopReason` is `stop` ends the turn answered (completed), `error` failed (a rate limit, an exhausted
 *   retry budget), `aborted` cancelled ("Interrupted by user", "Request was aborted"), or lost when its `errorMessage` says "Previous
 *   OMP process exited before completing the turn": the omp that ran it was killed (SIGHUP) in the turn and wrote its
 *   `{"type":"custom","customType":"session_exit"}` just before;
 * - a user, developer or tool-result message and an assistant message that calls tools (`toolUse`) keep a turn open, and so does
 *   a custom message that wakes the agent (WAKES: omp wakes one that finished with an `irc:incoming` message, and retries a failed
 *   turn after its `thinking-loop-redirect`), so an agent that finished may run again. The context omp adds after the last answer (a
 *   compaction, the `eval-state-context` it writes with it) starts no turn;
 * - a finished agent stays idle about seven minutes and then writes `session_exit` (dispose): the end of its process's hold on it.
 *   One written with a turn open means the omp quit before the turn ended: lost.
 * An omp killed without writing anything (SIGKILL, a crash, no power) leaves a turn open for good: an agent made before the omp that
 * now runs the pane started is a gone process's, and reads lost, as a Claude Code subagent does (START_SLACK_MS as in claude-subagents.ts).
 * A lost agent ended when it was last heard of; one that finished, when its last answer was written.
 *
 * Reading is bounded: the head once per file (HEAD_LIMIT), the end (TAIL_STEPS: the last 64 KiB, wider only when the last record is
 * bigger) when the file's size or time changed, at most READ_BUDGET bytes in one call, the folder's newest MAX_AGENTS files touched in the
 * last day, and only plain files, never a link. What was read stays kept by the file's identity; an unchanged file is only looked at.
 * Of the ended, the newest RECENT_LIMIT of the last day are listed after every one that runs.
 */
const READ_BUDGET = 8 * 1024 * 1024;
const HEAD_LIMIT = 256 * 1024;
const TAIL_STEPS = [64 * 1024, 256 * 1024, 1024 * 1024, 4 * 1024 * 1024] as const;
const MAX_AGENTS = 200;
const MAX_KEPT = 2048;
const RECENT_MS = 24 * 60 * 60 * 1000;
const RECENT_LIMIT = 10;
/** an omp process's start is known to the second, and the clock can step: only an agent made this long before it is taken for another process's */
const START_SLACK_MS = 60_000;
const POLL_MS = 2000;
const RETRY_MS = 15_000;
const RELOCATE_MS = 30_000;
/** an agent's name is a file name's part: nothing that could leave the folder, nothing of a nested agent's `Parent.Child` */
const FILE = /^([A-Za-z0-9_-]+)\.jsonl$/;

type Row = Record<string, unknown>;
/** one look at a plain file (claude-subagents.ts plain): `exact` is the identity a read must find */
interface Stat { size: number; mtimeMs: number; id: string; exact: string }
const row = (value: unknown): Row | null => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Row : null;
const text = (value: unknown): string | null => typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, 300) : null;
const time = (value: unknown): number | null => { const at = typeof value === "string" ? Date.parse(value) : NaN; return Number.isFinite(at) ? at : null; };
const iso = (at: number | null): string | null => at === null ? null : new Date(at).toISOString();

function parse(line: string): Row | null {
  try { return row(JSON.parse(line)); } catch { return null; }
}

/** omp names a model `provider/id`, and its chat shows the id */
function modelOf(value: unknown): string | null {
  const named = text(value);
  const slash = named === null ? -1 : named.indexOf("/");
  return named !== null && slash > 0 ? named.slice(slash + 1) : named;
}

interface Head { startedAt: number | null; model: string | null; agent: string | null; complete: boolean }

type Ending = "completed" | "failed" | "cancelled" | "lost";

/** `ending`: how the last turn ended, null while a turn is open; `at`: when the record that says so was written */
interface Tail { ending: Ending | null; at: number | null; exited: boolean; tokens: number | null }

/** a file with no record that says (just made) is at work */
const OPEN: Tail = { ending: null, at: null, exited: false, tokens: null };

/** `foreign`: a `.jsonl` that is no subagent's transcript; null: its first records are not written yet */
interface Kept { id: string; head: Head | "foreign" | null; size: number; mtimeMs: number; tail: Tail | null }
const kept = new Map<string, Kept>();

export function forgetOmpSubagents(): void {
  kept.clear();
}

function readHead(path: string, stat: Stat, budget: { left: number }): Head | "foreign" | null {
  const limit = Math.min(stat.size, HEAD_LIMIT);
  budget.left -= limit;
  const lines: string[] = [];
  const done = readLines(path, 0, stat, limit, (line) => { lines.push(line); }, false);
  if (done.failed) return null;
  // a first line longer than the head is no record of omp's
  if (lines.length === 0) return done.more ? "foreign" : null;
  let head: Head | null = null;
  let titled = false;
  for (const line of lines) {
    const entry = parse(line);
    if (head === null) {
      if (entry?.["type"] === "title" && !titled) { titled = true; continue; }
      const parent = entry?.["parentSession"];
      if (entry?.["type"] !== "session" || typeof parent !== "string" || parent.length === 0) return "foreign";
      head = { startedAt: time(entry["timestamp"]), model: null, agent: null, complete: false };
      continue;
    }
    if (entry === null) continue;
    if (entry["type"] === "model_change") head.model ??= modelOf(entry["model"]);
    else if (entry["type"] === "session_init") {
      head.agent = text(entry["agent"]);
      head.model ??= modelOf(entry["resolvedModel"]);
      head.complete = true;
      break;
    } else if (entry["type"] === "message") { head.complete = true; break; }
  }
  // a head that outgrew what is read of it is not read again for what it may still hold
  if (head !== null && stat.size > HEAD_LIMIT) head.complete = true;
  return head;
}

/** how an assistant record ended its turn: null where it calls tools, and the turn goes on */
function endOf(message: Row): Ending | null {
  const stop = message["stopReason"];
  if (typeof stop !== "string" || stop === "toolUse") return null;
  if (stop === "error") return "failed";
  if (stop === "aborted") return /exited before completing/i.test(text(message["errorMessage"]) ?? "") ? "lost" : "cancelled";
  return "completed";
}

/**
 * The custom messages that start a turn of an agent at rest, or go on with one that failed: a message to the agent, the result of a
 * background job it started, a redirect out of a thinking loop. Its other custom messages are context omp adds to a prompt or after a
 * compaction (`eval-state-context`, `plan-mode-context`, the mount notices...), which wakes none: one written after the last answer
 * leaves the agent as it was.
 */
const WAKES: Record<string, true> = { "irc:incoming": true, "async-result": true, "async-notify": true, "thinking-loop-redirect": true, "launch-completion": true, "ttsr-injection": true };

/** the end of a transcript from its last lines, newest looked at first; null when none of them says */
function classify(lines: readonly string[]): Tail | null {
  let ending: Ending | null | undefined;
  let at: number | null = null;
  let exited = false;
  let tokens: number | null = null;
  let answered = false;
  for (let index = lines.length - 1; index >= 0 && (ending === undefined || !answered); index--) {
    const line = lines[index]!;
    if (!line.includes('"type":"message"') && !line.includes('"type":"custom_message"') && !line.includes('"customType":"session_exit"')) continue;
    const entry = parse(line);
    if (entry === null) continue;
    const type = entry["type"];
    if (type === "custom") {
      if (ending === undefined && entry["customType"] === "session_exit") exited = true;
      continue;
    }
    if (type === "custom_message") {
      if (ending === undefined && typeof entry["customType"] === "string" && WAKES[entry["customType"]] === true) { ending = null; at = time(entry["timestamp"]); }
      continue;
    }
    const message = row(entry["message"]);
    if (type !== "message" || message === null) continue;
    const role = message["role"];
    if (role === "assistant") {
      if (!answered) {
        answered = true;
        const total = row(message["usage"])?.["totalTokens"];
        tokens = typeof total === "number" && Number.isFinite(total) && total > 0 ? total : null;
      }
      if (ending === undefined) { ending = endOf(message); at = time(entry["timestamp"]); }
    } else if (ending === undefined && (role === "user" || role === "developer" || role === "toolResult")) {
      // any other role is context omp keeps (the summary it writes after a compaction): no turn starts with it
      ending = null;
      at = time(entry["timestamp"]);
    }
  }
  return ending === undefined ? null : { ending, at, exited, tokens };
}

function readTail(path: string, stat: Stat, budget: { left: number }): Tail | null {
  for (const step of TAIL_STEPS) {
    const from = Math.max(0, stat.size - step);
    budget.left -= stat.size - from;
    const lines: string[] = [];
    const done = readLines(path, from, stat, stat.size - from, (line) => { lines.push(line); }, from > 0);
    if (done.failed) return null;
    const tail = classify(lines);
    if (tail !== null || from === 0) return tail ?? OPEN;
  }
  return OPEN;
}

/** what is read of one file, kept by its identity; null for a file that is no subagent's, not readable yet, or past the budget */
function look(path: string, stat: Stat, budget: { left: number }): { head: Head; tail: Tail } | null {
  let entry = kept.get(path);
  if (entry === undefined || entry.id !== stat.id) entry = { id: stat.id, head: null, size: -1, mtimeMs: -1, tail: null };
  remember(kept, path, entry, MAX_KEPT);
  let head = entry.head;
  if (head === "foreign") return null;
  if (head === null || !head.complete) {
    if (budget.left <= 0) return null;
    head = entry.head = readHead(path, stat, budget);
    if (head === null || head === "foreign") return null;
  }
  if ((entry.tail === null || entry.size !== stat.size || entry.mtimeMs !== stat.mtimeMs) && budget.left > 0) {
    const tail = readTail(path, stat, budget);
    if (tail !== null) { entry.tail = tail; entry.size = stat.size; entry.mtimeMs = stat.mtimeMs; }
  }
  return entry.tail === null ? null : { head, tail: entry.tail };
}

/**
 * `started`: when the omp process that runs the pane began (null where unknown), which an agent still at work must not
 * predate: it is the work of one that is gone.
 */
export function ompSubagents(sessionPath: string, now = Date.now(), started: number | null = null): { tasks: OmoTask[]; running: number } {
  if (!sessionPath.endsWith(".jsonl")) return { tasks: [], running: 0 };
  const dir = sessionPath.slice(0, -".jsonl".length);
  let names: string[];
  try {
    if (!lstatSync(dir).isDirectory()) return { tasks: [], running: 0 };
    names = readdirSync(dir);
  } catch { return { tasks: [], running: 0 }; }
  const files = names.flatMap((file) => {
    const name = FILE.exec(file)?.[1];
    const path = join(dir, file);
    const stat = name === undefined ? null : plain(path);
    return name !== undefined && stat !== null && now - stat.mtimeMs <= RECENT_MS ? [{ name, path, stat }] : [];
  }).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs).slice(0, MAX_AGENTS);
  const budget = { left: READ_BUDGET };
  const running: { task: OmoTask; at: number }[] = [];
  const ended: { task: OmoTask; at: number }[] = [];
  for (const { name, path, stat } of files) {
    const view = look(path, stat, budget);
    if (view === null) continue;
    const { head, tail } = view;
    const orphan = started !== null && head.startedAt !== null && head.startedAt < started - START_SLACK_MS;
    const status: OmoTask["status"] = tail.ending ?? (tail.exited || orphan ? "lost" : "running");
    const task: OmoTask = {
      id: name, title: name, category: head.agent, model: head.model, status,
      started_at: iso(head.startedAt), ended_at: status === "running" ? null : iso(tail.at),
      turns: null, tool_calls: null, tokens: tail.tokens,
      // nothing of a subagent's prompt or work leaves the server: no detail is opened for omp's
      detail_kind: null,
    };
    if (status === "running") { running.push({ task, at: head.startedAt ?? 0 }); continue; }
    const at = tail.at ?? head.startedAt ?? 0;
    if (at !== 0 && now - at <= RECENT_MS) ended.push({ task, at });
  }
  running.sort((a, b) => a.at - b.at);
  ended.sort((a, b) => b.at - a.at);
  return { tasks: [...running.map(({ task }) => task), ...ended.slice(0, RECENT_LIMIT).map(({ task }) => task)], running: running.length };
}

export interface OmpSession { path: string; startedAt: number | null }

export interface OmpSubagentDeps {
  /** the omp session the pane runs (conversation.ts ompPaneSession): null where it has none, or none is found */
  resolve: (pane: HerdrPane) => Promise<OmpSession | null>;
  onChange: (paneId: string, running: number) => void;
  now?: () => number;
  pollMs?: number;
  retryMs?: number;
  relocateMs?: number;
}

interface Tracked { key: string; at: number; session: OmpSession | null; running: number }

/**
 * The running subagents of each omp pane, counted for the pane's sidebar row and chip. The session's transcript is looked up as the
 * plan's is (session-plan.ts): at once for a pane or session not seen before, and again each RETRY_MS while none is known, each
 * RELOCATE_MS once one is; a lookup that fails for a moment leaves the session found for the same pane in place. omp reports the
 * pane's own status and no turn waits on these: only the count is told.
 */
export class OmpSubagentStatus {
  private readonly panes = new Map<string, Tracked>();
  private readonly wanted = new Set<string>();
  private readonly looking = new Map<string, Promise<void>>();
  private refreshed = false;
  /** the lookups whose answer was kept: a refresh counts the subagents of its panes at once only when one was */
  private looked = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly now: () => number;

  constructor(private readonly deps: OmpSubagentDeps) {
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => this.poll(), this.deps.pollMs ?? POLL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  countOf(paneId: string): number {
    return this.panes.get(paneId)?.running ?? 0;
  }

  sessionOf(paneId: string): OmpSession | null {
    return this.panes.get(paneId)?.session ?? null;
  }

  /** the pane's subagents as they are now: running first, then the newest that ended in the last day */
  tasksOf(paneId: string): OmoTask[] {
    const session = this.sessionOf(paneId);
    return session === null ? [] : ompSubagents(session.path, this.now(), session.startedAt).tasks;
  }

  /** a pane that ended: nothing is told of it, whatever it counted */
  forget(paneId: string): void {
    this.panes.delete(paneId);
    this.wanted.delete(paneId);
  }

  async refresh(panes: readonly HerdrPane[]): Promise<void> {
    this.wanted.clear();
    this.refreshed = true;
    for (const pane of panes) if (pane.agent === "omp") this.wanted.add(pane.pane_id);
    for (const [paneId, tracked] of this.panes) {
      if (this.wanted.has(paneId)) continue;
      this.panes.delete(paneId);
      if (tracked.running > 0) this.deps.onChange(paneId, 0);
    }
    const before = this.looked;
    await Promise.all(panes.map((pane) => this.ensure(pane)));
    if (this.looked !== before) this.poll();
  }

  /** `asked`: a request wants the lookup, whether or not the last snapshot has seen the pane */
  ensure(pane: HerdrPane, asked = false): Promise<void> {
    if (pane.agent !== "omp") return Promise.resolve();
    const looking = this.looking.get(pane.pane_id);
    if (looking !== undefined) return looking;
    const key = `${pane.agent_session?.value ?? ""}\0${pane.cwd ?? ""}`;
    const tracked = this.panes.get(pane.pane_id);
    if (tracked !== undefined && tracked.key === key && this.now() - tracked.at < (tracked.session === null ? this.deps.retryMs ?? RETRY_MS : this.deps.relocateMs ?? RELOCATE_MS)) return Promise.resolve();
    const lookup = this.lookUp(pane, key, asked).finally(() => this.looking.delete(pane.pane_id));
    this.looking.set(pane.pane_id, lookup);
    return lookup;
  }

  private async lookUp(pane: HerdrPane, key: string, asked: boolean): Promise<void> {
    const found = await this.deps.resolve(pane).catch(() => null);
    if (!asked && this.refreshed && !this.wanted.has(pane.pane_id)) return;
    const current = this.panes.get(pane.pane_id);
    const session = found ?? (current?.key === key ? current.session : null);
    this.panes.set(pane.pane_id, { key, at: this.now(), session, running: current?.running ?? 0 });
    this.looked += 1;
  }

  poll(): void {
    for (const [paneId, tracked] of this.panes) {
      const running = tracked.session === null ? 0 : ompSubagents(tracked.session.path, this.now(), tracked.session.startedAt).running;
      if (running === tracked.running) continue;
      tracked.running = running;
      this.deps.onChange(paneId, running);
    }
  }
}
