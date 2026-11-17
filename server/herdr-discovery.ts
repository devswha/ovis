import { existsSync, lstatSync, opendirSync, readFileSync, statSync, realpathSync } from "node:fs";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { normalize } from "node:path";
import { aclReader, harmlessGroups, trustRefusal } from "./herdr-core/discovery.ts";
import { herdrAcceptsConnection } from "./herdr/client.ts";
import type { FoundHerdrSession } from "../shared/machines.ts";

export interface HerdrDiscoveryHost {
  home: string;
  xdg?: string;
  procRoot?: string;
  uid?: number;
  platform?: NodeJS.Platform;
  probe?(socket: string): Promise<boolean>;
}
interface DiscoveryScope { dirs: Set<string>; paths: Set<string>; uid: number | undefined }
const MAX_CANDIDATES = 256;
const PROBE_TIMEOUT_MS = 1000;
const currentHost = (): HerdrDiscoveryHost => ({ home: process.env.HOME || homedir(), xdg: process.env.XDG_CONFIG_HOME, procRoot: "/proc", platform: process.platform, uid: process.getuid?.() });

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

async function discoveryScope(host: HerdrDiscoveryHost): Promise<DiscoveryScope> {
  const scope: DiscoveryScope = { dirs: new Set(), paths: new Set(), uid: host.uid ?? process.getuid?.() };
  const add = (path: string) => { if (scope.paths.size < MAX_CANDIDATES && existsSync(path)) scope.paths.add(path); };
  const allowRoot = (root: string | undefined) => {
    if (!root?.startsWith("/")) return;
    try { scope.dirs.add(realpathSync(join(root, "herdr"))); } catch {}
  };
  allowRoot(join(host.home, ".config")); allowRoot(host.xdg);
  const server = (args: string[], home: string | undefined, xdg?: string) => {
    if (home !== host.home) return;
    const path = processSocket(args, home, xdg);
    if (!path) return;
    allowRoot(xdg?.startsWith("/") ? xdg : join(home, ".config"));
    add(path);
  };
  if (host.platform === "linux" && host.procRoot) {
    try {
      const directory = opendirSync(host.procRoot);
      try {
        for (let entry; (entry = directory.readSync()) !== null;) {
          if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
          const proc = join(host.procRoot, entry.name);
          try {
            if (statSync(proc).uid !== scope.uid) continue;
            const args = readFileSync(join(proc, "cmdline"), "utf8").split("\0").filter(Boolean);
            const env = Object.fromEntries(readFileSync(join(proc, "environ"), "utf8").split("\0").filter(Boolean).map((item) => {
              const at = item.indexOf("="); return at < 0 ? [item, ""] : [item.slice(0, at), item.slice(at + 1)];
            }));
            server(args, env.HOME, env.XDG_CONFIG_HOME);
          } catch {}
        }
      } finally { directory.closeSync(); }
    } catch {}
  } else if (host.platform === "darwin") {
    const ps = Bun.spawn(["ps", "eww", "-U", String(scope.uid), "-o", "command="], { env: process.env, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: PROBE_TIMEOUT_MS });
    const text = await new Response(ps.stdout).text();
    if (await ps.exited === 0) for (const line of text.split("\n")) {
      // ps separates environment assignments with spaces; a value ends at the next assignment, not its first space.
      const env = Object.fromEntries([...line.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=(.*?)(?=\s[A-Za-z_][A-Za-z0-9_]*=|$)/g)].map((match) => [match[1], match[2]]));
      server(line.trim().split(/\s+/), env.HOME, env.XDG_CONFIG_HOME);
    }
  }
  for (const dir of scope.dirs) {
    add(join(dir, "herdr.sock"));
    try {
      const directory = opendirSync(join(dir, "sessions"));
      try {
        for (let entry; scope.paths.size < MAX_CANDIDATES && (entry = directory.readSync()) !== null;) {
          if (entry.isDirectory()) add(join(dir, "sessions", entry.name, "herdr.sock"));
        }
      } finally { directory.closeSync(); }
    } catch {}
  }
  return scope;
}

export async function chosenHerdrSocketStatus(path: string, host: HerdrDiscoveryHost = currentHost(), scope?: DiscoveryScope): Promise<"usable" | "gone" | "refused"> {
  if (!validHerdrSocket(path)) return "refused";
  const allowed = scope ?? await discoveryScope(host);
  try {
    // lstat proves the socket itself is no link; its folder carries the real-path check: Bun on macOS cannot resolve a socket (EOPNOTSUPP).
    const socket = lstatSync(path);
    if (!socket.isSocket() || socket.uid !== allowed.uid || realpathSync(dirname(path)) !== dirname(path)) return "refused";
    if (![...allowed.dirs].some((dir) => path.startsWith(dir + "/"))) return "refused";
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT" ? "gone" : "refused";
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answering = await Promise.race([
      (host.probe ?? herdrAcceptsConnection)(path),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), PROBE_TIMEOUT_MS); }),
    ]);
    return answering ? "usable" : "gone";
  } catch { return "gone"; }
  finally { clearTimeout(timer); }
}

export interface HerdrSocketPlace { dirs: string[]; uid: number | undefined; walk(folder: string): string | null }

const PLACE_ACL_AGE_MS = 60_000;

function placeWalk(): (folder: string) => string | null {
  let harmless = profileGroups(), acl = aclReader(), since = Date.now();
  return (folder) => {
    if (Date.now() - since >= PLACE_ACL_AGE_MS) { harmless = profileGroups(); acl = aclReader(); since = Date.now(); }
    return trustRefusal(folder, harmless, true, acl);
  };
}

export function profileGroups(own?: () => number | null): (gid: number, path: string) => boolean {
  return harmlessGroups("linux", own);
}

function nearestFolder(path: string): { dir: string; folder: Stats } | null {
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    try { return { dir, folder: lstatSync(dir) }; }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT") || dir === "/") return null; }
  }
}

export async function pinnedHerdrSocketStatus(path: string, host: HerdrDiscoveryHost = currentHost()): Promise<{ status: "usable" | "gone" | "refused"; place: HerdrSocketPlace; reason?: string }> {
  const scope = await discoveryScope(host);
  const configured = [join(host.home, ".config"), host.xdg].flatMap((root) => root?.startsWith("/") && !existsSync(join(root, "herdr")) ? [join(root, "herdr")] : []);
  const place = { dirs: [...scope.dirs, ...configured], uid: scope.uid, walk: placeWalk() };
  const nearest = nearestFolder(path);
  if (nearest === null) return { status: "refused", place };
  const reason = place.walk(nearest.dir);
  if (reason !== null) return { status: "refused", place, reason };
  const status = await chosenHerdrSocketStatus(path, host, scope);
  if (status !== "gone") return { status, place };
  if (normalize(path) !== path || !place.dirs.some((dir) => path.startsWith(dir + "/"))) return { status: "refused", place };
  const { dir, folder } = nearest;
  const own = folder.isDirectory() && folder.uid === place.uid && (folder.mode & 0o022) === 0 && realpathSync(dir) === dir;
  return { status: own ? "gone" : "refused", place };
}

// macOS refuses realpath on a socket (EOPNOTSUPP)
export function heldHerdrSocketStatus(path: string, place: HerdrSocketPlace): "usable" | "gone" | "refused" {
  try {
    const socket = lstatSync(path);
    const folder = dirname(path);
    return socket.isSocket() && socket.uid === place.uid && realpathSync(folder) === folder && place.dirs.some((dir) => path.startsWith(dir + "/")) && place.walk(folder) === null ? "usable" : "refused";
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT" ? "gone" : "refused";
  }
}

export async function discoverPinnableHerdrSessions(host: HerdrDiscoveryHost = currentHost()): Promise<{ sessions: FoundHerdrSession[]; refused: string | null }> {
  const scope = await discoveryScope(host);
  const walk = placeWalk();
  const results = await Promise.all([...scope.paths].map(async (path): Promise<FoundHerdrSession | string | null> => {
    const unsafe = walk(dirname(path));
    if (unsafe !== null) return unsafe;
    if (await chosenHerdrSocketStatus(path, host, scope) !== "usable") return null;
    const session = /\/herdr\/sessions\/([a-zA-Z0-9_-]{1,64})\/herdr\.sock$/.exec(path)?.[1];
    return { socket_path: path, ...(session ? { session } : {}), label: session ?? "Default session" };
  }));
  return {
    sessions: results.filter((result): result is FoundHerdrSession => result !== null && typeof result !== "string"),
    refused: results.find((result): result is string => typeof result === "string") ?? null,
  };
}

export async function discoverHerdrSessions(host: HerdrDiscoveryHost = currentHost()): Promise<FoundHerdrSession[]> {
  const scope = await discoveryScope(host);
  const results = await Promise.all([...scope.paths].map(async (path): Promise<FoundHerdrSession | null> => {
    if (await chosenHerdrSocketStatus(path, host, scope) !== "usable") return null;
    const session = /\/herdr\/sessions\/([a-zA-Z0-9_-]{1,64})\/herdr\.sock$/.exec(path)?.[1];
    return { socket_path: path, ...(session ? { session } : {}), label: session ?? "Default session" };
  }));
  return results.filter((result): result is FoundHerdrSession => result !== null);
}

export function validHerdrSocket(value: unknown): value is string {
  return typeof value === "string" && value.length <= 4096 && value.startsWith("/") && value.endsWith("/herdr.sock") && !/[\0\r\n]/.test(value);
}

export function parseFoundHerdrSessions(value: unknown): FoundHerdrSession[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CANDIDATES) throw new Error("The PC returned an invalid list of herdr sessions");
  return value.map((row: unknown) => {
    if (typeof row !== "object" || row === null || !("socket_path" in row) || !validHerdrSocket(row.socket_path)
      || !("label" in row) || typeof row.label !== "string" || row.label.length > 256
      || "session" in row && (typeof row.session !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(row.session))) throw new Error("The PC returned an invalid herdr session");
    return { socket_path: row.socket_path, label: row.label, ...("session" in row && typeof row.session === "string" ? { session: row.session } : {}) };
  });
}
