/** Agy owns one presence lock for the conversation currently displayed in this process. */
import { readdirSync, readFileSync, opendirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { dlopen, FFIType, ptr } from "bun:ffi";
import type { HerdrPane } from "../shared/protocol.ts";
import { paneProcessInfo } from "./herdr/client.ts";

export interface AgyStore { root: string; session: string; path: string; pid: number; started: string }
const LOCK = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.lock$/i;

/** Only paths held by the selected process are candidates; directory contents aren't evidence. */
export function agyStoreFromLocks(paths: readonly string[]): Pick<AgyStore, "root" | "session" | "path"> | null {
  const locks = new Set<string>();
  for (const path of paths) {
    if (basename(dirname(path)) !== "presence" || !LOCK.test(basename(path))) continue;
    try {
      const canonical = realpathSync(path);
      if (basename(dirname(canonical)) !== "presence" || !LOCK.test(basename(canonical)) || !statSync(canonical).isFile()) return null;
      locks.add(canonical);
    } catch { return null; }
  }
  if (locks.size !== 1) return null;
  const lock = [...locks][0]!;
  try {
    const root = dirname(dirname(lock));
    const session = basename(lock, ".lock");
    const path = join(root, "brain", session, ".system_generated", "logs", "transcript_full.jsonl");
    return { root, session, path };
  } catch { return null; }
}

/**
 * Windows has no `/proc` and no `lsof`, so the held locks are asked of the documented Restart
 * Manager instead: `RmGetList` names the processes using a file. Agy's presence locks are the only
 * files asked about, and a caller that cannot get an answer fails closed to the terminal.
 */
const RM_PROCESS_INFO_SIZE = 668; // RM_UNIQUE_PROCESS(12) + 256 WCHAR + 64 WCHAR + 4 x 4-byte fields
const MAX_WINDOWS_CANDIDATES = 4096;
const WINDOWS_SCAN_TTL_MS = 5_000;

/** Encode a UTF-8 string to a null-terminated UTF-16LE buffer for Win32 API calls. */
function utf16(value: string): Buffer { return Buffer.from(`${value}\0`, "utf16le"); }

/** Load rstrtmgr.dll via Bun FFI for querying file lock owners. */
const openRestartManager = () => dlopen("rstrtmgr.dll", {
  RmStartSession: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.u32 },
  RmRegisterResources: { args: [FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.u32 },
  RmGetList: { args: [FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
  RmEndSession: { args: [FFIType.u32], returns: FFIType.u32 },
});

/** Load kernel32.dll via Bun FFI for process inspection and handle management. */
const openKernel = () => dlopen("kernel32.dll", {
  OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
  GetProcessTimes: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
});

let windowsApis: { restartManager: ReturnType<typeof openRestartManager>; kernel: ReturnType<typeof openKernel> } | null = null;
/** Lazily initialize and cache Win32 FFI function bindings. */
function windowsApi(): NonNullable<typeof windowsApis> {
  windowsApis ??= { restartManager: openRestartManager(), kernel: openKernel() };
  return windowsApis;
}

/** Every process the Restart Manager names for this file; empty when the file is not held. */
function windowsHolders(path: string): number[] {
  const { restartManager } = windowsApi();
  const session = Buffer.alloc(4);
  // CCH_RM_SESSION_KEY (32) + NUL, in WCHARs = 66 bytes.
  if (restartManager.symbols.RmStartSession(session, 0, Buffer.alloc(68)) !== 0) return [];
  const handle = session.readUInt32LE(0);
  try {
    const name = utf16(path);
    const files = Buffer.alloc(8);
    files.writeBigUInt64LE(BigInt(ptr(name)), 0);
    if (restartManager.symbols.RmRegisterResources(handle, 1, files, 0, null, 0, null) !== 0) return [];
    const needed = Buffer.alloc(4), count = Buffer.alloc(4), reasons = Buffer.alloc(4);
    let status = restartManager.symbols.RmGetList(handle, needed, count, null, reasons);
    const total = needed.readUInt32LE(0);
    // ERROR_MORE_DATA carries the count; a complete answer in one call means no holders.
    if (status !== 234 || total === 0 || total > MAX_WINDOWS_CANDIDATES) return [];
    const list = Buffer.alloc(RM_PROCESS_INFO_SIZE * total);
    count.writeUInt32LE(total, 0);
    status = restartManager.symbols.RmGetList(handle, needed, count, list, reasons);
    if (status !== 0) return [];
    const owners: number[] = [];
    for (let index = 0; index < count.readUInt32LE(0); index += 1) owners.push(list.readUInt32LE(RM_PROCESS_INFO_SIZE * index));
    return owners;
  } finally { restartManager.symbols.RmEndSession(handle); }
}

/** Agy keeps one lock per conversation under its data dir; presence mirrors the agent's own store. */
export function windowsLockCandidates(env: Record<string, string | undefined> = process.env, home = homedir()): string[] {
  const roots = new Set([env["ANTIGRAVITY_APP_DATA_DIR"] || join(home, ".gemini", "antigravity-cli")]);
  const candidates: string[] = [];
  for (const root of roots) {
    let names: string[];
    try { names = readdirSync(join(root, "presence")); } catch { continue; }
    for (const name of names) if (LOCK.test(name)) candidates.push(join(root, "presence", name));
  }
  return candidates.slice(0, MAX_WINDOWS_CANDIDATES);
}

interface WindowsScan { at: number; owners: Map<number, string[]> }
let windowsScan: WindowsScan | null = null;
let windowsScanning: Promise<WindowsScan> | null = null;
let windowsScanId = 0;

/** Invalidate in-flight and completed candidate scans so the next lookup rescans. */
function invalidateWindowsScan(): void {
  windowsScan = null;
  windowsScanning = null;
  windowsScanId += 1;
}

/** Reset scan and holder caches between tests. */
export function resetWindowsScanCacheForTest(): void {
  invalidateWindowsScan();
  windowsHeld.clear();
}

/**
 * One pass over the candidates, shared by every caller and every pane. Each `RmGetList` call blocks,
 * so the pass yields between them: a scan takes a few seconds without stalling the server.
 */
function windowsScanAll(
  getHolders: (path: string) => number[] = windowsHolders,
  getCandidates: () => string[] = windowsLockCandidates,
): Promise<WindowsScan> {
  const known = windowsScan;
  if (known && Date.now() - known.at < WINDOWS_SCAN_TTL_MS) return Promise.resolve(known);
  if (!windowsScanning) {
    const id = ++windowsScanId;
    windowsScanning = (async () => {
      const owners = new Map<number, string[]>();
      for (const path of getCandidates()) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (windowsScanId !== id) break;
        for (const pid of getHolders(path)) owners.set(pid, [...(owners.get(pid) ?? []), path]);
      }
      const scan = { at: Date.now(), owners };
      if (windowsScanId === id) windowsScan = scan;
      return scan;
    })().finally(() => { if (windowsScanId === id) windowsScanning = null; });
  }
  return windowsScanning;
}

/** Validated pid → held lock, so a resolved pane costs one call per refresh instead of a pass. */
const windowsHeld = new Map<number, string>();

/** The locks this pid holds: one known path is re-validated, a new or moved session is scanned. */
export async function windowsHeldPaths(
  pid: number,
  getHolders: (path: string) => number[] = windowsHolders,
  getCandidates: () => string[] = windowsLockCandidates,
): Promise<string[]> {
  const known = windowsHeld.get(pid);
  if (known !== undefined) {
    if (getHolders(known).includes(pid)) return [known];
    windowsHeld.delete(pid);
    invalidateWindowsScan();
  }
  // A scan already names every owner, so a pane it saw costs one confirmation instead of a pass.
  const seen = windowsScan?.owners.get(pid);
  if (seen?.length === 1) {
    if (getHolders(seen[0]!).includes(pid)) {
      windowsHeld.set(pid, seen[0]!);
      if (windowsHeld.size > 64) windowsHeld.delete(windowsHeld.keys().next().value!);
      return seen;
    }
    invalidateWindowsScan();
  }
  const scan = await windowsScanAll(getHolders, getCandidates);
  const scanned = scan.owners.get(pid) ?? [];
  const held = scanned.filter((path) => getHolders(path).includes(pid));
  if (held.length !== scanned.length) invalidateWindowsScan();
  if (held.length === 1) {
    windowsHeld.set(pid, held[0]!);
    if (windowsHeld.size > 64) windowsHeld.delete(windowsHeld.keys().next().value!);
  }
  return held;
}

/** Stable process birth identity; elapsed-time estimates drift between reads on macOS. */
async function processIdentity(pid: number): Promise<{ started: string } | null> {
  try {
    if (process.platform === "linux") {
      const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").pop()!.split(" ");
      const ticks = fields[19];
      if (!ticks || !/^\d+$/.test(ticks)) return null;
      return { started: `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${ticks}` };
    }
    if (process.platform === "darwin") {
      const child = Bun.spawn(["/bin/ps", "-o", "lstart=", "-p", String(pid)], {
        stdout: "pipe", stderr: "ignore", timeout: 1000, env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      });
      const started = (await new Response(child.stdout).text()).trim();
      return await child.exited === 0 && started ? { started } : null;
    }
    if (process.platform === "win32") {
      // Creation time in 100 ns ticks: a reused pid starts later, so it cannot pass for the owner.
      const { kernel } = windowsApi();
      const handle = kernel.symbols.OpenProcess(0x1000, 0, pid);
      if (handle === null || handle === undefined) return null;
      try {
        const dates = Buffer.alloc(32);
        if (!kernel.symbols.GetProcessTimes(handle, dates, dates.subarray(8), dates.subarray(16), dates.subarray(24))) return null;
        const created = dates.readBigUInt64LE(0);
        return created > 0n ? { started: `win32:${created}` } : null;
      } finally { kernel.symbols.CloseHandle(handle); }
    }
  } catch { /* gone or unreadable owner */ }
  return null;
}

/** List open file paths held by the given process id on the current platform. */
async function heldPaths(pid: number): Promise<string[]> {
  if (process.platform === "darwin") {
    const child = Bun.spawn(["/usr/sbin/lsof", "-nPbw", "-a", "-p", String(pid), "-Fn"], { stdout: "pipe", stderr: "ignore", timeout: 3000 });
    const text = await new Response(child.stdout).text();
    if (await child.exited !== 0 || text.length > 1024 * 1024) return [];
    return text.split("\n").filter((line) => line.startsWith("n")).map((line) => line.slice(1));
  }
  if (process.platform === "win32") return windowsHeldPaths(pid);
  if (process.platform !== "linux") return [];
  const dir = opendirSync(`/proc/${pid}/fd`);
  const paths: string[] = [];
  try {
    let count = 0;
    for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
      if (++count > 4096) return [];
      try { paths.push(readlinkSync(`/proc/${pid}/fd/${entry.name}`)); } catch { /* closed during enumeration */ }
    }
  } finally { dir.closeSync(); }
  return paths;
}

/** herdr names the process `agy` on Unix and `agy.exe` on Windows, as it does for herdr itself. */
export function isAgyProcessName(name: unknown): boolean {
  if (typeof name !== "string") return false;
  return process.platform === "win32" ? /(?:^|[\\/])agy(?:\.exe)?$/i.test(name) : name === "agy";
}

/** Resolve the Agy session store for the given pane by matching process identity and held locks. */
export async function resolveAgyStore(pane: HerdrPane): Promise<AgyStore | null> {
  if (pane.agent !== "agy") return null;
  try {
    const info = await paneProcessInfo(pane.pane_id);
    const owners = (info?.foreground_processes ?? []).filter((p) => isAgyProcessName(p.name) && Number.isSafeInteger(p.pid) && p.pid > 1);
    if (owners.length !== 1) return null;
    const pid = owners[0]!.pid;
    const before = await processIdentity(pid);
    const store = agyStoreFromLocks(await heldPaths(pid));
    const after = await processIdentity(pid);
    return before && store && before.started === after?.started ? { ...store, pid, started: before.started } : null;
  } catch { return null; }
}

/** Check whether two AgyStore references identify the same process and session path. */
export function sameAgyStore(a: AgyStore, b: AgyStore | null): boolean {
  return b !== null && a.pid === b.pid && a.started === b.started && a.path === b.path;
}
