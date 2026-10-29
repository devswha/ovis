/**
 * The Ovis relay's routing, shared by the Cloudflare Worker (worker.ts) and the Bun server
 * (bun.ts). A PC and a phone that cannot reach each other both dial out to the relay, which pairs
 * their sockets by the PC's `server_id` and passes frames between them unread: the frames are
 * end-to-end encrypted between the two (README.md). Nothing here parses, logs or keeps a frame
 * beyond the short wait for the PC's data socket, and nothing is stored.
 *
 * Three kinds of socket meet in one room per `server_id` (`GET /v1/ws?server_id=..&v=1`):
 * - control (`role=server`): one per PC. It hears `sync`, `connected` and `disconnected` (JSON
 *   text) about clients, and sends nothing but keepalive pings.
 * - client (`role=client`): a phone or browser. The relay picks its `connection_id` and says so
 *   in its first frame, `{"type":"assigned","connection_id":"..."}`.
 * - data (`role=server&connection_id=..`): the PC's socket for one client, opened once the PC
 *   hears `connected` (or `sync`) for it. Frames then pass between client and data as they came.
 *
 * The room keeps no state that must outlive the process (or a Durable Object's eviction): who is
 * who lives with each socket (`RoomHost.info`), and a PC that reconnects gets the clients still
 * waiting in `sync`.
 */

/** the wire version this relay speaks, `v=` in the socket URL */
export const WIRE_VERSION = "1";
/** clients one server_id may have at once */
export const MAX_CLIENTS = 8;
/** clients one server_id may have waiting for their data socket at once */
export const MAX_PENDING = 4;
/** the largest frame passed on, in bytes; Ovis frames stay under about 22 KiB */
export const MAX_MESSAGE_BYTES = 64 * 1024;
/** a client's frames held until its data socket attaches: at most this many... */
export const BUFFER_FRAMES = 200;
/** ...and at most this many bytes */
export const BUFFER_BYTES = 1024 * 1024;
/** a socket that sends nothing (keepalive pings included) for this long is closed */
export const IDLE_MS = 120_000;
/**
 * The keepalive: a socket that sends exactly this text gets KEEPALIVE_PONG back and nothing is
 * passed on. On Cloudflare the runtime answers it without waking the Durable Object.
 */
export const KEEPALIVE_PING = '{"type":"ping"}';
export const KEEPALIVE_PONG = '{"type":"pong"}';
/** how stale a socket's saved last-seen time may get before it is written again (worker.ts saves it with the socket) */
const SEEN_WRITE_MS = 30_000;

/** WebSocket close codes the relay sends */
export const CLOSE = {
  /** the client went away (to its data socket), or the socket was idle */
  GOING_AWAY: 1001,
  /** a newer control socket replaced this one, a second data socket for one client, or an unknown wire version */
  POLICY: 1008,
  /** a frame over MAX_MESSAGE_BYTES */
  TOO_BIG: 1009,
  /** the PC's data socket went away (to its client), or the relay lost frames it held */
  RESTART: 1012,
  /** a limit: too many clients, too many waiting, or too much held before the PC attached */
  TRY_AGAIN: 1013,
} as const;

export type Role = "control" | "data" | "client";
export type Frame = string | ArrayBuffer | Uint8Array;

/** what a socket is, kept with the socket itself so it survives a Durable Object's eviction */
export interface SocketInfo {
  role: Role;
  connection_id: string | null;
  /** when it last sent something (written at most every SEEN_WRITE_MS) */
  seen: number;
  /** a client whose frames the relay holds (or held) for its data socket */
  buffered: boolean;
}

export interface SocketRequest {
  server_id: string;
  role: Role;
  connection_id: string | null;
  /** `v=` as given, checked once the socket is open so the client hears 1008, not an HTTP error */
  version: string | null;
}

/** Cloudflare's Rate Limiting binding, or anything with its shape */
export interface RateLimiter { limit(options: { key: string }): Promise<{ success: boolean }> }
export interface Limiters {
  /** keyed by the connecting address */
  perAddress: RateLimiter;
  /** asked with one key for all addresses, only once an address's own limit lets it through */
  global: RateLimiter;
}

const HEX32 = /^[0-9a-f]{32}$/;

/** The socket a `/v1/ws` URL asks for, or why it is refused (HTTP 400). */
export function parseSocketRequest(url: URL): SocketRequest | { error: string } {
  const params = url.searchParams;
  const serverId = params.get("server_id") ?? "";
  if (!HEX32.test(serverId)) return { error: "server_id must be 32 lowercase hex digits" };
  const role = params.get("role");
  const connectionId = params.get("connection_id");
  const version = params.get("v");
  if (role === "client") {
    if (connectionId !== null) return { error: "the relay assigns a client's connection_id" };
    return { server_id: serverId, role: "client", connection_id: null, version };
  }
  if (role !== "server") return { error: "role must be server or client" };
  if (connectionId === null) return { server_id: serverId, role: "control", connection_id: null, version };
  if (!HEX32.test(connectionId)) return { error: "connection_id must be 32 lowercase hex digits" };
  return { server_id: serverId, role: "data", connection_id: connectionId, version };
}

const text = (status: number, body: string, headers?: Record<string, string>) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers } });

/**
 * The HTTP side of both adapters: `/health`, and the checks a socket request passes before it is
 * upgraded. Returns the response to send, or the socket to open. `address` keys the per-address
 * limiter only; it is never kept.
 */
export async function admit(request: Request, address: string, limiters?: Limiters): Promise<Response | SocketRequest> {
  const url = new URL(request.url);
  if (url.pathname === "/health") return request.method === "GET" || request.method === "HEAD" ? text(200, "ok") : text(405, "", { allow: "GET" });
  if (url.pathname !== "/v1/ws") return text(404, "not found");
  if (request.method !== "GET") return text(405, "", { allow: "GET" });
  const socket = parseSocketRequest(url);
  if ("error" in socket) return text(400, socket.error);
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return text(426, "expected a WebSocket upgrade", { upgrade: "websocket" });
  if (limiters) {
    if (!(await limiters.perAddress.limit({ key: address })).success) return text(429, "too many connections", { "retry-after": "60" });
    if (!(await limiters.global.limit({ key: "all" })).success) return text(429, "too many connections", { "retry-after": "60" });
  }
  return socket;
}

/** what a room needs from the platform's sockets */
export interface RoomHost<S extends object> {
  /** every socket of this room still open (or closing) */
  sockets(): Iterable<S>;
  info(socket: S): SocketInfo | null;
  setInfo(socket: S, info: SocketInfo): void;
  send(socket: S, frame: Frame): void;
  close(socket: S, code: number, reason: string): void;
  /** when the platform last answered this socket's keepalive by itself, if it does */
  keepaliveAt?(socket: S): number | null;
  now(): number;
}

interface Held { frames: Frame[]; bytes: number }

const randomHex = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");

/** UTF-8 length of a text frame, without encoding it */
function utf8Length(value: string): number {
  let length = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) length += 1;
    else if (code < 0x800) length += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) { length += 4; i++; }
    else length += 3;
  }
  return length;
}

const byteLength = (frame: Frame) => typeof frame === "string" ? utf8Length(frame) : frame.byteLength;
/** a frame the platform may reuse once the handler returns, copied to be held */
const own = (frame: Frame): Frame => typeof frame === "string" ? frame : frame instanceof Uint8Array ? frame.slice() : frame.slice(0);

/** One server_id's sockets: pairs them, passes frames, enforces the limits. */
export class Room<S extends object> {
  /** frames of clients whose data socket has not attached yet, by connection_id */
  private readonly held = new Map<string, Held>();
  /** sockets the room has finished with (closed by either side) */
  private readonly ended = new WeakSet<S>();
  /** when each socket last sent something, exact (SocketInfo.seen lags by up to SEEN_WRITE_MS) */
  private readonly lastSeen = new WeakMap<S, number>();

  constructor(private readonly host: RoomHost<S>) {}

  private peers(): { socket: S; info: SocketInfo }[] {
    const out: { socket: S; info: SocketInfo }[] = [];
    for (const socket of this.host.sockets()) {
      if (this.ended.has(socket)) continue;
      const info = this.host.info(socket);
      if (info) out.push({ socket, info });
    }
    return out;
  }

  private find(role: Role, connectionId: string): { socket: S; info: SocketInfo } | undefined {
    return this.peers().find((peer) => peer.info.role === role && peer.info.connection_id === connectionId);
  }

  private tellControls(message: object): void {
    const body = JSON.stringify(message);
    for (const peer of this.peers()) if (peer.info.role === "control") this.host.send(peer.socket, body);
  }

  private end(socket: S, code: number, reason: string): void {
    if (this.ended.has(socket)) return;
    this.host.close(socket, code, reason);
    this.closed(socket);
  }

  /** A socket was upgraded: place it, or close it when the room refuses it. */
  open(socket: S, request: Pick<SocketRequest, "role" | "connection_id" | "version">): void {
    if (request.version !== WIRE_VERSION) return this.end(socket, CLOSE.POLICY, "unsupported wire version");
    const now = this.host.now();
    const peers = this.peers();
    if (request.role === "control") {
      // the newest control socket wins: an older one may be half-open after the PC's network moved
      for (const peer of peers) if (peer.info.role === "control") this.end(peer.socket, CLOSE.POLICY, "replaced by a newer control socket");
      this.host.setInfo(socket, { role: "control", connection_id: null, seen: now, buffered: false });
      this.lastSeen.set(socket, now);
      const waiting = peers.filter((peer) => peer.info.role === "client" && !peers.some((other) => other.info.role === "data" && other.info.connection_id === peer.info.connection_id));
      this.host.send(socket, JSON.stringify({ type: "sync", connection_ids: waiting.map((peer) => peer.info.connection_id) }));
      return;
    }
    if (request.role === "client") {
      const clients = peers.filter((peer) => peer.info.role === "client");
      if (clients.length >= MAX_CLIENTS) return this.end(socket, CLOSE.TRY_AGAIN, "too many clients for this server");
      const attached = new Set(peers.filter((peer) => peer.info.role === "data").map((peer) => peer.info.connection_id));
      if (clients.filter((peer) => !attached.has(peer.info.connection_id)).length >= MAX_PENDING) return this.end(socket, CLOSE.TRY_AGAIN, "too many clients waiting for this server");
      const connectionId = randomHex();
      this.host.setInfo(socket, { role: "client", connection_id: connectionId, seen: now, buffered: false });
      this.lastSeen.set(socket, now);
      this.host.send(socket, JSON.stringify({ type: "assigned", connection_id: connectionId }));
      this.tellControls({ type: "connected", connection_id: connectionId });
      return;
    }
    const connectionId = request.connection_id!;
    const client = peers.find((peer) => peer.info.role === "client" && peer.info.connection_id === connectionId);
    if (!client) return this.end(socket, CLOSE.GOING_AWAY, "client gone");
    if (peers.some((peer) => peer.info.role === "data" && peer.info.connection_id === connectionId)) return this.end(socket, CLOSE.POLICY, "this client already has a data socket");
    this.host.setInfo(socket, { role: "data", connection_id: connectionId, seen: now, buffered: false });
    this.lastSeen.set(socket, now);
    const held = this.held.get(connectionId);
    this.held.delete(connectionId);
    if (client.info.buffered && !held) {
      // the client's first frames were held by an instance that is gone (an evicted Durable
      // Object): the pair cannot start where the client thinks it did
      return this.end(client.socket, CLOSE.RESTART, "relay restarted");
    }
    for (const frame of held?.frames ?? []) this.host.send(socket, frame);
    if (client.info.buffered) this.host.setInfo(client.socket, { ...client.info, buffered: false });
  }

  /** A frame arrived on a socket: pass it on unread. */
  message(socket: S, frame: Frame): void {
    if (this.ended.has(socket)) return;
    const info = this.host.info(socket);
    if (!info) return;
    const size = byteLength(frame);
    if (size > MAX_MESSAGE_BYTES) return this.end(socket, CLOSE.TOO_BIG, "message too big");
    const now = this.host.now();
    this.lastSeen.set(socket, now);
    if (now - info.seen >= SEEN_WRITE_MS) this.host.setInfo(socket, { ...info, seen: now });
    if (frame === KEEPALIVE_PING) return this.host.send(socket, KEEPALIVE_PONG);
    if (info.role === "control") return;
    const connectionId = info.connection_id!;
    if (info.role === "data") {
      const client = this.find("client", connectionId);
      if (client) this.host.send(client.socket, frame);
      return;
    }
    const data = this.find("data", connectionId);
    if (data) return this.host.send(data.socket, frame);
    const held = this.held.get(connectionId) ?? { frames: [], bytes: 0 };
    if (held.frames.length >= BUFFER_FRAMES || held.bytes + size > BUFFER_BYTES) return this.end(socket, CLOSE.TRY_AGAIN, "too much sent before the server attached");
    held.frames.push(own(frame));
    held.bytes += size;
    this.held.set(connectionId, held);
    if (!info.buffered) this.host.setInfo(socket, { ...(this.host.info(socket) ?? info), buffered: true });
  }

  /** A socket closed (or failed): close its partner. Safe to call more than once. */
  closed(socket: S): void {
    if (this.ended.has(socket)) return;
    this.ended.add(socket);
    const info = this.host.info(socket);
    if (!info || info.role === "control") return;
    const connectionId = info.connection_id!;
    if (info.role === "client") {
      this.held.delete(connectionId);
      const data = this.find("data", connectionId);
      if (data) this.end(data.socket, CLOSE.GOING_AWAY, "client gone");
      this.tellControls({ type: "disconnected", connection_id: connectionId });
      return;
    }
    const client = this.find("client", connectionId);
    if (client) this.end(client.socket, CLOSE.RESTART, "server gone");
  }

  /** Closes sockets idle for IDLE_MS; returns when the next one would be due, or null when none is left. */
  sweep(): number | null {
    const now = this.host.now();
    let next: number | null = null;
    for (const peer of this.peers()) {
      if (this.ended.has(peer.socket)) continue;
      // without this instance's exact time (a Durable Object evicted since), the saved one may lag
      // the last frame by up to SEEN_WRITE_MS: count from its latest possible time, so a socket is
      // never closed sooner than IDLE_MS after its last frame (and at most SEEN_WRITE_MS later)
      const sent = this.lastSeen.get(peer.socket) ?? peer.info.seen + SEEN_WRITE_MS;
      const last = Math.max(sent, this.host.keepaliveAt?.(peer.socket) ?? 0);
      if (now - last >= IDLE_MS) this.end(peer.socket, CLOSE.GOING_AWAY, "idle");
      else next = Math.min(next ?? Infinity, last + IDLE_MS);
    }
    return next;
  }

  /** whether any socket of this room is still in use */
  get empty(): boolean {
    return this.peers().length === 0;
  }
}
