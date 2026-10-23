/**
 * Which Muse Code session a pane shows. herdr labels the pane `muse` but reports no session for
 * it, and argv names one only after `muse resume <id>`. Muse writes `.session.lock` into every
 * session directory it opens (`pid=<pid>`, and `host=<host>` on recent builds) and never deletes
 * it; a session the TUI switches away from ends its log with `session.end`.
 */
import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import type { HerdrPane } from "../shared/protocol.ts";
import { paneProcessInfo } from "./herdr/client.ts";
import { processStartUpperBoundAsync } from "./process-start.ts";

const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A process's start is an upper bound up to two seconds late on macOS (whole seconds of `ps` elapsed time, plus one). */
const START_SLACK_MS = 3000;
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

/**
 * The log of the one session `pid` holds open: its lock names the pid (and this host, when it
 * names one) and was written since the process started, and its log has not ended. A lock left
 * by an earlier process that had the same pid is older than this one; a session the process
 * switched away from has ended. Null unless exactly one is left.
 */
// ponytail: stats every session lock on each resolve; index locks by mtime if stores grow to thousands
export function museSessionFor(data: string, pid: number, startedAt: number, host = hostname()): string | null {
  const found: string[] = [];
  const sessions = join(data, "sessions");
  for (const year of names(sessions, /^\d{4}$/)) {
    for (const month of names(join(sessions, year), /^\d{2}$/)) {
      for (const day of names(join(sessions, year, month), /^\d{2}$/)) {
        for (const id of names(join(sessions, year, month, day), SESSION)) {
          const dir = join(sessions, year, month, day, id);
          const lock = join(dir, ".session.lock");
          try {
            if (statSync(lock).mtimeMs < startedAt - START_SLACK_MS) continue;
            const owner = parseMuseLock(readFileSync(lock, "utf8"));
            if (owner === null || owner.pid !== pid || (owner.host !== null && !sameHost(owner.host, host))) continue;
          } catch { continue; }
          const log = join(dir, "session.jsonl");
          if (museSessionLive(log)) found.push(log);
        }
      }
    }
  }
  return found.length === 1 ? found[0]! : null;
}

/** The session log a Muse pane shows, or null when its one Muse process holds no single session. */
export async function resolveMuseSession(pane: HerdrPane, data = defaultMuseData()): Promise<string | null> {
  try {
    const info = await paneProcessInfo(pane.pane_id);
    const owners = (info?.foreground_processes ?? []).filter((p) => Number.isSafeInteger(p.pid) && p.pid > 1 && isMuseExecutable(p.argv?.[0] ?? p.argv0 ?? ""));
    if (owners.length !== 1) return null;
    const startedAt = await processStartUpperBoundAsync(owners[0]!.pid);
    return startedAt === null ? null : museSessionFor(data, owners[0]!.pid, startedAt);
  } catch { return null; }
}
