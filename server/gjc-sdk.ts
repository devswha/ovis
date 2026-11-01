import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import nodePath from "node:path";
import { promisify } from "node:util";
import { gjcSdkGenerationCurrent } from "./gjc-sdk-generation.ts";
import { GjcSdkLookupError, lookupExecutionError } from "./gjc-sdk-error.ts";

const PAGE_LIMIT = 100;
const MAX_PAGES = 8;
const MAX_ROWS = PAGE_LIMIT * MAX_PAGES;
// A full `gjc sdk session raw global --op session.list` call measured 1.0-2.0 s on a
// loaded Apple M1 Pro, so 2 s cut off many cold lookups. The 10 s SDK budget reserves 5 s
// of the client's 15 s local chat read for other work, whose timeouts are independent.
// Status discovery keeps the old shorter budget so snapshots do not inherit cold-chat waits.
const COMMAND_TIMEOUT_MS = 5_000;
const TOTAL_TIMEOUT_MS = 10_000;
const STATUS_COMMAND_TIMEOUT_MS = 2_000;
const STATUS_TOTAL_TIMEOUT_MS = 8_000;
// Share roster polls across discovery and exact lookups instead of repeatedly
// spawning the CLI. Managed generation/process/header checks remain per read.
const SESSION_LIST_CACHE_TTL_MS = 10_000;
const SESSION_LIST_MAX_STARTS = 6;
const SESSION_LIST_START_WINDOW_MS = 10_050;
const MAX_BUFFER = 1024 * 1024;
const MAX_CURSOR_LENGTH = 4096;

export interface GjcSdkCommandOptions {
  env: NodeJS.ProcessEnv;
  encoding: "utf8";
  timeout: number;
  killSignal: "SIGKILL";
  maxBuffer: number;
  shell: false;
  windowsHide: true;
}

/** A narrow seam for fixture-driven tests; production always uses execFile below. */
export type GjcSdkCommandRunner = (command: string, args: string[], options: GjcSdkCommandOptions) => Promise<string>;

export type GjcSdkWorktreeRootResolver = (cwd: string, timeoutMs: number) => Promise<string | null>;

export interface GjcSdkBinding {
  sessionId: string;
  pid: number;
  path: string;
  hostIncarnation: string;
  endpointGeneration: number;
  /** Includes retired/fence rows: a heartbeat may revive a same-pid session without registering it. */
  guardSessionIds: string[];
}

const execFileAsync = promisify(execFile);

const runGjcSdkCommand: GjcSdkCommandRunner = async (command, args, options) => {
  const execution = execFileAsync(command, args, options);
  execution.child.stdin?.end();
  const { stdout } = await execution;
  return stdout;
};

interface SessionListCacheEntry {
  readonly output: string;
  readonly expiresAt: number;
}

interface SessionListState {
  readonly cache: Map<string, SessionListCacheEntry>;
  readonly inFlight: Map<string, Promise<string>>;
  readonly queue: SessionListQueue;
}

interface SessionListQueue {
  tail: Promise<void>;
  starts: number[];
}

interface SdkReadRequest {
  readonly agentDir: string;
  readonly deadline: number;
  readonly commandTimeoutMs: number;
  readonly cacheClock: () => number;
}

interface SessionListRequest extends SdkReadRequest {
  readonly jsonInput: Record<string, unknown>;
}

interface SessionQueryRequest extends SdkReadRequest {
  readonly args: string[];
}

const sessionListStates = new WeakMap<GjcSdkCommandRunner, Map<string, SessionListState>>();
const sessionListQueues = new WeakMap<GjcSdkCommandRunner, SessionListQueue>();
const sessionListCacheClock = () => performance.now();

const GIT_MAX_BUFFER = 64 * 1024;

/** Git's exit code alone also covers permission, ownership and repository failures. */
export function isGitOutsideWorktree(error: unknown): boolean {
  return isRecord(error) && error.code === 128 && error.stdout === ""
    && typeof error.stderr === "string"
    && /^fatal: not a git repository \(or any of the parent directories\): \.git\r?\n$/.test(error.stderr);
}

const gitWorktreeRoot: GjcSdkWorktreeRootResolver = async (cwd, timeoutMs) => {
  const execution = execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
    env: { ...process.env, LC_ALL: "C" },
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: GIT_MAX_BUFFER,
    shell: false,
    windowsHide: true,
  });
  execution.child.stdin?.end();
  try {
    const { stdout } = await execution;
    return stdout.endsWith("\r\n") ? stdout.slice(0, -2) : stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
  } catch (error) {
    if (isGitOutsideWorktree(error)) return null;
    throw lookupExecutionError(error);
  }
};

interface BrokerPage {
  indexSeq: number;
  sessions: unknown[];
  continuationCursor: string | null;
  savedSession: unknown;
}

interface SessionBinding {
  sessionId: string;
  pid: number;
  hostIncarnation: string;
  endpointGeneration: number;
  canonicalCwd: string;
  locatorCwd: string;
  worktreeRoot: string | null;
  stateRoot: string | null;
}

export interface GjcSdkSessionIdentity {
  readonly sessionId: string;
  readonly pid: number;
  readonly hostIncarnation: string;
  readonly endpointGeneration: number;
}

type ResolvedSession = GjcSdkSessionIdentity & { readonly savedSession: unknown; readonly guardSessionIds: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function definitivelyRetired(row: Record<string, unknown>): boolean {
  return row.live === false
    || row.deleted === true
    || (row.terminal === true && row.terminalUncertain === false);
}

function collectGuardSessionIds(rows: readonly unknown[], pids: ReadonlySet<number>, sessionIds: Set<string>): void {
  for (const row of rows) {
    if (isRecord(row) && typeof row.pid === "number" && pids.has(row.pid) && nonEmptyString(row.sessionId)) {
      sessionIds.add(row.sessionId);
    }
  }
}

/**
 * GJC also publishes a generation-zero direct-session GC fence at the agent root.
 * It has no endpoint authority and can remain live after /new. Only this proven
 * shape is ignored; foreign-root, uncertain and malformed zero-generation rows
 * must still prevent a binding (SDK session-index.ts: isDirectSessionGcFenceRow).
 */
function directSessionFence(row: Record<string, unknown>, agentDir: string): boolean {
  if (!isRecord(row.locator)
    || !nonEmptyString(row.sessionId) || row.live !== true
    || row.endpointGeneration !== 0
    || row.terminal !== false || row.terminalUncertain !== false || row.ambiguous !== false
    || row.identityProvenance !== "composite"
    || !nonEmptyString(row.hostIncarnation) || row.processIncarnation !== row.hostIncarnation
    || row.endpointMtimeMs !== undefined || row.endpointFileId !== undefined || row.endpointIncarnation !== undefined) return false;
  const root = canonicalPath(agentDir);
  return root !== null && canonicalPath(row.locator.stateRoot) === root;
}

function canonicalPath(value: unknown): string | null {
  if (typeof value !== "string" || !nodePath.isAbsolute(value)) return null;
  try {
    const canonical = realpathSync.native(value);
    return process.platform === "win32" ? canonical.toLowerCase() : canonical;
  } catch (error) {
    throw lookupExecutionError(error);
  }
}

function parseBrokerPage(text: string): BrokerPage {
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new GjcSdkLookupError("unavailable");
  }
  if (!isRecord(envelope) || envelope.type !== "broker_response" || envelope.ok !== true || !isRecord(envelope.result))
    throw new GjcSdkLookupError("unavailable");
  const result = envelope.result;
  if (typeof result.indexSeq !== "number" || !Number.isSafeInteger(result.indexSeq) || result.indexSeq < 0 || !Array.isArray(result.sessions))
    throw new GjcSdkLookupError("unavailable");

  let continuationCursor: string | null = null;
  if (Object.hasOwn(result, "continuationCursor") && result.continuationCursor !== null) {
    if (typeof result.continuationCursor !== "string"
      || result.continuationCursor.length === 0
      || result.continuationCursor.length > MAX_CURSOR_LENGTH
      || result.continuationCursor.trim() !== result.continuationCursor
      || /[\u0000-\u001f\u007f]/.test(result.continuationCursor)) throw new GjcSdkLookupError("unavailable");
    continuationCursor = result.continuationCursor;
  }

  return { indexSeq: result.indexSeq, sessions: result.sessions, continuationCursor, savedSession: result.savedSession };
}

function bindingFromRow(value: unknown, pids: ReadonlySet<number>, cwd: string, worktreeRoot: string | null): SessionBinding | null {
  if (!isRecord(value)) return null;
  const locator = value.locator;
  if (!isRecord(locator)
    || typeof locator.cwd !== "string"
    || !Object.hasOwn(locator, "worktreeRoot")
    || !Object.hasOwn(locator, "stateRoot")
    || !(locator.worktreeRoot === null || typeof locator.worktreeRoot === "string")
    || !(locator.stateRoot === null || typeof locator.stateRoot === "string")) return null;

  const canonicalCwd = canonicalPath(locator.cwd);
  if (canonicalCwd === null || canonicalCwd !== cwd || canonicalPath(locator.worktreeRoot) !== worktreeRoot) return null;
  if (locator.worktreeRoot !== null && canonicalPath(locator.worktreeRoot) === null) return null;
  if (typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0 || !pids.has(value.pid)
    || !nonEmptyString(value.sessionId)
    || typeof value.endpointGeneration !== "number" || !Number.isSafeInteger(value.endpointGeneration) || value.endpointGeneration <= 0
    || !nonEmptyString(value.hostIncarnation)
    || value.identityProvenance !== "composite"
    || value.live !== true
    || value.terminal !== false
    || value.terminalUncertain !== false
    || value.ambiguous !== false
    || value.deleted === true) return null;

  return {
    sessionId: value.sessionId,
    pid: value.pid,
    hostIncarnation: value.hostIncarnation,
    endpointGeneration: value.endpointGeneration,
    canonicalCwd,
    locatorCwd: locator.cwd,
    worktreeRoot: locator.worktreeRoot,
    stateRoot: locator.stateRoot,
  };
}

function sameBinding(row: unknown, expected: SessionBinding, pids: ReadonlySet<number>, cwd: string, worktreeRoot: string | null): boolean {
  const actual = bindingFromRow(row, pids, cwd, worktreeRoot);
  return actual !== null
    && actual.sessionId === expected.sessionId
    && actual.pid === expected.pid
    && actual.hostIncarnation === expected.hostIncarnation
    && actual.endpointGeneration === expected.endpointGeneration
    && actual.canonicalCwd === expected.canonicalCwd
    && actual.worktreeRoot === expected.worktreeRoot
    && actual.stateRoot === expected.stateRoot;
}

function sdkArgs(agentDir: string, jsonInput?: Record<string, unknown>): string[] {
  const args = [
    "sdk", "session", "raw", "global",
    "--op", "session.list",
    "--page", "--limit", String(PAGE_LIMIT),
    "--agent-dir", agentDir,
    "--attach-only", "--json",
  ];
  if (jsonInput !== undefined) args.push("--json-input", JSON.stringify(jsonInput));
  return args;
}

async function runBounded(
  runner: GjcSdkCommandRunner,
  args: string[],
  deadline: number,
  commandTimeoutMs: number,
  onRunnerSettled: () => void,
): Promise<string> {
  const remaining = Math.min(commandTimeoutMs, deadline - Date.now());
  if (remaining <= 0) {
    onRunnerSettled();
    throw new GjcSdkLookupError("timeout");
  }

  const options: GjcSdkCommandOptions = {
    env: { ...process.env, GJC_SDK_BROKER_AUTOSTART: "0" },
    encoding: "utf8",
    timeout: remaining,
    killSignal: "SIGKILL",
    maxBuffer: MAX_BUFFER,
    shell: false,
    windowsHide: true,
  };

  const execution = Promise.resolve()
    .then(() => runner("gjc", args, options))
    .then(
      (output) => {
        onRunnerSettled();
        return output;
      },
      (error: unknown) => {
        onRunnerSettled();
        throw lookupExecutionError(error);
      },
    );

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      execution,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new GjcSdkLookupError("timeout")), remaining);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function sessionListState(runner: GjcSdkCommandRunner, agentDir: string): SessionListState {
  let directories = sessionListStates.get(runner);
  if (directories === undefined) {
    directories = new Map();
    sessionListStates.set(runner, directories);
  }

  let state = directories.get(agentDir);
  if (state === undefined) {
    let queue = sessionListQueues.get(runner);
    if (queue === undefined) {
      queue = { tail: Promise.resolve(), starts: [] };
      sessionListQueues.set(runner, queue);
    }
    state = { cache: new Map(), inFlight: new Map(), queue };
    directories.set(agentDir, state);
  }
  return state;
}

function cachedSessionList(state: SessionListState, key: string, now: number): string | null {
  for (const [entryKey, entry] of state.cache) {
    if (entry.expiresAt <= now) state.cache.delete(entryKey);
  }
  return state.cache.get(key)?.output ?? null;
}

async function waitForSessionList<T>(previous: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new GjcSdkLookupError("timeout");

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      previous,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new GjcSdkLookupError("timeout")), remaining);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function reserveSessionListStart(queue: SessionListQueue, deadline: number, clock: () => number): Promise<void> {
  for (;;) {
    const now = clock();
    queue.starts = queue.starts.filter((start) => start > now - SESSION_LIST_START_WINDOW_MS);
    if (queue.starts.length < SESSION_LIST_MAX_STARTS) {
      queue.starts.push(now);
      return;
    }
    // The queue is global, including other native agent roots. An identity lookup
    // that cannot fit the next slot in its existing deadline fails closed.
    const earliest = queue.starts[0];
    if (earliest === undefined) continue;
    const wait = earliest + SESSION_LIST_START_WINDOW_MS - now;
    if (wait >= deadline - Date.now()) throw new GjcSdkLookupError("timeout");
    await new Promise<void>((resolve) => setTimeout(resolve, Math.max(1, Math.ceil(wait))));
  }
}

async function runSerializedSdkRead(
  runner: GjcSdkCommandRunner,
  request: SessionListRequest | SessionQueryRequest,
  state: SessionListState,
  key?: string,
): Promise<string> {
  const { agentDir, deadline, commandTimeoutMs, cacheClock } = request;
  const previous = state.queue.tail;
  let releaseQueue: (() => void) | undefined;
  const queueTurn = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  state.queue.tail = previous.then(() => queueTurn);
  const release = () => releaseQueue?.();
  let acquired = false;
  let runnerPending = false;
  let callerFinished = false;
  const releaseWhenFinished = () => {
    if (callerFinished && !runnerPending) release();
  };

  try {
    await waitForSessionList(previous, deadline);
    acquired = true;

    if (key !== undefined) {
      const cachedAfterWait = cachedSessionList(state, key, cacheClock());
      if (cachedAfterWait !== null) return cachedAfterWait;
    }

    await reserveSessionListStart(state.queue, deadline, cacheClock);
    const args = "args" in request ? request.args : sdkArgs(agentDir, request.jsonInput);
    runnerPending = true;
    const output = await runBounded(runner, args, deadline, commandTimeoutMs, () => {
      runnerPending = false;
      releaseWhenFinished();
    });
    if (key !== undefined && "jsonInput" in request) {
      const parsed = parseBrokerPage(output);
      const exactLookup = Object.hasOwn(request.jsonInput, "resolveSessionId");
      if (parsed.sessions.length <= PAGE_LIMIT && (!exactLookup || parsed.continuationCursor === null)) {
        state.cache.set(key, { output, expiresAt: cacheClock() + SESSION_LIST_CACHE_TTL_MS });
      }
    }
    return output;
  } catch (error) {
    if (!acquired) void previous.then(release, release);
    throw error;
  } finally {
    if (acquired) {
      callerFinished = true;
      releaseWhenFinished();
    }
  }
}

function runCachedSessionList(
  runner: GjcSdkCommandRunner,
  request: SessionListRequest,
): Promise<string> {
  if (request.deadline <= Date.now()) throw new GjcSdkLookupError("timeout");

  const state = sessionListState(runner, request.agentDir);
  const key = JSON.stringify(request.jsonInput);
  const cached = cachedSessionList(state, key, request.cacheClock());
  if (cached !== null) return Promise.resolve(cached);

  const inFlight = state.inFlight.get(key);
  if (inFlight !== undefined) {
    // A short status read may share a cold chat query, but never its longer deadline.
    return waitForSessionList(inFlight, Math.min(request.deadline, Date.now() + request.commandTimeoutMs));
  }

  const requestPromise = runSerializedSdkRead(runner, request, state, key);
  state.inFlight.set(key, requestPromise);
  const removeInFlight = () => {
    if (state.inFlight.get(key) === requestPromise) state.inFlight.delete(key);
  };
  void requestPromise.then(removeInFlight, removeInFlight);
  return requestPromise;
}

async function resolveWorktreeRoot(
  resolver: GjcSdkWorktreeRootResolver,
  cwd: string,
  deadline: number,
  commandTimeoutMs: number,
): Promise<string | null | undefined> {
  const timeoutMs = Math.min(commandTimeoutMs, deadline - Date.now());
  if (timeoutMs <= 0) throw new GjcSdkLookupError("timeout");

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const root = await Promise.race([
      Promise.resolve().then(() => resolver(cwd, timeoutMs)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new GjcSdkLookupError("timeout")), timeoutMs);
      }),
    ]);
    return root === null ? null : canonicalPath(root) ?? undefined;
  } catch (error) {
    throw lookupExecutionError(error);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function resolveTranscript(
  pids: readonly number[],
  cwd: string,
  agentDir: string,
  runner: GjcSdkCommandRunner,
  worktreeRootResolver: GjcSdkWorktreeRootResolver,
  cacheClock: () => number = sessionListCacheClock,
  purpose: "chat" | "status" = "chat",
): Promise<ResolvedSession | null> {
  try {
    if (!Array.isArray(pids) || pids.length === 0 || pids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)
      || typeof cwd !== "string" || cwd === ""
      || typeof agentDir !== "string" || agentDir === "") return null;

    const commandTimeoutMs = purpose === "status" ? STATUS_COMMAND_TIMEOUT_MS : COMMAND_TIMEOUT_MS;
    const deadline = Date.now() + (purpose === "status" ? STATUS_TOTAL_TIMEOUT_MS : TOTAL_TIMEOUT_MS);
    const canonicalCwd = canonicalPath(cwd);
    if (canonicalCwd === null) return null;
    const canonicalWorktreeRoot = await resolveWorktreeRoot(worktreeRootResolver, canonicalCwd, deadline, commandTimeoutMs);
    if (canonicalWorktreeRoot === undefined) return null;
    const wantedPids = new Set(pids);
    const seenCursors = new Set<string>();
    const rows: unknown[] = [];
    const guardSessionIds = new Set<string>();
    let indexSeq: number | null = null;
    let cursor: string | null = null;
    const scope = {
      version: 1,
      requested: "pwd",
      requestAnchor: { cwd: canonicalCwd, worktreeRoot: canonicalWorktreeRoot },
    } as const;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const input = cursor === null ? { scope } : { scope, cursor };
      const output = await runCachedSessionList(runner, { agentDir, jsonInput: input, deadline, commandTimeoutMs, cacheClock });
      const response = parseBrokerPage(output);
      if (response.sessions.length > PAGE_LIMIT) throw new GjcSdkLookupError("unavailable");
      if (indexSeq !== null && response.indexSeq !== indexSeq) throw new GjcSdkLookupError("unavailable");
      indexSeq = response.indexSeq;
      if (rows.length + response.sessions.length > MAX_ROWS) throw new GjcSdkLookupError("unavailable");
      rows.push(...response.sessions);
      collectGuardSessionIds(response.sessions, wantedPids, guardSessionIds);

      cursor = response.continuationCursor;
      if (cursor === null) break;
      if (seenCursors.has(cursor)) throw new GjcSdkLookupError("unavailable");
      seenCursors.add(cursor);
      if (page === MAX_PAGES - 1) throw new GjcSdkLookupError("unavailable");
    }

    const candidates: SessionBinding[] = [];
    for (const row of rows) {
      if (!isRecord(row) || typeof row.pid !== "number" || !wantedPids.has(row.pid) || definitivelyRetired(row)) continue;
      if (directSessionFence(row, agentDir)) continue;
      if (row.live !== true) return null;
      const binding = bindingFromRow(row, wantedPids, canonicalCwd, canonicalWorktreeRoot);
      if (binding === null) return null;
      candidates.push(binding);
    }
    if (candidates.length !== 1) return null;
    const expected = candidates[0];
    if (expected === undefined) return null;

    const lookup = await runCachedSessionList(runner, {
      agentDir,
      jsonInput: { cwd: expected.locatorCwd, resolveSessionId: expected.sessionId },
      deadline,
      commandTimeoutMs,
      cacheClock,
    });
    const exact = parseBrokerPage(lookup);
    if (exact.sessions.length > PAGE_LIMIT) throw new GjcSdkLookupError("unavailable");
    if (exact.continuationCursor !== null || indexSeq === null || exact.indexSeq < indexSeq) throw new GjcSdkLookupError("unavailable");

    collectGuardSessionIds(exact.sessions, wantedPids, guardSessionIds);
    const samePidRows = exact.sessions.filter((row) => isRecord(row)
      && row.pid === expected.pid
      && !definitivelyRetired(row) && !directSessionFence(row, agentDir));
    if (samePidRows.length !== 1 || !sameBinding(samePidRows[0], expected, wantedPids, canonicalCwd, canonicalWorktreeRoot)) return null;
    if (!isRecord(samePidRows[0]) || samePidRows[0].sessionId !== expected.sessionId) return null;
    guardSessionIds.add(expected.sessionId);
    return {
      sessionId: expected.sessionId,
      pid: expected.pid,
      savedSession: exact.savedSession,
      hostIncarnation: expected.hostIncarnation,
      endpointGeneration: expected.endpointGeneration,
      guardSessionIds: [...guardSessionIds],
    };
  } catch (error) {
    throw lookupExecutionError(error);
  }
}

function savedTranscript(binding: ResolvedSession | null): GjcSdkBinding | null {
  if (!binding) return null;
  const savedSession = binding.savedSession;
  if (!isRecord(savedSession) || savedSession.id !== binding.sessionId
    || typeof savedSession.path !== "string" || !nodePath.isAbsolute(savedSession.path)) return null;
  return {
    sessionId: binding.sessionId,
    pid: binding.pid,
    path: savedSession.path,
    hostIncarnation: binding.hostIncarnation,
    endpointGeneration: binding.endpointGeneration,
    guardSessionIds: binding.guardSessionIds,
  };
}

function currentIdentity(binding: ResolvedSession | null): GjcSdkSessionIdentity | null {
  if (!binding) return null;
  return {
    sessionId: binding.sessionId,
    pid: binding.pid,
    hostIncarnation: binding.hostIncarnation,
    endpointGeneration: binding.endpointGeneration,
  };
}

export function gjcSdkCurrentSession(
  pids: readonly number[],
  cwd: string,
  agentDir: string,
): Promise<GjcSdkSessionIdentity | null> {
  return gjcSdkCurrentSessionWithRunner(pids, cwd, agentDir, runGjcSdkCommand);
}

export function gjcSdkCurrentSessionWithRunner(
  pids: readonly number[],
  cwd: string,
  agentDir: string,
  runner: GjcSdkCommandRunner,
  worktreeRootResolver: GjcSdkWorktreeRootResolver = gitWorktreeRoot,
  cacheClock: () => number = sessionListCacheClock,
  generationCurrent: typeof gjcSdkGenerationCurrent = gjcSdkGenerationCurrent,
): Promise<GjcSdkSessionIdentity | null> {
  return resolveTranscript(pids, cwd, agentDir, runner, worktreeRootResolver, cacheClock, "status")
    .then(async (binding) => binding && await generationCurrent(agentDir, binding.sessionId, binding.endpointGeneration) ? currentIdentity(binding) : null)
    .catch((error: unknown) => { throw lookupExecutionError(error); });
}

/** Resolves the current readable GJC transcript for one of the pane's known GJC processes. */
export function gjcSdkTranscript(
  pids: readonly number[],
  cwd: string,
  agentDir: string,
  purpose: "chat" | "status" = "chat",
): Promise<GjcSdkBinding | null> {
  return gjcSdkTranscriptWithRunner(pids, cwd, agentDir, runGjcSdkCommand, gitWorktreeRoot, sessionListCacheClock, gjcSdkGenerationCurrent, purpose);
}

/** Fixture-injection entry point; production callers should use gjcSdkTranscript. */
export function gjcSdkTranscriptWithRunner(
  pids: readonly number[],
  cwd: string,
  agentDir: string,
  runner: GjcSdkCommandRunner,
  worktreeRootResolver: GjcSdkWorktreeRootResolver = gitWorktreeRoot,
  cacheClock: () => number = sessionListCacheClock,
  generationCurrent: typeof gjcSdkGenerationCurrent = gjcSdkGenerationCurrent,
  purpose: "chat" | "status" = "chat",
): Promise<GjcSdkBinding | null> {
  return resolveTranscript(pids, cwd, agentDir, runner, worktreeRootResolver, cacheClock, purpose)
    .then(async (binding) => binding && await generationCurrent(agentDir, binding.sessionId, binding.endpointGeneration) ? savedTranscript(binding) : null)
    .catch((error: unknown) => { throw lookupExecutionError(error); });
}

/** The only broker queries the bridge asks: reads, never a control or lifecycle operation. */
export type GjcSdkReadQuery = "runtime.capabilities" | "skill.list/state";
const READ_QUERIES: ReadonlySet<string> = new Set<GjcSdkReadQuery>(["runtime.capabilities", "skill.list/state"]);
const QUERY_TIMEOUT_MS = 1_200;

/**
 * One read-only query of a live session through the broker, attach-only: a broker that is not
 * already running fails the call instead of being started. Resolves the broker's response
 * (`{ ok: true, page | result }`); invalid requests return null and failed reads throw typed unavailable.
 */
export async function gjcSdkQuery(
  agentDir: string,
  sessionId: string,
  query: GjcSdkReadQuery,
  options: { runner?: GjcSdkCommandRunner; cacheClock?: () => number } = {},
): Promise<Record<string, unknown> | null> {
  if (!READ_QUERIES.has(query) || !nonEmptyString(sessionId) || sessionId.startsWith("-") || !nodePath.isAbsolute(agentDir)) return null;
  const args = ["sdk", "session", "raw", "query", sessionId, "--query", query, "--agent-dir", agentDir, "--attach-only", "--json"];
  const runner = options.runner ?? runGjcSdkCommand;
  let stdout: string;
  try {
    stdout = await runSerializedSdkRead(runner, {
      agentDir, args, deadline: Date.now() + QUERY_TIMEOUT_MS,
      commandTimeoutMs: QUERY_TIMEOUT_MS, cacheClock: options.cacheClock ?? sessionListCacheClock,
    }, sessionListState(runner, agentDir));
  } catch (error) { throw lookupExecutionError(error); }
  try {
    const response: unknown = JSON.parse(stdout);
    if (!isRecord(response) || response.ok !== true) throw new GjcSdkLookupError("unavailable");
    return response;
  } catch (error) { throw lookupExecutionError(error); }
}
