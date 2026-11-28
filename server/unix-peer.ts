import { execFile } from "node:child_process";
import { readdirSync, readlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** A socket inode as `ss` prints it. The `ss` of iproute2 6.1 (Ubuntu 24.04) prints it as a signed 32-bit
 * number, so past 2^31 inode 2154015387 reads -2140951909; /proc/net/unix always prints it unsigned. */
export const ssInode = (printed: string) => (BigInt(printed) & 0xffffffffn).toString();

/** The descriptors `pid` has open, each with the file it names, or null when they cannot be listed. */
export function descriptorTargets(pid: number): Map<string, string> | null {
  let descriptors: string[];
  try { descriptors = readdirSync(`/proc/${pid}/fd`); } catch { return null; }
  if (descriptors.length > 512) return null;
  const targets = new Map<string, string>();
  for (const descriptor of descriptors) {
    try { targets.set(descriptor, readlinkSync(`/proc/${pid}/fd/${descriptor}`)); } catch { return null; }
  }
  return targets;
}

export const socketInodes = (targets: ReadonlyMap<string, string>) =>
  new Set([...targets.values()].flatMap((target) => /^socket:\[(\d+)\]$/.exec(target)?.[1] ?? []));
export const sameDescriptors = (before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string> | null) =>
  after !== null && after.size === before.size && [...before].every(([descriptor, target]) => after.get(descriptor) === target);

/**
 * The kernel's unix stream sockets on Linux: `peers`, each established socket's inode to its peer's (from `ss`, which
 * /proc/net/unix lacks), and `names`, each socket's inode to the path it is bound to (an accepted socket carries its
 * listener's). null when either cannot be read.
 */
export async function unixSocketTable(): Promise<{ readonly peers: ReadonlyMap<string, string>; readonly names: ReadonlyMap<string, string> } | null> {
  try {
    const [sockets, established] = await Promise.all([
      readFile("/proc/net/unix", "utf8"),
      exec("ss", ["-xHn", "state", "established"], { timeout: 1000, maxBuffer: 2 * 1024 * 1024 }),
    ]);
    const names = new Map<string, string>();
    for (const line of sockets.split("\n")) {
      const hit = /^\S+:\s+\S+\s+\S+\s+\S+\s+0001\s+\S+\s+(\d+)\s+(\/.*)$/.exec(line);
      if (hit !== null) names.set(hit[1]!, hit[2]!);
    }
    const peers = new Map<string, string>();
    // the peer's address column is `*` (ss names no peer path), so the two inodes are the line's last numbers
    for (const line of established.stdout.split("\n")) {
      const pair = /^u_str\s+.*\s(-?\d+)\s+\*\s+(-?\d+)\s*$/.exec(line);
      if (pair !== null) peers.set(ssInode(pair[1]!), ssInode(pair[2]!));
    }
    return { peers, names };
  } catch { return null; }
}
