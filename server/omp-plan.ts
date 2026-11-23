import { open } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { ConversationPart } from "../shared/protocol.ts";
import { OMP_PLAN_PLACEHOLDER, ompPlanEditTarget, ompPlanName, planNoticeSource, type PlanNoticeKind } from "../shared/omp-plan.ts";

/**
 * omp's plan mode, as its transcript tells it (omp 19.1.1): `mode_change` records (`plan`, `plan_paused`, `none`
 * with the `approvedPlanFilePath` of an approved plan; other modes, goal and vibe, write their own through the
 * same record) and the `propose <slug>` command's result, which says which plan file went to review. A first
 * `mode_change plan` always names the placeholder `local://PLAN.md`; the agent's slug follows in a second one,
 * and a plan proposed again, once refined, writes none: the result of `propose` is what names the plan then.
 */
export type OmpPlanState =
  | { mode: "none" }
  | { mode: "plan"; file: string }
  | { mode: "paused" }
  | { mode: "approved"; file: string };

type Row = Record<string, unknown>;
const row = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const text = (value: unknown): string | undefined => typeof value === "string" && value !== "" ? value : undefined;

/** The plan file a successful `propose` (a `bash` call of omp's) sent to review, as its result records it. */
function proposed(entry: Row): string | null {
  const message = row(entry.message);
  if (entry.type !== "message" || message.role !== "toolResult") return null;
  const commands = row(message.details).toolCommands;
  if (!Array.isArray(commands)) return null;
  for (const command of commands) {
    const call = row(command);
    const inner = row(call.inner);
    if (call.tool === "propose" && (call.exitCode === undefined || call.exitCode === 0) && inner.planExists !== false) {
      const file = text(inner.planFilePath);
      if (file !== undefined) return file;
    }
  }
  return null;
}

/**
 * The one fold of the records: what plan mode is after `entry`. A `propose` that went through proves plan mode
 * is on, so a window that begins after the `mode_change` still finds the plan in review.
 */
export function reduceOmpPlan(state: OmpPlanState, entry: unknown): OmpPlanState {
  const record = row(entry);
  if (record.type === "mode_change") {
    const data = row(record.data);
    switch (record.mode) {
      case "plan": return { mode: "plan", file: text(data.planFilePath) ?? OMP_PLAN_PLACEHOLDER };
      case "plan_paused": return { mode: "paused" };
      case "none": {
        const approved = text(data.approvedPlanFilePath);
        return approved === undefined ? { mode: "none" } : { mode: "approved", file: approved };
      }
      // goal and vibe cannot start while plan mode is on or paused
      default: return { mode: "none" };
    }
  }
  const file = proposed(record);
  return file === null ? state : { mode: "plan", file };
}

/** What a record changed that the chat says in a line: null where it changed nothing a reader would miss. */
export type OmpPlanEvent = { kind: PlanNoticeKind; file: string | null };

export function ompPlanEvent(before: OmpPlanState, after: OmpPlanState, entry: unknown): OmpPlanEvent | null {
  const record = row(entry);
  if (record.type === "mode_change") {
    switch (after.mode) {
      // a plan already on is only given its slug
      case "plan": return before.mode === "plan" ? null : { kind: "on", file: after.file };
      case "paused": return before.mode === "paused" ? null : { kind: "paused", file: null };
      case "approved": return { kind: "approved", file: after.file };
      // other modes write `none` too: only the end of plan mode is said
      case "none": return before.mode === "plan" || before.mode === "paused" ? { kind: "off", file: null } : null;
    }
  }
  const file = proposed(record);
  return file === null ? null : { kind: "ready", file };
}

type Notice = Extract<ConversationPart, { kind: "notice" }>;
type Tool = Extract<ConversationPart, { kind: "tool" }>;

/** Where the session keeps its plan files, and the newest edit of each plan, the one that carries the plan whole. */
export interface OmpPlanFiles {
  dir: string | null;
  edits: Map<string, Tool>;
}

const WORDS: Record<PlanNoticeKind, string> = {
  on: "Plan mode on", ready: "Plan ready for review", paused: "Plan mode paused", off: "Plan mode off", approved: "Plan approved",
};

/** The plan notice for an event: its English line, its kind and slug in `source`, and the plan on disk once the session's folder is known. */
export function ompPlanNotice(event: OmpPlanEvent, files: OmpPlanFiles): Notice {
  const named = event.file === null ? null : ompPlanName(event.file);
  const slug = named?.slug ?? null;
  const path = named !== null && files.dir !== null && (event.kind === "ready" || event.kind === "approved") ? join(files.dir, named.file) : null;
  return { kind: "notice", text: slug === null ? WORDS[event.kind] : `${WORDS[event.kind]} · ${slug}`, source: planNoticeSource(event.kind, slug), ...(path === null ? {} : { plan_file: path }) };
}

/** The plan as the chat holds it in a row at most this long; a longer plan opens from its file. */
const PLAN_TEXT_MAX = 200_000;

/** `path` is the file `local://<file>` was resolved to: in a folder named `local`, under the name the call gave it. */
const onDisk = (path: string | undefined, file: string): path is string =>
  path !== undefined && isAbsolute(path) && basename(path) === file && basename(dirname(path)) === "local";

/**
 * A `write` or `edit` of a plan file, finished: the call carries where the file lies (omp's own `details`), which
 * also tells the session's folder for the notices that only know `local://`. An edit of a plan also carries the plan
 * whole as the edit left it (`details.newText`), on the file's newest edit alone: the older rows go back to their
 * scripts, so a plan refined many times is held once.
 */
export function notePlanTool(files: OmpPlanFiles, tool: Tool, details: unknown): void {
  if (tool.name !== "write" && tool.name !== "edit") return;
  let call: Row;
  try { call = row(JSON.parse(tool.input)); } catch { return; }
  const result = row(details);
  if (tool.name === "write") {
    const named = ompPlanName(call.path);
    const path = text(result.resolvedPath);
    if (named === null || !onDisk(path, named.file)) return;
    files.dir = dirname(path);
    tool.plan_file = path;
    return;
  }
  const target = typeof call.input === "string" ? ompPlanEditTarget(call.input) : null;
  const named = target === null ? null : ompPlanName(target);
  const path = text(result.path);
  if (named === null || !onDisk(path, named.file)) return;
  files.dir = dirname(path);
  tool.plan_file = path;
  const whole = text(result.newText);
  if (whole === undefined || whole.length > PLAN_TEXT_MAX) return;
  const older = files.edits.get(path);
  if (older !== undefined) delete older.plan_text;
  tool.plan_text = whole;
  files.edits.set(path, tool);
}

/** The folder omp keeps a session's `local://` files in: next to the transcript, named like it; null for a file that is not a `.jsonl`. */
export function ompLocalDir(transcript: string): string | null {
  return basename(transcript).endsWith(".jsonl") ? join(dirname(transcript), basename(transcript, ".jsonl"), "local") : null;
}

const TAIL_BYTES = 1024 * 1024;

/** Plan mode as the last megabyte of the transcript leaves it: the plan in review is among the last records. */
async function planModeNow(transcript: string): Promise<OmpPlanState> {
  const file = await open(transcript, "r");
  try {
    const { size } = await file.stat();
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n");
    // a read that starts inside a line cuts it
    if (size > length) lines.shift();
    let state: OmpPlanState = { mode: "none" };
    for (const line of lines) {
      if (!line.includes("\"mode_change\"") && !line.includes("\"propose\"")) continue;
      try { state = reduceOmpPlan(state, JSON.parse(line)); } catch { /* a torn line */ }
    }
    return state;
  } finally {
    await file.close();
  }
}

const PLAN_READ_BYTES = 256 * 1024;

async function readPlan(path: string): Promise<string | null> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(PLAN_READ_BYTES);
    const { bytesRead } = await file.read(buffer, 0, PLAN_READ_BYTES, 0);
    const plan = buffer.toString("utf8", 0, bytesRead);
    return plan.trim() === "" ? null : plan;
  } finally {
    await file.close();
  }
}

/**
 * The plan behind omp's Plan Review overlay, whole from the session's own `local/` folder: the overlay shows only
 * the part of it that fits the pane. Only for the pane's own session, only for the file the transcript says is in
 * plan mode, and only a name `ompPlanName` takes: no other `local://` file is read.
 */
export async function ompPlanFile(transcript: string): Promise<{ path: string; text: string } | null> {
  try {
    const state = await planModeNow(transcript);
    const named = state.mode === "plan" ? ompPlanName(state.file) : null;
    const dir = ompLocalDir(transcript);
    if (named === null || dir === null) return null;
    const path = join(dir, named.file);
    const plan = await readPlan(path);
    return plan === null ? null : { path, text: plan };
  } catch {
    return null;
  }
}
