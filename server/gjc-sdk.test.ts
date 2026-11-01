/// <reference lib="es2024.sharedmemory" />
import { afterAll, describe, expect, it, jest, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { GjcSdkLookupError } from "./gjc-sdk-error.ts";
import { gjcSdkGenerationCurrent } from "./gjc-sdk-generation.ts";
import {
  isGitOutsideWorktree,
  gjcSdkCurrentSessionWithRunner as sdkCurrentSessionWithRunner,
  gjcSdkQuery,
  gjcSdkTranscriptWithRunner as sdkTranscriptWithRunner,
  type GjcSdkCommandOptions,
  type GjcSdkCommandRunner,
  type GjcSdkWorktreeRootResolver,
} from "./gjc-sdk.ts";

const cwd = mkdtempSync(join(tmpdir(), "gjc-sdk-test-"));
const agentDir = join(cwd, "agent");
const savedPath = join(cwd, "sessions", "session.jsonl");
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

const locator = () => ({ cwd, worktreeRoot: cwd, stateRoot: join(cwd, ".gjc", "state") });

const testWorktreeRootResolver: GjcSdkWorktreeRootResolver = async () => cwd;
const currentGeneration = async () => true;

function gjcSdkTranscriptWithRunner(
  pids: readonly number[],
  workingDirectory: string,
  directory: string,
  runner: GjcSdkCommandRunner,
  rootResolver: GjcSdkWorktreeRootResolver = testWorktreeRootResolver,
  cacheClock?: () => number,
  generationCurrent: typeof import("./gjc-sdk-generation.ts").gjcSdkGenerationCurrent = async () => true,
  purpose: "chat" | "status" = "chat",
) {
  return sdkTranscriptWithRunner(pids, workingDirectory, directory, runner, rootResolver, cacheClock, generationCurrent, purpose);
}

function gjcSdkCurrentSessionWithRunner(
  pids: readonly number[],
  workingDirectory: string,
  directory: string,
  runner: GjcSdkCommandRunner,
  rootResolver: GjcSdkWorktreeRootResolver = testWorktreeRootResolver,
  cacheClock?: () => number,
  generationCurrent: typeof import("./gjc-sdk-generation.ts").gjcSdkGenerationCurrent = async () => true,
) {
  return sdkCurrentSessionWithRunner(pids, workingDirectory, directory, runner, rootResolver, cacheClock, generationCurrent);
}

function session(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: "session-1",
    locator: locator(),
    endpointGeneration: 4,
    pid: 321,
    hostIncarnation: "linux:12345",
    identityProvenance: "composite",
    terminalUncertain: false,
    ambiguous: false,
    terminal: false,
    live: true,
    ...overrides,
  };
}

function broker(result: Record<string, unknown>): string {
  return JSON.stringify({ type: "broker_response", ok: true, result });
}

function page(sessions: unknown[], extra: Record<string, unknown> = {}): string {
  return broker({ indexSeq: 11, sessions, ...extra });
}

function scope(cwd: string, worktreeRoot: string | null = cwd) {
  return { version: 1, requested: "pwd", requestAnchor: { cwd, worktreeRoot } };
}

function saved(row: Record<string, unknown> = session(), id = "session-1", path = savedPath): string {
  return page([row], { savedSession: { id, path } });
}

interface Call {
  command: string;
  args: string[];
  options: GjcSdkCommandOptions;
}

function fakeRunner(
  output: readonly string[] | ((args: string[], call: number) => string | Promise<string>),
): { calls: Call[]; runner: GjcSdkCommandRunner } {
  const calls: Call[] = [];
  const runner: GjcSdkCommandRunner = async (command, args, options) => {
    const call = calls.length;
    calls.push({ command, args: [...args], options });
    if (typeof output === "function") return output(args, call);
    const response = output[call];
    if (response === undefined) throw new Error("Unexpected SDK command");
    return response;
  };
  return { calls, runner };
}

/** Bun freezes timer APIs under fake time; a native wait gives event waits a real deadline. */
async function bounded<T>(promise: Promise<T>): Promise<T> {
  const state = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Atomics.waitAsync(state, 0, 0, 1000);
  if (!deadline.async) throw new Error("SDK test deadline could not start");
  try {
    return await Promise.race([
      promise,
      deadline.value.then(() => { throw new Error("SDK test event did not arrive"); }),
    ]);
  } finally {
    Atomics.notify(state, 0);
  }
}

function timedStep<T>(value: T, duration: number) {
  const started = Promise.withResolvers<void>();
  return {
    started: started.promise,
    run: () => new Promise<T>((resolve) => {
      // fixed wait: simulated command duration is the deadline behaviour under test.
      setTimeout(() => resolve(value), duration);
      started.resolve();
    }),
  };
}

const commandArgs = [
  "sdk", "session", "raw", "global",
  "--op", "session.list",
  "--page", "--limit", "100",
  "--agent-dir", agentDir,
  "--attach-only", "--json",
];

describe("GJC live identity independent of saved-store indexing", () => {
  it("accepts a null Git anchor only for the exact non-worktree diagnostic", async () => {
    const outside = { code: 128, stdout: "", stderr: "fatal: not a git repository (or any of the parent directories): .git\n" };
    expect(isGitOutsideWorktree(outside)).toBe(true);
    for (const failure of [
      { ...outside, stderr: "fatal: detected dubious ownership in repository at '/private/work'\n" },
      { ...outside, stderr: "fatal: cannot open .git/config: Permission denied\n" },
      { ...outside, stderr: "Permission denied\n" + outside.stderr },
      { ...outside, stdout: "unexpected" },
      { ...outside, code: "EACCES" },
    ]) expect(isGitOutsideWorktree(failure)).toBe(false);
    const row = session({ locator: { ...locator(), worktreeRoot: null } });
    const fixture = fakeRunner([page([row]), saved(row)]);
    await expect(sdkCurrentSessionWithRunner([321], cwd, agentDir, fixture.runner, undefined, undefined, currentGeneration))
      .resolves.toMatchObject({ sessionId: "session-1" });
    expect(fixture.calls).toHaveLength(2);
  });

  it.each([
    null,
    { id: "session-1" },
    { id: "session-1", path: "" },
    { id: "session-1", path: "relative.jsonl" },
    { id: "wrong-session", path: savedPath },
    { id: "session-1", path: savedPath },
  ])("rejects native revocation with unchanged cached pages and saved metadata %j", async (savedSession) => {
    for (const revoked of ["retired", "replaced", "unknown"]) {
      const fixture = fakeRunner([page([session()]), page([session()], { savedSession })]);
      let status = "current";
      const observations: [string, number][] = [];
      const generation = (directory: string, id: string, endpointGeneration: number) => gjcSdkGenerationCurrent(directory, id, endpointGeneration, {
        generationStatus: async (sessionId, generation) => {
          observations.push([sessionId, generation]);
          return { status };
        },
      });
      const lookup = (reader: typeof sdkCurrentSessionWithRunner | typeof sdkTranscriptWithRunner) =>
        reader([321], cwd, agentDir, fixture.runner, testWorktreeRootResolver, undefined, generation);
      expect((await lookup(sdkCurrentSessionWithRunner))?.sessionId).toBe("session-1");
      const transcript = await lookup(sdkTranscriptWithRunner);
      if (savedSession?.id === "session-1" && savedSession.path === savedPath) expect(transcript).toMatchObject({ sessionId: "session-1", path: savedPath });
      else expect(transcript).toBeNull();
      status = revoked;
      expect(await lookup(sdkCurrentSessionWithRunner)).toBeNull();
      expect(await lookup(sdkTranscriptWithRunner)).toBeNull();
      status = "current";
      expect((await lookup(sdkCurrentSessionWithRunner))?.sessionId).toBe("session-1");
      expect(observations).toEqual(Array.from({ length: 5 }, () => ["session-1", 4]));
      expect(fixture.calls).toHaveLength(2);
    }
  });

  it.each([
    { code: "ENOENT", reason: "unavailable" },
    { code: "EACCES", reason: "unavailable" },
    { code: "ENOEXEC", reason: "unavailable" },
    { code: "EIO", reason: "unavailable" },
    { code: "BROKER", reason: "unavailable" },
    { code: "ETIMEDOUT", reason: "timeout" },
    { killed: true, reason: "timeout" },
    { signal: "SIGKILL", reason: "timeout" },
    { code: "ERR_CHILD_PROCESS_TIMEOUT", reason: "timeout" },
  ])("rechecks %j across status and chat sharing warm broker pages", async ({ reason, ...metadata }) => {
    const fixture = fakeRunner([page([session()]), saved()]);
    let unavailable = false;
    const proofs: [string, number][] = [];
    const generation = (directory: string, id: string, endpoint: number) => gjcSdkGenerationCurrent(directory, id, endpoint, {
      generationStatus: async (sessionId, endpointGeneration) => {
        expect(directory).toBe(agentDir);
        proofs.push([sessionId, endpointGeneration]);
        if (unavailable) throw Object.assign(new Error(`private cross-purpose evidence ${savedPath}`), metadata);
        return { status: "current" };
      },
    });
    const read = (purpose: "chat" | "status") => sdkTranscriptWithRunner(
      [321], cwd, agentDir, fixture.runner, testWorktreeRootResolver, () => 0, generation, purpose,
    );
    expect(await read("status")).toMatchObject({ sessionId: "session-1", path: savedPath });
    unavailable = true;
    for (const purpose of ["chat", "status"] as const) {
      const failure = await read(purpose).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(GjcSdkLookupError);
      expect(failure).toMatchObject({ reason, message: "GJC SDK lookup failed" });
      expect(JSON.stringify(failure)).not.toContain(savedPath);
    }
    unavailable = false;
    expect(await read("chat")).toMatchObject({ sessionId: "session-1", path: savedPath });
    expect(proofs).toEqual(Array.from({ length: 4 }, () => ["session-1", 4]));
    expect(fixture.calls).toHaveLength(2);
  });

  it.each(["ENOENT", "EACCES", "BROKER", "ETIMEDOUT"])("does not share an in-flight %s generation proof between cached readers", async (code) => {
    const readers = [sdkCurrentSessionWithRunner, sdkTranscriptWithRunner];
    for (const savedSession of [
      null,
      { id: "session-1" },
      { id: "session-1", path: "" },
      { id: "session-1", path: "relative.jsonl" },
      { id: "wrong-session", path: savedPath },
      { id: "session-1", path: savedPath },
    ]) {
      for (const heldReader of [0, 1]) {
        const fixture = fakeRunner([page([session()]), page([session()], { savedSession })]);
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const observed: number[] = [];
        const read = (index: number) => readers[index]!(
          [321], cwd, agentDir, fixture.runner, testWorktreeRootResolver, undefined,
          (directory, id, generation) => gjcSdkGenerationCurrent(directory, id, generation, {
            generationStatus: async (sessionId, endpointGeneration) => {
              expect([directory, sessionId, endpointGeneration]).toEqual([agentDir, "session-1", 4]);
              observed.push(index);
              if (index === heldReader) {
                entered.resolve();
                await release.promise;
                throw Object.assign(new Error(`private held generation ${savedPath}`), { code });
              }
              return { status: "current" };
            },
          }),
        );
        const held = read(heldReader).catch((error: unknown) => error);
        try {
          await entered.promise;
          const independent = await read(1 - heldReader);
          const readable = savedSession?.id === "session-1" && savedSession.path === savedPath;
          if (heldReader === 0 && !readable) expect(independent).toBeNull();
          else expect(independent).toMatchObject({ sessionId: "session-1", pid: 321 });
          expect(observed).toEqual([heldReader, 1 - heldReader]);
          expect(fixture.calls).toHaveLength(2);
        } finally { release.resolve(); }
        const failure = await held;
        expect(failure).toBeInstanceOf(GjcSdkLookupError);
        expect(failure).toMatchObject({ reason: code === "ETIMEDOUT" ? "timeout" : "unavailable", message: "GJC SDK lookup failed" });
        expect(JSON.stringify(failure)).not.toContain(savedPath);
        expect(fixture.calls).toHaveLength(2);
      }
    }
  });

  it("keeps a hung generation proof independent of another cached reader and recovers after timeout", async () => {
    jest.useFakeTimers();
    try {
      const readers = [sdkCurrentSessionWithRunner, sdkTranscriptWithRunner];
      for (const savedSession of [
        null,
        { id: "session-1" },
        { id: "session-1", path: "" },
        { id: "session-1", path: "relative.jsonl" },
        { id: "wrong-session", path: savedPath },
        { id: "session-1", path: savedPath },
      ]) {
        for (const heldReader of [0, 1]) {
          const fixture = fakeRunner([page([session()]), page([session()], { savedSession })]);
          const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
          const observed: number[] = [];
          let hold = true;
          const read = (index: number) => readers[index]!(
            [321], cwd, agentDir, fixture.runner, testWorktreeRootResolver, undefined,
            (directory, id, generation) => gjcSdkGenerationCurrent(directory, id, generation, {
              generationStatus: async (sessionId, endpointGeneration) => {
                expect([directory, sessionId, endpointGeneration]).toEqual([agentDir, "session-1", 4]);
                observed.push(index);
                if (hold && index === heldReader) { entered.resolve(); await release.promise; }
                return { status: "current" };
              },
            }),
          );
          const held = read(heldReader).catch((error: unknown) => error);
          try {
            await bounded(entered.promise);
            const independent = await bounded(read(1 - heldReader));
            const readable = savedSession?.id === "session-1" && savedSession.path === savedPath;
            if (heldReader === 0 && !readable) expect(independent).toBeNull();
            else expect(independent).toMatchObject({ sessionId: "session-1", pid: 321 });
            expect(observed).toEqual([heldReader, 1 - heldReader]);
            expect(fixture.calls).toHaveLength(2);
            jest.advanceTimersByTime(2_000);
            expect(await bounded(held)).toEqual(new GjcSdkLookupError("timeout"));
            hold = false;
            const recovered = await bounded(read(heldReader));
            if (heldReader === 1 && !readable) expect(recovered).toBeNull();
            else expect(recovered).toMatchObject({ sessionId: "session-1", pid: 321 });
            expect(observed).toEqual([heldReader, 1 - heldReader, heldReader]);
            expect(fixture.calls).toHaveLength(2);
          } finally { release.resolve(); await held; }
        }
      }
    } finally { jest.clearAllTimers(); jest.useRealTimers(); }
  });

  it.each(["retired", "replaced", "unknown"])("does not borrow another reader's current proof while its own generation becomes %s", async (status) => {
    const readers = [sdkCurrentSessionWithRunner, sdkTranscriptWithRunner];
    for (const savedSession of [null, { id: "session-1", path: savedPath }]) {
      for (const heldReader of [0, 1]) {
        const fixture = fakeRunner([page([session()]), page([session()], { savedSession })]);
        const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
        const observed: number[] = [];
        let hold = true;
        const read = (index: number) => readers[index]!(
          [321], cwd, agentDir, fixture.runner, testWorktreeRootResolver, undefined,
          (directory, id, generation) => gjcSdkGenerationCurrent(directory, id, generation, {
            generationStatus: async (sessionId, endpointGeneration) => {
              expect([directory, sessionId, endpointGeneration]).toEqual([agentDir, "session-1", 4]);
              observed.push(index);
              if (hold && index === heldReader) {
                entered.resolve();
                await release.promise;
                return { status };
              }
              return { status: "current" };
            },
          }),
        );
        const held = read(heldReader);
        try {
          await bounded(entered.promise);
          const independent = await read(1 - heldReader);
          if (heldReader === 0 && savedSession === null) expect(independent).toBeNull();
          else expect(independent).toMatchObject({ sessionId: "session-1", pid: 321 });
          expect(observed).toEqual([heldReader, 1 - heldReader]);
        } finally { release.resolve(); }
        expect(await held).toBeNull();
        hold = false;
        const recovered = await read(heldReader);
        if (heldReader === 1 && savedSession === null) expect(recovered).toBeNull();
        else expect(recovered).toMatchObject({ sessionId: "session-1", pid: 321 });
        expect(observed).toEqual([heldReader, 1 - heldReader, heldReader]);
        expect(fixture.calls).toHaveLength(2);
      }
    }
  });

  it.each(["ENOENT", "EACCES", "EPERM", "BROKER", "EPIPE", "ECONNREFUSED", "ETIMEDOUT"])("propagates native generation %s through both cached SDK readers", async (code) => {
    for (const savedSession of [
      null,
      { id: "session-1" },
      { id: "session-1", path: "" },
      { id: "session-1", path: "relative.jsonl" },
      { id: "wrong-session", path: savedPath },
      { id: "session-1", path: savedPath },
    ]) {
      const fixture = fakeRunner([page([session()]), page([session()], { savedSession })]);
      let unavailable = true;
      const observations: [string, number][] = [];
      const generationCurrent = (directory: string, id: string, generation: number) => gjcSdkGenerationCurrent(directory, id, generation, {
        generationStatus: async (sessionId, endpointGeneration) => {
          observations.push([sessionId, endpointGeneration]);
          if (unavailable) throw Object.assign(new Error("private generation evidence"), { code });
          return { status: "current" };
        },
      });
      const read = (lookup: typeof sdkCurrentSessionWithRunner | typeof sdkTranscriptWithRunner) =>
        lookup([321], cwd, agentDir, fixture.runner, testWorktreeRootResolver, undefined, generationCurrent);
      for (const lookup of [sdkCurrentSessionWithRunner, sdkTranscriptWithRunner]) {
        const failure = await read(lookup).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(GjcSdkLookupError);
        expect(failure).toMatchObject({ reason: code === "ETIMEDOUT" ? "timeout" : "unavailable", message: "GJC SDK lookup failed" });
        expect(JSON.stringify(failure)).not.toContain("private generation evidence");
      }
      unavailable = false;
      expect(await read(sdkCurrentSessionWithRunner)).toMatchObject({ sessionId: "session-1", pid: 321 });
      const transcript = await read(sdkTranscriptWithRunner);
      if (savedSession?.id !== "session-1" || savedSession.path !== savedPath) expect(transcript).toBeNull();
      else expect(transcript).toMatchObject({ sessionId: "session-1", path: savedPath });
      expect(observations).toEqual(Array.from({ length: 4 }, () => ["session-1", 4]));
      expect(fixture.calls).toHaveLength(2);
    }
  });

  it.each(["ENOENT", "EACCES", "BROKER", "ETIMEDOUT"])("isolates concurrent %s generation failures while sharing cached SDK pages", async (code) => {
    const readers = [sdkCurrentSessionWithRunner, sdkTranscriptWithRunner];
    for (const savedSession of [null, { id: "session-1", path: savedPath }]) {
      for (const failedReader of [0, 1]) {
        const fixture = fakeRunner([page([session()]), page([session()], { savedSession })]);
        const observations: number[] = [];
        const results = await Promise.allSettled(readers.map((reader, index) => reader(
          [321], cwd, agentDir, fixture.runner, testWorktreeRootResolver, undefined,
          (directory, id, generation) => gjcSdkGenerationCurrent(directory, id, generation, {
            generationStatus: async (sessionId, endpointGeneration) => {
              observations.push(index);
              expect([directory, sessionId, endpointGeneration]).toEqual([agentDir, "session-1", 4]);
              if (index === failedReader) throw Object.assign(new Error(`private generation ${savedPath}`), { code });
              return { status: "current" };
            },
          }),
        )));
        const failed = results[failedReader]!;
        expect(failed.status).toBe("rejected");
        if (failed.status !== "rejected") throw new Error("Unavailable generation was authorized");
        expect(failed.reason).toBeInstanceOf(GjcSdkLookupError);
        expect(failed.reason).toMatchObject({ reason: code === "ETIMEDOUT" ? "timeout" : "unavailable", message: "GJC SDK lookup failed" });
        expect(JSON.stringify(failed.reason)).not.toContain(savedPath);
        const other = results[1 - failedReader]!;
        expect(other.status).toBe("fulfilled");
        if (other.status !== "fulfilled") throw new Error("Another reader inherited the failed proof");
        if (failedReader === 0 && savedSession === null) expect(other.value).toBeNull();
        else expect(other.value).toMatchObject({ sessionId: "session-1", pid: 321 });
        expect(observations.sort()).toEqual([0, 1]);
        expect(fixture.calls).toHaveLength(2);
      }
    }
  });

  it.each(["ENOENT", "EACCES", "EPERM", "BROKER", "EPIPE", "ECONNREFUSED", "ETIMEDOUT"])("sanitizes raw generation %s rejections even with cached SDK pages", async (code) => {
    for (const savedSession of [null, { id: "session-1", path: savedPath }]) {
      const fixture = fakeRunner([page([session()]), page([session()], { savedSession })]);
      let unavailable = false;
      const generationCurrent = async () => {
        if (unavailable) throw Object.assign(new Error(`private generation ${savedPath}`), { code });
        return true;
      };
      const read = (lookup: typeof sdkCurrentSessionWithRunner | typeof sdkTranscriptWithRunner) =>
        lookup([321], cwd, agentDir, fixture.runner, testWorktreeRootResolver, undefined, generationCurrent);
      expect(await read(sdkCurrentSessionWithRunner)).toMatchObject({ sessionId: "session-1" });
      unavailable = true;
      for (const lookup of [sdkCurrentSessionWithRunner, sdkTranscriptWithRunner]) {
        const failure = await read(lookup).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(GjcSdkLookupError);
        expect(failure).toMatchObject({ reason: code === "ETIMEDOUT" ? "timeout" : "unavailable", message: "GJC SDK lookup failed" });
        expect(JSON.stringify(failure)).not.toContain(savedPath);
      }
      unavailable = false;
      expect(await read(sdkCurrentSessionWithRunner)).toMatchObject({ sessionId: "session-1" });
      expect(fixture.calls).toHaveLength(2);
    }
  });

  it.each(["ENOENT", "EACCES", "EPERM", "ENOEXEC", "EIO", "BROKER", "EPIPE", "ECONNREFUSED", "ERR_CHILD_PROCESS_TIMEOUT", "ETIMEDOUT"])("rejects %s without leaking CLI details or erasing a pending identity", async (code) => {
    const runner: GjcSdkCommandRunner = async () => { throw Object.assign(new Error("secret /home/user/private"), { code }); };
    for (const lookup of [gjcSdkCurrentSessionWithRunner, gjcSdkTranscriptWithRunner]) {
      const failure = lookup([321], cwd, agentDir, runner);
      await expect(failure).rejects.toBeInstanceOf(GjcSdkLookupError);
      await expect(failure).rejects.toMatchObject({ reason: code === "ETIMEDOUT" || code === "ERR_CHILD_PROCESS_TIMEOUT" ? "timeout" : "unavailable" });
      await expect(failure).rejects.not.toThrow("secret");
    }
  });

  it.each(["ENOENT", "EACCES", "BROKER", "ETIMEDOUT"])("retries an exact %s broker failure without caching absence or borrowing generation proof", async (code) => {
    for (const reader of [sdkCurrentSessionWithRunner, sdkTranscriptWithRunner]) {
      for (const savedSession of [null, { id: "session-1", path: savedPath }]) {
        const fixture = fakeRunner((_args, call) => {
          if (call === 1) throw Object.assign(new Error(`private exact lookup ${savedPath}`), { code });
          return page([session()], call === 0 ? {} : { savedSession });
        });
        const proofs: [string, number][] = [];
        const generation = async (_directory: string, id: string, endpoint: number) => {
          proofs.push([id, endpoint]);
          return true;
        };
        const read = (lookup: typeof reader) => lookup([321], cwd, agentDir, fixture.runner, testWorktreeRootResolver, () => 0, generation);
        await expect(read(reader)).rejects.toMatchObject({ name: "GjcSdkLookupError", reason: code === "ETIMEDOUT" ? "timeout" : "unavailable", message: "GJC SDK lookup failed" });
        expect(proofs).toEqual([]);
        expect(fixture.calls).toHaveLength(2);
        await expect(read(sdkCurrentSessionWithRunner)).resolves.toMatchObject({ sessionId: "session-1", pid: 321 });
        const transcript = await read(sdkTranscriptWithRunner);
        if (savedSession === null) expect(transcript).toBeNull();
        else expect(transcript).toMatchObject({ sessionId: "session-1", path: savedPath });
        expect(proofs).toEqual([["session-1", 4], ["session-1", 4]]);
        // Only the failed exact lookup is retried; both readers reuse successful pages.
        expect(fixture.calls).toHaveLength(3);
      }
    }
  });

  it("checks generation for a current identity without a saved transcript", async () => {
    const fixture = fakeRunner([page([session()]), page([session()], { savedSession: null })]);
    const observed: string[] = [];
    const generationCurrent: typeof import("./gjc-sdk-generation.ts").gjcSdkGenerationCurrent = async (directory, id, generation) => {
      observed.push(`${directory}:${id}:${generation}`);
      return observed.length === 1;
    };
    await expect(gjcSdkCurrentSessionWithRunner([321], cwd, agentDir, fixture.runner, testWorktreeRootResolver, undefined, generationCurrent))
      .resolves.toMatchObject({ sessionId: "session-1" });
    await expect(gjcSdkCurrentSessionWithRunner([321], cwd, agentDir, fixture.runner, testWorktreeRootResolver, undefined, generationCurrent))
      .resolves.toBeNull();
    expect(observed).toEqual([`${agentDir}:session-1:4`, `${agentDir}:session-1:4`]);
    expect(fixture.calls).toHaveLength(2);
  });
  it("proves the current private session even when the saved-store index has no path", async () => {
    const fixture = fakeRunner([page([session()]), page([session()], { savedSession: null })]);
    expect(await gjcSdkCurrentSessionWithRunner([321], cwd, agentDir, fixture.runner, testWorktreeRootResolver))
      .toEqual({ sessionId: "session-1", pid: 321, hostIncarnation: "linux:12345", endpointGeneration: 4 });
    const transcript = fakeRunner([page([session()]), page([session()], { savedSession: null })]);
    expect(await gjcSdkTranscriptWithRunner([321], cwd, agentDir, transcript.runner)).toBeNull();
  });

  it.each([
    undefined,
    null,
    false,
    [],
    "unindexed",
    { id: "session-1" },
    { id: "session-1", path: "relative.jsonl" },
    { id: "another-session", path: savedPath },
  ])("keeps live authority separate from unreadable saved metadata %j", async (savedSession) => {
    const fixture = fakeRunner([page([session()]), page([session()], { savedSession })]);
    const generations: [string, number][] = [];
    const generationCurrent = async (_directory: string, id: string, generation: number) => {
      generations.push([id, generation]);
      return true;
    };
    await expect(sdkCurrentSessionWithRunner([321], cwd, agentDir, fixture.runner, testWorktreeRootResolver, undefined, generationCurrent))
      .resolves.toMatchObject({ sessionId: "session-1", pid: 321 });
    await expect(sdkTranscriptWithRunner([321], cwd, agentDir, fixture.runner, testWorktreeRootResolver, undefined, generationCurrent)).resolves.toBeNull();
    expect(generations).toEqual([["session-1", 4], ["session-1", 4]]);
    expect(fixture.calls).toHaveLength(2);
  });

  it("does not relax ambiguous, uncertain or changed live authority for private sessions", async () => {
    for (const invalid of [{ ambiguous: true }, { terminalUncertain: true }, { live: false }, { endpointGeneration: 5 }, { hostIncarnation: "linux:other" }]) {
      const fixture = fakeRunner([page([session()]), page([session(invalid)], { savedSession: null })]);
      expect(await gjcSdkCurrentSessionWithRunner([321], cwd, agentDir, fixture.runner, testWorktreeRootResolver)).toBeNull();
    }
  });
});

describe("GJC SDK transcript identity binding", () => {
  it("ignores only the proven generation-zero direct-session GC fence after /new", async () => {
    mkdirSync(agentDir, { recursive: true });
    const fence = session({
      sessionId: "previous-session",
      endpointGeneration: 0,
      processIncarnation: "linux:12345",
      locator: { ...locator(), stateRoot: agentDir },
    });
    const valid = fakeRunner([page([fence, session()]), saved()]);
    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, valid.runner))
      .resolves.toMatchObject({ sessionId: "session-1" });
    for (const invalid of [
      { ...fence, locator: { ...locator(), stateRoot: cwd } },
      { ...fence, terminalUncertain: true },
      { ...fence, ambiguous: true },
      { ...fence, processIncarnation: "linux:other" },
      { ...fence, endpointFileId: "unexpected-endpoint" },
    ]) {
      const { runner } = fakeRunner([page([invalid, session()]), saved()]);
      await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner)).resolves.toBeNull();
    }
  });

  it("uses a null SDK worktree anchor for a directory outside Git", async () => {
    const row = session({ locator: { ...locator(), worktreeRoot: null } });
    const { calls, runner } = fakeRunner([page([row]), saved(row)]);
    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner, async () => null))
      .resolves.toMatchObject({ sessionId: "session-1" });
    expect(calls[0]!.args).toEqual([...commandArgs, "--json-input", JSON.stringify({ scope: scope(cwd, null) })]);
  });

  it("resolves the matching process identity and the SDK's saved file", async () => {
    const { calls, runner } = fakeRunner([page([session()]), saved()]);

    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner)).resolves.toEqual({
      sessionId: "session-1",
      pid: 321,
      path: savedPath,
      hostIncarnation: "linux:12345",
      endpointGeneration: 4,
      guardSessionIds: ["session-1"],
    });
    expect(calls.map(({ command, args }) => [command, args])).toEqual([
      ["gjc", [...commandArgs, "--json-input", JSON.stringify({ scope: scope(cwd) })]],
      ["gjc", [...commandArgs, "--json-input", JSON.stringify({ cwd, resolveSessionId: "session-1" })]],
    ]);
  });

  it("paginates with the same limit and rejects conflicting page index sequences", async () => {
    const { calls, runner } = fakeRunner([
      page([session({ pid: 999 })], { continuationCursor: "next-page" }),
      page([session()]),
      saved(),
    ]);
    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner)).resolves.toMatchObject({ sessionId: "session-1" });
    expect(calls[0]!.args).toEqual([...commandArgs, "--json-input", JSON.stringify({ scope: scope(cwd) })]);
    expect(calls[1]!.args).toEqual([...commandArgs, "--json-input", JSON.stringify({ scope: scope(cwd), cursor: "next-page" })]);
    expect(calls[2]!.args).toEqual([...commandArgs, "--json-input", JSON.stringify({ cwd, resolveSessionId: "session-1" })]);

    const conflicting = fakeRunner([
      page([], { continuationCursor: "next-page" }),
      broker({ indexSeq: 12, sessions: [session()] }),
    ]);
    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, conflicting.runner)).rejects.toEqual(new GjcSdkLookupError("unavailable"));
    expect(conflicting.calls).toHaveLength(2);
  });

  it("guards stale and direct-fence same-pid sessions across pages without unrelated pids", async () => {
    mkdirSync(agentDir, { recursive: true });
    const stale = session({ sessionId: "stale-same-pid", live: false });
    const fence = session({
      sessionId: "direct-fence",
      endpointGeneration: 0,
      processIncarnation: "linux:12345",
      locator: { ...locator(), stateRoot: agentDir },
    });
    const unrelated = session({ sessionId: "unrelated-pid", pid: 999 });
    const exactStale = session({ sessionId: "exact-stale-same-pid", deleted: true });
    const exactUnrelated = session({ sessionId: "exact-unrelated-pid", pid: 999 });
    const { runner } = fakeRunner([
      page([stale, unrelated], { continuationCursor: "next-page" }),
      page([fence, session()]),
      page([stale, fence, session(), exactStale, exactUnrelated], {
        savedSession: { id: "session-1", path: savedPath },
      }),
    ]);

    const binding = await gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner);
    expect(binding?.guardSessionIds).toEqual([
      "stale-same-pid",
      "direct-fence",
      "session-1",
      "exact-stale-same-pid",
    ]);
    expect(binding?.guardSessionIds).not.toContain("unrelated-pid");
    expect(binding?.guardSessionIds).not.toContain("exact-unrelated-pid");
  });

  it("does not choose by cwd alone when multiple pane GJC processes match", async () => {
    const { calls, runner } = fakeRunner([page([session(), session({ sessionId: "session-2", pid: 322 })])]);
    await expect(gjcSdkTranscriptWithRunner([321, 322], cwd, agentDir, runner)).resolves.toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("scopes the scan so unrelated historical sessions beyond the page budget are excluded", async () => {
    const historical = Array.from({ length: 801 }, (_, index) => session({
      sessionId: `historical-${index}`,
      pid: 10_000 + index,
      live: false,
      locator: { cwd: join(cwd, `history-${index}`), worktreeRoot: null, stateRoot: join(cwd, ".gjc", "state") },
    }));
    const calls: Call[] = [];
    const runner: GjcSdkCommandRunner = async (command, args, options) => {
      const call = calls.length;
      calls.push({ command, args: [...args], options });
      const inputIndex = args.indexOf("--json-input");
      const input = inputIndex >= 0 ? JSON.parse(args[inputIndex + 1]!) : {};
      if (call === 0) {
        const rows = [...historical, session()].filter((row) => row.locator && (row.locator as Record<string, unknown>).cwd === input.scope?.requestAnchor.cwd);
        return page(rows);
      }
      return saved();
    };

    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner)).resolves.toMatchObject({ sessionId: "session-1" });
    expect(calls[0]!.args).toEqual([...commandArgs, "--json-input", JSON.stringify({ scope: scope(cwd) })]);
    expect(calls).toHaveLength(2);
  });

  it("accepts a live session alongside definitively retired rows for the same pid", async () => {
    const terminal = session({ sessionId: "old-session", terminal: true, terminalUncertain: false });
    const deleted = session({ sessionId: "deleted-session", deleted: true });
    const { calls, runner } = fakeRunner([
      page([terminal, deleted, session()]),
      page([terminal, deleted, session()], { savedSession: { id: "session-1", path: savedPath } }),
    ]);
    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner)).resolves.toMatchObject({ sessionId: "session-1" });
    expect(calls).toHaveLength(2);
  });

  it("rejects competing active rows after exact lookup even when discovery was unique", async () => {
    const current = session();
    const competing = session({ sessionId: "session-2" });
    const { calls, runner } = fakeRunner([
      page([current]),
      page([current, competing], { savedSession: { id: "session-1", path: savedPath } }),
    ]);
    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner)).resolves.toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("uses the row's original symlinked cwd for exact resolution and matches its canonical identity", async () => {
    const alias = join(cwd, "cwd-alias");
    symlinkSync(cwd, alias, process.platform === "win32" ? "junction" : "dir");
    const discoveryRow = session({ locator: { ...locator(), cwd: alias } });
    const { calls, runner } = fakeRunner([page([discoveryRow]), saved()]);

    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner)).resolves.toMatchObject({ sessionId: "session-1" });
    expect(calls[0]!.args).toEqual([...commandArgs, "--json-input", JSON.stringify({ scope: scope(cwd) })]);
    expect(calls[1]!.args).toEqual([...commandArgs, "--json-input", JSON.stringify({ cwd: alias, resolveSessionId: "session-1" })]);
  });

  it("anchors a pwd scope at its containing git worktree root", async () => {
    const nestedCwd = join(cwd, "nested");
    const worktreeAlias = join(cwd, "worktree-alias");
    mkdirSync(nestedCwd);
    symlinkSync(cwd, worktreeAlias, process.platform === "win32" ? "junction" : "dir");
    const row = session({ locator: { ...locator(), cwd: nestedCwd } });
    let receivedCwd = "";
    let receivedTimeout = 0;
    const rootResolver: GjcSdkWorktreeRootResolver = async (requestedCwd, timeoutMs) => {
      receivedCwd = requestedCwd;
      receivedTimeout = timeoutMs;
      return worktreeAlias;
    };
    const { calls, runner } = fakeRunner([
      page([row]),
      page([row], { savedSession: { id: "session-1", path: savedPath } }),
    ]);

    await expect(gjcSdkTranscriptWithRunner([321], nestedCwd, agentDir, runner, rootResolver)).resolves.toMatchObject({ sessionId: "session-1" });
    expect(receivedCwd).toBe(nestedCwd);
    expect(receivedTimeout).toBeGreaterThan(0);
    expect(receivedTimeout).toBeLessThanOrEqual(5_000);
    expect(calls[0]!.args).toEqual([
      ...commandArgs,
      "--json-input",
      JSON.stringify({ scope: scope(nestedCwd, cwd) }),
    ]);
  });

  it.each(["ENOENT", "EACCES", "ETIMEDOUT"])("sanitizes %s worktree resolver failures before starting the broker", async (code) => {
    let rootLookups = 0;
    const secret = `private ${code} worktree credentials`;
    const rootResolver: GjcSdkWorktreeRootResolver = async () => {
      rootLookups += 1;
      throw Object.assign(new Error(secret), { code });
    };
    const { calls, runner } = fakeRunner([page([session()]), saved()]);

    const failure = await gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner, rootResolver).catch(error => error);
    expect(failure).toBeInstanceOf(GjcSdkLookupError);
    expect(failure).toMatchObject({ reason: code === "ETIMEDOUT" ? "timeout" : "unavailable", message: "GJC SDK lookup failed" });
    expect(JSON.stringify(failure)).not.toContain(secret);
    expect(rootLookups).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it.each(["ENOENT", "EACCES"])("keeps %s canonical anchor failures typed on both identity paths", async code => {
    const root = join(cwd, `anchor-${code}`);
    mkdirSync(root);
    for (const target of [cwd, root]) {
      for (const lookup of [gjcSdkCurrentSessionWithRunner, gjcSdkTranscriptWithRunner]) {
        const row = session({ locator: { ...locator(), worktreeRoot: root } });
        const fixture = fakeRunner([page([row]), saved(row)]);
        const native = realpathSync.native;
        const denied = spyOn(realpathSync, "native").mockImplementation(((value: string, ...args: unknown[]) => {
          if (String(value) === target) throw Object.assign(new Error(`secret ${target}`), { code });
          return Reflect.apply(native, realpathSync, [value, ...args]);
        }) as typeof realpathSync.native);
        try {
          const failure = await lookup([321], cwd, agentDir, fixture.runner, async () => root).catch(error => error);
          expect(failure).toBeInstanceOf(GjcSdkLookupError);
          expect(failure).toMatchObject({ reason: "unavailable", message: "GJC SDK lookup failed" });
          expect(JSON.stringify(failure)).not.toContain(target);
          expect(fixture.calls).toHaveLength(0);
        } finally { denied.mockRestore(); }
        await expect(lookup([321], cwd, agentDir, fixture.runner, async () => root)).resolves.toMatchObject({ sessionId: "session-1" });
        expect(fixture.calls).toHaveLength(2);
      }
    }
  });

  it("distinguishes two same-cwd panes by each pane's supplied GJC pid", async () => {
    const rows = [session(), session({ sessionId: "session-2", pid: 322 })];
    const { runner } = fakeRunner((args) => {
      const inputIndex = args.indexOf("--json-input");
      const rawInput = args[inputIndex + 1];
      if (rawInput === undefined) throw new Error("Missing SDK query input");
      const input: unknown = JSON.parse(rawInput);
      if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("Invalid SDK query input");
      if (!("resolveSessionId" in input)) return page(rows);
      const sessionId = input.resolveSessionId;
      if (typeof sessionId !== "string") throw new Error("Invalid exact session id");
      const row = rows.find((candidate) => candidate.sessionId === sessionId);
      if (row === undefined) throw new Error("Unknown exact session id");
      return saved(row, sessionId, join(cwd, `${sessionId}.jsonl`));
    });

    const first = await gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner);
    const second = await gjcSdkTranscriptWithRunner([322], cwd, agentDir, runner);
    expect(first?.sessionId).toBe("session-1");
    expect(second?.sessionId).toBe("session-2");
  });

  it("fails closed for multiple live rows competing for one pane process", async () => {
    const otherCwd = join(cwd, "other");
    mkdirSync(otherCwd, { recursive: true });
    const { calls, runner } = fakeRunner([page([session(), session({ sessionId: "session-2" })])]);
    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner)).resolves.toBeNull();
    expect(calls).toHaveLength(1);

    const malformed = fakeRunner([page([session(), session({ identityProvenance: "legacy" })])]);
    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, malformed.runner)).resolves.toBeNull();
    expect(malformed.calls).toHaveLength(1);

    const conflictingCwd = fakeRunner([page([session(), session({ locator: { ...locator(), cwd: otherCwd } })])]);
    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, conflictingCwd.runner)).resolves.toBeNull();
    expect(conflictingCwd.calls).toHaveLength(1);
  });

  it("observes a /new session after the raw listing cache expires", async () => {
    let now = 0;
    const cacheClock = () => now;
    const { calls, runner } = fakeRunner((_args, call) => {
      const turn = Math.floor(call / 2);
      const row = session({ sessionId: `session-${turn + 1}` });
      return call % 2 === 0 ? page([row]) : saved(row, `session-${turn + 1}`, join(cwd, `session-${turn + 1}.jsonl`));
    });

    const first = await gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner, testWorktreeRootResolver, cacheClock);
    now = 10_000;
    const second = await gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner, testWorktreeRootResolver, cacheClock);
    expect(first?.sessionId).toBe("session-1");
    expect(second).toEqual({
      sessionId: "session-2",
      pid: 321,
      path: join(cwd, "session-2.jsonl"),
      hostIncarnation: "linux:12345",
      endpointGeneration: 4,
      guardSessionIds: ["session-2"],
    });
    expect(calls).toHaveLength(4);
  });

  it("ignores stale, deleted, terminal, legacy, uncertain, and unrelated rows", async () => {
    const otherCwd = join(cwd, "other");
    mkdirSync(otherCwd, { recursive: true });
    const invalidRows: Record<string, unknown>[] = [
      { live: false },
      { deleted: true },
      { terminal: true },
      { terminalUncertain: true },
      { ambiguous: true },
      { identityProvenance: "legacy" },
      { endpointGeneration: 0 },
      { hostIncarnation: " " },
      { pid: 999 },
      { locator: { ...locator(), cwd: otherCwd } },
    ];
    for (const invalid of invalidRows) {
      const { calls, runner } = fakeRunner([page([session(invalid)])]);
      await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner)).resolves.toBeNull();
      expect(calls).toHaveLength(1);
    }
  });

  it("rechecks the full locator, generation, and host incarnation before returning a path", async () => {
    const otherState = join(cwd, "other-state");
    mkdirSync(otherState, { recursive: true });
    const changedRows = [
      session({ endpointGeneration: 5 }),
      session({ hostIncarnation: "linux:next" }),
      session({ locator: { ...locator(), stateRoot: otherState } }),
    ];
    for (const changed of changedRows) {
      const { calls, runner } = fakeRunner([page([session()]), saved(changed)]);
      await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner)).resolves.toBeNull();
      expect(calls).toHaveLength(2);
    }
  });

  it("rejects an exact lookup from an older broker index sequence", async () => {
    const older = broker({ indexSeq: 10, sessions: [session()], savedSession: { id: "session-1", path: savedPath } });
    const { calls, runner } = fakeRunner([page([session()]), older]);
    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner)).rejects.toEqual(new GjcSdkLookupError("unavailable"));
    expect(calls).toHaveLength(2);
  });

  it("requires the exact saved session and an absolute path", async () => {
    const invalidSavedSessions = [
      undefined,
      { id: "another-session", path: savedPath },
      { id: "session-1", path: "relative/session.jsonl" },
    ];
    for (const savedSession of invalidSavedSessions) {
      const result = page([session()], savedSession === undefined ? {} : { savedSession });
      const { runner } = fakeRunner([page([session()]), result]);
      await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner)).resolves.toBeNull();
    }
  });

  it("refuses an incomplete exact lookup rather than accepting its saved path", async () => {
    const { runner } = fakeRunner([
      page([session()]),
      page([session()], { continuationCursor: "incomplete", savedSession: { id: "session-1", path: savedPath } }),
    ]);
    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner)).rejects.toEqual(new GjcSdkLookupError("unavailable"));
  });

  it("resolves a cold two-call lookup past eight seconds within the ten-second total", async () => {
    jest.useFakeTimers();
    try {
      const steps = [timedStep(page([session()]), 4_600), timedStep(saved(), 4_600)];
      const { calls, runner } = fakeRunner((_args, call) => steps[call]!.run());
      const lookup = gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner, async () => {
        // Additional asynchronous resolution must not require changing a microtask count.
        for (let index = 0; index < 25; index++) await Promise.resolve();
        return cwd;
      }).catch((error: unknown) => error);
      for (const step of steps) {
        await bounded(step.started);
        jest.advanceTimersByTime(4_600);
      }
      expect(await bounded(lookup)).toMatchObject({ sessionId: "session-1" });
      expect(calls).toHaveLength(2);
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  it("exhausts the ten-second total across the worktree probe and SDK calls", async () => {
    jest.useFakeTimers();
    try {
      const probe = timedStep(cwd, 4_000);
      const steps = [timedStep(page([session()]), 4_000), timedStep(saved(), 4_000)];
      const { calls, runner } = fakeRunner((_args, call) => steps[call]!.run());
      const lookup = gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner, probe.run).catch((error: unknown) => error);
      await bounded(probe.started);
      jest.advanceTimersByTime(4_000);
      await bounded(steps[0]!.started);
      jest.advanceTimersByTime(4_000);
      await bounded(steps[1]!.started);
      expect(calls[1]!.options.timeout).toBe(2_000);
      jest.advanceTimersByTime(2_000);
      expect(await bounded(lookup)).toEqual(new GjcSdkLookupError("timeout"));
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  it("keeps status discovery on the old two-second command budget", async () => {
    jest.useFakeTimers();
    try {
      const step = timedStep(page([session()]), 2_300);
      const { calls, runner } = fakeRunner(step.run);
      const lookup = gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner, testWorktreeRootResolver, undefined, currentGeneration, "status")
        .catch((error: unknown) => error);
      await bounded(step.started);
      expect(calls[0]!.options.timeout).toBe(2_000);
      jest.advanceTimersByTime(2_000);
      expect(await bounded(lookup)).toEqual(new GjcSdkLookupError("timeout"));
    } finally { jest.clearAllTimers(); jest.useRealTimers(); }
  });

  it("caps status discovery at eight seconds including the worktree probe", async () => {
    jest.useFakeTimers();
    try {
      const probe = timedStep(cwd, 1_800);
      const steps = [
        timedStep(page([], { continuationCursor: "a" }), 1_800),
        timedStep(page([], { continuationCursor: "b" }), 1_800),
        timedStep(page([session()]), 1_800),
        timedStep(saved(), 1_800),
      ];
      const { calls, runner } = fakeRunner((_args, call) => steps[call]!.run());
      const lookup = gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner, probe.run, undefined, currentGeneration, "status")
        .catch((error: unknown) => error);
      await bounded(probe.started);
      jest.advanceTimersByTime(1_800);
      for (const step of steps.slice(0, 3)) {
        await bounded(step.started);
        jest.advanceTimersByTime(1_800);
      }
      await bounded(steps[3]!.started);
      expect(calls[3]!.options.timeout).toBe(800);
      jest.advanceTimersByTime(800);
      expect(await bounded(lookup)).toEqual(new GjcSdkLookupError("timeout"));
    } finally { jest.clearAllTimers(); jest.useRealTimers(); }
  });

  it("ends a hung SDK lookup at its deadline", async () => {
    jest.useFakeTimers();
    try {
      const entered = Promise.withResolvers<void>();
      const { calls, runner } = fakeRunner(() => {
        entered.resolve();
        return new Promise(() => {});
      });
      const lookup = gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner).catch((error: unknown) => error);
      await bounded(entered.promise);
      jest.advanceTimersByTime(5_000);
      expect(await bounded(lookup)).toEqual(new GjcSdkLookupError("timeout"));
      expect(calls).toHaveLength(1);
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  it.each([
    { killed: true },
    { signal: "SIGKILL" },
    { code: "ETIMEDOUT" },
    { code: "ERR_CHILD_PROCESS_TIMEOUT" },
  ])("classifies subprocess timeout metadata %j without exposing process details", async (metadata) => {
    const { runner } = fakeRunner(() => {
      throw Object.assign(new Error("/private/path secret-token"), metadata, { stderr: "secret-token" });
    });
    const error = await gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(GjcSdkLookupError);
    expect(error).toMatchObject({ reason: "timeout", message: "GJC SDK lookup failed" });
    expect(error).not.toHaveProperty("cause");
    expect(error).not.toHaveProperty("stderr");
  });

  it("reports an execution failure during exact session resolution as unavailable", async () => {
    const { calls, runner } = fakeRunner((_args, call) => {
      if (call === 0) return page([session()]);
      throw Object.assign(new Error("SDK executable unavailable"), { code: "ENOENT" });
    });
    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner)).rejects.toEqual(new GjcSdkLookupError("unavailable"));
    expect(calls).toHaveLength(2);
  });

  it("ends a hung worktree probe with a typed timeout before SDK lookup", async () => {
    jest.useFakeTimers();
    try {
      const entered = Promise.withResolvers<void>();
      const { calls, runner } = fakeRunner([page([session()]), saved()]);
      const lookup = gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner, () => {
        entered.resolve();
        return new Promise(() => {});
      }).catch((error: unknown) => error);
      await bounded(entered.promise);
      jest.advanceTimersByTime(5_000);
      expect(await bounded(lookup)).toEqual(new GjcSdkLookupError("timeout"));
      expect(calls).toHaveLength(0);
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  it("propagates subprocess timeouts from the worktree probe", async () => {
    const { calls, runner } = fakeRunner([page([session()]), saved()]);
    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner, async () => {
      throw Object.assign(new Error("Git timeout"), { killed: true, signal: "SIGKILL" });
    })).rejects.toEqual(new GjcSdkLookupError("timeout"));
    expect(calls).toHaveLength(0);
  });

  it("rejects malformed broker output and repeated or over-budget pagination", async () => {
    const secret = "private broker credentials";
    for (const code of ["ENOENT", "EACCES"]) {
      const output = JSON.stringify({ type: "broker_response", ok: false, error: { code, message: secret } });
      const { calls, runner } = fakeRunner([output]);
      const failure = await gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner).catch(error => error);
      expect(failure).toBeInstanceOf(GjcSdkLookupError);
      expect(failure).toMatchObject({ reason: "unavailable", message: "GJC SDK lookup failed" });
      expect(JSON.stringify(failure)).not.toContain(secret);
      expect(calls).toHaveLength(1);
    }

    const repeated = fakeRunner([page([], { continuationCursor: "same" }), page([], { continuationCursor: "same" })]);
    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, repeated.runner)).rejects.toEqual(new GjcSdkLookupError("unavailable"));
    expect(repeated.calls).toHaveLength(2);

    for (const cursor of ["", "  ", 7, { token: "cursor" }]) {
      const malformed = fakeRunner([page([], { continuationCursor: cursor })]);
      await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, malformed.runner)).rejects.toEqual(new GjcSdkLookupError("unavailable"));
      expect(malformed.calls).toHaveLength(1);
    }

    const pages = fakeRunner((_args, call) => page([], { continuationCursor: `cursor-${call}` }));
    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, pages.runner)).rejects.toMatchObject({ name: "GjcSdkLookupError", reason: "timeout" });
    expect(pages.calls).toHaveLength(6); // the global spawn budget precedes the larger page ceiling
  });

  it("classifies oversized discovery and exact broker pages as unavailable", async () => {
    const oversized = page(Array.from({ length: 101 }, () => session()));
    for (const phase of ["discovery", "exact"] as const) {
      for (const lookup of [gjcSdkTranscriptWithRunner, gjcSdkCurrentSessionWithRunner]) {
        const fixture = fakeRunner(phase === "exact" ? [page([session()]), oversized] : [oversized]);
        await expect(lookup([321], cwd, agentDir, fixture.runner)).rejects.toEqual(new GjcSdkLookupError("unavailable"));
        expect(fixture.calls).toHaveLength(phase === "exact" ? 2 : 1);
      }
    }
  });

  it.each(["discovery", "exact"] as const)("reports malformed %s broker responses as sanitized unavailable on both APIs", async phase => {
    for (const output of [
      "not json /private/secret",
      JSON.stringify({ type: "broker_response", ok: true }),
      broker({ indexSeq: 11, sessions: {} }),
      broker({ sessions: [session()] }),
    ]) {
      for (const lookup of [gjcSdkTranscriptWithRunner, gjcSdkCurrentSessionWithRunner]) {
        const fixture = fakeRunner(phase === "exact" ? [page([session()]), output] : [output]);
        const failure = await lookup([321], cwd, agentDir, fixture.runner).catch((error: unknown) => error);
        expect(failure).toEqual(new GjcSdkLookupError("unavailable"));
        expect(JSON.stringify(failure)).not.toContain("secret");
        expect(fixture.calls).toHaveLength(phase === "exact" ? 2 : 1);
      }
    }
  });

  it("keeps a valid empty roster as a null identity on both APIs", async () => {
    for (const lookup of [gjcSdkTranscriptWithRunner, gjcSdkCurrentSessionWithRunner]) {
      const fixture = fakeRunner([page([])]);
      await expect(lookup([321], cwd, agentDir, fixture.runner)).resolves.toBeNull();
      expect(fixture.calls).toHaveLength(1);
    }
  });

  it.each(["ENOENT", "EACCES"] as const)("reports %s canonicalization outages as unavailable on both APIs", async code => {
    const missingCwd = join(cwd, `unreadable-${code}`);
    const native = realpathSync.native;
    const probe = jest.spyOn(realpathSync, "native").mockImplementation(((path: Parameters<typeof realpathSync.native>[0]) => {
      if (path === missingCwd) throw Object.assign(new Error("secret canonicalization failure"), { code });
      return native(path);
    }) as typeof realpathSync.native);
    try {
      for (const lookup of [gjcSdkTranscriptWithRunner, gjcSdkCurrentSessionWithRunner]) {
        const fixture = fakeRunner([page([session()]), saved()]);
        const failure = await lookup([321], missingCwd, agentDir, fixture.runner).catch((error: unknown) => error);
        expect(failure).toEqual(new GjcSdkLookupError("unavailable"));
        expect(JSON.stringify(failure)).not.toContain("secret");
        expect(fixture.calls).toHaveLength(0);
      }
    } finally {
      probe.mockRestore();
    }
  });

  it("reports unreadable broker locator canonicalization without hiding it as identity mismatch", async () => {
    for (const lookup of [gjcSdkTranscriptWithRunner, gjcSdkCurrentSessionWithRunner]) {
      const fixture = fakeRunner([page([session({ locator: { ...locator(), cwd: join(cwd, "missing-broker-cwd") } })])]);
      await expect(lookup([321], cwd, agentDir, fixture.runner)).rejects.toEqual(new GjcSdkLookupError("unavailable"));
      expect(fixture.calls).toHaveLength(1);
    }
  });

  it.each(["discovery", "exact"] as const)("reports %s broker failures as sanitized unavailable and never caches them", async phase => {
    const failure = JSON.stringify({ type: "broker_response", ok: false, error: "secret /private/session" });
    const fixture = fakeRunner((_args, call) => phase === "discovery" || call > 0 ? failure : page([session()]));
    await expect(gjcSdkCurrentSessionWithRunner([321], cwd, agentDir, fixture.runner)).rejects.toEqual(new GjcSdkLookupError("unavailable"));
    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, fixture.runner)).rejects.toEqual(new GjcSdkLookupError("unavailable"));
    expect(fixture.calls).toHaveLength(phase === "discovery" ? 2 : 3);
  });

  it("keeps SDK execution bounded, non-interactive, and quiet on transport failure", async () => {
    let captured: Call | undefined;
    const runner: GjcSdkCommandRunner = async (command, args, options) => {
      captured = { command, args: [...args], options };
      throw new Error("broker credentials and local paths must not escape");
    };

    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner)).rejects.toMatchObject({ name: "GjcSdkLookupError", reason: "unavailable", message: "GJC SDK lookup failed" });
    expect(captured?.command).toBe("gjc");
    expect(captured?.args).toEqual([...commandArgs, "--json-input", JSON.stringify({ scope: scope(cwd) })]);
    expect(captured?.options.env.GJC_SDK_BROKER_AUTOSTART).toBe("0");
    expect(captured?.options.shell).toBe(false);
    expect(captured?.options).not.toHaveProperty("stdio");
    expect(captured?.options.maxBuffer).toBe(1024 * 1024);
    expect(captured?.options.timeout).toBeGreaterThan(0);
    expect(captured?.options.timeout).toBeLessThanOrEqual(5_000);
    expect(captured?.options.killSignal).toBe("SIGKILL");
  });
});

describe("GJC SDK session.list cache", () => {
  it("bounds status waits independently while sharing a cold chat query", async () => {
    jest.useFakeTimers();
    try {
      const discovery = timedStep(page([session()]), 4_000);
      const { calls, runner } = fakeRunner((_args, call) => call === 0 ? discovery.run() : saved());
      const chat = gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner);
      await bounded(discovery.started);
      const joined = Promise.withResolvers<void>();
      const status = gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner, async () => {
        joined.resolve();
        return cwd;
      }, undefined, currentGeneration, "status").catch((error: unknown) => error);
      await bounded(joined.promise);
      await nextTurn();
      jest.advanceTimersByTime(2_000);
      expect(await bounded(status)).toEqual(new GjcSdkLookupError("timeout"));
      expect(calls).toHaveLength(1);
      jest.advanceTimersByTime(2_000);
      expect(await bounded(chat)).toMatchObject({ sessionId: "session-1", path: savedPath });
      expect(calls).toHaveLength(2);
      await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner, testWorktreeRootResolver, undefined, currentGeneration, "status"))
        .resolves.toMatchObject({ sessionId: "session-1" });
      expect(calls).toHaveLength(2);
    } finally { jest.clearAllTimers(); jest.useRealTimers(); }
  });

  it("rejects a revoked generation on each cached transcript read without starting another runner", async () => {
    const fixture = fakeRunner([page([session()]), saved()]);
    let observations = 0;
    const generationCurrent: typeof import("./gjc-sdk-generation.ts").gjcSdkGenerationCurrent = async () => ++observations === 1;
    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, fixture.runner, testWorktreeRootResolver, undefined, generationCurrent))
      .resolves.toMatchObject({ sessionId: "session-1", guardSessionIds: ["session-1"] });
    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, fixture.runner, testWorktreeRootResolver, undefined, generationCurrent))
      .resolves.toBeNull();
    expect(observations).toBe(2);
    expect(fixture.calls).toHaveLength(2);
  });

  it.each(["ENOENT", "EACCES", "BROKER"] as const)("sanitizes %s failures on both lookup paths and retries failed raw queries", async code => {
    const secret = `private ${code} credentials ${savedPath}`;
    for (const lookup of [gjcSdkTranscriptWithRunner, gjcSdkCurrentSessionWithRunner]) {
      const fixture = fakeRunner((_args, call) => {
        if (call === 0) throw Object.assign(new Error(secret), { code });
        return call === 1 ? page([session()]) : saved();
      });
      const failure = await lookup([321], cwd, agentDir, fixture.runner).catch(error => error);
      expect(failure).toBeInstanceOf(GjcSdkLookupError);
      expect(failure).toMatchObject({ reason: "unavailable", message: "GJC SDK lookup failed" });
      expect(JSON.stringify(failure)).not.toContain(secret);
      await expect(lookup([321], cwd, agentDir, fixture.runner)).resolves.toMatchObject({ sessionId: "session-1" });
      expect(fixture.calls).toHaveLength(3);
    }
  });
  it.each(["ENOENT", "EACCES", "BROKER"] as const)("does not hide generation %s behind cached broker pages or missing saved metadata", async code => {
    for (const savedSession of [null, { id: "session-1", path: savedPath }]) {
      const fixture = fakeRunner([page([session()]), page([session()], { savedSession })]);
      const secret = `private generation ${code} ${savedPath}`;
      let failing = false, observations = 0;
      const generationCurrent = async () => {
        observations += 1;
        if (failing) throw Object.assign(new Error(secret), { code });
        return true;
      };
      const lookups = [sdkCurrentSessionWithRunner, sdkTranscriptWithRunner];
      const read = (lookup: typeof lookups[number]) => lookup([321], cwd, agentDir, fixture.runner, testWorktreeRootResolver, () => 0, generationCurrent);
      await expect(read(sdkCurrentSessionWithRunner)).resolves.toMatchObject({ sessionId: "session-1" });
      failing = true;
      for (const lookup of lookups) {
        const failure = await read(lookup).catch(error => error);
        expect(failure).toBeInstanceOf(GjcSdkLookupError);
        expect(failure).toMatchObject({ reason: "unavailable", message: "GJC SDK lookup failed" });
        expect(JSON.stringify(failure)).not.toContain(secret);
      }
      failing = false;
      await expect(read(sdkCurrentSessionWithRunner)).resolves.toMatchObject({ sessionId: "session-1" });
      if (savedSession === null) await expect(read(sdkTranscriptWithRunner)).resolves.toBeNull();
      else await expect(read(sdkTranscriptWithRunner)).resolves.toMatchObject({ path: savedPath });
      expect(observations).toBe(5);
      expect(fixture.calls).toHaveLength(2);
    }
  });

  it("coalesces concurrent callers for the same raw query", async () => {
    let resolveFirstStarted: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      resolveFirstStarted = resolve;
    });
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let resolveSecondRoot: () => void = () => {};
    const secondRootStarted = new Promise<void>((resolve) => {
      resolveSecondRoot = resolve;
    });
    let rootLookups = 0;
    const rootResolver: GjcSdkWorktreeRootResolver = async () => {
      rootLookups += 1;
      if (rootLookups === 2) resolveSecondRoot();
      return cwd;
    };
    const calls: Call[] = [];
    const runner: GjcSdkCommandRunner = async (command, args, options) => {
      const call = calls.length;
      calls.push({ command, args: [...args], options });
      if (call === 0) {
        resolveFirstStarted();
        await firstGate;
      }
      return call % 2 === 0 ? page([session()]) : saved();
    };

    const first = gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner, rootResolver);
    await firstStarted;
    const second = gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner, rootResolver);
    await secondRootStarted;
    await nextTurn();
    releaseFirst();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { sessionId: "session-1", pid: 321, path: savedPath, hostIncarnation: "linux:12345", endpointGeneration: 4, guardSessionIds: ["session-1"] },
      { sessionId: "session-1", pid: 321, path: savedPath, hostIncarnation: "linux:12345", endpointGeneration: 4, guardSessionIds: ["session-1"] },
    ]);
    expect(calls).toHaveLength(2);
  });

  it("hits the TTL cache and starts new listings at expiry", async () => {
    let now = 0;
    const cacheClock = () => now;
    const { calls, runner } = fakeRunner((_args, call) => call % 2 === 0 ? page([session()]) : saved());

    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner, testWorktreeRootResolver, cacheClock))
      .resolves.toMatchObject({ sessionId: "session-1" });
    now = 9_999;
    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner, testWorktreeRootResolver, cacheClock))
      .resolves.toMatchObject({ sessionId: "session-1" });
    expect(calls).toHaveLength(2);

    now = 10_000;
    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner, testWorktreeRootResolver, cacheClock))
      .resolves.toMatchObject({ sessionId: "session-1" });
    expect(calls).toHaveLength(4);
  });

  it("retries failed and malformed listings without caching them", async () => {
    for (const firstResult of ["malformed", "failed"] as const) {
      const fixture = fakeRunner((_args, call) => {
        if (call === 0 && firstResult === "malformed") return "not json";
        if (call === 0) throw new Error("fixture transport failure");
        return page([session()]);
      });

      await expect(gjcSdkCurrentSessionWithRunner([321], cwd, agentDir, fixture.runner)).rejects.toMatchObject({ name: "GjcSdkLookupError", reason: "unavailable" });
      await expect(gjcSdkCurrentSessionWithRunner([321], cwd, agentDir, fixture.runner)).resolves.toEqual({
        sessionId: "session-1",
        pid: 321,
        hostIncarnation: "linux:12345",
        endpointGeneration: 4,
      });
      expect(fixture.calls).toHaveLength(3);
    }
  });

  it("keeps identity rejection when raw discovery and exact rows are cached", async () => {
    const changedIdentity = session({ endpointGeneration: 5 });
    const fixture = fakeRunner([page([session()]), saved(changedIdentity)]);

    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, fixture.runner)).resolves.toBeNull();
    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, fixture.runner)).resolves.toBeNull();
    expect(fixture.calls).toHaveLength(2);
  });

  it("separates listings by agentDir", async () => {
    const secondAgentDir = join(cwd, "second-agent");
    const fixture = fakeRunner((_args, _call) => page([session()]));

    await expect(gjcSdkCurrentSessionWithRunner([321], cwd, agentDir, fixture.runner)).resolves.toMatchObject({ sessionId: "session-1" });
    await expect(gjcSdkCurrentSessionWithRunner([321], cwd, secondAgentDir, fixture.runner)).resolves.toMatchObject({ sessionId: "session-1" });
    expect(fixture.calls).toHaveLength(4);
    expect(fixture.calls[0]?.args).toContain(agentDir);
    expect(fixture.calls[2]?.args).toContain(secondAgentDir);
  });

  it("isolates fixture caches by command runner", async () => {
    const firstRunner = fakeRunner((_args, _call) => page([session()]));
    const secondRunner = fakeRunner((_args, _call) => page([session({ sessionId: "session-2" })]));

    await expect(gjcSdkCurrentSessionWithRunner([321], cwd, agentDir, firstRunner.runner)).resolves.toMatchObject({ sessionId: "session-1" });
    await expect(gjcSdkCurrentSessionWithRunner([321], cwd, agentDir, secondRunner.runner)).resolves.toMatchObject({ sessionId: "session-2" });
    expect(firstRunner.calls).toHaveLength(2);
    expect(secondRunner.calls).toHaveLength(2);
  });

  it("bounds starts across agent roots, fails closed at the deadline, and recovers at the next window", async () => {
    let now = 0;
    const clock = () => now;
    const fixture = fakeRunner((_args, call) => call % 2 === 0 ? page([session()]) : saved());
    const lookup = (root: number) => gjcSdkCurrentSessionWithRunner([321], cwd, join(cwd, `budget-agent-${root}`), fixture.runner, testWorktreeRootResolver, clock);
    await expect(gjcSdkTranscriptWithRunner([321], cwd, join(cwd, "budget-agent-1"), fixture.runner, testWorktreeRootResolver, clock))
      .resolves.toMatchObject({ sessionId: "session-1" });
    for (const root of [2, 3]) await expect(lookup(root)).resolves.toMatchObject({ sessionId: "session-1" });
    await expect(lookup(4)).rejects.toMatchObject({ name: "GjcSdkLookupError", reason: "timeout" });
    await expect(lookup(4)).rejects.toMatchObject({ name: "GjcSdkLookupError", reason: "timeout" });
    expect(fixture.calls).toHaveLength(6);
    expect(fixture.calls.slice(0, 2).map(({ options }) => options.timeout)).toEqual([5_000, 5_000]);
    expect(fixture.calls.slice(2).map(({ options }) => options.timeout)).toEqual([2_000, 2_000, 2_000, 2_000]);
    now = 10_050;
    await expect(lookup(4)).resolves.toMatchObject({ sessionId: "session-1" });
    expect(fixture.calls).toHaveLength(8);
  });

  it("serializes concurrent distinct-root lookups under one six-start window", async () => {
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    let firstStarted: () => void = () => {};
    const started = new Promise<void>(resolve => { firstStarted = resolve; });
    let active = 0;
    let maxActive = 0;
    let starts = 0;
    const runner: GjcSdkCommandRunner = async () => {
      starts += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        if (starts === 1) {
          firstStarted();
          await firstGate;
        }
        return page([]);
      } finally {
        active -= 1;
      }
    };
    const clock = () => 1_000;
    const lookup = (index: number) => gjcSdkCurrentSessionWithRunner(
      [321], cwd, join(cwd, `concurrent-budget-${index}`), runner, testWorktreeRootResolver, clock,
    );
    const first = lookup(0);
    try {
      await started;
      const outcomesPending = Promise.allSettled([first, ...Array.from({ length: 6 }, (_, index) => lookup(index + 1))]);
      releaseFirst();
      const outcomes = await outcomesPending;
      expect(outcomes.filter(outcome => outcome.status === "fulfilled").map(outcome => outcome.value)).toEqual(Array(6).fill(null));
      const rejected = outcomes.filter(outcome => outcome.status === "rejected");
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toBeInstanceOf(GjcSdkLookupError);
      expect(rejected[0]?.reason).toMatchObject({ reason: "timeout" });
      expect(starts).toBe(6);
      expect(maxActive).toBe(1);
    } finally {
      releaseFirst();
    }
  });

  it.each(["same", "different"])("serializes raw queries with %s agent directories", async (directory) => {
    const nestedCwd = join(cwd, "nested-query");
    mkdirSync(nestedCwd, { recursive: true });
    const nestedSession = session({
      sessionId: "session-2",
      pid: 322,
      locator: { ...locator(), cwd: nestedCwd },
    });
    let resolveFirstStarted: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      resolveFirstStarted = resolve;
    });
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let resolveSecondRoot: () => void = () => {};
    const secondRootStarted = new Promise<void>((resolve) => {
      resolveSecondRoot = resolve;
    });
    let rootLookups = 0;
    const rootResolver: GjcSdkWorktreeRootResolver = async () => {
      rootLookups += 1;
      if (rootLookups === 2) resolveSecondRoot();
      return cwd;
    };
    const calls: Call[] = [];
    let active = 0;
    let maxActive = 0;
    const runner: GjcSdkCommandRunner = async (command, args, options) => {
      const call = calls.length;
      calls.push({ command, args: [...args], options });
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (call === 0) {
        resolveFirstStarted();
        await firstGate;
      }
      active -= 1;
      return page([session(), nestedSession]);
    };

    const first = gjcSdkCurrentSessionWithRunner([321], cwd, agentDir, runner, rootResolver);
    await firstStarted;
    const second = gjcSdkCurrentSessionWithRunner([322], nestedCwd, directory === "same" ? agentDir : join(cwd, "other-agent"), runner, rootResolver);
    await secondRootStarted;
    await nextTurn();
    const callsWhileFirstIsActive = calls.length;
    releaseFirst();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { sessionId: "session-1", pid: 321, hostIncarnation: "linux:12345", endpointGeneration: 4 },
      { sessionId: "session-2", pid: 322, hostIncarnation: "linux:12345", endpointGeneration: 4 },
    ]);
    expect(callsWhileFirstIsActive).toBe(1);
    expect(calls).toHaveLength(4);
    expect(maxActive).toBe(1);
  });
});


describe("GJC SDK session.list timeout queue", () => {
  it("keeps the queue until a timed-out runner actually settles", async () => {
    const nestedCwd = join(cwd, "timeout-nested");
    mkdirSync(nestedCwd, { recursive: true });
    const nestedSession = session({
      sessionId: "session-2",
      pid: 322,
      locator: { ...locator(), cwd: nestedCwd },
    });
    let notifyFirstStarted: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      notifyFirstStarted = resolve;
    });
    let releaseFirstRunner: () => void = () => {};
    const firstRunnerGate = new Promise<void>((resolve) => {
      releaseFirstRunner = resolve;
    });
    let notifySecondRoot: () => void = () => {};
    const secondRootStarted = new Promise<void>((resolve) => {
      notifySecondRoot = resolve;
    });
    const rootResolver: GjcSdkWorktreeRootResolver = async (requestedCwd) => {
      if (requestedCwd === nestedCwd) notifySecondRoot();
      return cwd;
    };
    const calls: Call[] = [];
    let active = 0;
    let maxActive = 0;
    const runner: GjcSdkCommandRunner = async (command, args, options) => {
      const call = calls.length;
      calls.push({ command, args: [...args], options });
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (call === 0) {
        notifyFirstStarted();
        await firstRunnerGate;
        active -= 1;
        return page([session()]);
      }
      active -= 1;
      const inputIndex = args.indexOf("--json-input");
      const rawInput = args[inputIndex + 1];
      if (rawInput === undefined) throw new Error("Missing SDK query input");
      const input: unknown = JSON.parse(rawInput);
      if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("Invalid SDK query input");
      if ("resolveSessionId" in input) return page([nestedSession], { savedSession: null });
      return page([session(), nestedSession]);
    };

    const first = sdkCurrentSessionWithRunner([321], cwd, agentDir, runner, rootResolver, undefined, async () => true);
    await firstStarted;
    await expect(first).rejects.toMatchObject({ name: "GjcSdkLookupError", reason: "timeout" });

    const second = sdkCurrentSessionWithRunner([322], nestedCwd, agentDir, runner, rootResolver, undefined, currentGeneration);
    await secondRootStarted;
    await nextTurn();
    expect(calls).toHaveLength(1);

    releaseFirstRunner();
    await expect(second).resolves.toEqual({
      sessionId: "session-2",
      pid: 322,
      hostIncarnation: "linux:12345",
      endpointGeneration: 4,
    });
    expect(calls).toHaveLength(3);
    expect(maxActive).toBe(1);
  });
});

describe("gjcSdkQuery", () => {
  it.each(["ENOENT", "EACCES", "BROKER"])("keeps failed %s query starts in the shared identity budget", async code => {
    let starts = 0, clock = 0, observations = 0;
    const cacheClock = () => clock;
    const runner: GjcSdkCommandRunner = async (_command, args) => {
      if (++starts <= 4) throw Object.assign(new Error(`private ${code} broker path`), { code });
      return args.includes("global") ? page([session()], { savedSession: null }) : JSON.stringify({ ok: true });
    };
    for (const query of ["runtime.capabilities", "skill.list/state", "runtime.capabilities", "skill.list/state"] as const) {
      await expect(gjcSdkQuery(agentDir, "session-1", query, { runner, cacheClock }))
        .rejects.toEqual(new GjcSdkLookupError("unavailable"));
    }
    const generationCurrent = (directory: string, id: string, generation: number) => gjcSdkGenerationCurrent(directory, id, generation, {
      generationStatus: async (sessionId, endpointGeneration) => {
        observations += 1;
        expect([directory, sessionId, endpointGeneration]).toEqual([agentDir, "session-1", 4]);
        return { status: "current" };
      },
    });
    await expect(sdkCurrentSessionWithRunner([321], cwd, agentDir, runner, testWorktreeRootResolver, cacheClock, generationCurrent))
      .resolves.toMatchObject({ sessionId: "session-1" });
    expect(observations).toBe(1);
    await expect(gjcSdkQuery(join(cwd, "other-root"), "session-1", "skill.list/state", { runner, cacheClock }))
      .rejects.toEqual(new GjcSdkLookupError("timeout"));
    expect(starts).toBe(6);
    clock = 10_050;
    await expect(gjcSdkQuery(agentDir, "session-1", "skill.list/state", { runner, cacheClock })).resolves.toMatchObject({ ok: true });
    expect(starts).toBe(7);
  });

  it("shares one six-start window and one child with identity listings across roots", async () => {
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    let clock = 0, starts = 0, active = 0, peak = 0;
    const runner: GjcSdkCommandRunner = async (_command, args) => {
      active += 1; starts += 1; peak = Math.max(peak, active);
      try {
        if (starts === 1) { started.resolve(); await gate.promise; }
        return args.includes("global") ? page([]) : JSON.stringify({ ok: true, page: { items: [], complete: true } });
      } finally { active -= 1; }
    };
    const cacheClock = () => clock;
    const listing = gjcSdkCurrentSessionWithRunner([321], cwd, agentDir, runner, testWorktreeRootResolver, cacheClock);
    await bounded(started.promise);
    const query = gjcSdkQuery(join(cwd, "query-root"), "session-1", "skill.list/state", { runner, cacheClock });
    try {
      await nextTurn();
      expect(starts).toBe(1);
    } finally { gate.resolve(); }
    await expect(listing).resolves.toBeNull();
    await expect(query).resolves.toMatchObject({ ok: true });
    for (let i = 0; i < 4; i++) {
      await expect(gjcSdkQuery(join(cwd, `query-root-${i}`), "session-1", "runtime.capabilities", { runner, cacheClock })).resolves.toMatchObject({ ok: true });
    }
    await expect(gjcSdkQuery(agentDir, "session-1", "skill.list/state", { runner, cacheClock })).rejects.toEqual(new GjcSdkLookupError("timeout"));
    expect(starts).toBe(6);
    expect(peak).toBe(1);
    clock = 10_050;
    await expect(gjcSdkQuery(agentDir, "session-1", "skill.list/state", { runner, cacheClock })).resolves.toMatchObject({ ok: true });
    expect(starts).toBe(7);
  });

  it.each(["ENOENT", "EACCES", "BROKER", "ETIMEDOUT"])("sanitizes a native query's %s execution failure", async code => {
    const runner: GjcSdkCommandRunner = async () => { throw Object.assign(new Error("private broker credentials"), { code }); };
    const failure = await gjcSdkQuery(agentDir, "session-1", "skill.list/state", { runner }).catch(error => error);
    expect(failure).toBeInstanceOf(GjcSdkLookupError);
    expect(failure).toMatchObject({ reason: code === "ETIMEDOUT" ? "timeout" : "unavailable", message: "GJC SDK lookup failed" });
    expect(JSON.stringify(failure)).not.toContain("private broker credentials");
  });

  it.each(["not JSON: private broker credentials", "null", "[]", "{}", '{"ok":false,"error":"private broker credentials"}'])
    ("keeps a failed broker response typed and sanitized: %s", async output => {
      const runner: GjcSdkCommandRunner = async () => output;
      const failure = await gjcSdkQuery(agentDir, "session-1", "skill.list/state", { runner }).catch(error => error);
      expect(failure).toBeInstanceOf(GjcSdkLookupError);
      expect(failure).toMatchObject({ reason: "unavailable", message: "GJC SDK lookup failed" });
      expect(JSON.stringify(failure)).not.toContain("private broker credentials");
    });

  it("holds the shared queue until a timed-out native query's child actually settles", async () => {
    jest.useFakeTimers();
    const gate = Promise.withResolvers<void>(), started = Promise.withResolvers<void>();
    let starts = 0;
    const runner: GjcSdkCommandRunner = async () => {
      if (++starts === 1) { started.resolve(); await gate.promise; }
      return JSON.stringify({ ok: true, page: { items: [], complete: true } });
    };
    try {
      const first = gjcSdkQuery(agentDir, "session-1", "skill.list/state", { runner }).catch(error => error);
      await bounded(started.promise);
      jest.advanceTimersByTime(1_200);
      expect(await bounded(first)).toEqual(new GjcSdkLookupError("timeout"));
      const second = gjcSdkQuery(agentDir, "session-1", "runtime.capabilities", { runner });
      await nextTurn();
      expect(starts).toBe(1);
      gate.resolve();
      await expect(bounded(second)).resolves.toMatchObject({ ok: true });
      expect(starts).toBe(2);
    } finally { gate.resolve(); jest.clearAllTimers(); jest.useRealTimers(); }
  });

  it("asks one read query, attach-only, and refuses anything else", async () => {
    const seen: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const runner: GjcSdkCommandRunner = async (_command, args, options) => {
      seen.push({ args, env: options.env });
      return JSON.stringify({ ok: true, page: { items: [], complete: true } });
    };
    const response = await gjcSdkQuery(agentDir, "session-1", "skill.list/state", { runner });
    expect(response?.ok).toBe(true);
    expect(seen[0]!.args).toEqual(["sdk", "session", "raw", "query", "session-1", "--query", "skill.list/state", "--agent-dir", agentDir, "--attach-only", "--json"]);
    expect(seen[0]!.env.GJC_SDK_BROKER_AUTOSTART).toBe("0");
    // a control operation or a flag-shaped session id never reaches the CLI
    expect(await gjcSdkQuery(agentDir, "session-1", "skill.invoke" as never, { runner })).toBeNull();
    expect(await gjcSdkQuery(agentDir, "--op", "skill.list/state", { runner })).toBeNull();
    expect(seen).toHaveLength(1);
    const refused: GjcSdkCommandRunner = async () => JSON.stringify({ type: "broker_response", ok: false });
    await expect(gjcSdkQuery(agentDir, "session-1", "skill.list/state", { runner: refused })).rejects.toEqual(new GjcSdkLookupError("unavailable"));
  });
});
