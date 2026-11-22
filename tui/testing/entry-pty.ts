import type { Subprocess } from "bun";
import { join } from "node:path";
import { answerQueries, gridText, runSupervised, screenOutput, type PtyRun, type SupervisedRun } from "./pty.ts";

export const SOURCE_OVIS = [process.execPath, join(import.meta.dir, "../../scripts/plugin.ts")] as const;
export const DETACH = "\x02q";
export const RESTORE = "\x1b[<u\x1b[?1006l\x1b[?1002l\x1b[?2004l\x1b[?1004l\x1b[?25h\x1b[?1049l";
export const HOST_ANSWERS = [
  ["\x1b[?2026$p", "\x1b[?2026;2$y"],
  ["\x1b[c", "\x1b[?62;22c"],
] as const;

export function entryEnv(folder: { readonly root: string; readonly env: Record<string, string> }, bin?: string): Record<string, string> {
  return {
    ...folder.env,
    ...(bin ? { OVIS_HC_BIN: bin } : {}),
    TERM: "xterm-256color", COLORTERM: "truecolor", PORT: "1", TMPDIR: folder.root,
    HERDR_TEST_SESSION: `entry-${process.pid}`,
    HERDR_PLUGIN_CONFIG_DIR: join(folder.root, "plugin-config"),
    HERDR_PLUGIN_STATE_DIR: join(folder.root, "plugin-state"),
    OVIS_TUI_STATE_DIR: join(folder.root, "tui-state"),
  };
}

export function entryPty(
  entry: readonly string[],
  env: Record<string, string>,
  cols: number,
  rows: number,
  options: { readonly deadlineMs?: number; readonly maxOutputChars?: number; readonly answers?: ReadonlyArray<readonly [string, string]>; readonly onData?: (text: string) => void } = {},
): SupervisedRun {
  const answer = answerQueries((bytes) => run.type(bytes), options.answers ?? HOST_ANSWERS);
  const run: SupervisedRun = runSupervised({
    entry: ["sh", "-c", 'cd "$HOME" && exec "$@"', "entry", ...entry],
    env, cols, rows, deadlineMs: options.deadlineMs ?? 15_000, maxOutputChars: options.maxOutputChars,
    onData: (text) => { answer(text); options.onData?.(text); },
  });
  return run;
}

/** Wait for new terminal output, excluding every byte already captured at `from`. */
export function fresh(run: PtyRun, from: number, text: string): Promise<void> {
  const quoted = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return run.until(new RegExp(`^[\\s\\S]{${from}}[\\s\\S]*${quoted}`), text);
}

/** A child this code spawned, through its own handle: the only thing the helpers below ever signal. */
type Owned = Pick<Subprocess, "kill" | "exited" | "exitCode" | "signalCode">;

/** True when `work` settled within `ms`, false at the limit; the timer never outlives the call. */
async function settledWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work.then(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

/** SIGTERM, then SIGKILL after `graceMs`, on a child this code spawned; says how far it had to go. */
export async function terminate(child: Owned, graceMs: number): Promise<"exited" | "SIGTERM" | "SIGKILL"> {
  if (child.exitCode !== null || child.signalCode !== null) return "exited";
  child.kill("SIGTERM");
  if (await settledWithin(child.exited, graceMs)) return "SIGTERM";
  child.kill("SIGKILL");
  await child.exited;
  return "SIGKILL";
}

async function readCapped(stream: ReadableStream<Uint8Array>, maxBytes: number, stop: AbortSignal): Promise<string> {
  const reader = stream.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  stop.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (let part = await reader.read(); !part.done; part = await reader.read()) {
      size += part.value.byteLength;
      if (size > maxBytes) throw new Error(`the output passed ${maxBytes} bytes`);
      chunks.push(part.value);
    }
  } finally {
    stop.removeEventListener("abort", cancel);
    cancel();
  }
  return Buffer.concat(chunks).toString("utf8");
}

export interface BoundedRun {
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly deadlineMs: number;
  /** each of stdout and stderr may hold this many bytes */
  readonly maxBytes: number;
  readonly graceMs: number;
}

/**
 * Runs a command to its end within `deadlineMs`, with at most `maxBytes` on each stream. A command that
 * hangs or floods is stopped through its own handle (SIGTERM, then SIGKILL) and the run rejects.
 */
export async function runBounded(command: readonly string[], options: BoundedRun): Promise<{ code: number; out: string; err: string }> {
  const child = Bun.spawn([...command], { cwd: options.cwd, env: options.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const stop = new AbortController();
  const work = Promise.all([child.exited, readCapped(child.stdout, options.maxBytes, stop.signal), readCapped(child.stderr, options.maxBytes, stop.signal)]);
  work.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`did not finish within ${options.deadlineMs} ms`)), options.deadlineMs);
  });
  try {
    const [code, out, err] = await Promise.race([work, limit]);
    return { code, out, err };
  } catch (error) {
    stop.abort();
    const ended = await terminate(child, options.graceMs);
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${command.join(" ")}: ${reason}${ended === "exited" ? "" : ` (stopped with ${ended})`}`, { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

/** Keeps only the last `keep` characters of a stream, and drains the rest, so a noisy child never fills memory. */
export function drainTail(stream: ReadableStream<Uint8Array>, keep: number): { text(): string; readonly done: Promise<void> } {
  const decoder = new TextDecoder();
  let tail = "";
  const done = (async () => {
    try {
      for await (const chunk of stream) tail = (tail + decoder.decode(chunk, { stream: true })).slice(-keep);
    } catch (error) {
      tail += `[read failed: ${error instanceof Error ? error.message : String(error)}]`;
    }
  })();
  return { text: () => tail, done };
}

/**
 * Ends a child this code spawned: `ask` (already bounded) is its polite stop request; a child still
 * alive `graceMs` after that is stopped through its handle. `forced` names the signal that was needed.
 */
export async function shutdownOwned(child: Owned, ask: () => Promise<unknown>, graceMs: number): Promise<{ forced: "SIGTERM" | "SIGKILL" | null; askError: unknown }> {
  let askError: unknown;
  if (child.exitCode === null && child.signalCode === null) {
    try {
      await ask();
    } catch (error) {
      askError = error;
    }
  }
  if (await settledWithin(child.exited, graceMs)) return { forced: null, askError };
  const ended = await terminate(child, graceMs);
  return { forced: ended === "exited" ? null : ended, askError };
}

/** Wait for any output past byte `from`: the first sign that the program reacted. */
export function anyFresh(run: PtyRun, from: number, what: string): Promise<void> {
  return run.until(new RegExp(`^[\\s\\S]{${from + 1}}`), what);
}

const TOP_LEFT = new Set(["┌", "╭", "┏", "╔"]);
const TOP_RIGHT = new Set(["┐", "╮", "┓", "╗"]);
const BOTTOM_LEFT = new Set(["└", "╰", "┗", "╚"]);
const BOTTOM_RIGHT = new Set(["┘", "╯", "┛", "╝"]);
const ACROSS = new Set(["─", "━", "═"]);
const DOWN = new Set(["│", "┃", "║"]);

/** Every closed box-drawing rectangle on a grid, as `top,left,bottom,right`: whole frames, whatever they say. */
export function closedBoxes(grid: string): string[] {
  const rows = grid.split("\n").map((line) => Array.from(line));
  const at = (row: number, col: number) => rows[row]?.[col] ?? "";
  const found: string[] = [];
  for (const [top, cells] of rows.entries()) {
    for (const [left, cell] of cells.entries()) {
      if (!TOP_LEFT.has(cell)) continue;
      let right = left + 1;
      while (ACROSS.has(at(top, right))) right++;
      if (right === left + 1 || !TOP_RIGHT.has(at(top, right))) continue;
      let bottom = top + 1;
      while (DOWN.has(at(bottom, left)) && DOWN.has(at(bottom, right))) bottom++;
      if (bottom === top + 1 || !BOTTOM_LEFT.has(at(bottom, left)) || !BOTTOM_RIGHT.has(at(bottom, right))) continue;
      let whole = true;
      for (let col = left + 1; col < right; col++) whole &&= ACROSS.has(at(bottom, col));
      if (whole) found.push(`${top},${left},${bottom},${right}`);
    }
  }
  return found;
}

export const visibleGrid = (run: PtyRun, cols: number, rows: number): Promise<string> =>
  gridText(screenOutput(run.output()), cols, rows);
