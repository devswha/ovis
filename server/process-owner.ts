import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

export interface ProcessBirth { platform: string; value: string }
export interface OwnerRecord { pid: number; generation: string; birth?: ProcessBirth }
export type BirthReading = { state: "absent" } | { state: "identified"; birth: ProcessBirth } | { state: "unknown" };

/** Field 22 of /proc/<pid>/stat (start time in clock ticks after boot), counted after the last ") " because the command name may hold one. */
export function linuxStartTicks(stat: string): string | null {
  const end = stat.lastIndexOf(") ");
  if (end < 0) return null;
  const ticks = stat.slice(end + 2).split(" ")[19];
  return ticks !== undefined && /^\d+$/.test(ticks) ? ticks : null;
}

/** `ps -o lstart=` under LC_ALL=C and TZ=UTC, e.g. "Wed Oct 21 17:41:40 2026". */
export function parseLstart(text: string): string | null {
  const value = text.trim().replace(/\s+/g, " ");
  return /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(value) ? value : null;
}

/** Signal 0 sends nothing: ESRCH proves the PID free, EPERM means someone else's process runs there. */
export function probeProcess(pid: number): "absent" | "running" | "denied" {
  try {
    process.kill(pid, 0);
    return "running";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ESRCH" ? "absent" : code === "EPERM" ? "denied" : "running";
  }
}

function birthValue(pid: number): string | null {
  try {
    if (process.platform === "linux") {
      const ticks = linuxStartTicks(readFileSync(`/proc/${pid}/stat`, "utf8"));
      const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      return ticks && boot ? `${boot}:${ticks}` : null;
    }
    if (process.platform === "darwin") {
      const ps = Bun.spawnSync(["/bin/ps", "-o", "lstart=", "-p", String(pid)], {
        stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 2000, env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      });
      return ps.exitCode === 0 ? parseLstart(ps.stdout.toString()) : null;
    }
    if (process.platform === "win32") {
      // the creation time Windows records for the process, read through CIM as windows-processes.ts
      // reads it: CIM has it for every process, while Get-Process StartTime throws for one this user
      // cannot open (a SYSTEM, elevated or other session's process) unless it runs elevated
      const ps = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command",
        `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction SilentlyContinue; if ($p -and $p.CreationDate) { ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() }`],
      { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 10_000, windowsHide: true });
      const value = ps.exitCode === 0 ? ps.stdout.toString().trim() : "";
      return /^\d+$/.test(value) ? value : null;
    }
  } catch {}
  return null;
}

export function readProcessBirth(pid: number): BirthReading {
  if (probeProcess(pid) === "absent") return { state: "absent" };
  const value = birthValue(pid);
  if (value !== null) return { state: "identified", birth: { platform: process.platform, value } };
  return probeProcess(pid) === "absent" ? { state: "absent" } : { state: "unknown" };
}

let ownBirth: ProcessBirth | null | undefined;
export function newOwnerRecord(): OwnerRecord {
  if (ownBirth === undefined) {
    const reading = readProcessBirth(process.pid);
    ownBirth = reading.state === "identified" ? reading.birth : null;
  }
  return { pid: process.pid, generation: randomUUID(), ...(ownBirth ? { birth: ownBirth } : {}) };
}

const BIRTH_FORMS: Record<string, (value: string) => boolean> = {
  linux: (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d+$/.test(value),
  darwin: (value) => parseLstart(value) === value,
  win32: (value) => /^\d+$/.test(value),
};

export function parseBirth(birth: unknown): ProcessBirth | null {
  if (birth === null || typeof birth !== "object") return null;
  const { platform, value } = birth as Record<string, unknown>;
  if (typeof platform !== "string" || typeof value !== "string" || !Object.hasOwn(BIRTH_FORMS, platform)) return null;
  return BIRTH_FORMS[platform]!(value) ? { platform, value } : null;
}

export function parseOwnerRecord(text: string): OwnerRecord | null {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (value === null || typeof value !== "object") return null;
  const { pid, generation, birth } = value as Record<string, unknown>;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return null;
  if (typeof generation !== "string" || !generation || generation.length > 200) return null;
  if (birth === undefined) return { pid, generation };
  const parsed = parseBirth(birth);
  return parsed ? { pid, generation, birth: parsed } : null;
}

export function ownerGone(owner: { pid: number; birth?: unknown }): boolean {
  if (probeProcess(owner.pid) === "absent" || exitedUnreaped(owner.pid)) return true;
  const recorded = parseBirth(owner.birth);
  if (!recorded || recorded.platform !== process.platform) return false;
  const reading = readProcessBirth(owner.pid);
  return reading.state === "absent" || (reading.state === "identified" && reading.birth.value !== recorded.value);
}

/**
 * Linux: the PID holds a process that has exited but whose parent has not reaped it yet (state Z).
 * It runs no code and holds nothing, whoever it was, yet it still answers signal 0 with its birth.
 */
function exitedUnreaped(pid: number): boolean {
  if (process.platform !== "linux") return false;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[0] === "Z";
  } catch {
    return false;
  }
}

/**
 * A PID-only record from an older version: on Windows, a process that started after the record was
 * written is proved to be someone else (a forced shutdown skips cleanup and Windows hands the PID on).
 */
export function legacyOwnerReplaced(pid: number, recordedAt: number): boolean {
  if (process.platform !== "win32") return false;
  const reading = readProcessBirth(pid);
  return reading.state === "identified" && Number(reading.birth.value) > recordedAt;
}
