import { appendCompatibleTranscript } from "./transcript-version.ts";
import { basename } from "node:path";
import { commandTerminals } from "./claude-subagents.ts";
import { transcriptReader, sameTranscriptVersion, type TranscriptFile } from "./transcript-reader.ts";

/** Terminal metadata only: historical reads never replay prompt/turn evidence. */
export interface CommandEnd { id: string; at: number; status: "completed" | "failed" | "cancelled"; /** the Bash call the notice names (`<tool-use-id>`), when it names one */ call: string | null }
export interface HistoryVersion { id: string; size: number; mtimeMs: number }
/**
 * How the commands told of in a transcript's first `through` bytes ended. `complete`: nothing more
 * is to come below the limit asked for: every byte up to it was read, and found unchanged by one
 * check of them all since (or the read gave up after failing again and again). An end is told only
 * when the line it came from is as it was read in the transcript as it is now: a check of every byte
 * read at this very version says so, or else that line read again (after a rewrite that also grew
 * the transcript, an end no longer written there is not told, and its command stays running). A record too large
 * to read or not JSON is passed over: it proves nothing, and a command it may have ended stays as
 * the window alone tells it.
 */
export interface HistoryEvidence { unverified?: false; version: HistoryVersion; through: number; complete: boolean; ends: HistoryEnd[] }
/** A timed-out prefix read's bounded metadata. It has NO terminal authority until lines are vouched. */
export interface HistoryCandidate { readonly unverified: true; readonly version: Readonly<HistoryVersion>; readonly through: number; readonly complete: false; readonly ends: readonly HistoryEnd[] }
export type HistoryResult = HistoryEvidence | HistoryCandidate;
/** An end, and the line it was read from: where it starts and ends (past its newline) in the transcript, and a digest of it. */
export type HistoryEnd = CommandEnd & { from: number; to: number; digest: bigint };

interface Entry {
  path: string;
  abort: AbortController;
  active: boolean;
  /** the session the transcript is (its name): a row naming another session ends none of its commands */
  session: string;
  /** the transcript as last seen */
  version: HistoryVersion;
  limit: number;
  /** read up to here, in a record too large to read (`skipping`), or waiting for the record there to be written whole (`cutAt`: the size it was cut at) */
  offset: number;
  skipping: boolean;
  cutAt: number | null;
  /** a digest of each run of bytes read, in order: each ends at `end` and starts where the one before ended */
  spans: { end: number; digest: bigint }[];
  /** every span was found unchanged at this version, up to `checkedThrough` */
  checked: HistoryVersion | null;
  checkedThrough: number;
  /** a check of every span under way: the next span to check, at the version it began at */
  check: { next: number; version: HistoryVersion } | null;
  /** when the last check began, how many began, and the most a waiter wants begun (one begun after it came) */
  checkedAt: number;
  checks: number;
  wanted: number;
  waiters: number;
  ends: HistoryEnd[];
  queued: boolean;
  listeners: Set<() => void>;
  failures: number;
  retryAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const MAX_SESSIONS = 16;
const MAX_ENDS = 5000;
/** A read takes at most this much of a file at once, so a record longer than it is passed over. */
const CHUNK = 1024 * 1024;
/** The event loop gets its turn after about this much work (finishAsync). */
const SLICE_MS = 4;
/** A transcript that changed after a check is checked again this long after, at the soonest, unless a request waits for it. */
const CHECK_INTERVAL_MS = 5000;
/** A read that fails is tried again after a second, then twice as long each time up to this, and given up after MAX_FAILURES in a row. */
const RETRY_MAX_MS = 30_000;
const MAX_FAILURES = 5;
/** Only a line holding one of these can end a command (commandTerminals): every other line is passed over unread. */
const NEWLINE = Buffer.from("\n");
const MARKERS = ["<task-notification>", '"task_id"', '"shell_id"'].map((marker) => Buffer.from(marker));

const entries = new Map<string, Entry>();
const queue: Entry[] = [];
let draining = false;
let active = 0;
let reads = new AbortController();
const metadataFailures = new Map<string, { failures: number; retryAt: number }>();
/** Moved on by every reset: a request waiting from before it gives up. */
let generation = 0;
let holders = 0;


interface ReadOptions { signal?: AbortSignal; deadline?: number }
const historySignal = (signal?: AbortSignal): AbortSignal => signal === undefined ? reads.signal : AbortSignal.any([reads.signal, signal]);
export async function historyVersion(path: string, options: ReadOptions = {}): Promise<HistoryVersion | null> {
  const epoch = generation;
  const previous = metadataFailures.get(path);
  if ((previous?.retryAt ?? 0) > Date.now()) return null;
  try {
    const version = await transcriptReader.version(path, { signal: historySignal(options.signal), deadline: options.deadline ?? Date.now() + 10_000 });
    if (epoch === generation) metadataFailures.delete(path);
    return version;
  } catch {
    if (epoch !== generation || options.signal?.aborted || (options.deadline !== undefined && Date.now() >= options.deadline)) return null;
    const entry = entries.get(path);
    if (entry) { failed(entry); later(entry, entry.retryAt); }
    else {
      const failures = (previous?.failures ?? 0) + 1;
      metadataFailures.delete(path);
      metadataFailures.set(path, { failures, retryAt: retryAt(failures) });
      if (metadataFailures.size > MAX_SESSIONS) metadataFailures.delete(metadataFailures.keys().next().value!);
    }
    return null;
  }
}
const retryAt = (failures: number): number => Date.now() + Math.min(RETRY_MAX_MS, 1000 * 2 ** Math.min(MAX_FAILURES, failures - 1));
function failed(entry: Entry): void { entry.failures++; entry.retryAt = retryAt(entry.failures); }
export const sameHistory = appendCompatibleTranscript;
const sameVersion = sameTranscriptVersion;

/**
 * What the history read of `path` knows so far, read on (when `schedule`) on the main thread a slice
 * at a time. `needed`: the ids whose ends are wanted (all when left out); only theirs are told.
 */
export async function commandHistory(path: string, limit: number, schedule = true, needed?: ReadonlySet<string>, options: ReadOptions = {}): Promise<HistoryEvidence | null> {
  const epoch = generation;
  const existing = entries.get(path);
  // A failed scan owns the retry policy, including metadata checks from status polls. Returning
  // no terminal authority here is an I/O failure, never the ordinary-append path.
  if (existing && Date.now() < existing.retryAt) return { version: existing.version, through: existing.offset, complete: existing.failures >= MAX_FAILURES, ends: [] };
  const version = await historyVersion(path, options);
  if (epoch !== generation || options.signal?.aborted || (options.deadline !== undefined && Date.now() >= options.deadline)) return null;
  if (version === null) return null;
  let entry = entries.get(path);
  if (entry && !sameHistory(entry.version, version)) { discard(entry); entry = undefined; }
  if (entry) entries.delete(path);
  else {
    if (entries.size >= MAX_SESSIONS) {
      // the least recently used one nobody watches or waits for; none such: this one is not read
      const old = [...entries.values()].find((value) => value.listeners.size === 0);
      if (!old) return null;
      discard(old);
    }
    entry = {
      path, abort: new AbortController(), active: false, session: basename(path, ".jsonl"), version, limit, offset: 0, skipping: false, cutAt: null, spans: [], checked: null, checkedThrough: 0, check: null,
      checkedAt: -Infinity, checks: 0, wanted: 0, waiters: 0, ends: [], queued: false, listeners: new Set(), failures: 0, retryAt: 0, timer: null,
    };
  }
  entries.set(path, entry);
  entry.version = version;
  entry.limit = Math.max(entry.limit, limit);
  if (schedule) enqueue(entry);
  return evidence(entry, limit, needed, options);
}

async function evidence(entry: Entry, limit: number, needed: ReadonlySet<string> | undefined, options: ReadOptions): Promise<HistoryEvidence | null> {
  const wanted = needed === undefined ? [...entry.ends] : entry.ends.filter((end) => needed.has(end.id));
  const version = entry.version;
  const through = entry.offset;
  const checked = entry.checked !== null && entry.checkedThrough >= through;
  const proof = wanted.length === 0 || (checked && sameVersion(entry.checked!, version)) ? { version, ends: wanted }
    : await vouchedEnds(entry.path, version.id, wanted, AbortSignal.any([entry.abort.signal, historySignal(options.signal)]), options.deadline);
  if (entries.get(entry.path) !== entry || options.signal?.aborted || (options.deadline !== undefined && Date.now() >= options.deadline)) return null;
  const complete = entry.failures >= MAX_FAILURES || (through >= limit && checked && proof !== null);
  return { version: proof?.version ?? version, through, complete, ends: proof?.ends ?? [] };
}

/** The most bytes of lines one call reads again (vouchedEnds): past it, what they told is unknown. */
const VOUCH_BYTES = 4 * 1024 * 1024;

/**
 * `ends` when every line they came from (newline and all) reads as it did in the transcript `id` as
 * it is now, and nothing changed it while they were read; else null: a command they end may still run.
 */
export async function vouchedEnds(path: string, id: string, ends: readonly HistoryEnd[], signal?: AbortSignal, deadline = Date.now() + 10_000, observed?: (version: HistoryVersion | null) => void): Promise<{ version: HistoryVersion; ends: HistoryEnd[] } | null> {
  const lines = new Map<number, HistoryEnd>();
  for (const end of ends) lines.set(end.from, end);
  let bytes = 0;
  for (const line of lines.values()) bytes += line.to - line.from;
  if (bytes > VOUCH_BYTES) return null;
  try {
    return await transcriptReader.read(path, async (file) => {
      const before = file.initial;
      observed?.(before);
      if (before.id !== id) return null;
      for (const line of lines.values()) {
        const bytes = await file.read(line.from, line.to - line.from);
        if (bytes.length !== line.to - line.from || BigInt(Bun.hash.xxHash3(bytes)) !== line.digest) return null;
      }
      const after = await file.stat();
      const now = await file.pathVersion();
      observed?.(now);
      if (!sameVersion(before, after) || now === null || !sameVersion(before, now)) return null;
      return { version: after, ends: [...ends] };
    }, { signal: historySignal(signal), deadline });
  } catch { return null; }
}

/** Calls `changed` when the read of `path` learns something, starts over, ends or stops; null when `path` has no read. */
export function watchCommandHistory(path: string, changed: () => void): (() => void) | null {
  const entry = entries.get(path);
  if (!entry) return null;
  entry.listeners.add(changed);
  return () => unlisten(entry, changed);
}

function unlisten(entry: Entry, listener: () => void): void {
  entry.listeners.delete(listener);
  if (entry.listeners.size > 0) return;
  // nobody wants it read on: it waits for the next call
  if (entry.queued) { const index = queue.indexOf(entry); if (index >= 0) { queue.splice(index, 1); entry.queued = false; } else if (!entry.active) entry.queued = false; }
  if (entry.timer !== null) { clearTimeout(entry.timer); entry.timer = null; }
}

/**
 * The history of `path` read through `limit` and checked, as far as it gets in `ms`. It answers as
 * soon as the read stops: it is done, it waits for a record to be written whole, or it failed. A
 * transcript replaced meanwhile is read anew within the same time.
 */
export async function waitCommandHistory(path: string, limit: number, ms = 10_000, signal?: AbortSignal): Promise<HistoryResult | null> {
  const deadline = Date.now() + ms;
  const epoch = generation;
  for (;;) {
    if (signal?.aborted || generation !== epoch) return null;
    if (Date.now() >= deadline) return candidate(path);
    const previous = entries.get(path);
    const found = await commandHistory(path, limit, false, undefined, { signal, deadline });
    const entry = entries.get(path);
    if (found === null && entry !== undefined && entry !== previous && generation === epoch) continue;
    if (found === null || entry === undefined) return Date.now() >= deadline ? candidate(path) : found;
    // a check begun before this request may have read the bytes before a rewrite: it waits for one begun after
    entry.wanted = entry.checks + 1;
    entry.waiters++;
    enqueue(entry);
    const again = !entry.queued ? false : await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => finish(false), Math.max(0, deadline - Date.now()));
      const abort = () => finish(false);
      const changed = () => {
        if (generation !== epoch) finish(false);
        else if (entries.get(path) !== entry) finish(true);
        else if (!entry.queued) finish(false);
      };
      function finish(replaced: boolean) {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        unlisten(entry!, changed);
        resolve(replaced);
      }
      signal?.addEventListener("abort", abort, { once: true });
      entry.listeners.add(changed);
      if (signal?.aborted) finish(false);
    });
    entry.waiters--;
    if (generation !== epoch || signal?.aborted) return null;
    if (Date.now() >= deadline) return candidate(path);
    if (!again) {
      const result = await commandHistory(path, limit, false, undefined, { signal, deadline });
      if (Date.now() >= deadline) return candidate(path);
      if (result !== null || entries.get(path) === entry) return result;
    }
    // the replacement is read as far as it goes now, not to the length its predecessor had
    limit = Math.min(limit, (await historyVersion(path, { signal, deadline }))?.size ?? limit);
  }
}

function candidate(path: string): HistoryCandidate | null {
  const entry = entries.get(path);
  return entry === undefined ? null : Object.freeze({ unverified: true, version: Object.freeze({ ...entry.version }), through: entry.offset, complete: false, ends: Object.freeze(entry.ends.map((end) => Object.freeze({ ...end }))) });
}

function discard(entry: Entry): void {
  entry.abort.abort();
  if (entries.get(entry.path) === entry) entries.delete(entry.path);
  if (entry.queued) { const index = queue.indexOf(entry); if (index >= 0) { queue.splice(index, 1); entry.queued = false; } else if (!entry.active) entry.queued = false; }
  if (entry.timer !== null) { clearTimeout(entry.timer); entry.timer = null; }
  notify(entry);
}

/** What `entry` has to do next: read on, check what it read, nothing until a time, or nothing. */
function due(entry: Entry, now: number): "scan" | "check" | number | null {
  if (entry.failures >= MAX_FAILURES) return null;
  if (now < entry.retryAt) return entry.retryAt;
  if (entry.check !== null) return "check";
  if (entry.offset < entry.limit) return entry.cutAt !== null && entry.version.size <= entry.cutAt ? null : "scan";
  if (entry.checked !== null && entry.checkedThrough >= entry.offset && sameVersion(entry.checked, entry.version)) return null;
  // read through but never checked whole, or a request waits: now; else not more often than the interval
  if (entry.checkedThrough < entry.offset || (entry.waiters > 0 && entry.checks < entry.wanted)) return "check";
  return now >= entry.checkedAt + CHECK_INTERVAL_MS ? "check" : entry.checkedAt + CHECK_INTERVAL_MS;
}

function enqueue(entry: Entry): void {
  if (entry.queued) return;
  const work = due(entry, Date.now());
  if (typeof work === "number") later(entry, work);
  if (work !== "scan" && work !== "check") return;
  entry.queued = true;
  queue.push(entry);
  pump();
}

/** Work held back to `at` is taken up then, for as long as somebody watches. */
function later(entry: Entry, at: number): void {
  if (entry.timer !== null || entry.listeners.size === 0) return;
  entry.timer = setTimeout(() => {
    entry.timer = null;
    if (entries.get(entry.path) === entry) enqueue(entry);
  }, Math.max(0, at - Date.now()));
  entry.timer.unref?.();
}

function pump(): void {
  if (draining) return;
  draining = true;
  setImmediate(() => {
    draining = false;
    while (active < 2 && queue.length > 0) {
      const entry = queue.shift()!;
      if (entries.get(entry.path) !== entry || entry.active) continue;
      entry.active = true;
      active++;
      void step(entry).finally(() => { entry.active = false; active--; pump(); });
    }
  });
}

/** One bounded window per session, yielding both the disk lane and event loop between slices. */
async function step(entry: Entry): Promise<void> {
  if (entries.get(entry.path) !== entry) return;
  const before = entry.ends.length;
  let restarted = false;
  try {
    await transcriptReader.read(entry.path, async (file) => {
      const now = file.initial;
      if (entries.get(entry.path) !== entry) return;
      if (!sameHistory(entry.version, now)) { discard(entry); return; }
      entry.version = now;
      const work = due(entry, Date.now());
      // Start CPU accounting after metadata has settled, not before a slow disk wait.
      if (work === "scan") {
        if (entry.offset === 0 && entry.spans.length === 0) { entry.checked = now; entry.checkedThrough = 0; }
        const extends_ = entry.checked !== null && sameVersion(entry.checked, now) && entry.checkedThrough === entry.offset;
        await scan(entry, file);
        const after = await file.stat();
        if (extends_ && sameVersion(now, after)) entry.checkedThrough = entry.offset;
      } else if (work === "check") {
        if (!await check(entry, file, now)) { restart(entry); restarted = true; }
      }
    }, { signal: entry.abort.signal, deadline: Date.now() + 10_000 });
    if (entries.get(entry.path) !== entry) return;
    entry.failures = 0;
    entry.retryAt = 0;
  } catch {
    if (entries.get(entry.path) !== entry) return;
    failed(entry);
  }
  if (entries.get(entry.path) !== entry) return;
  entry.queued = false;
  const work = due(entry, Date.now());
  if ((work === "scan" || work === "check") && entry.listeners.size > 0) { entry.queued = true; queue.push(entry); }
  else if (typeof work === "number") later(entry, work);
  if (restarted || entry.ends.length !== before || !entry.queued) notify(entry);
}

function notify(entry: Entry): void {
  // a listener let go of before its turn comes (a tracker stopped) hears nothing
  for (const listener of [...entry.listeners]) queueMicrotask(() => { if (entry.listeners.has(listener)) listener(); });
}

/** The bytes read were changed: everything learnt from them goes, and the read starts again. */
function restart(entry: Entry): void {
  entry.offset = 0;
  entry.skipping = false;
  entry.cutAt = null;
  entry.spans = [];
  entry.checked = null;
  entry.checkedThrough = 0;
  entry.check = null;
  entry.ends = [];
}

/** Reads on from `entry.offset`, a chunk at most, and keeps the ends of the whole lines it read. */
async function scan(entry: Entry, file: TranscriptFile): Promise<void> {
  entry.cutAt = null;
  // a record cut at the limit is read whole: past the limit, as far as the transcript goes
  const end = Math.max(entry.limit, entry.version.size);
  const bytes = await file.read(entry.offset, Math.min(CHUNK, end - entry.offset));
  if (entries.get(entry.path) !== entry) return;
  const stop = performance.now() + SLICE_MS;
  let from = 0;
  if (entry.skipping) {
    const newline = bytes.indexOf(10);
    from = newline < 0 ? bytes.length : newline + 1;
    entry.skipping = newline < 0;
  }
  let to = from;
  if (!entry.skipping) {
    const last = bytes.lastIndexOf(10);
    if (last >= from) to = last + 1;
    // a record longer than a chunk is passed over: it proves nothing
    else if (from === 0 && bytes.length === CHUNK) { to = CHUNK; entry.skipping = true; }
  }
  const read = terminals(entry, bytes, from, to, stop);
  // the newest are kept: a command still unresolved more likely ended late than early
  if (entry.ends.length > MAX_ENDS) entry.ends.splice(0, entry.ends.length - MAX_ENDS);
  // read to the transcript's end (a record not written whole, or a limit past it): read on once it grows
  if (read === to && entry.offset + bytes.length >= entry.version.size) entry.cutAt = entry.version.size;
  to = read;
  if (to === 0) return;
  entry.spans.push({ end: entry.offset + to, digest: BigInt(Bun.hash.xxHash3(bytes.subarray(0, to))) });
  entry.offset += to;
}

/** The ends told by the lines from `from` to `to` (whole lines), as far as the slice lasts: where it stopped. */
function terminals(entry: Entry, bytes: Buffer, from: number, to: number, stop: number): number {
  const next = MARKERS.map((marker) => bytes.indexOf(marker, from));
  for (;;) {
    let hit = -1;
    for (const at of next) if (at >= 0 && at < to && (hit < 0 || at < hit)) hit = at;
    if (hit < 0) return to;
    const start = bytes.lastIndexOf(10, hit) + 1;
    const end = bytes.indexOf(10, hit);
    // the newlines on both sides too: they keep the record whole (a line begun at a chunk's start
    // follows the newline the last read stopped after)
    const lead = entry.offset + start > 0 ? 1 : 0;
    const line = start >= lead ? bytes.subarray(start - lead, end + 1) : Buffer.concat([NEWLINE, bytes.subarray(start, end + 1)]);
    const digest = BigInt(Bun.hash.xxHash3(line));
    for (const terminal of commandTerminals(bytes.toString("utf8", start, end), entry.session)) entry.ends.push({ ...terminal, from: entry.offset + start - lead, to: entry.offset + end + 1, digest });
    for (let index = 0; index < next.length; index++) if (next[index]! >= 0 && next[index]! <= end) next[index] = bytes.indexOf(MARKERS[index]!, end + 1);
    if (performance.now() >= stop) return end + 1;
  }
}

/** Checks the spans read against their digests, as far as the slice lasts; false when one changed. */
async function check(entry: Entry, file: TranscriptFile, now: HistoryVersion): Promise<boolean> {
  if (entry.check === null) { entry.check = { next: 0, version: now }; entry.checks++; entry.checkedAt = Date.now(); }
  const pass = entry.check;
  if (pass.next < entry.spans.length) {
    const start = pass.next === 0 ? 0 : entry.spans[pass.next - 1]!.end;
    const span = entry.spans[pass.next]!;
    const bytes = await file.read(start, span.end - start);
    if (entries.get(entry.path) !== entry) return true;
    if (bytes.length !== span.end - start || BigInt(Bun.hash.xxHash3(bytes)) !== span.digest) return false;
    pass.next++;
  }
  if (pass.next >= entry.spans.length) {
    entry.check = null;
    entry.checked = pass.version;
    entry.checkedThrough = entry.offset;
  }
  return true;
}

export function resetCommandHistory(): void {
  generation++;
  metadataFailures.clear();
  reads.abort();
  reads = new AbortController();
  for (const entry of [...entries.values()]) discard(entry);
  queue.length = 0;
}
export function holdCommandHistory(): () => void {
  holders++;
  let released = false;
  return () => { if (!released) { released = true; if (--holders === 0) resetCommandHistory(); } };
}
export function commandHistorySize(): { waiting: number; sessions: number; draining: boolean; timers: number } {
  return { waiting: queue.length, sessions: entries.size, draining: draining || active > 0, timers: [...entries.values()].filter((entry) => entry.timer !== null).length };
}
