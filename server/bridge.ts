import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { BRIDGE_PROTOCOL, REMOTE_BUNDLE_VERSION, type BridgeIdentity } from "../shared/machines.ts";
import { HerdrError, herdrSocketPath, ping } from "./herdr/client.ts";
import { OwnerGuardUnavailable, withOwnerGuard } from "./owner-guard.ts";
import { newOwnerRecord, ownerGone, probeProcess, type ProcessBirth } from "./process-owner.ts";
import type { Socket } from "bun";
import { attachableIdentity, sidecarAvailable } from "./pty/sidecar.ts";

/**
 * `generation` and `birth` identify the registering process beyond its PID; older bridges wrote neither.
 * `port` is on 127.0.0.1, the only address the app's SSH tunnel goes to (`loopbackRelay`).
 */
export interface BridgeDescriptor { managed_remote?: boolean; port: number; token: string; pid: number; generation?: string; birth?: ProcessBirth; socket_path: string; bridge_protocol: number; bundle_version: string }
export function bridgeRegistry(): string { return join(homedir(), ".config/herdr-web-ui/bridges"); }
export function socketPath(): string {
  const path = resolve(herdrSocketPath());
  try { return realpathSync(path); } catch { return path; }
}
export function descriptorPath(socket = socketPath()): string { return join(bridgeRegistry(), createHash("sha256").update(socket).digest("hex") + ".json"); }
/** `sidecar`: whether this bridge can run the PTY sidecar; the PC list reads its terminal lens from the herdr told here. */
export async function bridgeIdentity(sidecar = sidecarAvailable()): Promise<BridgeIdentity> {
  const socket = socketPath();
  let stat;
  try { stat = statSync(socket); } catch (error) {
    // A herdr that is not running leaves no socket (on Windows, no marker). Said by code and
    // without the path: the server that asked shows this to whoever is adding the PC.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new HerdrError("socket_missing", "herdr's socket is missing; herdr is not running for this session");
    throw error;
  }
  const info = attachableIdentity(await ping(), sidecar);
  return { pid: process.pid, managed_remote: process.env["OVIS_REMOTE"] === "1", bridge_protocol: BRIDGE_PROTOCOL, bundle_version: REMOTE_BUNDLE_VERSION, socket_path: socket, socket_id: `${stat.dev}:${stat.ino}`, herdr: info };
}
/**
 * Whether the bridge a descriptor names still runs: a PID now held by a process of another birth
 * does not count. Outside Windows neither does a PID this user may not signal (EPERM), whatever
 * birth was recorded: every bridge in this user's registry runs as this user, so that is someone
 * else's process. The app's own check (`kill -0`, remote-host.ts) takes it for gone too and starts
 * a bridge, which must not then find the old one live. On Windows a logon session of this same user
 * may refuse the probe, so there only the birth decides.
 */
export function descriptorLive(descriptor: Pick<BridgeDescriptor, "pid" | "birth">): boolean {
  if (!Number.isSafeInteger(descriptor.pid) || descriptor.pid <= 0) return false;
  if (process.platform !== "win32" && probeProcess(descriptor.pid) === "denied") return false;
  return !ownerGone(descriptor);
}

/** One reading of the descriptor file; equal readings mean nobody replaced it in between. */
function readDescriptor(path: string): { id: string; text: string } | null {
  try {
    const stat = statSync(path);
    return { id: `${stat.dev}:${stat.ino}:${stat.mtimeMs}`, text: readFileSync(path, "utf8") };
  } catch { return null; }
}
function liveIn(reading: { text: string } | null): boolean {
  if (!reading) return false;
  try { return descriptorLive(JSON.parse(reading.text) as BridgeDescriptor); } catch { return false; /* unreadable descriptor: replace it */ }
}

/**
 * `registered` says whether this server's descriptor was written: it is not while another live
 * bridge holds the descriptor, when the descriptor changed while this one started, or when its
 * guard cannot be taken. `options.path` places the descriptor elsewhere and `options.sampled` runs
 * between reading the old descriptor and taking the guard; both are test seams.
 */
export function registerBridge(port: number, token = randomBytes(32).toString("hex"), options: { path?: string; sampled?(): void } = {}): { token: string; registered: boolean; close(): void } {
  const path = options.path ?? descriptorPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const unregistered = { token, registered: false, close() {} };
  // Registration never overwrites a live bridge. Its credential remains reusable.
  const seen = readDescriptor(path);
  if (liveIn(seen)) return unregistered;
  options.sampled?.();
  const record = newOwnerRecord();
  try {
    const registered = withOwnerGuard(path, () => {
      const now = readDescriptor(path);
      // another bridge registered while this one started: it is the registered one
      if (now?.id !== seen?.id || now?.text !== seen?.text || liveIn(now)) return false;
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ managed_remote: process.env["OVIS_REMOTE"] === "1", port, token, pid: process.pid, generation: record.generation, ...(record.birth ? { birth: record.birth } : {}), socket_path: socketPath(), bridge_protocol: BRIDGE_PROTOCOL, bundle_version: REMOTE_BUNDLE_VERSION } satisfies BridgeDescriptor), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, path);
      return true;
    });
    if (!registered) return unregistered;
  } catch (error) {
    // a guard that could not be released (OwnerGuardReleaseFailed) fails the start: this process
    // must not keep serving on a guard it may still hold
    if (!(error instanceof OwnerGuardUnavailable)) throw error;
    // fails closed: this server runs unregistered and the descriptor is left as it was
    console.error(`This bridge was not registered (descriptor ${path}): ${error.message}`);
    return unregistered;
  }
  return {
    token,
    registered: true,
    close() {
      try {
        withOwnerGuard(path, () => {
          let current: Partial<BridgeDescriptor> | null;
          try { current = JSON.parse(readFileSync(path, "utf8")) as Partial<BridgeDescriptor> | null; }
          catch { return; /* already gone or unreadable: nothing of ours to remove */ }
          if (current?.pid === process.pid && current.generation === record.generation) unlinkSync(path);
        });
      } catch (error) {
        console.error(`The bridge descriptor ${path} may have been left in place: ${error instanceof Error ? error.message : error}`);
      }
    },
  };
}

/** a 127/8 address or a wildcard: a server bound there already answers on 127.0.0.1 */
export function answersOnLoopback(hostname: string): boolean {
  const name = hostname.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return name === "0.0.0.0" || name === "::" || /^127(?:\.\d{1,3}){3}$/.test(name);
}

/**
 * `queue`: what this socket has not taken yet; `early`: what the client sent before the server's side
 * opened; `ending`: the other side closed, so this one ends once its queue is sent
 */
interface Relayed { peer?: Socket<Relayed>; queue: Uint8Array[]; early: Uint8Array[]; closed?: boolean; ending?: boolean }
/** writes `chunk` after what the socket has not taken yet; `drain` sends the rest */
function send(socket: Socket<Relayed>, chunk: Uint8Array): void {
  if (socket.data.queue.length) { socket.data.queue.push(chunk); return; }
  const written = socket.write(chunk);
  if (written < chunk.byteLength) socket.data.queue.push(chunk.subarray(Math.max(written, 0)));
}
function drain(socket: Socket<Relayed>): void {
  while (socket.data.queue.length) {
    const chunk = socket.data.queue[0]!;
    const written = socket.write(chunk);
    if (written < chunk.byteLength) { socket.data.queue[0] = chunk.subarray(Math.max(written, 0)); return; }
    socket.data.queue.shift();
  }
  if (socket.data.ending) socket.end();
}
/** ends `socket` after what it still has to send */
function endAfterQueue(socket: Socket<Relayed> | undefined): void {
  if (!socket) return;
  socket.data.ending = true;
  if (!socket.data.queue.length) socket.end();
}

/**
 * A port on 127.0.0.1 that passes each connection on to `hostname:port` (#1960). An Ovis whose HOST
 * is another address does not answer on the PC's loopback, where the app's SSH tunnel always goes:
 * it registers this port as its bridge instead. The tunnel then never reaches past the PC's loopback,
 * whatever a descriptor says, and a request through it still arrives from that address, not loopback.
 */
export function loopbackRelay(hostname: string, port: number): { port: number; stop(): void } {
  const target = hostname.replace(/^\[(.*)\]$/, "$1");
  const listener = Bun.listen<Relayed>({ hostname: "127.0.0.1", port: 0, socket: {
    open(client) {
      client.data = { queue: [], early: [] };
      void Bun.connect<Relayed>({ hostname: target, port, data: { queue: [], early: [] }, socket: {
        open(peer) {
          if (client.data.closed) { peer.end(); return; }
          peer.data.peer = client;
          client.data.peer = peer;
          for (const chunk of client.data.early.splice(0)) send(peer, chunk);
        },
        data(peer, chunk) { send(client, chunk); },
        drain,
        close() { endAfterQueue(client); },
        error() { endAfterQueue(client); },
      } }).catch(() => client.end());
    },
    data(client, chunk) { if (client.data.peer) send(client.data.peer, chunk); else client.data.early.push(chunk); },
    drain,
    close(client) { client.data.closed = true; endAfterQueue(client.data.peer); },
    error(client) { client.data.closed = true; endAfterQueue(client.data.peer); },
  } });
  return { port: listener.port, stop: () => listener.stop(true) };
}
