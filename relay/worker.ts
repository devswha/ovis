/**
 * The Ovis relay on Cloudflare, at relay.ovis.sh (README.md). The Worker answers `/health` and
 * checks each socket request (core.ts `admit`, rate limits included) before handing it to the
 * Durable Object of its `server_id`, so a refused request never wakes one. The Durable Object
 * holds the room's sockets through the WebSocket Hibernation API: who each socket is lives in its
 * attachment, so the object may be evicted between frames and the room picks up where it was.
 * The PC's keepalive is answered by the runtime itself (`setWebSocketAutoResponse`), so an idle
 * PC never wakes it; an alarm closes sockets idle for IDLE_MS.
 */
import { IDLE_MS, KEEPALIVE_PING, KEEPALIVE_PONG, Room, admit, parseSocketRequest, type Frame, type RateLimiter, type RoomHost, type SocketInfo } from "./core.ts";

/** the part of a Cloudflare server-side WebSocket the relay uses */
export interface HibernatableSocket {
  send(frame: Frame): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

/** the part of DurableObjectState the relay uses */
export interface RelayState {
  acceptWebSocket(socket: HibernatableSocket, tags?: string[]): void;
  getWebSockets(tag?: string): HibernatableSocket[];
  setWebSocketAutoResponse(pair?: unknown): void;
  getWebSocketAutoResponseTimestamp(socket: HibernatableSocket): Date | null;
  storage: { getAlarm(): Promise<number | null>; setAlarm(time: number): Promise<void> };
}

interface DurableObjectStub { fetch(request: Request): Promise<Response> }
export interface Env {
  RELAY: { idFromName(name: string): unknown; get(id: unknown): DurableObjectStub };
  /** Cloudflare's Rate Limiting binding (wrangler.toml), keyed by the connecting address */
  RELAY_LIMITER: RateLimiter;
  /** the backstop over all addresses together */
  RELAY_GLOBAL_LIMITER: RateLimiter;
}

/** the Workers runtime's globals the Durable Object needs (tests put fakes in their place) */
interface Runtime {
  WebSocketPair: new () => { 0: HibernatableSocket; 1: HibernatableSocket };
  WebSocketRequestResponsePair: new (request: string, response: string) => unknown;
}
const runtime = () => globalThis as unknown as Runtime;

const ROLES = new Set(["control", "data", "client"]);
function isInfo(value: unknown): value is SocketInfo {
  if (typeof value !== "object" || value === null) return false;
  const info = value as Record<string, unknown>;
  return typeof info["role"] === "string" && ROLES.has(info["role"]) && (info["connection_id"] === null || typeof info["connection_id"] === "string")
    && typeof info["seen"] === "number" && typeof info["buffered"] === "boolean";
}

export class RelayRoom {
  private readonly room: Room<HibernatableSocket>;

  constructor(private readonly state: RelayState, _env?: Env) {
    state.setWebSocketAutoResponse(new (runtime().WebSocketRequestResponsePair)(KEEPALIVE_PING, KEEPALIVE_PONG));
    const infos = new WeakMap<HibernatableSocket, SocketInfo>();
    const host: RoomHost<HibernatableSocket> = {
      sockets: () => state.getWebSockets(),
      info: (socket) => {
        let info = infos.get(socket);
        if (!info) {
          const saved = socket.deserializeAttachment();
          if (!isInfo(saved)) return null;
          info = saved;
          infos.set(socket, info);
        }
        return info;
      },
      setInfo: (socket, info) => {
        infos.set(socket, info);
        socket.serializeAttachment(info);
      },
      send: (socket, frame) => {
        // a socket the far end already closed throws here; its webSocketClose ends it in the room
        try { socket.send(frame); } catch { /* see above */ }
      },
      close: (socket, code, reason) => {
        // closing a socket that is already closed throws; it is gone either way
        try { socket.close(code, reason); } catch { /* see above */ }
      },
      keepaliveAt: (socket) => state.getWebSocketAutoResponseTimestamp(socket)?.getTime() ?? null,
      now: () => Date.now(),
    };
    this.room = new Room(host);
  }

  async fetch(request: Request): Promise<Response> {
    const socket = parseSocketRequest(new URL(request.url));
    if ("error" in socket) return new Response(socket.error, { status: 400 });
    const pair = new (runtime().WebSocketPair)();
    this.state.acceptWebSocket(pair[1]);
    this.room.open(pair[1], socket);
    if ((await this.state.storage.getAlarm()) === null) await this.state.storage.setAlarm(Date.now() + IDLE_MS);
    return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
  }

  webSocketMessage(socket: HibernatableSocket, message: string | ArrayBuffer): void {
    this.room.message(socket, message);
  }

  webSocketClose(socket: HibernatableSocket): void {
    this.room.closed(socket);
  }

  webSocketError(socket: HibernatableSocket): void {
    this.room.closed(socket);
  }

  async alarm(): Promise<void> {
    const next = this.room.sweep();
    if (next !== null) await this.state.storage.setAlarm(Math.max(next, Date.now() + 1000));
  }
}

export async function handle(request: Request, env: Env): Promise<Response> {
  const admitted = await admit(request, request.headers.get("cf-connecting-ip") ?? "", { perAddress: env.RELAY_LIMITER, global: env.RELAY_GLOBAL_LIMITER });
  if (admitted instanceof Response) return admitted;
  return env.RELAY.get(env.RELAY.idFromName(admitted.server_id)).fetch(request);
}

export default {
  fetch: (request: Request, env: Env) => handle(request, env),
};
