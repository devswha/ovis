/**
 * A copy made in tmux, brought to the browsers that show it (#1517). herdr's attach stream drops
 * a pane's OSC 52 (herdrdev/herdr#4612), so tmux's clipboard writes never reach a browser.
 *
 * Only while the shared `tmuxCopy` setting is on (off by default): for each pane some browser shows
 * whose foreground process is a tmux client, this server sets one indexed `pane-set-clipboard` hook
 * on that client's tmux server at runtime, and unsets it once no shown pane runs that tmux, the
 * setting goes off or the server stops. No file of the user's (`~/.tmux.conf` or any other) is ever
 * written, and the user's own hooks on that event stay, as the hook takes an index of its own.
 *
 * The hook POSTs only the tmux socket and the copying pane (never the text) to a route that takes
 * nothing but a loopback peer (127.0.0.1 or ::1, no proxy) carrying this server's secret, read by curl
 * from a 0600 file in the state folder, so neither another user on the PC nor a page in a browser can
 * post a copy. The server then reads tmux's newest buffer itself and tells it to the browsers showing
 * a pane whose tmux client shows the copying pane's window: the clients tmux itself would set.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { cameThroughProxy } from "./access.ts";
import { jsonResponse } from "./http.ts";

export const TMUX_COPIED_PATH = "/api/tmux/copied";
export const TMUX_HOOK_HEADER = "x-ovis-tmux-hook";
const TMUX_TIMEOUT_MS = 2000;
/** a bigger copy is dropped, as the client drops an OSC 52 write above MAX_OSC52_BYTES (src/lib/osc52.ts) */
export const MAX_TMUX_COPY_BYTES = 100 * 1024;
/** how often the shown panes are looked at again for a tmux started, ended or left since */
const SWEEP_MS = 3000;
const LOOPBACK_PEERS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
/** a path the hook names inside tmux's and the shell's quoting; anything else is not hooked */
const PLAIN_PATH = /^\/[\w./-]+$/;

export interface TmuxForeground { pid?: number | null; argv?: string[] | null }

export interface TmuxCopyOptions {
  stateDir: string;
  /** the port this server listens on, the one the hook posts to on 127.0.0.1 */
  port(): number | undefined;
  enabled(): boolean;
  /** calls back when the setting may have changed; answers the unsubscribe */
  subscribe(listener: () => void): () => void;
  shownPanes(): Iterable<string>;
  /** the pane's foreground processes, as herdr's `pane.process_info` names them */
  foreground(paneId: string): Promise<TmuxForeground[]>;
  /** the clients each pane has now; the answer tells a copy to those of them still showing the pane */
  capture(): (paneId: string, text: string) => void;
  /** the tmux and curl programs; found on PATH unless a test names others */
  tmux?: string | null;
  curl?: string | null;
  sweepMs?: number;
}

async function run(program: string, args: string[], limit = 64 * 1024): Promise<string | null> {
  const child = Bun.spawn([program, ...args], { env: process.env, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: TMUX_TIMEOUT_MS });
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of child.stdout) {
    size += chunk.byteLength;
    if (size > limit) {
      child.kill();
      return null;
    }
    chunks.push(chunk);
  }
  if (await child.exited !== 0) return null;
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * The socket a tmux client's argv connects to: `-S path`, else `-L name` (or `default`) in
 * `$TMUX_TMPDIR/tmux-<uid>/`, as tmux itself picks it. Null when the argv is not a tmux client.
 */
export function tmuxSocketOf(argv: readonly string[], tmpdir: string, uid: number): string | null {
  if (argv.length === 0 || basename(argv[0]!) !== "tmux") return null;
  let path: string | null = null;
  let name = "default";
  for (let i = 1; i < argv.length; i++) {
    const word = argv[i]!;
    if (word === "--" || !word.startsWith("-") || word === "-") break;
    for (let at = 1; at < word.length; at++) {
      const flag = word[at]!;
      if (!"cfLST".includes(flag)) continue;
      const value = at + 1 < word.length ? word.slice(at + 1) : argv[++i];
      if (value === undefined) return null;
      if (flag === "S") path = value;
      if (flag === "L") name = value;
      break;
    }
  }
  return path ?? join(tmpdir, `tmux-${uid}`, name);
}

/** A socket this server's own user made: another user's tmux could hand it any text. */
function ownSocket(path: string): boolean {
  const uid = process.getuid?.();
  if (uid === undefined) return false;
  try {
    const stat = lstatSync(path);
    return stat.isSocket() && stat.uid === uid;
  } catch {
    return false;
  }
}

/** TMUX_TMPDIR as the client process has it (Linux), else as this server has it. */
function clientTmpdir(pid: number): string {
  try {
    const environ = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
    const found = environ.find((entry) => entry.startsWith("TMUX_TMPDIR="))?.slice(12);
    if (found) return found;
  } catch {}
  return process.env["TMUX_TMPDIR"] || "/tmp";
}

/** the sockets this state folder's servers hooked, by hook index, so a run after a crash unsets them */
const HOOKED_FILE = "tmux-hooks.json";

/** N of tmux's automatic buffer name `bufferN`, or null for a buffer named by hand */
function automaticNumber(name: string): number | null {
  const match = /^buffer(\d+)$/.exec(name);
  return match ? Number(match[1]) : null;
}

function highest(buffers: Set<string>): number {
  let most = -1;
  for (const key of buffers) most = Math.max(most, automaticNumber(key.split("\t")[0]!) ?? -1);
  return most;
}

export class TmuxCopyHooks {
  private readonly secret = randomBytes(32).toString("hex");
  private headerFile: string | null = null;
  private readonly tmux: string | null;
  private readonly curl: string | null;
  /** the shown panes that run a tmux client: its pid and its server's socket (real path) */
  private readonly panes = new Map<string, { pid: number; socket: string }>();
  /** the sockets whose tmux has this server's hook now */
  private readonly hooked = new Set<string>();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly unsubscribe: () => void;
  private sweeping: Promise<void> | null = null;
  /** copies being read per socket: a copy while one is read is read once after it (the newest buffer then) */
  private readonly reading = new Map<string, { again: (() => void) | null }>();
  private warned = false;
  /** the buffers each hooked tmux held at the last look (`name\tcreated`): a hook's copy is the one buffer new since */
  private readonly seen = new Map<string, Set<string>>();
  /** the highest automatic buffer number (`bufferN`) each hooked tmux has shown: tmux numbers its copies on from it */
  private readonly lastNumber = new Map<string, number>();
  private readonly leftovers: Promise<void>;
  private again = false;
  private stopped = false;

  constructor(private readonly options: TmuxCopyOptions) {
    this.tmux = options.tmux === undefined ? Bun.which("tmux") : options.tmux;
    this.curl = options.curl === undefined ? Bun.which("curl") : options.curl;
    this.timer = setInterval(() => void this.sweep(), options.sweepMs ?? SWEEP_MS);
    this.timer.unref();
    this.unsubscribe = options.subscribe(() => void this.sweep());
    this.leftovers = this.clearLeftovers().catch(() => {});
  }

  /** the URL the hook posts to: in the hook text, it tells this server's hook from any other */
  private url(index: number): string {
    return `http://127.0.0.1:${index}${TMUX_COPIED_PATH}`;
  }

  private hookedPath(): string {
    return join(this.options.stateDir, HOOKED_FILE);
  }

  private readHooked(): Record<string, string[]> {
    try {
      const held = JSON.parse(readFileSync(this.hookedPath(), "utf8")) as unknown;
      return typeof held === "object" && held !== null && !Array.isArray(held) ? held as Record<string, string[]> : {};
    } catch {
      return {};
    }
  }

  private writeHooked(): void {
    const index = this.index();
    if (index === null) return;
    const all = this.readHooked();
    if (this.hooked.size === 0) delete all[String(index)];
    else all[String(index)] = [...this.hooked];
    try { writeFileSync(this.hookedPath(), `${JSON.stringify(all)}\n`, { mode: 0o600 }); } catch {}
  }

  /** A server of this port that ended without unsetting its hooks (a crash, a kill) left them listed: they go now. */
  private async clearLeftovers(): Promise<void> {
    const index = this.index();
    if (index === null || this.tmux === null) return;
    const left = this.readHooked()[String(index)];
    if (!Array.isArray(left)) return;
    await Promise.all(left.filter((socket) => typeof socket === "string" && !this.hooked.has(socket) && ownSocket(socket)).map((socket) => this.unsetOurs(socket, index)));
    if (this.hooked.size === 0) this.writeHooked();
  }

  /** The hook at our index, when it is this server's own; another hook there (the user's) is never replaced or unset. */
  private async hookAt(socket: string, index: number): Promise<"ours" | "free" | "other"> {
    const shown = await run(this.tmux!, ["-S", socket, "show-hooks", "-g", `pane-set-clipboard[${index}]`]);
    // tmux answers an unset index with its name alone
    const value = shown?.trim().replace(/^pane-set-clipboard\[\d+\]/, "").trim() ?? "";
    if (value === "") return "free";
    return value.includes(this.url(index)) ? "ours" : "other";
  }

  private async unsetOurs(socket: string, index: number): Promise<void> {
    if (await this.hookAt(socket, index) === "ours") await run(this.tmux!, ["-S", socket, "set-hook", "-gu", `pane-set-clipboard[${index}]`]);
  }

  /** this server's own secret file, made new and only this user's: a name taken by anything else (a link) is replaced, never followed */
  private secretFile(index: number): string {
    if (this.headerFile !== null) return this.headerFile;
    const path = join(this.options.stateDir, `tmux-hook-${index}.header`);
    try { unlinkSync(path); } catch {}
    const fd = openSync(path, "wx", 0o600);
    try { writeSync(fd, `${TMUX_HOOK_HEADER}: ${this.secret}\n`); } finally { closeSync(fd); }
    return this.headerFile = path;
  }

  /** the hook's array index: one per server port, so two servers on this PC never unset each other's */
  private index(): number | null {
    const port = this.options.port();
    return port === undefined || port <= 0 ? null : port;
  }

  /** Looks at the shown panes again and sets or unsets the hooks to match. Settles once it is done. */
  sweep(): Promise<void> {
    if (this.sweeping) {
      this.again = true;
      return this.sweeping;
    }
    this.sweeping = (async () => {
      do {
        this.again = false;
        await this.reconcile().catch((error: unknown) => console.error(`tmux copy: ${error instanceof Error ? error.message : String(error)}`));
      } while (this.again && !this.stopped);
    })().finally(() => { this.sweeping = null; });
    return this.sweeping;
  }

  private async reconcile(): Promise<void> {
    await this.leftovers;
    const on = !this.stopped && this.options.enabled() && this.tmux !== null && process.platform !== "win32";
    const shown = on ? new Set(this.options.shownPanes()) : new Set<string>();
    for (const paneId of this.panes.keys()) if (!shown.has(paneId)) this.panes.delete(paneId);
    await Promise.all([...shown].map(async (paneId) => {
      const client = (await this.options.foreground(paneId).catch(() => [])).find((process) =>
        typeof process.pid === "number" && Array.isArray(process.argv) && basename(process.argv[0] ?? "") === "tmux");
      if (!client) {
        this.panes.delete(paneId);
        return;
      }
      const pid = client.pid!;
      if (this.panes.get(paneId)?.pid === pid) return;
      const socket = await this.clientSocket(pid, client.argv!);
      if (socket === null) this.panes.delete(paneId);
      else this.panes.set(paneId, { pid, socket });
    }));
    const wanted = new Set([...this.panes.values()].map((pane) => pane.socket));
    await Promise.all([
      ...[...wanted].filter((socket) => !this.hooked.has(socket)).map((socket) => this.install(socket)),
      ...[...this.hooked].filter((socket) => !wanted.has(socket)).map((socket) => this.uninstall(socket)),
    ]);
  }

  /** The real path of the tmux socket the client `pid` is attached to, checked with that tmux; null when it is not attached there. */
  private async clientSocket(pid: number, argv: string[]): Promise<string | null> {
    const uid = process.getuid?.();
    if (uid === undefined) return null;
    const named = tmuxSocketOf(argv, clientTmpdir(pid), uid);
    if (named === null || !isAbsolute(named)) return null;
    let socket: string;
    try { socket = realpathSync(named); } catch { return null; }
    if (!ownSocket(socket)) return null;
    const clients = await run(this.tmux!, ["-S", socket, "list-clients", "-F", "#{client_pid}"]);
    return clients?.split("\n").includes(String(pid)) ? socket : null;
  }

  private async install(socket: string): Promise<void> {
    const index = this.index();
    if (index === null) return;
    const header = this.curl !== null && PLAIN_PATH.test(this.curl) && PLAIN_PATH.test(join(this.options.stateDir, "x")) ? this.secretFile(index) : null;
    if (header === null) {
      if (!this.warned) console.error("tmux copy: no hook is set: curl is missing, or its path or the state folder's has characters the hook cannot quote");
      this.warned = true;
      return;
    }
    if (await this.hookAt(socket, index) === "other") {
      console.error(`tmux copy: pane-set-clipboard[${index}] on ${socket} is another hook; it is left as it is`);
      return;
    }
    const buffers = await this.buffers(socket);
    if (buffers === null) return;
    this.seen.set(socket, buffers);
    this.lastNumber.set(socket, highest(buffers));
    const post = `${this.curl} -fsS -m 2 -o /dev/null -H @${header} --data-urlencode socket=#{q:socket_path} --data-urlencode pane=#{pane_id} ${this.url(index)} || true`;
    if (await run(this.tmux!, ["-S", socket, "set-hook", "-g", `pane-set-clipboard[${index}]`, `run-shell -b "${post}"`]) !== null) {
      this.hooked.add(socket);
      this.writeHooked();
    }
  }

  private async buffers(socket: string): Promise<Set<string> | null> {
    const listed = await run(this.tmux!, ["-S", socket, "list-buffers", "-F", "#{buffer_name}\t#{buffer_created}"]);
    return listed === null ? null : new Set(listed.split("\n").filter((line) => line !== ""));
  }

  private async uninstall(socket: string): Promise<void> {
    this.hooked.delete(socket);
    this.seen.delete(socket);
    this.lastNumber.delete(socket);
    const index = this.index();
    if (index !== null) await this.unsetOurs(socket, index);
    this.writeHooked();
  }

  /** Unsets every hook this server set; settles once tmux has answered. */
  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.unsubscribe();
    await this.sweeping;
    this.panes.clear();
    await Promise.all([...this.hooked].map((socket) => this.uninstall(socket)));
    if (this.headerFile !== null) try { unlinkSync(this.headerFile); } catch {}
    this.headerFile = null;
  }

  /** Whether the request is this server's hook: a POST from 127.0.0.1 or ::1, straight to it, with its secret and no Origin. */
  fromHook(request: Request, peer: string | null): boolean {
    if (request.method !== "POST" || peer === null || !LOOPBACK_PEERS.has(peer) || cameThroughProxy(request.headers) || request.headers.has("origin")) return false;
    const presented = Buffer.from(request.headers.get(TMUX_HOOK_HEADER) ?? "");
    const secret = Buffer.from(this.secret);
    return presented.byteLength === secret.byteLength && timingSafeEqual(presented, secret);
  }

  async handle(request: Request, peer: string | null): Promise<Response> {
    if (!this.fromHook(request, peer) || !this.options.enabled()) return jsonResponse({ error: { code: "not_found", message: "not found" } }, 404);
    // who shows a pane now: a browser that joins while the copy is read is not sent a copy from before it
    const tell = this.options.capture();
    const form = await request.formData().catch(() => null);
    const named = form?.get("socket");
    const pane = form?.get("pane");
    if (typeof named !== "string" || !isAbsolute(named) || typeof pane !== "string" || !/^%\d+$/.test(pane)) {
      return jsonResponse({ error: { code: "invalid_request", message: "socket must be an absolute path and pane a tmux pane id" } }, 400);
    }
    let socket: string;
    try { socket = realpathSync(named); } catch { socket = named; }
    if (!this.hooked.has(socket) || !ownSocket(socket)) return jsonResponse({ error: { code: "forbidden", message: "this server set no hook on that tmux" } }, 403);
    // one read per socket at a time, in order; copies that came during it are read once after it
    const busy = this.reading.get(socket);
    if (busy) {
      busy.again = () => this.read(socket, pane, tell);
      return new Response(null, { status: 204 });
    }
    const state: { again: (() => void) | null } = { again: null };
    this.reading.set(socket, state);
    try {
      await this.read(socket, pane, tell);
      while (state.again) {
        const next = state.again;
        state.again = null;
        await next();
      }
    } finally {
      this.reading.delete(socket);
    }
    return new Response(null, { status: 204 });
  }

  private async read(socket: string, pane: string, tell: (paneId: string, text: string) => void): Promise<void> {
    // The copy this hook is for is the one buffer made since the last look. Two or more (copies close
    // together, perhaps in other windows) cannot be told apart, so none of them is sent: a copy reaches
    // only the window it was made in, or nowhere. A buffer changed in place (append-selection) is not new.
    const now = await this.buffers(socket);
    if (now === null) return;
    const fresh = [...now].filter((key) => !(this.seen.get(socket)?.has(key) ?? false));
    this.seen.set(socket, now);
    const last = this.lastNumber.get(socket) ?? -1;
    this.lastNumber.set(socket, Math.max(last, highest(now)));
    // and it is the very next copy tmux numbered: a skipped number is a copy tmux already dropped
    // (a small buffer-limit), which may have been this hook's, so nothing goes
    if (fresh.length !== 1) return;
    const name = fresh[0]!.split("\t")[0]!;
    if (automaticNumber(name) !== last + 1) return;
    const [text, window, clients] = await Promise.all([
      run(this.tmux!, ["-S", socket, "show-buffer", "-b", name], MAX_TMUX_COPY_BYTES),
      run(this.tmux!, ["-S", socket, "display-message", "-p", "-t", pane, "#{window_id}"]),
      run(this.tmux!, ["-S", socket, "list-clients", "-F", "#{client_pid}\t#{window_id}"]),
    ]);
    // nothing to copy, a copy too big for a browser's clipboard (as OSC 52 drops it), or a pane gone
    if (!text || window === null || clients === null) return;
    const shown = window.trim();
    const pids = new Set(clients.split("\n").flatMap((line) => {
      const [pid, at] = line.split("\t");
      return at === shown && pid && /^\d+$/.test(pid) ? [Number(pid)] : [];
    }));
    const showing = new Set(this.options.shownPanes());
    for (const [paneId, client] of this.panes) {
      if (client.socket === socket && pids.has(client.pid) && showing.has(paneId)) tell(paneId, text);
    }
  }
}
