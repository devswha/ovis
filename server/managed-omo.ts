import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readlinkSync, readSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { PaneProcessInfo } from "../shared/herdr-api.generated.ts";
import type { HerdrPane } from "../shared/protocol.ts";
import { hostBootAt, matchesOmoHolder } from "./omo.ts";
import { processStartedAt } from "./process-start.ts";

export interface ManagedOmoProcess {
  pid: number; starttime: string; boot: string; cwd: string; cgroup: string; exe: string;
  parentPid: number; argv: readonly string[];
}

/** OS observations may be injected for isolated fixtures; production uses Linux /proc. */
export interface ManagedOmoSystem {
  platform: string; uid: number;
  process(pid: number): ManagedOmoProcess | null;
  socketOwnedBy(socket: string, pid: number): boolean;
  bootAt(): number | null;
  startedAt(pid: number): number | null;
}

export interface ManagedOmoInput {
  pane: HerdrPane;
  processInfo: PaneProcessInfo | null;
  namespace: string;
  /** Exact local socket used by this Ovis connection, never a remote endpoint. */
  socket: string;
  /** XDG_CONFIG_HOME used by the manager when it pinned herdr. */
  configDir: string;
}

export interface ManagedOmoEvidence {
  agent: "omo"; paneId: string; workspaceId: string; terminalId: string;
  nonce: string; generation: number; engineGeneration: number;
  sessionId: string; sessionPath: string; sessionDir: string; holderPath: string;
  cwd: string; pid: number; startedAt: number; processStart: string; boot: string;
  wrapperPid: number; wrapperStart: string;
  /** Digest of all observed bindings, including the record and file identities. */
  binding: string;
}

export const MANAGED_OMO_PROOF_REASONS = [
  "argv", "broker_argv", "changed", "child_argv", "child_executable", "clock", "directory_changed",
  "directory_limit", "directory_owner", "file_changed", "file_owner", "generation", "holder_ambiguous",
  "holder_identity", "holder_invalid", "holder_limit", "holder_name", "manager_script", "pane_process",
  "pane_tag", "path", "path_ancestor", "path_link", "platform", "process_identity", "process_pin",
  "read_limit", "record_identity", "runtime", "runtime_identity", "runtime_limit", "server_identity",
  "session_ambiguous", "session_file", "session_identity", "socket_identity", "socket_path", "unavailable",
  "wrapper", "wrapper_identity",
] as const;
export type ManagedOmoProofReason = typeof MANAGED_OMO_PROOF_REASONS[number];

export class ManagedOmoProofFailure extends Error {
  constructor(readonly reason: ManagedOmoProofReason) { super(reason); this.name = "ManagedOmoProofFailure"; }
}

function fail(reason: ManagedOmoProofReason): never { throw new ManagedOmoProofFailure(reason); }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function absolute(value: unknown): value is string { return typeof value === "string" && isAbsolute(value) && resolve(value) === value; }
function positive(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function identity(stat: { dev: number; ino: number; mode: number; uid: number; size: number; mtimeMs: number; ctimeMs: number; nlink: number }): readonly number[] {
  return [stat.dev, stat.ino, stat.mode, stat.uid, stat.size, stat.mtimeMs, stat.ctimeMs, stat.nlink];
}
function owned(stat: { uid: number; mode: number }, uid: number): boolean { return stat.uid === uid && (stat.mode & 0o002) === 0; }
function safeAncestor(stat: { uid: number; mode: number; isDirectory(): boolean }, uid: number): boolean {
  const stickyRoot = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
  const ownerControlled = stat.uid === uid && (stat.mode & 0o002) === 0;
  return stat.isDirectory() && (stickyRoot || ownerControlled || (stat.uid === 0 && (stat.mode & 0o022) === 0));
}

/** Ancestors follow the GJC repair policy; the namespace and its records stay private below. */
function safePath(path: string, uid: number): void {
  if (!absolute(path)) fail("path");
  const target = lstatSync(path);
  if (target.isSymbolicLink() || realpathSync(path) !== path) fail("path_link");
  for (let current = dirname(path); ; current = dirname(current)) {
    const stat = lstatSync(current);
    if (!safeAncestor(stat, uid)) fail("path_ancestor");
    if (realpathSync(current) !== current) fail("path_link");
    if (dirname(current) === current) return;
  }
}
function directory(path: string, uid: number, privateMode = false): readonly number[] {
  safePath(path, uid);
  const stat = lstatSync(path);
  if (!stat.isDirectory() || !owned(stat, uid) || (privateMode && (stat.mode & 0o077) !== 0)) fail("directory_owner");
  return identity(stat);
}
function file(path: string, uid: number, limit: number, privateMode = false): { bytes: Buffer; id: readonly number[] } {
  safePath(path, uid);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || !owned(before, uid) || (privateMode && (before.mode & 0o077) !== 0) || before.size > limit) fail("file_owner");
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, length);
      if (count === 0) break;
      length += count;
    }
    if (length > limit || !same(identity(before), identity(fstatSync(fd))) || !same(identity(before), identity(lstatSync(path)))) fail("file_changed");
    return { bytes: bytes.subarray(0, length), id: identity(before) };
  } finally { closeSync(fd); }
}
function boundedText(path: string, limit: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > limit) fail("read_limit");
    return bytes.subarray(0, length).toString("utf8");
  } finally { closeSync(fd); }
}
function boundedNames(path: string, limit: number): string[] {
  const handle = opendirSync(path);
  try {
    const names: string[] = [];
    for (;;) {
      const entry = handle.readSync();
      if (entry === null) return names;
      names.push(entry.name);
      if (names.length > limit) fail("directory_limit");
    }
  } finally { handle.closeSync(); }
}
function procProcess(pid: number): ManagedOmoProcess | null {
  if (!positive(pid) || process.platform !== "linux" || process.getuid === undefined) return null;
  try {
    const root = `/proc/${pid}`;
    if (statSync(root).uid !== process.getuid()) return null;
    const text = boundedText(join(root, "stat"), 16384);
    const end = text.lastIndexOf(") ");
    if (end < 0) return null;
    const fields = text.slice(end + 2).trim().split(/\s+/);
    const parentPid = Number(fields[1]);
    const starttime = fields[19];
    const cgroup = boundedText(join(root, "cgroup"), 65536).split("\n").find(line => line.startsWith("0::"))?.slice(3);
    const argv = boundedText(join(root, "cmdline"), 65536).split("\0");
    if (argv.at(-1) === "") argv.pop();
    if (fields[0] === "Z" || !starttime || !/^\d+$/.test(starttime) || !Number.isSafeInteger(parentPid)
      || !cgroup || !argv.length) return null;
    return { pid, parentPid, starttime, cgroup, argv, boot: boundedText("/proc/sys/kernel/random/boot_id", 256).trim(),
      cwd: realpathSync(join(root, "cwd")), exe: readlinkSync(join(root, "exe")) };
  } catch { return null; }
}

/** Match the listening kernel socket to a descriptor of the already-pinned server, without a process search. */
function socketOwnedBy(socket: string, pid: number): boolean {
  try {
    const target = statSync(socket);
    const table = boundedText("/proc/net/unix", 4 * 1024 * 1024);
    const matches = new Set<string>();
    for (const line of table.split("\n").slice(1)) {
      const words = line.trim().split(/\s+/);
      if (words.length < 8 || words[3] !== "00010000" || !/^\d+$/.test(words[6]!)) continue;
      const path = words.slice(7).join(" ");
      if (!isAbsolute(path)) continue;
      try {
        const info = statSync(path);
        if (info.isSocket() && info.dev === target.dev && info.ino === target.ino) matches.add(`socket:[${words[6]}]`);
      } catch { /* another socket disappeared */ }
    }
    if (matches.size !== 1) return false;
    const fds = boundedNames(`/proc/${pid}/fd`, 65536);
    for (const fd of fds) {
      try { if (matches.has(readlinkSync(`/proc/${pid}/fd/${fd}`))) return true; } catch { /* descriptor closed */ }
    }
  } catch { /* unavailable is not proof */ }
  return false;
}
const system: ManagedOmoSystem = {
  platform: process.platform, uid: process.getuid?.() ?? -1, process: procProcess, socketOwnedBy,
  bootAt: hostBootAt, startedAt: processStartedAt,
};

function pin(value: unknown, live: ManagedOmoProcess | null): live is ManagedOmoProcess {
  if (!object(value) || !live || !positive(value.pid) || typeof value.starttime !== "string" || !/^\d+$/.test(value.starttime)
    || typeof value.boot !== "string" || !value.boot || !absolute(value.cwd) || !absolute(value.exe)
    || typeof value.cgroup !== "string" || !value.cgroup.startsWith("/")) return false;
  return value.pid === live.pid && value.starttime === live.starttime && value.boot === live.boot
    && value.cwd === live.cwd && value.exe === live.exe && value.cgroup === live.cgroup;
}
function pid(value: unknown): number { if (!object(value) || !positive(value.pid)) fail("process_pin"); return value.pid; }
function args(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256 || value.some(item => typeof item !== "string")) fail("argv");
  return value as string[];
}
function list(path: string, uid: number): string[] {
  const before = directory(path, uid);
  const names = boundedNames(path, 512).sort();
  if (!same(before, directory(path, uid))) fail("directory_changed");
  return names;
}

const MAX_RUNTIME_ENTRIES = 128;
const MAX_RUNTIME_FILE_BYTES = 128 * 1024 * 1024;
const MAX_RUNTIME_TOTAL_BYTES = 512 * 1024 * 1024;

/** Match manager fingerprint values without an unbounded read or trusting a pathname alone. */
function runtimeIdentityMatches(argv: readonly string[], runtime: Readonly<Record<string, string>>): Set<string> {
  const entries = Object.entries(runtime);
  if (entries.length === 0 || entries.length > MAX_RUNTIME_ENTRIES) fail("runtime_identity");
  const canonicalPaths = new Set<string>();
  let totalBytes = 0;
  for (const [path, expected] of entries) {
    if (!absolute(path) || typeof expected !== "string") fail("runtime_identity");
    let canonical: string;
    try { canonical = realpathSync(path); } catch { fail("runtime_identity"); }
    if (!absolute(canonical)) fail("runtime_identity");
    const fd = openSync(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.size > MAX_RUNTIME_FILE_BYTES || totalBytes + before.size > MAX_RUNTIME_TOTAL_BYTES) fail("runtime_limit");
      totalBytes += before.size;
      const hash = createHash("sha256");
      const chunk = Buffer.alloc(64 * 1024);
      let offset = 0;
      while (offset < before.size) {
        const count = readSync(fd, chunk, 0, Math.min(chunk.length, before.size - offset), offset);
        if (count <= 0) fail("runtime_identity");
        hash.update(chunk.subarray(0, count));
        offset += count;
      }
      const after = fstatSync(fd);
      if (!same(identity(before), identity(after)) || !same(identity(before), identity(lstatSync(canonical)))
        || realpathSync(path) !== canonical) fail("runtime_identity");
      const digest = hash.digest("hex");
      if (expected !== `${canonical}:${digest}`) fail("runtime_identity");
      canonicalPaths.add(canonical);
    } finally { closeSync(fd); }
  }
  if (!argv.slice(0, 2).every(path => {
    try { return canonicalPaths.has(realpathSync(path)); } catch { return false; }
  })) fail("runtime_identity");
  return canonicalPaths;
}

function observe(input: ManagedOmoInput, os: ManagedOmoSystem): ManagedOmoEvidence {
  if (os.platform !== "linux" || !Number.isSafeInteger(os.uid) || os.uid < 0) fail("platform");
  const tokens = input.pane.tokens;
  if (!object(tokens) || typeof tokens.hm_managed_session !== "string" || !/^[0-9a-f]{32}$/.test(tokens.hm_managed_session)
    || typeof tokens.hm_managed_generation !== "string" || !/^[1-9][0-9]*$/.test(tokens.hm_managed_generation)) fail("pane_tag");
  const nonce = tokens.hm_managed_session;
  const generation = Number(tokens.hm_managed_generation);
  if (!positive(generation)) fail("generation");
  const namespaceId = directory(input.namespace, os.uid, true);
  const recordPath = join(input.namespace, `${nonce}.json`);
  const stored = file(recordPath, os.uid, 65536, true);
  const row: unknown = JSON.parse(stored.bytes.toString("utf8"));
  if (!object(row) || row.schema !== 2 || row.nonce !== nonce || row.harness !== "omo" || row.launcher_harness !== "omo"
    || row.generation !== generation || !positive(row.engine_generation) || row.broker_fork_generation !== row.engine_generation
    || row.state !== "ready" || row.desired_state !== "running" || row.pane_id !== input.pane.pane_id
    || row.workspace_id !== input.pane.workspace_id || row.terminal_id !== input.pane.terminal_id
    || typeof row.terminal_id !== "string" || !row.terminal_id || !absolute(row.cwd) || !input.pane.cwd
    || realpathSync(input.pane.cwd) !== row.cwd || realpathSync(row.cwd) !== row.cwd) fail("record_identity");
  if (!absolute(input.configDir) || !absolute(input.socket) || typeof row.server_session !== "string"
    || !/^[A-Za-z0-9_-]{1,80}$/.test(row.server_session)) fail("socket_path");
  const serverSocket = join(input.configDir, "herdr", "sessions", row.server_session, "herdr.sock");
  let socket: { isSocket(): boolean; uid: number; dev: number; ino: number };
  let expectedSocket: { isSocket(): boolean; uid: number; dev: number; ino: number };
  try {
    safePath(serverSocket, os.uid);
    socket = statSync(input.socket);
    expectedSocket = statSync(serverSocket);
  } catch { fail("socket_identity"); }
  if (!socket.isSocket() || !expectedSocket.isSocket() || socket.uid !== os.uid || expectedSocket.uid !== os.uid
    || socket.dev !== expectedSocket.dev || socket.ino !== expectedSocket.ino) fail("socket_identity");
  try { if (realpathSync(input.socket) !== realpathSync(serverSocket)) fail("socket_identity"); }
  catch { fail("socket_identity"); }
  const server = os.process(pid(row.server));
  if (!pin(row.server, server) || !os.socketOwnedBy(input.socket, server.pid)) fail("server_identity");
  const sessionDir = join(input.namespace, `${nonce}.sessions`);
  if (row.session_dir !== sessionDir || row.socket !== `/run/user/${os.uid}/herdr-managed/${nonce}.sock`
    || typeof row.session_id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(row.session_id)
    || !absolute(row.session_file) || dirname(row.session_file) !== sessionDir || !row.session_file.endsWith(".jsonl")) fail("session_identity");
  const sessionDirId = directory(sessionDir, os.uid, true);
  const sessionNames = list(sessionDir, os.uid).filter(name => name.endsWith(".jsonl"));
  if (sessionNames.length !== 1 || sessionNames[0] !== basename(row.session_file)) fail("session_ambiguous");
  safePath(row.session_file, os.uid);
  const sessionStat = lstatSync(row.session_file);
  if (!sessionStat.isFile() || !owned(sessionStat, os.uid) || !object(row.file_identity)
    || !Number.isSafeInteger(row.file_identity.dev) || !Number.isSafeInteger(row.file_identity.ino)
    || row.file_identity.dev !== sessionStat.dev || row.file_identity.ino !== sessionStat.ino) fail("session_file");
  const broker = os.process(pid(row.broker)); const child = os.process(pid(row.child));
  if (!pin(row.broker, broker) || !pin(row.child, child) || broker.pid === child.pid || child.parentPid !== broker.pid
    || broker.cwd !== row.cwd || child.cwd !== row.cwd || broker.cgroup !== child.cgroup
    || broker.boot !== child.boot || server.boot !== child.boot
    || !broker.cgroup.endsWith(`/herdr-agent-${nonce}.service`)) fail("process_identity");
  const command = args(row.argv);
  if (!same(child.argv, command) && !same(child.argv, [...command, "--session", row.session_file])) fail("child_argv");
  if (!absolute(command[0]) || realpathSync(command[0]) !== child.exe || realpathSync(child.exe) !== child.exe
    || !same(command.slice(-2), ["--session-dir", sessionDir])) fail("child_executable");
  if (!object(row.runtime) || Object.values(row.runtime).some(value => typeof value !== "string")) fail("runtime");
  const scripts = Object.keys(row.runtime).filter(path => basename(path) === "managed_pty.py");
  if (scripts.length !== 1 || !absolute(scripts[0]) || realpathSync(scripts[0]) !== scripts[0]) fail("manager_script");
  const script = scripts[0];
  const runtimePaths = runtimeIdentityMatches(command, row.runtime as Record<string, string>);
  if (!runtimePaths.has(script)) fail("manager_script");
  if (!same(broker.argv, ["/usr/bin/python3", script, "serve", "--record", recordPath])) fail("broker_argv");
  const info = input.processInfo;
  if (!info || info.pane_id !== row.pane_id || !Array.isArray(info.foreground_processes)) fail("pane_process");
  const attach = ["/usr/bin/python3", script, "attach", "--record", recordPath, "--generation", String(generation), "--terminal", row.terminal_id];
  const wrappers = info.foreground_processes.filter(p => same(p.argv, attach) && p.cwd === row.cwd && positive(p.pid));
  if (wrappers.length !== 1 || !wrappers[0]) fail("wrapper");
  const wrapper = os.process(wrappers[0].pid);
  if (!wrapper || !same(wrapper.argv, attach) || wrapper.cwd !== row.cwd || !/^\d+$/.test(wrapper.starttime) || !positive(wrapper.parentPid) || wrapper.boot !== child.boot
    || realpathSync("/usr/bin/python3") !== wrapper.exe || realpathSync("/usr/bin/python3") !== broker.exe) fail("wrapper_identity");
  const startedAt = os.startedAt(child.pid); const bootAt = os.bootAt();
  if (startedAt === null || bootAt === null || !Number.isFinite(startedAt) || !Number.isFinite(bootAt)) fail("clock");
  const holderRoot = join(sessionDir, "session-holders");
  const dirs = list(holderRoot, os.uid);
  let count = dirs.length;
  const found: { path: string; id: readonly number[] }[] = [];
  const dirIds: unknown[] = [];
  for (const name of dirs) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(name)) fail("holder_name");
    const dir = join(holderRoot, name);
    const names = list(dir, os.uid); count += names.length;
    if (count > 512) fail("holder_limit");
    dirIds.push([dir, directory(dir, os.uid)]);
    for (const filename of names) {
      if (!/^[1-9][0-9]*\.json$/.test(filename)) fail("holder_name");
      const path = join(dir, filename); const saved = file(path, os.uid, 4096);
      const value: unknown = JSON.parse(saved.bytes.toString("utf8"));
      if (!object(value) || !positive(value.pid) || filename !== `${value.pid}.json` || typeof value.cwd !== "string"
        || typeof value.bootAtMs !== "number" || !Number.isFinite(value.bootAtMs)
        || typeof value.processStartedAtMs !== "number" || !Number.isFinite(value.processStartedAtMs)) fail("holder_invalid");
      if (name === row.session_id || value.pid === child.pid) {
        if (name !== row.session_id || !matchesOmoHolder(value, child.pid, row.cwd, startedAt, bootAt, true)) fail("holder_identity");
        found.push({ path, id: saved.id });
      }
    }
  }
  if (found.length !== 1 || !found[0]) fail("holder_ambiguous");
  const finalRecord = file(recordPath, os.uid, 65536, true);
  if (!same(stored.id, finalRecord.id) || !stored.bytes.equals(finalRecord.bytes)) fail("changed");
  if (!same(namespaceId, directory(input.namespace, os.uid, true)) || !same(sessionDirId, directory(sessionDir, os.uid, true))
    || !same(dirs, list(holderRoot, os.uid))) fail("directory_changed");
  for (const [path, id] of dirIds as [string, readonly number[]][]) if (!same(id, directory(path, os.uid))) fail("directory_changed");
  const binding = createHash("sha256").update(JSON.stringify({ record: stored.bytes.toString("base64"), recordId: stored.id,
    namespaceId, sessionDirId, sessionId: [sessionStat.dev, sessionStat.ino, sessionStat.uid, sessionStat.mode],
    socket: [socket.dev, socket.ino], server, broker, child, wrapper, holder: found[0], holderDirs: dirIds })).digest("hex");
  return { agent: "omo", paneId: input.pane.pane_id, workspaceId: row.workspace_id as string, terminalId: row.terminal_id,
    nonce, generation, engineGeneration: row.engine_generation, sessionId: row.session_id, sessionPath: row.session_file,
    sessionDir, holderPath: found[0].path, cwd: row.cwd, pid: child.pid, startedAt, processStart: child.starttime,
    boot: child.boot, wrapperPid: wrapper.pid, wrapperStart: wrapper.starttime, binding };
}

/** Return a double-observed, fail-closed proof; no conversation bytes are read. */
export function readManagedOmoEvidence(input: ManagedOmoInput, os: ManagedOmoSystem = system): ManagedOmoEvidence | null {
  return inspectManagedOmoEvidence(input, os).evidence;
}

/** Reports only a fixed proof stage, never the observed record or filesystem values. */
export function inspectManagedOmoEvidence(input: ManagedOmoInput, os: ManagedOmoSystem = system): { evidence: ManagedOmoEvidence | null; reason: ManagedOmoProofReason | null } {
  try {
    const first = observe(input, os); const second = observe(input, os);
    return first.binding === second.binding ? { evidence: second, reason: null } : { evidence: null, reason: "changed" };
  } catch (error) { return { evidence: null, reason: error instanceof ManagedOmoProofFailure ? error.reason : "unavailable" }; }
}

/** Obtain fresh pane and process-info inputs before calling this immediately before use. */
export function revalidateManagedOmoEvidence(evidence: ManagedOmoEvidence, input: ManagedOmoInput, os: ManagedOmoSystem = system): boolean {
  const current = readManagedOmoEvidence(input, os);
  return current !== null && current.binding === evidence.binding;
}
