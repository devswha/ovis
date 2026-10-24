/**
 * Which Muse Code session a pane shows. herdr labels the pane `muse` but reports no session for
 * it, and argv names one only after `muse resume <id>`. Muse writes `.session.lock` into every
 * session directory it opens (`pid=<pid>`, and `host=<host>` on recent builds) and never deletes
 * it; a session the TUI switches away from ends its log with `session.end`.
 */
import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { HerdrPane } from "../shared/protocol.ts";
import { paneProcessInfo } from "./herdr/client.ts";
import { processStartUpperBoundAsync } from "./process-start.ts";

const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * A process's start is an upper bound: up to two seconds late on macOS (whole seconds of `ps`
 * elapsed time, plus one), and up to two 10 ms ticks late on Linux.
 */
const START_SLACK_MS = process.platform === "darwin" ? 3000 : 20;
const TAIL_BYTES = 64 * 1024;

/** `muse` itself, or the versioned `muse-bin-<version>` binary its launcher runs. */
export function isMuseExecutable(argv0: string): boolean {
  const name = basename(argv0.replace(/\\/g, "/")).replace(/\.exe$/i, "");
  return name === "muse" || name.startsWith("muse-bin-");
}

/** Where Muse keeps its data: `$XDG_DATA_HOME/muse`, else `~/.local/share/muse`. */
export function defaultMuseData(): string {
  const xdg = process.env["XDG_DATA_HOME"];
  return join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".local", "share"), "muse");
}

/** The pid and host a session lock names; null for any other content (a subagent's lock is empty). */
export function parseMuseLock(text: string): { pid: number; host: string | null } | null {
  const pid = /^pid=(\d+)$/m.exec(text)?.[1];
  return pid === undefined ? null : { pid: Number(pid), host: /^host=(.+)$/m.exec(text)?.[1] ?? null };
}

/**
 * The log exists and its last complete record is not `session.end`. A record still being
 * written counts as live; a log not created yet does not, since the lock can come first.
 */
export function museSessionLive(path: string): boolean {
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return false; }
  try {
    const size = fstatSync(fd).size;
    const bytes = Buffer.alloc(Math.min(size, TAIL_BYTES));
    const got = readSync(fd, bytes, 0, bytes.length, size - bytes.length);
    const lines = bytes.subarray(0, got).toString("utf8").split("\n");
    if (lines.pop() !== "") return true;
    return lines.at(-1)?.includes('"payload_type":"session.end"') !== true;
  } catch { return false; } finally { closeSync(fd); }
}

/** Host names compared by their first label, as `mini` and `mini.local` name one PC. */
const sameHost = (a: string, b: string): boolean => a.split(".")[0]!.toLowerCase() === b.split(".")[0]!.toLowerCase();

function names(dir: string, pattern: RegExp): string[] {
  try { return readdirSync(dir).filter((name) => pattern.test(name)); } catch { return []; }
}

/** Past this many sessions the store is not scanned and Chat uses Terminal, as in grok-store.ts. */
const MAX_SESSIONS = 4096;

/** A Muse process of the pane, with an upper bound of its start time. */
export interface MuseOwner { pid: number; startedAt: number }

/** The session directory each process was last bound to, by store and pid; checked again on each resolve. */
const bound = new Map<string, string>();
/** Until when a scan that bound nothing stands, by store and pids: the monitor resolves such a pane every 2 s. */
const missed = new Map<string, number>();
const MISS_MS = 2000;

function remember<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > 64) map.delete(map.keys().next().value!);
}

/**
 * The log in `dir` and the one of `owners` its lock names (with this host, when it names one),
 * when the lock was written since that process started and the log has not ended; else null. A
 * lock left by an earlier process that had the same pid is older than this one; a session the
 * process switched away from has ended. The lock is read only when it is new enough for one owner.
 */
function heldLog(dir: string, owners: readonly MuseOwner[], host: string): { pid: number; log: string } | null {
  const lock = join(dir, ".session.lock");
  let pid: number | undefined;
  try {
    const written = statSync(lock).mtimeMs;
    const fresh = owners.filter((owner) => written >= owner.startedAt - START_SLACK_MS);
    if (fresh.length === 0) return null;
    const named = parseMuseLock(readFileSync(lock, "utf8"));
    if (named === null || (named.host !== null && !sameHost(named.host, host))) return null;
    pid = fresh.find((owner) => owner.pid === named.pid)?.pid;
  } catch { return null; }
  const log = join(dir, "session.jsonl");
  return pid !== undefined && museSessionLive(log) ? { pid, log } : null;
}

/**
 * The log of the one session the pane's Muse processes hold open (heldLog). A binding is kept
 * per process and only its own lock and log end are checked on later resolves. The store is
 * scanned again when that check fails, as after an in-TUI switch, which ends the old log. Null
 * unless the scan leaves exactly one session, or when the store holds more than MAX_SESSIONS.
 * A scan that binds nothing is not repeated for MISS_MS, so a pane whose Muse has written no log
 * yet costs one scan per monitor interval. It is kept by pids only, as each reading of a start
 * time differs: a new process that takes a pid back within MISS_MS waits that long to bind.
 */
export function museSessionFor(data: string, owners: MuseOwner[], host = hostname(), now = Date.now()): string | null {
  for (const owner of owners) {
    const key = `${owner.pid}\0${data}`;
    const dir = bound.get(key);
    if (dir === undefined) continue;
    const held = heldLog(dir, [owner], host);
    if (held !== null) return held.log;
    bound.delete(key);
  }
  const scan = `${owners.map((owner) => owner.pid).sort((a, b) => a - b).join(",")}\0${data}`;
  if ((missed.get(scan) ?? 0) > now) return null;
  const found = scanStore(data, owners, host);
  if (found === null) {
    remember(missed, scan, now + MISS_MS);
    return null;
  }
  missed.delete(scan);
  remember(bound, `${found.pid}\0${data}`, dirname(found.log));
  return found.log;
}

/** The one session in the store that heldLog finds for `owners`, or null for none, several or a store too large to read. */
function scanStore(data: string, owners: readonly MuseOwner[], host: string): { pid: number; log: string } | null {
  const dirs: string[] = [];
  const sessions = join(data, "sessions");
  for (const year of names(sessions, /^\d{4}$/)) {
    for (const month of names(join(sessions, year), /^\d{2}$/)) {
      for (const day of names(join(sessions, year, month), /^\d{2}$/)) {
        for (const id of names(join(sessions, year, month, day), SESSION)) {
          if (dirs.push(join(sessions, year, month, day, id)) > MAX_SESSIONS) return null;
        }
      }
    }
  }
  let found: { pid: number; log: string } | null = null;
  for (const dir of dirs) {
    const held = heldLog(dir, owners, host);
    if (held === null) continue;
    if (found !== null) return null;
    found = held;
  }
  return found;
}

/**
 * The session log a Muse pane shows, or null when its Muse processes hold no single session.
 * A `muse` launcher that stays alive beside its `muse-bin-…` child holds no lock of its own.
 */
export async function resolveMuseSession(pane: HerdrPane, data = defaultMuseData()): Promise<string | null> {
  try {
    const info = await paneProcessInfo(pane.pane_id);
    const pids = (info?.foreground_processes ?? []).filter((p) => Number.isSafeInteger(p.pid) && p.pid > 1 && isMuseExecutable(p.argv?.[0] ?? p.argv0 ?? "")).map((p) => p.pid);
    const owners = (await Promise.all(pids.map(async (pid) => ({ pid, startedAt: await processStartUpperBoundAsync(pid) }))))
      .filter((owner): owner is MuseOwner => owner.startedAt !== null);
    return owners.length === 0 ? null : museSessionFor(data, owners);
  } catch { return null; }
}
