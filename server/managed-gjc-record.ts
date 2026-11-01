import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import type { HerdrPane } from "../shared/protocol.ts";

export interface ManagedGjcFileIdentity { readonly dev: number; readonly ino: number }
export interface ManagedGjcProcessPin {
  readonly pid: number; readonly starttime: string; readonly boot: string;
  readonly cwd: string; readonly cgroup: string; readonly exe: string;
}
export interface ManagedGjcRecord {
  readonly nonce: string; readonly generation: number; readonly engineGeneration: number;
  readonly paneId: string; readonly workspaceId: string; readonly terminalId: string;
  readonly cwd: string; readonly sessionId: string; readonly sessionFile: string; readonly sessionDir: string;
  readonly fileIdentity: ManagedGjcFileIdentity; readonly broker: ManagedGjcProcessPin; readonly child: ManagedGjcProcessPin;
  readonly argv: readonly string[]; readonly env: Readonly<Record<string, string>>;
  readonly runtime: Readonly<Record<string, string>>; readonly recordPath: string;
  readonly state: string; readonly desiredState: string; readonly serverSession: string;
}
export interface ManagedGjcEvidence {
  readonly record: ManagedGjcRecord;
  readonly bindingDigest: string;
  readonly namespaceIdentity: ManagedGjcFileIdentity;
  readonly sessionDirectoryIdentity: ManagedGjcFileIdentity;
}

export class ManagedGjcProofFailure extends Error {
  constructor(readonly reason: string) { super(reason); this.name = "ManagedGjcProofFailure"; }
}

const NONCE = /^[0-9a-f]{32}$/;
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const TOKEN_GENERATION = /^[1-9][0-9]*$/;

function invalid(reason: string): never { throw new ManagedGjcProofFailure(reason); }
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function stringMap(value: unknown): Readonly<Record<string, string>> | null {
  if (!isObject(value) || Object.values(value).some(item => typeof item !== "string")) return null;
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) {
    if (typeof item !== "string") return null;
    result[key] = item;
  }
  return result;
}
function stringArray(value: unknown): readonly string[] | null {
  return Array.isArray(value) && value.every((item): item is string => typeof item === "string") ? value : null;
}
function fileIdentity(value: unknown): ManagedGjcFileIdentity | null {
  if (!isObject(value) || typeof value.dev !== "number" || !Number.isSafeInteger(value.dev) || value.dev < 0
    || typeof value.ino !== "number" || !Number.isSafeInteger(value.ino) || value.ino < 0) return null;
  return { dev: value.dev, ino: value.ino };
}
function processPin(value: unknown): ManagedGjcProcessPin | null {
  if (!isObject(value) || typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0
    || typeof value.starttime !== "string" || !/^\d+$/.test(value.starttime)
    || typeof value.boot !== "string" || value.boot.length === 0
    || typeof value.cwd !== "string" || !isAbsolute(value.cwd)
    || typeof value.cgroup !== "string" || !value.cgroup.startsWith("/")
    || typeof value.exe !== "string" || !isAbsolute(value.exe)) return null;
  return { pid: value.pid, starttime: value.starttime, boot: value.boot, cwd: value.cwd, cgroup: value.cgroup, exe: value.exe };
}
function privateOwned(info: { uid: number; mode: number }): boolean {
  return (process.getuid === undefined || info.uid === process.getuid()) && (info.mode & 0o022) === 0;
}
function safeAncestor(info: { uid: number; mode: number; isDirectory(): boolean }): boolean {
  const stickyRoot = info.uid === 0 && (info.mode & 0o1000) !== 0;
  const ownerControlled = process.getuid !== undefined && info.uid === process.getuid() && (info.mode & 0o002) === 0;
  return info.isDirectory() && (stickyRoot || ownerControlled || (info.uid === 0 && (info.mode & 0o022) === 0));
}
function assertSafeAncestors(path: string): void {
  for (let current = path; ; current = dirname(current)) {
    const info = lstatSync(current);
    if (!safeAncestor(info)) invalid("blocked_record_ancestor_mode");
    if (realpathSync(current) !== current) invalid("blocked_record_ancestor_link");
    if (dirname(current) === current) return;
  }
}
function sameFile(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
function isNodeError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string";
}
function runtimeIdentityMatches(argv: readonly string[], runtime: Readonly<Record<string, string>>): boolean {
  const canonicalPaths = new Set<string>();
  for (const [path, expected] of Object.entries(runtime)) {
    if (!isAbsolute(path)) return false;
    try {
      const canonical = realpathSync(path);
      const digest = createHash("sha256").update(readFileSync(canonical)).digest("hex");
      if (expected !== `${canonical}:${digest}`) return false;
      canonicalPaths.add(canonical);
    } catch (error) {
      if (isNodeError(error)) return false;
      throw error;
    }
  }
  return argv.slice(0, 2).every(path => canonicalPaths.has(path));
}
function parseRecord(value: unknown, nonce: string, path: string): ManagedGjcRecord {
  if (!isObject(value)) invalid("blocked_record_identity");
  const row = value;
  if (row.schema !== 2 || row.nonce !== nonce || row.harness !== "gjc" || row.launcher_harness !== "gjc"
    || typeof row.generation !== "number" || !Number.isSafeInteger(row.generation) || row.generation < 1
    || typeof row.engine_generation !== "number" || !Number.isSafeInteger(row.engine_generation) || row.engine_generation < 1
    || row.state !== "ready" || row.desired_state !== "running"
    || typeof row.cwd !== "string" || !isAbsolute(row.cwd)
    || typeof row.pane_id !== "string" || row.pane_id.length === 0
    || typeof row.workspace_id !== "string" || row.workspace_id.length === 0
    || typeof row.terminal_id !== "string" || row.terminal_id.length === 0
    || typeof row.session_id !== "string" || !SESSION_ID.test(row.session_id)
    || typeof row.session_file !== "string" || !isAbsolute(row.session_file)
    || typeof row.session_dir !== "string" || !isAbsolute(row.session_dir)
    || typeof row.server_session !== "string" || row.server_session.length === 0) invalid("blocked_record_identity");

  const pin = fileIdentity(row.file_identity);
  const broker = processPin(row.broker);
  const child = processPin(row.child);
  const argv = stringArray(row.argv);
  const env = stringMap(row.env);
  const runtime = stringMap(row.runtime);
  const executable = argv?.[0];
  const entry = argv?.[1];
  if (pin === null || broker === null || child === null || argv === null || argv.length < 2 || env === null || runtime === null
    || executable === undefined || entry === undefined || !isAbsolute(executable) || !isAbsolute(entry)) {
    invalid("blocked_record_identity");
  }
  if (!runtimeIdentityMatches(argv, runtime)) invalid("blocked_runtime_identity");
  if (broker.pid === child.pid || broker.cwd !== row.cwd || child.cwd !== row.cwd
    || broker.cgroup !== child.cgroup || !broker.cgroup.endsWith(`/herdr-agent-${nonce}.service`)) {
    invalid("blocked_runtime_identity");
  }
  const sessionDir = join(dirname(path), `${nonce}.sessions`);
  if (row.session_dir !== sessionDir || dirname(row.session_file) !== sessionDir || !row.session_file.endsWith(".jsonl")) {
    invalid("blocked_session_root");
  }
  return {
    nonce, generation: row.generation, engineGeneration: row.engine_generation,
    paneId: row.pane_id, workspaceId: row.workspace_id, terminalId: row.terminal_id,
    cwd: row.cwd, sessionId: row.session_id, sessionFile: row.session_file, sessionDir,
    fileIdentity: pin, broker, child, argv, env, runtime, recordPath: path,
    state: row.state, desiredState: row.desired_state, serverSession: row.server_session,
  };
}

function recordBinding(record: ManagedGjcRecord, namespaceId: ManagedGjcFileIdentity, storeId: ManagedGjcFileIdentity): string {
  const value = [record.nonce, record.generation, record.engineGeneration, record.paneId, record.workspaceId,
    record.terminalId, record.cwd, record.sessionId, record.sessionFile, record.sessionDir,
    record.fileIdentity, record.broker, record.child, record.argv,
    Object.entries(record.env).sort(([a], [b]) => a.localeCompare(b)),
    Object.entries(record.runtime).sort(([a], [b]) => a.localeCompare(b)),
    record.state, record.desiredState, record.serverSession, namespaceId, storeId];
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function declaresManagedGjc(pane: HerdrPane): boolean {
  if (!isObject(pane.tokens)) return false;
  return Object.hasOwn(pane.tokens, "hm_managed_session") || Object.hasOwn(pane.tokens, "hm_managed_generation");
}

export function sameManagedGjcPane(left: HerdrPane, right: HerdrPane): boolean {
  const a = isObject(left.tokens) ? left.tokens : null;
  const b = isObject(right.tokens) ? right.tokens : null;
  return left.pane_id === right.pane_id && left.workspace_id === right.workspace_id && left.terminal_id === right.terminal_id
    && left.cwd === right.cwd && a?.hm_managed_session === b?.hm_managed_session
    && a?.hm_managed_generation === b?.hm_managed_generation;
}

export function readManagedGjcEvidence(pane: HerdrPane, namespace: string): ManagedGjcEvidence | null {
  if (!isObject(pane.tokens)) return null;
  const tokens = pane.tokens;
  const tagged = Object.hasOwn(tokens, "hm_managed_session") || Object.hasOwn(tokens, "hm_managed_generation");
  if (!tagged) return null;
  const nonce = tokens.hm_managed_session;
  const generation = tokens.hm_managed_generation;
  if (typeof nonce !== "string" || !NONCE.test(nonce)) invalid("blocked_managed_token");
  if (typeof generation !== "string" || !TOKEN_GENERATION.test(generation) || !Number.isSafeInteger(Number(generation))) invalid("blocked_managed_generation");
  const uid = process.getuid?.();
  if (uid === undefined || process.platform !== "linux" || !isAbsolute(namespace)) invalid("blocked_record_platform");
  const namespaceInfo = lstatSync(namespace);
  if (!namespaceInfo.isDirectory() || !privateOwned(namespaceInfo) || (namespaceInfo.mode & 0o077) !== 0) invalid("blocked_record_namespace");
  assertSafeAncestors(namespace);
  const recordPath = join(namespace, `${nonce}.json`);
  const fd = openSync(recordPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let value: unknown;
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || !privateOwned(opened) || (opened.mode & 0o077) !== 0 || opened.size > 65536) invalid("blocked_record_owner");
    const buffer = Buffer.alloc(65537);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    if (length > 65536) invalid("blocked_record_size");
    const current = lstatSync(recordPath);
    if (!sameFile(opened, current) || realpathSync(recordPath) !== recordPath) invalid("blocked_record_changed");
    value = JSON.parse(buffer.subarray(0, length).toString("utf8"));
  } finally { closeSync(fd); }

  if (isObject(value) && value.schema === 2 && value.nonce === nonce && value.generation === Number(generation)
    && (value.harness === "omo" || value.harness === "codex" || value.harness === "claude")) {
    if (value.launcher_harness !== value.harness || value.desired_state !== "running" || value.state !== "ready"
      || value.pane_id !== pane.pane_id || value.workspace_id !== pane.workspace_id || value.terminal_id !== pane.terminal_id
      || typeof value.cwd !== "string" || pane.cwd === undefined || pane.cwd === null || realpathSync(pane.cwd) !== value.cwd) {
      invalid("blocked_pane_identity");
    }
    return null;
  }
  const record = parseRecord(value, nonce, recordPath);
  if (record.generation !== Number(generation)) invalid("blocked_managed_generation");
  if (pane.cwd === undefined || pane.cwd === null || realpathSync(pane.cwd) !== record.cwd
    || pane.pane_id !== record.paneId || pane.workspace_id !== record.workspaceId || pane.terminal_id !== record.terminalId) {
    invalid("blocked_pane_identity");
  }
  const storeInfo = lstatSync(record.sessionDir);
  if (!storeInfo.isDirectory() || !privateOwned(storeInfo) || (storeInfo.mode & 0o077) !== 0
    || realpathSync(record.sessionDir) !== record.sessionDir) invalid("blocked_session_root");
  assertSafeAncestors(record.sessionDir);
  const fileInfo = lstatSync(record.sessionFile);
  if (!fileInfo.isFile() || !privateOwned(fileInfo) || !sameFile(fileInfo, record.fileIdentity)
    || realpathSync(record.sessionFile) !== record.sessionFile) invalid("blocked_session_replaced");
  const header = readHeader(record.sessionFile, record.fileIdentity);
  if (header.id !== record.sessionId || typeof header.cwd !== "string" || !isAbsolute(header.cwd)
    || realpathSync(header.cwd) !== record.cwd) invalid("blocked_session_header");
  const namespaceIdentity = { dev: namespaceInfo.dev, ino: namespaceInfo.ino };
  const sessionDirectoryIdentity = { dev: storeInfo.dev, ino: storeInfo.ino };
  return { record, namespaceIdentity, sessionDirectoryIdentity,
    bindingDigest: recordBinding(record, namespaceIdentity, sessionDirectoryIdentity) };
}

function readHeader(path: string, pin: ManagedGjcFileIdentity): { id: unknown; cwd: unknown } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || !sameFile(info, pin) || !privateOwned(info)) invalid("blocked_session_replaced");
    const bytes = Buffer.alloc(16385);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, length);
      if (count === 0) break;
      const newline = bytes.indexOf(10, length);
      length += count;
      if (newline >= 0) {
        const row = JSON.parse(bytes.subarray(0, newline).toString("utf8"));
        if (!isObject(row) || row.type !== "session") invalid("blocked_session_header");
        return { id: row.id, cwd: row.cwd };
      }
    }
    invalid("blocked_session_header");
  } finally { closeSync(fd); }
}

export function openManagedGjcTranscript(evidence: ManagedGjcEvidence): number {
  const { record } = evidence;
  const fd = openSync(record.sessionFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    const pathInfo = lstatSync(record.sessionFile);
    const namespaceInfo = lstatSync(dirname(record.recordPath));
    const storeInfo = lstatSync(record.sessionDir);
    if (!info.isFile() || !privateOwned(info) || !sameFile(info, record.fileIdentity) || !sameFile(info, pathInfo)
      || !sameFile(namespaceInfo, evidence.namespaceIdentity) || !sameFile(storeInfo, evidence.sessionDirectoryIdentity)
      || realpathSync(record.sessionFile) !== record.sessionFile) invalid("blocked_session_replaced");
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}
