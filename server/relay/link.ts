import { importPublicKey, importSecretKey, openDaemonSecureChannel } from "../../shared/relay-e2ee.ts";
import type { Transport } from "../../shared/relay-e2ee.ts";
import type { MuxClock } from "../../shared/relay-mux-engine.ts";
import type { RequestServices } from "../dispatch.ts";
import type { RelayIdentity } from "./identity.ts";
import { RelaySession, relayClock } from "./session.ts";
import type { RelaySocketHandlers } from "./virtual-socket.ts";
import { version } from "../../package.json";
import { bytesToHex } from "@noble/hashes/utils.js";
import { answerServerChallenge, SERVER_PROOF_CLOSE } from "../../shared/relay-server-proof.ts";

export interface RelayLinkOptions {
  readonly relay: string;
  readonly identity: RelayIdentity;
  readonly services: RequestServices;
  /** The server's listening port, resolved after binding (including port: 0). */
  readonly port: number;
  readonly connect?: (url: string) => WebSocket;
  readonly clock?: MuxClock;
  readonly random?: () => number;
  readonly onState: (phase: "connecting" | "online" | "error", error: string | null) => void;
}

interface DataConnection {
  readonly socket: WebSocket;
  readonly cancelTimeout: () => void;
  readonly sockets: Set<Parameters<RelaySocketHandlers["open"]>[0]>;
  session?: RelaySession;
  cancelKeepalive?: () => void;
}

/** Physical relay I/O only: admission and dispatch remain in RelaySession. */
export class RelayLink {
  private control: WebSocket | undefined;
  private readonly data = new Map<string, DataConnection>();
  private stopped = false;
  private attempts = 0;
  private cancelRetry: (() => void) | undefined;
  private cancelKeepalive: (() => void) | undefined;
  private readonly clock: MuxClock;

  constructor(private readonly options: RelayLinkOptions) {
    this.clock = options.clock ?? relayClock;
  }

  get sessions(): number { return [...this.data.values()].filter((entry) => entry.session?.mux.active).length; }

  start(): void { if (!this.stopped && !this.control) this.openControl(); }

  private socket(connectionId?: string): WebSocket {
    const url = new URL("/v1/ws", this.options.relay);
    url.searchParams.set("server_id", this.options.identity.server_id);
    url.searchParams.set("role", "server");
    url.searchParams.set("v", "1");
    url.searchParams.set("proof", "1");
    url.searchParams.set("public_key", bytesToHex(importPublicKey(this.options.identity.public_key)));
    if (connectionId) url.searchParams.set("connection_id", connectionId);
    return (this.options.connect ?? ((address) => new WebSocket(address)))(url.href);
  }

  private openControl(): void {
    if (this.stopped) return;
    this.options.onState("connecting", null);
    let socket: WebSocket;
    try { socket = this.socket(); }
    catch { this.retry(); return; }
    this.control = socket;
    let proofAnswered = false;
    let lastPong = this.clock.now();
    // An upgrade that never answers is also a lost relay.
    this.cancelKeepalive = this.clock.setTimeout(() => socket.close(), 15_000);
    socket.onopen = () => {
      if (this.stopped || this.control !== socket) { socket.close(); return; }
      this.cancelKeepalive?.();
      lastPong = this.clock.now();
      const heartbeat = () => {
        if (this.stopped || this.control !== socket) return;
        if (this.clock.now() - lastPong >= 30_000) { socket.close(); return; }
        if (proofAnswered) socket.send('{"type":"ping"}');
        this.cancelKeepalive = this.clock.setTimeout(heartbeat, 10_000);
      };
      this.cancelKeepalive = this.clock.setTimeout(heartbeat, 10_000);
    };
    socket.onmessage = (event) => {
      if (this.stopped || this.control !== socket || typeof event.data !== "string") return;
      if (!proofAnswered) {
        proofAnswered = this.prove(socket, event.data, null);
        return;
      }
      let value: unknown;
      try { value = JSON.parse(event.data); } catch { socket.close(); return; }
      if (typeof value !== "object" || value === null || !("type" in value)) { socket.close(); return; }
      if (value.type === "pong") { lastPong = this.clock.now(); return; }
      if (value.type === "sync" && "connection_ids" in value && Array.isArray(value.connection_ids)
        && value.connection_ids.length <= 8 && value.connection_ids.every((id) => typeof id === "string" && /^[0-9a-f]{32}$/.test(id))) {
        this.attempts = 0;
        this.options.onState("online", null);
        for (const id of value.connection_ids) this.openData(id);
      } else if ("connection_id" in value && typeof value.connection_id === "string" && /^[0-9a-f]{32}$/.test(value.connection_id)) {
        if (value.type === "connected") this.openData(value.connection_id);
        else if (value.type === "disconnected") this.data.get(value.connection_id)?.socket.close();
        else socket.close();
      } else socket.close();
    };
    socket.onerror = () => socket.close();
    socket.onclose = (event) => {
      if (this.control !== socket) return;
      this.control = undefined;
      this.cancelKeepalive?.();
      // The relay also uses 4401 for late answers. Only an explicit key mismatch is permanent.
      if (event.code === SERVER_PROOF_CLOSE
        && (event.reason === "server key does not match server_id" || event.reason === "invalid server key")) {
        console.error(JSON.stringify({ event: "relay.server_proof.failed", code: event.code, reason: event.reason }));
        this.options.onState("error", `Relay refused the server proof (${event.code}): ${event.reason}`);
        return;
      }
      if (!this.stopped) this.retry();
    };
  }

  private prove(socket: WebSocket, frame: unknown, connectionId: string | null): boolean {
    const answer = answerServerChallenge(frame, importSecretKey(this.options.identity.secret_key), {
      server_id: this.options.identity.server_id, role: connectionId === null ? "control" : "data", connection_id: connectionId,
    });
    if (!answer) { socket.close(4000, "invalid relay server challenge"); return false; }
    socket.send(answer);
    return true;
  }

  private retry(): void {
    if (this.stopped) return;
    this.options.onState("error", "Relay connection lost; reconnecting.");
    const delay = Math.round(Math.min(++this.attempts, 30) * 1000 * (0.8 + (this.options.random ?? Math.random)() * 0.4));
    this.cancelRetry = this.clock.setTimeout(() => this.openControl(), delay);
  }

  private openData(id: string): void {
    if (this.stopped || this.data.has(id) || this.data.size >= 8) return;
    let socket: WebSocket;
    try { socket = this.socket(id); } catch { return; }
    socket.binaryType = "arraybuffer";
    const entry: DataConnection = {
      socket, sockets: new Set(),
      cancelTimeout: this.clock.setTimeout(() => socket.close(), 15_000),
    };
    this.data.set(id, entry);
    let proofAnswered = false;
    const transport: Transport = {
      onmessage: null, onclose: null, onerror: null,
      send: (data) => { socket.send(data); },
      close: (code, reason) => socket.close(code, reason),
    };
    socket.onmessage = (event) => {
      if (!proofAnswered) {
        proofAnswered = this.prove(socket, event.data, id);
        return;
      }
      if (event.data === '{"type":"pong"}') return;
      if (typeof event.data === "string" || event.data instanceof ArrayBuffer) {
        transport.onmessage?.({ data: event.data, isBinary: typeof event.data !== "string" });
      } else socket.close();
    };
    socket.onerror = () => { transport.onerror?.(new Error("Relay data connection failed")); socket.close(); };
    socket.onclose = (event) => {
      entry.cancelTimeout();
      entry.cancelKeepalive?.();
      transport.onclose?.(event.code, event.reason);
      if (this.data.get(id) === entry) this.data.delete(id);
    };
    socket.onopen = () => {
      const heartbeat = () => {
        if (this.stopped || this.data.get(id) !== entry) return;
        if (proofAnswered) socket.send('{"type":"ping"}');
        entry.cancelKeepalive = this.clock.setTimeout(heartbeat, 10_000);
      };
      entry.cancelKeepalive = this.clock.setTimeout(heartbeat, 10_000);
    };
    // Install the handshake consumer before the data socket can receive held client frames.
    void openDaemonSecureChannel(transport, {
      daemonKeyPair: {
        publicKey: importPublicKey(this.options.identity.public_key),
        secretKey: importSecretKey(this.options.identity.secret_key),
      },
      events: { onmessage: (data) => { if (!this.stopped) entry.session?.receive(data); } },
    }).then((channel) => {
      entry.cancelTimeout();
      if (this.stopped || this.data.get(id) !== entry || !channel.isOpen()) { channel.close(); return; }
      const handlers = this.options.services.core.socketHandlers;
      entry.session = new RelaySession({
        channel, services: this.options.services, port: this.options.port, serverId: this.options.identity.server_id,
        serverVersion: version, minSupportedClient: "0.4.20",
        routingOverhead: 0, maxWireMessageBytes: 64 * 1024,
        websocket: {
          ...handlers,
          open: (peer) => { entry.sockets.add(peer); return handlers.open(peer); },
          close: (peer, code, reason) => { entry.sockets.delete(peer); handlers.close(peer, code, reason); },
        },
      });
    }).catch(() => socket.close());
  }

  /** Cancel retries synchronously; finish queued policy closes before ending protected carriers. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.cancelRetry?.();
    this.cancelKeepalive?.();
    const control = this.control;
    this.control = undefined;
    await Promise.all([...this.data.values()].map(async (entry) => {
      entry.cancelTimeout();
      entry.cancelKeepalive?.();
      for (const socket of entry.sockets) socket.close(1001, "Relay stopped");
      if (entry.session) {
        await entry.session.mux.flush();
        entry.session.mux.goAway("shutdown", 0);
        await entry.session.mux.flush();
      }
      entry.socket.close();
    }));
    control?.close();
    this.data.clear();
  }
}
