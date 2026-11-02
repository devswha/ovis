import { lstatSync } from "node:fs";

/** Terminal metadata only: historical reads never replay prompt/turn evidence. */
export interface CommandEnd { id: string; at: number; status: "completed" | "failed" | "cancelled" }
export interface HistoryVersion { id: string; size: number; mtimeMs: number }
export interface HistoryEvidence { version: HistoryVersion; through: number; complete: boolean; ends: CommandEnd[] }
export interface HistoryChunk { path: string; version: HistoryVersion; offset: number; limit: number; skipping: boolean; witness: string | null }
export interface HistoryCheckpoint { version: HistoryVersion; offset: number; skipping: boolean; witness: string; uncertain: boolean; waiting: boolean; ends: CommandEnd[] }
interface Entry {
  path: string; version: HistoryVersion; limit: number; offset: number; skipping: boolean;
  witness: string | null; uncertain: boolean; ends: Map<string, CommandEnd>; queued: boolean;
  listeners: Set<() => void>; retryAt: number; waitingAt: number | null;
}
const MAX_SESSIONS = 16;
const MAX_ENDS = 5000;
const entries = new Map<string, Entry>();
const queue: Entry[] = [];
type Thread = Worker & { ref(): void; unref(): void };
let worker: Thread | null = null;
let active: Entry | null = null;
let ending = false;
let workerURL = new URL("./claude-command-history-worker.ts", import.meta.url);
let holders = 0;

export function historyVersion(path: string): HistoryVersion | null {
  try {
    const stat = lstatSync(path);
    return stat.isFile() ? { id: `${stat.dev}:${stat.ino}`, size: stat.size, mtimeMs: stat.mtimeMs } : null;
  } catch { return null; }
}
export function sameHistory(older: HistoryVersion, newer: HistoryVersion): boolean {
  return older.id === newer.id && newer.size >= older.size && (newer.size !== older.size || newer.mtimeMs === older.mtimeMs);
}

/** A single bounded maintenance lane, independent of the four interactive file workers. */
export function commandHistory(path: string, limit: number, schedule = true): HistoryEvidence | null {
  const version = historyVersion(path);
  if (version === null) return null;
  let entry = entries.get(path);
  if (entry && !sameHistory(entry.version, version)) { discard(entry); entry = undefined; }
  if (!entry) {
    if (entries.size >= MAX_SESSIONS) {
      // Never evict an owned/in-flight cursor to admit unbounded new sessions.
      const old = [...entries.values()].find((value) => value.listeners.size === 0 && value !== active);
      if (!old) return null;
      discard(old);
    }
    entry = { path, version, limit, offset: 0, skipping: false, witness: null, uncertain: false, ends: new Map(), queued: false, listeners: new Set(), retryAt: 0, waitingAt: null };
    entries.set(path, entry);
  }
  entry.version = version;
  entry.limit = Math.max(entry.limit, limit);
  if (schedule) enqueue(entry);
  return { version, through: entry.offset, complete: entry.offset >= limit && !entry.uncertain, ends: [...entry.ends.values()] };
}

/** The tracker owns ongoing work; null means the bounded cache has not admitted this path. */
export function watchCommandHistory(path: string, changed: () => void): (() => void) | null {
  const entry = entries.get(path);
  if (!entry) return null;
  entry.listeners.add(changed);
  return () => {
    entry.listeners.delete(changed);
    if (entry.listeners.size === 0 && entry.queued) {
      const at = queue.indexOf(entry);
      if (at >= 0) queue.splice(at, 1);
      entry.queued = false;
    }
  };
}

export async function waitCommandHistory(path: string, limit: number, ms = 10_000, signal?: AbortSignal): Promise<HistoryEvidence | null> {
  if (signal?.aborted) return commandHistory(path, limit, false);
  let evidence = commandHistory(path, limit);
  if (evidence === null || evidence.through >= limit) return evidence;
  await new Promise<void>((resolve) => {
    let release: (() => void) | null = null;
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal?.removeEventListener("abort", done); release?.(); resolve(); }
    signal?.addEventListener("abort", done, { once: true });
    release = watchCommandHistory(path, () => {
      const entry = entries.get(path);
      if (!entry || entry.offset >= limit) done();
    });
    if (release === null) done();
  });
  evidence = commandHistory(path, limit, false);
  return evidence;
}
function discard(entry: Entry): void {
  if (entries.get(entry.path) === entry) entries.delete(entry.path);
  const at = queue.indexOf(entry);
  if (at >= 0) queue.splice(at, 1);
  entry.queued = false;
  for (const listener of [...entry.listeners]) queueMicrotask(listener);
}
function enqueue(entry: Entry): void {
  if (entry.offset >= entry.limit || entry.queued || active === entry || Date.now() < entry.retryAt || (entry.waitingAt !== null && entry.version.size <= entry.waitingAt)) return;
  entry.queued = true;
  queue.push(entry);
  queueMicrotask(pump);
}
function pump(): void {
  if (ending || active || queue.length === 0) return;
  if (!worker) {
    const thread = new Worker(workerURL) as Thread;
    worker = thread;
    thread.unref();
    thread.addEventListener("message", (event: MessageEvent<{ result?: HistoryCheckpoint; error?: string }>) => {
      const entry = active;
      active = null;
      thread.unref();
      if (entry && entries.get(entry.path) === entry) {
        const result = event.data.result;
        const current = historyVersion(entry.path);
        if (!result) {
          entry.retryAt = Date.now() + 2000;
          entry.ends.clear();
          entry.offset = 0;
          entry.witness = null;
          entry.skipping = false;
          entry.uncertain = false;
          entry.waitingAt = null;
          if (current) entry.version = current;
          for (const listener of [...entry.listeners]) queueMicrotask(listener);
        } else if (!current || !sameHistory(result.version, current)) discard(entry);
        else {
          entry.version = current;
          entry.offset = result.offset;
          entry.skipping = result.skipping;
          entry.witness = result.witness;
          entry.uncertain ||= result.uncertain;
          entry.waitingAt = result.waiting ? result.version.size : null;
          for (const end of result.ends) {
            if (entry.ends.has(end.id)) continue;
            if (entry.ends.size >= MAX_ENDS) { entry.uncertain = true; continue; }
            entry.ends.set(end.id, end);
          }
          for (const listener of [...entry.listeners]) queueMicrotask(listener);
          if (entry.listeners.size > 0) enqueue(entry); // each chunk goes behind every other waiting session
        }
      }
      pump();
    });
    // Keep the physical slot charged until close, including a termination request or module error.
    thread.addEventListener("error", () => { ending = true; void thread.terminate(); });
    thread.addEventListener("close", () => {
      if (worker !== thread) return;
      worker = null;
      ending = false;
      if (active) { const entry = active; active = null; discard(entry); }
      pump();
    });
  }
  const entry = queue.shift()!;
  entry.queued = false;
  active = entry;
  worker.ref();
  worker.postMessage({ path: entry.path, version: entry.version, offset: entry.offset, limit: entry.limit, skipping: entry.skipping, witness: entry.witness } satisfies HistoryChunk);
}
export function resetCommandHistory(): void {
  for (const entry of [...entries.values()]) discard(entry);
  queue.length = 0;
  if (worker) { ending = true; void worker.terminate(); }
}
export function holdCommandHistory(): () => void {
  holders++;
  let released = false;
  return () => { if (!released) { released = true; if (--holders === 0) resetCommandHistory(); } };
}
/** Test-only worker substitution; a terminating thread still occupies the sole physical slot. */
export function setCommandHistoryWorker(url = new URL("./claude-command-history-worker.ts", import.meta.url)): void {
  workerURL = url;
  resetCommandHistory();
}
export function commandHistorySize(): { threads: number; waiting: number; sessions: number; active: boolean } {
  return { threads: worker === null ? 0 : 1, waiting: queue.length, sessions: entries.size, active: active !== null };
}
