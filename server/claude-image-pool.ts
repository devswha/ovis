import { closeSync } from "node:fs";

import { MAX_IMAGE_BYTES } from "./codex-images.ts";
import { FileBusyError } from "./file-pool.ts";

/** Only metadata crosses into the image thread; pane authorization stays with the caller. */
export interface ClaudeImageJob { path: string; ref: string; binding: string; generation: string }
type ClaudeImageWork = ClaudeImageJob & { op?: "inspect" | "check" };
export interface ClaudeImage { mediaType: string; bytes: Uint8Array<ArrayBuffer>; generation: string }
export type ClaudeImageResult = ClaudeImage | { generation: string };
export interface ClaudeImageRequest { id: number; job: ClaudeImageWork; opened?: Int32Array<SharedArrayBuffer> }
export interface ClaudeImageReply { id: number; result?: ClaudeImageResult | null; error?: string }

/** Queue time is part of an image request's deadline, just as for long file tasks. */
export const CLAUDE_IMAGE_DEADLINE_MS = 15_000;
const WAITING = 8;
const JOB_WAITERS = 8;
const TOTAL_WAITERS = 32;
interface PoolOptions { worker: URL; deadlineMs: number }
const DEFAULTS: PoolOptions = { worker: new URL("./claude-image-worker.ts", import.meta.url), deadlineMs: CLAUDE_IMAGE_DEADLINE_MS };
let options = DEFAULTS;
interface Waiter { done: (image: ClaudeImageResult | null) => void; fail: (error: Error) => void; timer: ReturnType<typeof setTimeout>; unlisten?: () => void }
interface Pending { key: string; request: ClaudeImageRequest; waiters: Set<Waiter> }
type BunWorker = Worker & { ref(): void; unref(): void };
interface Thread { worker: BunWorker; running: Pending | null; retiring: boolean; opened: Int32Array<SharedArrayBuffer>; closed: Promise<void> }
let thread: Thread | null = null;
const queue: Pending[] = [];
const jobs = new Map<string, Pending>();
let waiters = 0;
let sequence = 0;
let holders = 0;

/**
 * One physical image thread in the process, independent of commands, task lists and file routes.
 * An expired request cannot stop a disk syscall. Even terminate/error/server shutdown leaves the
 * physical slot taken until close; a server started meanwhile cannot grow another image thread.
 */
export function holdClaudeImagePool(): () => void {
  holders += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders -= 1;
    if (holders === 0) stop("the server stopped");
  };
}

/** Test support: the previous physical thread must close before the replacement may start. */
export function setClaudeImagePoolOptions(next: Partial<PoolOptions> = {}): void {
  options = { ...DEFAULTS, ...next };
  stop("the image thread was replaced");
}
export function claudeImagePoolSize(): { physical: number; retiring: number; running: number; waiting: number; waiters: number } {
  return { physical: thread === null ? 0 : 1, retiring: thread?.retiring ? 1 : 0, running: thread?.running === null || thread === null ? 0 : 1, waiting: queue.length, waiters };
}
/** The physical thread present now has closed, including one terminated inside a syscall. */
export async function claudeImageThreadClosed(): Promise<void> { await thread?.closed; }

/** Coalesce only a caller's explicitly authorized binding and validated file generation. */
export function claudeImageTask(job: ClaudeImageJob, signal?: AbortSignal, deadline?: number): Promise<ClaudeImage | null> {
  return task(job, signal, deadline) as Promise<ClaudeImage | null>;
}
/** One absolute budget across authorization, metadata, scan and final binding checks. */
export function claudeImageDeadline(began = performance.now()): number { return began + options.deadlineMs; }
/** File metadata stays on the same bounded thread too; unknown generations never coalesce. */
export async function claudeImageGeneration(path: string, binding: string, signal?: AbortSignal, deadline?: number): Promise<string | null> {
  const result = await task({ op: "inspect", path, binding, ref: "", generation: `inspect-${++sequence}` }, signal, deadline);
  return result !== null && "generation" in result ? result.generation ?? null : null;
}
/** A final metadata fence after pane reauthorization; a changed file is retried by a later request. */
export async function claudeImageGenerationCurrent(job: ClaudeImageJob, signal?: AbortSignal, deadline?: number): Promise<boolean> {
  const result = await task({ ...job, op: "check", ref: "" }, signal, deadline);
  return result !== null && "generation" in result && result.generation === job.generation;
}
function task(job: ClaudeImageWork, signal?: AbortSignal, deadline = performance.now() + options.deadlineMs): Promise<ClaudeImageResult | null> {
  if (signal?.aborted) return Promise.reject(new FileBusyError("the request was cancelled"));
  if (deadline <= performance.now()) return Promise.reject(new FileBusyError("the image did not answer in time"));
  const key = JSON.stringify([job.op ?? "read", job.binding, job.path, job.generation, job.ref]);
  let pending = jobs.get(key);
  if (waiters >= TOTAL_WAITERS || (pending !== undefined && pending.waiters.size >= JOB_WAITERS)) return Promise.reject(new FileBusyError("too many requests are waiting for an image"));
  if (pending === undefined) {
    if ((thread !== null && (thread.retiring || thread.running !== null)) && queue.length >= WAITING) return Promise.reject(new FileBusyError("the image thread is busy"));
    pending = { key, request: { id: ++sequence, job: { ...job } }, waiters: new Set() };
    jobs.set(key, pending);
    queue.push(pending);
  }
  const work = pending;
  return new Promise((done, fail) => {
    const waiter: Waiter = { done, fail, timer: setTimeout(() => leave(work, waiter, new FileBusyError("the image did not answer in time")), Math.max(0, deadline - performance.now())) };
    work.waiters.add(waiter);
    waiters += 1;
    if (signal !== undefined) {
      const cancel = () => leave(work, waiter, new FileBusyError("the request was cancelled"));
      signal.addEventListener("abort", cancel, { once: true });
      waiter.unlisten = () => signal.removeEventListener("abort", cancel);
    }
    pump();
  });
}

function leave(pending: Pending, waiter: Waiter, outcome: ClaudeImageResult | null | Error): void {
  if (!pending.waiters.delete(waiter)) return;
  waiters -= 1;
  clearTimeout(waiter.timer);
  waiter.unlisten?.();
  if (outcome instanceof Error) waiter.fail(outcome);
  else waiter.done(outcome);
  if (pending.waiters.size === 0) {
    jobs.delete(pending.key);
    const at = queue.indexOf(pending);
    if (at >= 0) queue.splice(at, 1);
    // A running job stays attached to its physical thread until its real answer/close.
  }
}
function finish(pending: Pending, outcome: ClaudeImageResult | null | Error): void {
  for (const waiter of [...pending.waiters]) leave(pending, waiter, outcome);
}
function stop(reason: string): void {
  for (const pending of [...queue]) finish(pending, new FileBusyError(reason));
  if (thread !== null) retire(thread, new FileBusyError(reason));
}
function retire(current: Thread, error: Error): void {
  if (current.retiring) return;
  current.retiring = true;
  if (current.running !== null) finish(current.running, error);
  // Do not clear thread/running here: termination can wait for a blocked disk read.
  // Bun takes its shutdown keep-alive when termination begins: unref must happen BEFORE it,
  // so the last server can exit even if the worker's syscall never returns.
  current.worker.unref();
  void current.worker.terminate();
}
function validReply(value: unknown, job: ClaudeImageWork): value is ClaudeImageReply {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const reply = value as ClaudeImageReply;
  if (!Number.isSafeInteger(reply.id)) return false;
  if (reply.error !== undefined) return typeof reply.error === "string";
  if (reply.result === null) return true;
  const result = reply.result;
  if (result === undefined || typeof result !== "object" || Array.isArray(result)) return false;
  if (!("generation" in result) || typeof result.generation !== "string" || result.generation.length === 0) return false;
  if (job.op !== undefined) return true;
  return result !== undefined && "mediaType" in result && typeof result.mediaType === "string" && /^image\/(png|jpeg|gif|webp)$/.test(result.mediaType) && result.bytes instanceof Uint8Array && result.bytes.buffer instanceof ArrayBuffer && result.bytes.byteOffset === 0 && result.bytes.byteLength === result.bytes.buffer.byteLength && result.bytes.byteLength > 0 && result.bytes.byteLength <= MAX_IMAGE_BYTES;
}
function start(): Thread {
  const worker = new Worker(options.worker) as BunWorker;
  worker.unref();
  let closed = () => {};
  const opened = new Int32Array(new SharedArrayBuffer(4));
  opened[0] = -1;
  const current: Thread = { worker, running: null, retiring: false, opened, closed: new Promise((done) => { closed = done; }) };
  thread = current;
  worker.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (current.retiring) return;
    const pending = current.running;
    const reply = event.data;
    if (pending === null || !validReply(reply, pending.request.job) || reply.id !== pending.request.id) {
      retire(current, new Error("the image thread returned an invalid answer"));
      return;
    }
    current.running = null;
    worker.unref();
    finish(pending, reply.error !== undefined ? new Error(reply.error) : reply.result ?? null);
    pump();
  });
  worker.addEventListener("error", () => retire(current, new Error("the image thread failed")));
  worker.addEventListener("close", () => {
    if (current.running !== null) finish(current.running, new Error("the image thread ended"));
    const fd = Atomics.exchange(current.opened, 0, -1);
    if (fd >= 0) { try { closeSync(fd); } catch { /* the thread closed it before stopping */ } }
    if (thread === current) thread = null;
    closed();
    pump();
  });
  return current;
}
function pump(): void {
  if (queue.length === 0 || (thread !== null && (thread.retiring || thread.running !== null))) return;
  const pending = queue.shift()!;
  let current: Thread;
  try { current = thread ?? start(); }
  catch {
    finish(pending, new Error("the image thread could not start"));
    pump();
    return;
  }
  current.running = pending;
  current.worker.ref();
  try { current.worker.postMessage({ ...pending.request, opened: current.opened }); }
  catch { retire(current, new Error("the image task could not start")); }
}
