import { arrayBufferToBase64, base64ToArrayBuffer } from "../../../shared/vendor/paseo-e2ee/base64.ts";
import type { RelaySocket } from "../../../shared/relay-channel.ts";
import { isDirectCarrier } from "../../../shared/relay-mux.ts";
import { hasNativePlugin } from "../nativeApp.ts";

export const DIRECT_PLUGIN = "OvisDirect";
export const APP_ORIGIN = "https://app.ovis.sh";

export function isDirectSocketUrl(url: string): boolean {
  const match = /^(ws:\/\/[^/?#]+)\/v1\/ws\?v=1$/.exec(url);
  return match !== null && isDirectCarrier(match[1]!);
}

export type DirectFrame = { readonly kind: "text"; readonly data: string } | { readonly kind: "binary"; readonly data: string };
export type DirectEvent =
  | { readonly type: "message"; readonly id: string; readonly kind: "text" | "binary"; readonly data: string }
  | { readonly type: "close"; readonly id: string; readonly code: number; readonly reason: string }
  | { readonly type: "error"; readonly id: string };

export interface DirectBridge {
  open(url: string): Promise<string>;
  send(id: string, frame: DirectFrame): Promise<void>;
  close(id: string, code?: number, reason?: string): Promise<void>;
  ack(id: string, messages: number): Promise<void>;
  listen(handler: (event: DirectEvent) => void): void;
}

interface CapacitorEvents {
  nativePromise?: (plugin: string, method: string, options?: Record<string, unknown>) => Promise<unknown>;
  addListener?: (plugin: string, event: string, callback: (data: unknown) => void) => unknown;
}

function parseEvent(type: DirectEvent["type"], data: unknown): DirectEvent | null {
  if (typeof data !== "object" || data === null) return null;
  const value = data as Record<string, unknown>;
  if (typeof value.id !== "string") return null;
  switch (type) {
    case "message":
      return (value.kind === "text" || value.kind === "binary") && typeof value.data === "string" ? { type, id: value.id, kind: value.kind, data: value.data } : null;
    case "close":
      return { type, id: value.id, code: typeof value.code === "number" ? value.code : 1006, reason: typeof value.reason === "string" ? value.reason : "" };
    case "error":
      return { type, id: value.id };
  }
}

export function capacitorDirectBridge(): DirectBridge | undefined {
  const cap = (globalThis as { Capacitor?: CapacitorEvents }).Capacitor;
  const call = cap?.nativePromise;
  const addListener = cap?.addListener;
  if (!call || !addListener) return undefined;
  return {
    open: async (url) => {
      const answer = await call(DIRECT_PLUGIN, "open", { url }) as { id?: unknown } | null;
      if (typeof answer?.id !== "string") throw new Error("OvisDirect opened no socket");
      return answer.id;
    },
    send: async (id, frame) => { await call(DIRECT_PLUGIN, "send", { id, kind: frame.kind, data: frame.data }); },
    close: async (id, code, reason) => { await call(DIRECT_PLUGIN, "close", { id, ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) }); },
    ack: async (id, messages) => { await call(DIRECT_PLUGIN, "ack", { id, messages }); },
    listen: (handler) => {
      for (const type of ["message", "close", "error"] as const) {
        addListener(DIRECT_PLUGIN, type, (data) => { const event = parseEvent(type, data); if (event) handler(event); });
      }
    },
  };
}

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;
export const EARLY_SEND_BYTES = 4 * 1024 * 1024;
export const EARLY_SEND_MESSAGES = 16_384;
const encoder = new TextEncoder();

class DirectSocket implements RelaySocket {
  binaryType: BinaryType = "arraybuffer";
  readyState = CONNECTING;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  id: string | undefined;
  private early: DirectFrame[] = [];
  private earlyBytes = 0;
  private closeAsked: { code?: number; reason?: string } | undefined;
  private unacked = 0;

  constructor(private readonly bridge: DirectBridge) {}

  opened(id: string): void {
    this.id = id;
    if (this.readyState === CONNECTING) this.readyState = OPEN;
    for (const frame of this.early) this.forward(frame);
    this.early = [];
    if (this.closeAsked) this.closeNative(this.closeAsked.code, this.closeAsked.reason);
  }

  refused(): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.early = [];
    this.onerror?.(new Event("error"));
    this.onclose?.(new CloseEvent("close", { code: 1006, reason: "", wasClean: false }));
  }

  send(data: string | ArrayBuffer): void {
    if (this.readyState === CLOSING || this.readyState === CLOSED) return;
    const frame: DirectFrame = typeof data === "string" ? { kind: "text", data } : { kind: "binary", data: arrayBufferToBase64(data) };
    if (this.id !== undefined) { this.forward(frame); return; }
    this.earlyBytes += typeof data === "string" ? encoder.encode(data).byteLength : data.byteLength;
    if (this.early.length + 1 > EARLY_SEND_MESSAGES || this.earlyBytes > EARLY_SEND_BYTES) {
      this.early = [];
      this.readyState = CLOSED;
      this.closeAsked = { code: 1009, reason: "send queue full" };
      queueMicrotask(() => this.onclose?.(new CloseEvent("close", { code: 1009, reason: "send queue full", wasClean: false })));
      return;
    }
    this.early.push(frame);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === CLOSING || this.readyState === CLOSED) return;
    this.readyState = CLOSING;
    if (this.id === undefined) this.closeAsked = { ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) };
    else this.closeNative(code, reason);
  }

  event(event: DirectEvent): void {
    switch (event.type) {
      case "message": {
        if (this.readyState === CLOSED) return;
        const data = event.kind === "text" ? event.data : base64ToArrayBuffer(event.data);
        if (this.unacked++ === 0) queueMicrotask(() => this.flushAck());
        this.onmessage?.(new MessageEvent("message", { data }));
        return;
      }
      case "error":
        if (this.readyState !== CLOSED) this.onerror?.(new Event("error"));
        return;
      case "close":
        if (this.readyState === CLOSED) return;
        this.readyState = CLOSED;
        this.onclose?.(new CloseEvent("close", { code: event.code, reason: event.reason, wasClean: event.code !== 1006 }));
        return;
    }
  }

  private flushAck(): void {
    const messages = this.unacked;
    this.unacked = 0;
    if (messages === 0 || this.id === undefined || this.readyState === CLOSED) return;
    this.bridge.ack(this.id, messages).catch((error: unknown) => console.warn("Ovis: the direct socket's acknowledgement failed", error));
  }

  private forward(frame: DirectFrame): void {
    const id = this.id!;
    this.bridge.send(id, frame).catch((error: unknown) => console.warn("Ovis: a direct socket send failed", error));
  }

  private closeNative(code?: number, reason?: string): void {
    this.bridge.close(this.id!, code, reason).catch((error: unknown) => console.warn("Ovis: a direct socket did not close", error));
  }
}

export function directSocketFactory(bridge: DirectBridge): (url: string) => RelaySocket {
  const sockets = new Map<string, DirectSocket>();
  const waiting = new Map<string, DirectEvent[]>();
  let opening = 0;
  bridge.listen((event) => {
    const socket = sockets.get(event.id);
    if (socket) {
      socket.event(event);
      if (event.type === "close") sockets.delete(event.id);
      return;
    }
    if (opening > 0) waiting.set(event.id, [...(waiting.get(event.id) ?? []), event]);
  });
  return (url) => {
    if (!isDirectSocketUrl(url)) throw new TypeError("Not a direct carrier's address");
    const socket = new DirectSocket(bridge);
    opening++;
    bridge.open(url).then((id) => {
      opening--;
      const early = waiting.get(id) ?? [];
      waiting.delete(id);
      if (opening === 0) waiting.clear();
      sockets.set(id, socket);
      socket.opened(id);
      for (const event of early) {
        socket.event(event);
        if (event.type === "close") sockets.delete(id);
      }
    }, () => {
      opening--;
      if (opening === 0) waiting.clear();
      socket.refused();
    });
    return socket;
  };
}

let shared: ((url: string) => RelaySocket) | undefined;
let tailnet: (() => boolean) | undefined;

export function directTailnetSupport(call: (plugin: string, method: string) => Promise<unknown>): () => boolean {
  let supported = false;
  call(DIRECT_PLUGIN, "features").then(
    (answer) => { supported = (answer as { tailnet?: unknown } | null)?.tailnet === true; },
    () => {},
  );
  return () => supported;
}

export function nativeDirectTailnet(): () => boolean {
  const call = (globalThis as { Capacitor?: CapacitorEvents }).Capacitor?.nativePromise;
  if (!call) return () => false;
  tailnet ??= directTailnetSupport(call);
  return tailnet;
}

export function nativeDirectSocket(): ((url: string) => RelaySocket) | undefined {
  if (typeof window === "undefined" || window.location.origin !== APP_ORIGIN || !hasNativePlugin(DIRECT_PLUGIN)) return undefined;
  if (shared) return shared;
  const bridge = capacitorDirectBridge();
  if (!bridge) return undefined;
  shared = directSocketFactory(bridge);
  return shared;
}
