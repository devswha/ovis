import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "bun:test";
import { assertManagedGjcCurrent, managedGjcSdkRunner, resolveManagedGjcSession, type ManagedGjcDeps } from "./managed-gjc-session.ts";
import { makeManagedGjcFixture, managedGjcDependencies } from "./managed-gjc-fixture.ts";
import { readManagedGjcEvidence } from "./managed-gjc-record.ts";
import { sessionSnapshot } from "./herdr/client.ts";

const makeFixture = makeManagedGjcFixture;
const dependencies = managedGjcDependencies;

it("accepts only the manager's exact resumed session file", async () => {
  for (const resume of ["exact", "other", "extra", "reordered"] as const) {
    const fixture = makeFixture();
    try {
      const child = fixture.live.get(fixture.sdkPid)!;
      const suffix = resume === "reordered" ? [fixture.sessionFile, "--resume"]
        : ["--resume", resume === "other" ? "/tmp/other.jsonl" : fixture.sessionFile, ...(resume === "extra" ? ["--extra"] : [])];
      fixture.live.set(child.pid, { ...child, argv: [...child.argv, ...suffix] });
      expect((await resolveManagedGjcSession(fixture.pane, dependencies(fixture)))?.state).toBe(resume === "exact" ? "ready" : "blocked");
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  }
});

it("shares SDK roster runners only for the same pinned runtime and environment", () => {
  const fixture = makeFixture();
  try {
    const record = readManagedGjcEvidence(fixture.pane, fixture.namespace)!.record;
    const dir = join(fixture.root, "agent");
    const runner = managedGjcSdkRunner(record, dir);
    expect(managedGjcSdkRunner(record, dir)).toBe(runner);
    expect(managedGjcSdkRunner(record, `${dir}-other`)).not.toBe(runner);
    expect(managedGjcSdkRunner({ ...record, runtime: { ...record.runtime, changed: "hash" } }, dir)).not.toBe(runner);
    expect(managedGjcSdkRunner({ ...record, env: { ...record.env, PATH: "/other" } }, dir)).not.toBe(runner);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

it("returns local and foreign snapshots without managed authority lookups or relabeling", async () => {
  const fixture = makeFixture();
  const root = mkdtempSync(join(tmpdir(), "mgjc-sock-"));
  const previousSocket = process.env.HERDR_SOCKET;
  const previousNamespace = process.env.HERDR_MANAGED_NAMESPACE;
  const requests: string[] = [];
  const local = createServer(socket => socket.on("data", data => {
    const request = JSON.parse(data.toString()) as { id: string; method: string };
    requests.push(request.method);
    socket.end(`${JSON.stringify({ id: request.id, result: request.method === "session.snapshot"
      ? { snapshot: fixture.snapshot() } : { process_info: fixture.processInfo } })}\n`);
  }));
  const foreign = createServer(socket => socket.on("data", data => {
    const request = JSON.parse(data.toString()) as { id: string };
    socket.end(`${JSON.stringify({ id: request.id, result: { snapshot: fixture.snapshot() } })}\n`);
  }));
  try {
    const localPath = join(root, "local.sock");
    const foreignPath = join(root, "foreign.sock");
    await Promise.all([new Promise<void>(resolve => local.listen(localPath, resolve)), new Promise<void>(resolve => foreign.listen(foreignPath, resolve))]);
    process.env.HERDR_SOCKET = localPath;
    process.env.HERDR_MANAGED_NAMESPACE = `${fixture.namespace}-missing`;
    expect(await sessionSnapshot(foreignPath)).toEqual(fixture.snapshot());
    expect(requests).toEqual([]);
    expect(await sessionSnapshot()).toEqual(fixture.snapshot());
    expect(requests).toEqual(["session.snapshot"]);
    for (const agent of ["gjc", "omo", "codex"] as const) {
      fixture.pane = { ...fixture.pane, agent };
      expect(await sessionSnapshot()).toEqual(fixture.snapshot());
      expect(await sessionSnapshot(foreignPath)).toEqual(fixture.snapshot());
    }
    expect(requests).toEqual(Array(4).fill("session.snapshot"));
  } finally {
    if (previousSocket === undefined) delete process.env.HERDR_SOCKET; else process.env.HERDR_SOCKET = previousSocket;
    if (previousNamespace === undefined) delete process.env.HERDR_MANAGED_NAMESPACE; else process.env.HERDR_MANAGED_NAMESPACE = previousNamespace;
    local.close();
    foreign.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

it("resolves the exact managed GJC file after broker, child, wrapper and SDK identity proof", async () => {
  const fixture = makeFixture();
  try {
    const resolved = await resolveManagedGjcSession(fixture.pane, dependencies(fixture));
    expect(resolved?.state === "blocked" ? resolved.reason : resolved?.state).toBe("ready");
    if (resolved?.state === "ready") expect(resolved.binding.evidence.record.sessionFile).toBe(fixture.sessionFile);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

it("leaves a valid managed OMO record to the existing OMO resolver", async () => {
  const fixture = makeFixture();
  try {
    fixture.record["harness"] = "omo";
    fixture.record["launcher_harness"] = "omo";
    fixture.writeRecord();
    expect(await resolveManagedGjcSession(fixture.pane, dependencies(fixture))).toBeNull();
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

it("rejects an executable substitution outside the producer's canonical hash pins", async () => {
  const fixture = makeFixture();
  try {
    const replacement = join(fixture.root, "substitute-bun");
    writeFileSync(replacement, "untrusted executable\n", { mode: 0o600 });
    const argv = fixture.record["argv"];
    if (Array.isArray(argv)) fixture.record["argv"] = [replacement, ...argv.slice(1)];
    fixture.writeRecord();
    const result = await resolveManagedGjcSession(fixture.pane, dependencies(fixture));
    expect(result?.state === "blocked" ? result.reason : result?.state).toBe("blocked_runtime_identity");
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

it("rejects a GJC entry substitution outside the producer's canonical hash pins", async () => {
  const fixture = makeFixture();
  try {
    const replacement = join(fixture.root, "substitute-gjc");
    writeFileSync(replacement, "untrusted executable\n", { mode: 0o600 });
    const argv = fixture.record["argv"];
    if (Array.isArray(argv)) fixture.record["argv"] = [argv[0], replacement, ...argv.slice(2)];
    fixture.writeRecord();
    const result = await resolveManagedGjcSession(fixture.pane, dependencies(fixture));
    expect(result?.state === "blocked" ? result.reason : result?.state).toBe("blocked_runtime_identity");
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

it("rejects changed runtime contents after the producer pinned them", async () => {
  const changedPin = makeFixture();
  try {
    writeFileSync(changedPin.runtimeProofFile, "changed package identity\n");
    const result = await resolveManagedGjcSession(changedPin.pane, dependencies(changedPin));
    expect(result?.state === "blocked" ? result.reason : result?.state).toBe("blocked_runtime_identity");
  } finally { rmSync(changedPin.root, { recursive: true, force: true }); }
});

it("rejects a live child command-line substitution", async () => {
  const changedProcess = makeFixture();
  try {
    const child = changedProcess.live.get(changedProcess.sdkPid);
    if (child) changedProcess.live.set(child.pid, { ...child, argv: ["/tmp/substituted-bun", ...child.argv.slice(1)] });
    const result = await resolveManagedGjcSession(changedProcess.pane, dependencies(changedProcess));
    expect(result?.state === "blocked" ? result.reason : result?.state).toBe("blocked_child_identity");
  } finally { rmSync(changedProcess.root, { recursive: true, force: true }); }
});

it("rejects stale broker and child births and an SDK session from another run", async () => {
  for (const pid of [51001, 51002]) {
    const fixture = makeFixture();
    try {
      const live = fixture.live.get(pid);
      if (live) fixture.live.set(pid, { ...live, starttime: "999" });
      const result = await resolveManagedGjcSession(fixture.pane, dependencies(fixture));
      expect(result?.state).toBe("blocked");
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  }
  const stalePid = makeFixture();
  try {
    const child = stalePid.record["child"];
    if (child !== null && typeof child === "object") stalePid.record["child"] = { ...child, pid: 51999 };
    stalePid.writeRecord();
    expect((await resolveManagedGjcSession(stalePid.pane, dependencies(stalePid)))?.state).toBe("blocked");
  } finally { rmSync(stalePid.root, { recursive: true, force: true }); }

  const fixture = makeFixture();
  try {
    fixture.sdkSessionId = "another-session";
    expect((await resolveManagedGjcSession(fixture.pane, dependencies(fixture)))?.state).toBe("blocked");
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

it("rejects generation, pane, project and transcript inode mismatches", async () => {
  const cases = [
    (f: ReturnType<typeof makeFixture>) => { f.pane = { ...f.pane, tokens: { hm_managed_session: "a".repeat(32), hm_managed_generation: "2" } }; },
    (f: ReturnType<typeof makeFixture>) => { f.pane = { ...f.pane, pane_id: "other-pane" }; },
    (f: ReturnType<typeof makeFixture>) => { f.pane = { ...f.pane, terminal_id: "other-terminal" }; },
    (f: ReturnType<typeof makeFixture>) => {
      const otherProject = join(f.root, "other-project");
      mkdirSync(otherProject, { mode: 0o700 });
      f.pane = { ...f.pane, cwd: otherProject };
    },
    (f: ReturnType<typeof makeFixture>) => {
      const otherProject = join(f.root, "other-project");
      mkdirSync(otherProject, { mode: 0o700 });
      writeFileSync(f.sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "00000000-0000-4000-8000-000000000001", cwd: otherProject })}\n`);
    },
    (f: ReturnType<typeof makeFixture>) => {
      const replacement = join(f.root, "replacement.jsonl");
      writeFileSync(replacement, "replacement\n", { mode: 0o600 });
      const info = statSync(replacement);
      f.record["file_identity"] = { dev: info.dev, ino: info.ino };
      f.writeRecord();
    },
  ];
  for (const change of cases) {
    const fixture = makeFixture();
    try {
      change(fixture);
      expect((await resolveManagedGjcSession(fixture.pane, dependencies(fixture)))?.state).toBe("blocked");
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  }
});

it("rejects removed or replaced authoritative records", async () => {
  const removed = makeFixture();
  try {
    rmSync(removed.recordPath);
    expect((await resolveManagedGjcSession(removed.pane, dependencies(removed)))?.state).toBe("blocked");
  } finally { rmSync(removed.root, { recursive: true, force: true }); }

  const replaced = makeFixture();
  try {
    replaced.record["session_id"] = "replacement-session";
    replaced.writeRecord();
    expect((await resolveManagedGjcSession(replaced.pane, dependencies(replaced)))?.state).toBe("blocked");
  } finally { rmSync(replaced.root, { recursive: true, force: true }); }
});

it("rejects a world-writable non-sticky ancestor of the managed authority", async () => {
  const fixture = makeFixture();
  try {
    chmodSync(fixture.root, 0o777);
    const result = await resolveManagedGjcSession(fixture.pane, dependencies(fixture));
    expect(result?.state === "blocked" ? result.reason : result?.state).toBe("blocked_record_ancestor_mode");
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

it("rechecks the live pane and record after the SDK lookup", async () => {
  const fixture = makeFixture();
  try {
    const deps: ManagedGjcDeps = {
      ...dependencies(fixture),
      sdkSession: async (_record, pid) => {
        fixture.pane = { ...fixture.pane, terminal_id: "reassigned" };
        return { sessionId: fixture.sdkSessionId, pid, hostIncarnation: `linux:${fixture.sdkBirth}`, endpointGeneration: 3 };
      },
    };
    expect((await resolveManagedGjcSession(fixture.pane, deps))?.state).toBe("blocked");
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }

  const changed = makeFixture();
  try {
    const deps: ManagedGjcDeps = {
      ...dependencies(changed),
      sdkSession: async (_record, pid) => {
        changed.record["generation"] = 2;
        changed.writeRecord();
        return { sessionId: changed.sdkSessionId, pid, hostIncarnation: `linux:${changed.sdkBirth}`, endpointGeneration: 3 };
      },
    };
    expect((await resolveManagedGjcSession(changed.pane, deps))?.state).toBe("blocked");
  } finally { rmSync(changed.root, { recursive: true, force: true }); }
});

it("rejects endpoint and host changes after a transcript binding is captured", async () => {
  for (const changed of ["generation", "host"] as const) {
    const fixture = makeFixture();
    try {
      let generation = 3;
      let host = `linux:${fixture.sdkBirth}`;
      const deps: ManagedGjcDeps = {
        ...dependencies(fixture),
        sdkSession: async (_record, pid) => ({ sessionId: fixture.sdkSessionId, pid, hostIncarnation: host, endpointGeneration: generation }),
      };
      const resolved = await resolveManagedGjcSession(fixture.pane, deps);
      expect(resolved?.state).toBe("ready");
      if (resolved?.state !== "ready") throw new Error("missing binding");
      if (changed === "generation") generation++; else host = "linux:other";
      await expect(assertManagedGjcCurrent(fixture.pane, resolved.binding, deps)).rejects.toMatchObject({ reason: "blocked_managed_identity_changed" });
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  }
});

it("rechecks SDK generation after the last asynchronous pane process proof", async () => {
  const fixture = makeFixture();
  try {
    let generation = 3;
    let infos = 0;
    const deps: ManagedGjcDeps = {
      ...dependencies(fixture),
      processInfo: async () => { if (++infos === 2) generation = 4; return fixture.processInfo; },
      sdkSession: async (_record, pid) => ({ sessionId: fixture.sdkSessionId, pid, hostIncarnation: `linux:${fixture.sdkBirth}`, endpointGeneration: generation }),
    };
    expect(await resolveManagedGjcSession(fixture.pane, deps)).toMatchObject({ state: "blocked", reason: "blocked_gjc_session_mismatch" });
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

it("rechecks record, transcript header and live processes after the final SDK await", async () => {
  for (const change of ["record", "header", "process"] as const) {
    const fixture = makeFixture();
    try {
      let calls = 0;
      const deps: ManagedGjcDeps = {
        ...dependencies(fixture),
        sdkSession: async (_record, pid) => {
          if (++calls === 2) {
            if (change === "record") { fixture.record["generation"] = 2; fixture.writeRecord(); }
            if (change === "header") writeFileSync(fixture.sessionFile, `${JSON.stringify({ type: "session", id: "other", cwd: fixture.cwd })}\n`);
            if (change === "process") fixture.live.delete(fixture.sdkPid);
          }
          return { sessionId: fixture.sdkSessionId, pid, hostIncarnation: `linux:${fixture.sdkBirth}`, endpointGeneration: 3 };
        },
      };
      expect((await resolveManagedGjcSession(fixture.pane, deps))?.state).toBe("blocked");
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  }
});
