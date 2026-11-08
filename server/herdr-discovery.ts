import { existsSync, lstatSync, readdirSync, readFileSync, statSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { herdrAcceptsConnection } from "./herdr/client.ts";
import type { FoundHerdrSession } from "../shared/machines.ts";

export interface HerdrDiscoveryHost {
  home: string;
  /** the account's own home (its passwd entry): a HOME other than it is a sandbox, which sees only its own roots */
  accountHome?: string;
  xdg?: string;
  procRoot?: string;
  uid?: number;
  platform?: NodeJS.Platform;
  probe?(socket: string): Promise<boolean>;
}

function processSocket(args: string[], home: string, xdg?: string): string | null {
  if (!args[0]?.split("/").pop()?.startsWith("herdr")) return null;
  const tail = args.slice(1);
  let session: string | undefined;
  const at = tail.indexOf("--session");
  if (at >= 0) { session = tail[at + 1]; tail.splice(at, 2); }
  if (tail[0] !== "server" || session !== undefined && !/^[a-zA-Z0-9_-]{1,64}$/.test(session)) return null;
  const root = xdg?.startsWith("/") ? xdg : join(home, ".config");
  return session ? join(root, "herdr/sessions", session, "herdr.sock") : join(root, "herdr/herdr.sock");
}

function candidates(host: HerdrDiscoveryHost): string[] {
  const roots = [...new Set([join(host.home, ".config"), host.xdg].filter((root): root is string => Boolean(root)))];
  const paths: string[] = [];
  for (const root of roots) {
    const base = join(root, "herdr");
    paths.push(join(base, "herdr.sock"));
    try {
      for (const entry of readdirSync(join(base, "sessions"), { withFileTypes: true })) {
        if (entry.isDirectory()) paths.push(join(base, "sessions", entry.name, "herdr.sock"));
      }
    } catch { /* a missing sessions directory is normal */ }
  }
  if (host.platform === "linux" && host.procRoot) {
    for (const entry of readdirSync(host.procRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
      const proc = join(host.procRoot, entry.name);
      try {
        const uid = statSync(proc).uid;
        if (host.uid !== undefined && uid !== host.uid) continue;
        const args = readFileSync(join(proc, "cmdline"), "utf8").split("\0").filter(Boolean);
        const env = Object.fromEntries(readFileSync(join(proc, "environ"), "utf8").split("\0").filter(Boolean).map((item) => {
          const at = item.indexOf("="); return at < 0 ? [item, ""] : [item.slice(0, at), item.slice(at + 1)];
        }));
        // A sandbox HOME must never reach the account's live sessions through /proc.
        if (env.HOME && env.HOME !== host.home) continue;
        const socket = processSocket(args, env.HOME || host.home, env.XDG_CONFIG_HOME);
        if (socket) paths.push(socket);
      } catch { /* a process may exit while it is being inspected */ }
    }
  }
  // every listening unix socket named herdr.sock, whatever program serves it (a wrapper, a renamed binary) and wherever
  // its XDG root is: ownership, scope and a real connection decide below
  if (host.platform === "linux" && host.procRoot) {
    try {
      for (const line of readFileSync(join(host.procRoot, "net/unix"), "utf8").split("\n").slice(1)) {
        const fields = line.trim().split(/\s+/);
        // Flags 00010000: a listening socket (__SO_ACCEPTCON)
        // the path is the rest of the line: it may hold spaces
        const path = fields.slice(7).join(" ");
        if (fields[3] === "00010000" && path?.startsWith("/") && path.endsWith("/herdr.sock")) paths.push(path);
      }
    } catch { /* no /proc/net/unix: the roots and processes above are all there is */ }
  }
  return [...new Set(paths)];
}

/** the account's home from /etc/passwd (Bun's userInfo().homedir follows $HOME); none found keeps discovery confined */
function passwdHome(uid: number | undefined): string | undefined {
  try {
    for (const line of readFileSync("/etc/passwd", "utf8").split("\n")) {
      const fields = line.split(":");
      if (fields.length >= 7 && Number(fields[2]) === uid && fields[2] !== "") return fields[5];
    }
  } catch { /* no /etc/passwd */ }
  // an account from LDAP or SSSD is not in /etc/passwd: ask NSS
  try {
    const entry = Bun.spawnSync(["getent", "passwd", String(uid)], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const fields = entry.stdout.toString().trim().split(":");
    if (entry.exitCode === 0 && fields.length >= 7 && Number(fields[2]) === uid) return fields[5];
  } catch { /* no getent (macOS): discovery stays confined to HOME and its XDG root */ }
  return undefined;
}

export async function discoverHerdrSessions(host: HerdrDiscoveryHost = { home: process.env.HOME || homedir(), xdg: process.env.XDG_CONFIG_HOME, procRoot: "/proc", platform: process.platform, uid: process.getuid?.() }): Promise<FoundHerdrSession[]> {
  const probe = host.probe ?? herdrAcceptsConnection;
  const uid = host.uid ?? process.getuid?.();
  const roots: string[] = [];
  for (const root of [host.home, host.xdg]) {
    if (!root?.startsWith("/")) continue;
    try { roots.push(realpathSync(root)); } catch { /* a missing config root has no candidates */ }
  }
  // only a sandboxed HOME is confined to its own roots; the account itself may run herdr under any XDG root it set
  const confined = host.home !== (host.accountHome ?? passwdHome(uid));
  const found: FoundHerdrSession[] = [];
  const paths = candidates(host);
  if (host.platform === "darwin") {
    const ps = Bun.spawn(["ps", "eww", "-U", String(host.uid ?? process.getuid?.()), "-o", "command="], { env: process.env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const text = await new Response(ps.stdout).text();
    if (await ps.exited === 0) for (const line of text.split("\n")) {
      const home = /(?:^|\s)HOME=(\S+)/.exec(line)?.[1];
      if (home && home !== host.home) continue;
      const args = line.trim().split(/\s+/);
      const xdg = /(?:^|\s)XDG_CONFIG_HOME=(\S+)/.exec(line)?.[1];
      const socket = processSocket(args, host.home, xdg);
      if (socket) paths.push(socket);
    }
  }
  const seen = new Set<string>();
  for (const path of paths) {
    if (!existsSync(path)) continue;
    let socket: string;
    try {
      const link = lstatSync(path);
      if (link.uid !== uid) continue;
      socket = realpathSync(path);
      const resolved = statSync(socket);
      if (resolved.uid !== uid || !resolved.isSocket()) continue;
      if (confined && !roots.some((root) => socket === root || socket.startsWith(root + "/"))) continue;
    } catch { continue; /* a daemon may leave while discovery runs */ }
    if (seen.has(socket)) continue;
    seen.add(socket);
    if (!existsSync(socket)) continue;
    try { if (!(await probe(socket))) continue; } catch { continue; }
    const session = /\/herdr\/sessions\/([a-zA-Z0-9_-]{1,64})\/herdr\.sock$/.exec(socket)?.[1];
    found.push({ socket_path: socket, ...(session ? { session } : {}), label: session ?? "Default session" });
  }
  return found;
}

export function validHerdrSocket(value: unknown): value is string {
  return typeof value === "string" && value.length <= 4096 && value.startsWith("/") && value.endsWith("/herdr.sock") && !/[\0\r\n]/.test(value);
}

export function parseFoundHerdrSessions(value: unknown): FoundHerdrSession[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) throw new Error("The PC returned an invalid list of herdr sessions");
  return value.map((row: unknown) => {
    if (typeof row !== "object" || row === null || !("socket_path" in row) || !validHerdrSocket(row.socket_path)
      || !("label" in row) || typeof row.label !== "string" || row.label.length > 256
      || "session" in row && (typeof row.session !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(row.session))) throw new Error("The PC returned an invalid herdr session");
    return { socket_path: row.socket_path, label: row.label, ...("session" in row && typeof row.session === "string" ? { session: row.session } : {}) };
  });
}
