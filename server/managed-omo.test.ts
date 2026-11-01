import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaneProcessInfo } from "../shared/herdr-api.generated.ts";
import type { HerdrPane } from "../shared/protocol.ts";
import { inspectManagedOmoEvidence, readManagedOmoEvidence, revalidateManagedOmoEvidence, type ManagedOmoInput, type ManagedOmoProcess, type ManagedOmoSystem } from "./managed-omo.ts";

const roots: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "managed-omo-")); roots.push(root);
  const dir = (path: string) => { mkdirSync(path, { recursive: true, mode: 0o700 }); return path; };
  const uid = process.getuid!();
  const nonce = "0123456789abcdef0123456789abcdef";
  const namespace = dir(join(root, "managed"));
  const sessionDir = dir(join(namespace, `${nonce}.sessions`));
  const sessionId = "session-1";
  const holderDir = dir(join(sessionDir, "session-holders", sessionId));
  const holder = join(holderDir, "30.json");
  const cwd = dir(join(root, "project"));
  const configDir = dir(join(root, "config"));
  const socketDir = dir(join(configDir, "herdr", "sessions", "phase1"));
  const socket = join(socketDir, "herdr.sock");
  const server = createServer(); servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
  const alias = join(root, "alias.sock"); symlinkSync(socket, alias);
  const manager = dir(join(root, "manager"));
  const script = join(manager, "managed_pty.py"); writeFileSync(script, "manager", { mode: 0o600 });
  const exe = join(root, "bun"); writeFileSync(exe, "engine", { mode: 0o700 });
  const entry = join(root, "omo.mjs"); writeFileSync(entry, "engine", { mode: 0o600 });
  const sessionPath = join(sessionDir, "session.jsonl"); writeFileSync(sessionPath, "not inspected", { mode: 0o600 });
  const { statSync } = await import("node:fs");
  const sessionStat = statSync(sessionPath);
  const recordPath = join(namespace, `${nonce}.json`);
  const argv = [exe, entry, "--session-dir", sessionDir];
  const fingerprint = (path: string) => `${realpathSync(path)}:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
  const group = `/user.slice/herdr-agent-${nonce}.service`;
  const python = realpathSync("/usr/bin/python3");
  const base = (pid: number, exe: string, cgroup: string, parentPid: number, argv: string[]): ManagedOmoProcess =>
    ({ pid, exe, cwd, cgroup, parentPid, argv, starttime: `${pid}000`, boot: "boot" });
  const processes = new Map<number, ManagedOmoProcess>([
    [10, base(10, python, "/server", 1, [python])],
    [20, base(20, python, group, 1, ["/usr/bin/python3", script, "serve", "--record", recordPath])],
    [30, base(30, exe, group, 20, argv)],
    [40, base(40, python, "/pane", 1, ["/usr/bin/python3", script, "attach", "--record", recordPath, "--generation", "1", "--terminal", "term"])],
  ]);
  const pin = (pid: number) => {
    const p = processes.get(pid)!;
    return { pid, starttime: p.starttime, boot: p.boot, cwd: p.cwd, cgroup: p.cgroup, exe: p.exe };
  };
  const record: Record<string, unknown> = {
    schema: 2, nonce, harness: "omo", launcher_harness: "omo", generation: 1, engine_generation: 1,
    broker_fork_generation: 1, state: "ready", desired_state: "running", pane_id: "w:p1", workspace_id: "w",
    terminal_id: "term", cwd, argv, server_session: "phase1", server: pin(10), broker: pin(20), child: pin(30),
    session_id: sessionId, session_file: sessionPath, session_dir: sessionDir,
    file_identity: { dev: sessionStat.dev, ino: sessionStat.ino }, socket: `/run/user/${uid}/herdr-managed/${nonce}.sock`,
    runtime: { [exe]: fingerprint(exe), [entry]: fingerprint(entry), [script]: fingerprint(script) },
  };
  const save = () => writeFileSync(recordPath, JSON.stringify(record), { mode: 0o600 });
  const saveHolder = (path = holder, pid = 30) => writeFileSync(path,
    JSON.stringify({ pid, cwd, bootAtMs: 100000, processStartedAtMs: 110000 }), { mode: 0o600 });
  save(); saveHolder();
  const pane = { pane_id: "w:p1", workspace_id: "w", terminal_id: "term", cwd,
    agent_status: "working", focused: false, revision: 1, tab_id: "tab",
    tokens: { hm_managed_session: nonce, hm_managed_generation: "1" } } as HerdrPane;
  const processInfo = { pane_id: pane.pane_id, foreground_processes: [
    { pid: 40, name: "python3", cwd, argv: [...processes.get(40)!.argv] },
  ] } satisfies PaneProcessInfo;
  const input: ManagedOmoInput = { pane, processInfo, namespace, socket: alias, configDir };
  const os: ManagedOmoSystem = { platform: "linux", uid, process: pid => processes.get(pid) ?? null,
    socketOwnedBy: (_socket, pid) => pid === 10, bootAt: () => 100000, startedAt: () => 110000 };
  return { root, input, os, record, save, holder, holderDir, saveHolder, processes, recordPath, sessionPath, sessionDir, socket, script, exe };
}

describe.skipIf(process.platform !== "linux")("managed OMO ownership", () => {
  it("binds a private session and alias socket to the broker's child, and revalidates", async () => {
    const f = await fixture();
    // Native holder and transcript modes can be group-readable inside the private store.
    chmodSync(f.holderDir, 0o775); chmodSync(f.holder, 0o664); chmodSync(f.sessionPath, 0o664);
    const evidence = readManagedOmoEvidence(f.input, f.os);
    expect(evidence).toMatchObject({ agent: "omo", paneId: "w:p1", pid: 30, wrapperPid: 40,
      sessionPath: f.sessionPath, holderPath: f.holder, sessionId: "session-1" });
    expect(revalidateManagedOmoEvidence(evidence!, f.input, f.os)).toBe(true);
    f.processes.get(40)!.starttime = "40001";
    expect(revalidateManagedOmoEvidence(evidence!, f.input, f.os)).toBe(false);
  });

  it("rejects a wrong pane generation, process pin or broker parent", async () => {
    const f = await fixture();
    f.input.pane.tokens!.hm_managed_generation = "2";
    expect(readManagedOmoEvidence(f.input, f.os)).toBeNull();
    f.input.pane.tokens!.hm_managed_generation = "1";
    f.processes.get(30)!.starttime = "changed";
    expect(readManagedOmoEvidence(f.input, f.os)).toBeNull();
    f.processes.get(30)!.starttime = "30000";
    f.processes.get(30)!.parentPid = 40;
    expect(readManagedOmoEvidence(f.input, f.os)).toBeNull();
  });

  it("rejects an unsupported host, another socket, or an unowned listener", async () => {
    const f = await fixture();
    expect(inspectManagedOmoEvidence(f.input, { ...f.os, platform: "darwin" })).toEqual({ evidence: null, reason: "platform" });
    expect(readManagedOmoEvidence(f.input, { ...f.os, platform: "darwin" })).toBeNull();
    expect(readManagedOmoEvidence({ ...f.input, socket: "https://remote.example" }, f.os)).toBeNull();
    let processReads = 0;
    const tracked = { ...f.os, process: (pid: number) => { processReads++; return f.os.process(pid); } };
    expect(readManagedOmoEvidence({ ...f.input, socket: f.recordPath }, tracked)).toBeNull();
    expect(processReads).toBe(0);
    expect(readManagedOmoEvidence(f.input, { ...f.os, socketOwnedBy: () => false })).toBeNull();
    expect(inspectManagedOmoEvidence(f.input, { ...f.os, socketOwnedBy: () => false })).toEqual({ evidence: null, reason: "server_identity" });
  });

  it("admits an owner-controlled 775 ancestor while retaining the private namespace", async () => {
    const f = await fixture();
    chmodSync(f.root, 0o775);
    expect(readManagedOmoEvidence(f.input, f.os)).not.toBeNull();
    chmodSync(f.root, 0o777);
    expect(inspectManagedOmoEvidence(f.input, f.os)).toEqual({ evidence: null, reason: "path_ancestor" });
  });

  it("rejects a symlinked namespace ancestor and non-private final records", async () => {
    const f = await fixture();
    const link = join(f.root, "linked"); symlinkSync(f.root, link);
    expect(inspectManagedOmoEvidence({ ...f.input, namespace: join(link, "managed") }, f.os)).toEqual({ evidence: null, reason: "path_link" });
    chmodSync(f.recordPath, 0o644);
    expect(inspectManagedOmoEvidence(f.input, f.os)).toEqual({ evidence: null, reason: "file_owner" });
  });

  it("requires recorded runtime hashes for the child and managed PTY script", async () => {
    const f = await fixture();
    const evidence = readManagedOmoEvidence(f.input, f.os);
    expect(evidence).not.toBeNull();
    const runtime = { ...(f.record.runtime as Record<string, string>) };
    f.record.runtime = { ...runtime, [f.exe]: "pinned" };
    f.save();
    expect(inspectManagedOmoEvidence(f.input, f.os)).toMatchObject({ evidence: null, reason: "runtime_identity" });
    f.record.runtime = runtime;
    writeFileSync(f.script, "changed", { mode: 0o600 });
    f.save();
    expect(inspectManagedOmoEvidence(f.input, f.os)).toMatchObject({ evidence: null, reason: "runtime_identity" });
  });

  it("rejects extra holders and mismatched holder birth or cwd", async () => {
    const f = await fixture();
    const other = join(f.sessionDir, "session-holders", "other"); mkdirSync(other, { mode: 0o700 });
    f.saveHolder(join(other, "30.json"));
    expect(readManagedOmoEvidence(f.input, f.os)).toBeNull();
    rmSync(other, { recursive: true });
    writeFileSync(f.holder, JSON.stringify({ pid: 30, cwd: f.root, bootAtMs: 100000, processStartedAtMs: 110000 }));
    expect(readManagedOmoEvidence(f.input, f.os)).toBeNull();
    writeFileSync(f.holder, JSON.stringify({ pid: 30, cwd: f.input.pane.cwd, bootAtMs: 100000, processStartedAtMs: 105000 }));
    expect(readManagedOmoEvidence(f.input, f.os)).toBeNull();
  });

  it("rejects record replacement, symlinks and changing generation", async () => {
    const f = await fixture();
    const evidence = readManagedOmoEvidence(f.input, f.os)!;
    f.record.generation = 2; f.save();
    expect(revalidateManagedOmoEvidence(evidence, f.input, f.os)).toBe(false);
    f.record.generation = 1; f.save();
    let reads = 0;
    const changing: ManagedOmoSystem = { ...f.os, process: pid => {
      if (++reads === 5) { f.record.generation = 2; f.save(); }
      return f.os.process(pid);
    } };
    expect(readManagedOmoEvidence(f.input, changing)).toBeNull();
    f.record.generation = 1; f.save();
    const original = `${f.recordPath}.original`;
    const { renameSync } = await import("node:fs");
    renameSync(f.recordPath, original); symlinkSync(original, f.recordPath);
    expect(readManagedOmoEvidence(f.input, f.os)).toBeNull();
  });
});
