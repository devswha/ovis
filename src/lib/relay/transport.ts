import type { HttpStream, MuxClock, WsStream } from "../../../shared/relay-mux-engine.ts";
import { REQUEST_HEADERS } from "../../../shared/relay-mux.ts";
import { MuxProtocolError } from "../../../shared/relay-mux.ts";
import type { RelayOffer } from "../../../shared/relay-offer.ts";
import type { EventSourceLike, Transport, WebSocketLike } from "../transport.ts";
import { openRelayChannel, UnsafeRelayDestinationError } from "./channel.ts";
import type { RelayChannel, RelayChannelOptions, RelayServerInfo } from "./channel.ts";
import { ServerIdentityChangedError } from "./device.ts";
import { relayResourceUrl, serveRelayResources } from "./resources.ts";

export interface RelayTransportOptions extends RelayChannelOptions {
  readonly openChannel?: typeof openRelayChannel;
  readonly clock?: MuxClock;
  /** A reconnect the PC refused for good (`isFatalRelayError`): the transport has closed itself, and the shell shows why. */
  readonly onFatal?: (error: Error) => void;
}

/** Whether another attempt could only fail the same way: the device was revoked or never paired, the PC's identity or protocol changed, or the offer is unsafe. */
export function isFatalRelayError(error: unknown): error is Error {
  if (error instanceof ServerIdentityChangedError || error instanceof UnsafeRelayDestinationError) return true;
  return error instanceof MuxProtocolError && (error.code === "auth_revoked" || error.code === "auth_failed"
    || error.code === "unsupported_version" || error.code === "unsupported_extension" || error.code === "unsupported_transport");
}

const clock: MuxClock = {
  now: () => performance.now(),
  setTimeout: (callback, ms) => {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
};

function target(url: string): string {
  const parsed = new URL(url, "https://relay.ovis.invalid");
  return parsed.pathname + parsed.search;
}

function method(value: string): "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" {
  switch (value) {
    case "GET": case "HEAD": case "POST": case "PUT": case "PATCH": case "DELETE": case "OPTIONS": return value;
    default: throw new TypeError(`Unsupported relay method: ${value}`);
  }
}

/** Property handlers occupy the listener position of their first non-null assignment. */
function eventProperties(target: EventTarget, names: readonly string[]): void {
  for (const name of names) {
    let handler: EventListener | null = null;
    const listener = (event: Event): void => { handler?.call(target, event); };
    Object.defineProperty(target, `on${name}`, {
      configurable: true, enumerable: true,
      get: () => handler,
      set: (value: EventListener | null) => {
        if (value === null) target.removeEventListener(name, listener);
        else if (handler === null) target.addEventListener(name, listener);
        handler = value;
      },
    });
  }
}

/** Establish once before boot installs it. A reconnect replaces only the carrier, never streams. */
export async function openRelayTransport(offer: RelayOffer, options: RelayTransportOptions = {}): Promise<RelayTransport> {
  const transport = new RelayTransport(offer, options);
  try { await transport.connect(); return transport; }
  catch (error) { transport.close(); throw error; }
}

export class RelayTransport implements Transport {
  readonly kind = "relay";
  private channel: RelayChannel | undefined;
  private known: RelayServerInfo | undefined;
  private generation = 0;
  private opening: Promise<void> | undefined;
  private stopped = false;
  private delay = 1000;
  private cancelRetry: (() => void) | undefined;
  private readonly abort = new AbortController();
  private readonly stopResources: () => void;
  private readonly wake = (): void => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    if (this.stopped || this.channel || this.opening) return;
    this.cancelRetry?.();
    this.cancelRetry = undefined;
    void this.connect().catch((error: unknown) => this.failed(error));
  };
  private readonly aborted = (): void => this.close();

  constructor(private readonly offer: RelayOffer, private readonly options: RelayTransportOptions = {}) {
    options.signal?.throwIfAborted();
    this.stopResources = serveRelayResources(this, offer.server_id, () => !this.stopped && this.channel?.mux.active === true);
    options.signal?.addEventListener("abort", this.aborted, { once: true });
    globalThis.addEventListener?.("online", this.wake);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.wake);
  }

  connect(): Promise<void> {
    if (this.opening) return this.opening;
    if (this.stopped || this.channel) return Promise.resolve();
    this.opening = this.establish().finally(() => { this.opening = undefined; });
    return this.opening;
  }

  private async establish(): Promise<void> {
    const generation = ++this.generation;
    // A one-use pairing code must never be reused after admission.
    const { code, ...savedOffer } = this.offer;
    const channel = await (this.options.openChannel ?? openRelayChannel)(generation === 1 ? this.offer : savedOffer, {
      ...this.options, signal: this.abort.signal,
      onClose: (error) => {
        if (generation !== this.generation || this.stopped) return;
        this.channel = undefined;
        this.options.onClose?.(error);
        this.failed(error);
      },
    });
    if (generation !== this.generation || this.stopped) { channel.close(); return; }
    if (!channel.mux.active) throw new TypeError("Relay carrier lost during admission");
    this.channel = channel;
    this.known = channel.server;
    this.cancelRetry?.();
    this.cancelRetry = undefined;
    this.delay = 1000;
  }

  /** What the PC said of itself on the latest admission: a reconnect after its update names the new version. */
  get server(): RelayServerInfo | undefined { return this.known; }

  /** A reconnect that failed: tried again later, unless no later attempt could succeed. */
  private failed(error: unknown): void {
    if (this.stopped) return;
    if (!isFatalRelayError(error)) { this.retry(); return; }
    this.close();
    this.options.onFatal?.(error);
  }

  private retry(): void {
    if (this.stopped || this.cancelRetry) return;
    this.cancelRetry = (this.options.clock ?? clock).setTimeout(() => {
      this.cancelRetry = undefined;
      void this.connect().catch((error: unknown) => this.failed(error));
    }, this.delay);
    this.delay = Math.min(30_000, this.delay * 2);
  }

  private mux() {
    if (this.stopped || !this.channel?.mux.active) throw new TypeError("Relay carrier is disconnected");
    return this.channel.mux;
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const address = input instanceof Request ? input : new URL(String(input), "https://relay.ovis.invalid").href;
    // These are browser networking policies, not properties of an encrypted mux request.
    const request = new Request(address, { ...init, credentials: "omit", mode: "cors" });
    request.signal.throwIfAborted();
    let stream: HttpStream;
    try {
      const allowed: readonly string[] = REQUEST_HEADERS;
      stream = this.mux().openHttp({
        target: target(request.url), method: method(request.method),
        headers: [...request.headers].filter(([name]) => allowed.includes(name)),
        body: request.body ? "stream" : "none",
      });
    } catch (error) { throw new TypeError("Relay request failed", { cause: error }); }
    return new Promise<Response>((resolve, reject) => {
      const aborted = (): void => { stream.reset(); reject(request.signal.reason); };
      request.signal.addEventListener("abort", aborted, { once: true });
      stream.onDispose = (error) => {
        request.signal.removeEventListener("abort", aborted);
        if (error) reject(request.signal.aborted ? request.signal.reason : new TypeError("Relay request failed", { cause: error }));
      };
      stream.onHeaders = ({ status, headers }) => {
        if (status < 200) return;
        // Keep the body streaming; a failed carrier also errors an already returned body.
        const reader = stream.body.getReader();
        const body = stream.noBody ? null : new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const next = await reader.read();
              if (next.done) controller.close();
              else controller.enqueue(next.value);
            } catch (error) {
              controller.error(request.signal.aborted ? request.signal.reason : new TypeError("Relay body failed", { cause: error }));
            }
          },
          cancel: (reason) => reader.cancel(reason),
        }, { highWaterMark: 0 });
        resolve(new Response(body, { status, headers: headers.map(([name, value]) => [name, value]) }));
      };
      if (request.signal.aborted) { aborted(); return; }
      if (request.body) void stream.sendBody(request.body).catch((error: unknown) => {
        if (stream.stopped) return;
        stream.reset("internal_error");
        reject(request.signal.aborted ? request.signal.reason : new TypeError("Relay upload failed", { cause: error }));
      });
    });
  }

  openSocket(url: string): RelayWebSocket { return new RelayWebSocket(() => this.mux().openWs({ target: target(url), headers: [], protocols: [] })); }
  openEventSource(url: string): RelayEventSource { return new RelayEventSource(this, url); }
  resourceUrl(path: string, signal?: AbortSignal): Promise<string> { return relayResourceUrl(this, this.offer.server_id, path, signal); }

  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.stopResources();
    ++this.generation;
    this.cancelRetry?.();
    this.cancelRetry = undefined;
    this.abort.abort();
    this.channel?.close();
    this.channel = undefined;
    this.options.signal?.removeEventListener("abort", this.aborted);
    globalThis.removeEventListener?.("online", this.wake);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.wake);
  }
}

export class RelayWebSocket extends EventTarget implements WebSocketLike {
  override addEventListener<K extends keyof WebSocketEventMap>(type: K, listener: (event: WebSocketEventMap[K]) => void, options?: boolean | AddEventListenerOptions): void;
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void;
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void {
    super.addEventListener(type, listener, options);
  }
  override removeEventListener<K extends keyof WebSocketEventMap>(type: K, listener: (event: WebSocketEventMap[K]) => void, options?: boolean | EventListenerOptions): void;
  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void;
  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void {
    super.removeEventListener(type, listener, options);
  }
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState: number = this.CONNECTING;
  binaryType: BinaryType = "blob";
  declare onopen: WebSocketLike["onopen"];
  declare onmessage: WebSocketLike["onmessage"];
  declare onclose: WebSocketLike["onclose"];
  declare onerror: WebSocketLike["onerror"];
  private stream: WsStream | undefined;
  private pendingBytes = 0;
  private outgoing = Promise.resolve();
  private events = Promise.resolve();
  get bufferedAmount(): number { return this.pendingBytes + (this.stream?.getBufferedAmount() ?? 0); }

  constructor(private readonly open: () => WsStream) {
    super();
    eventProperties(this, ["open", "message", "close", "error"]);
    // Browser socket events are asynchronous even when a test carrier answers synchronously.
    queueMicrotask(() => {
      if (this.readyState !== this.CONNECTING) return;
      try {
        const stream = this.open();
        this.stream = stream;
        stream.onAccept = () => { void this.enqueue(() => {
          if (this.readyState !== this.CONNECTING) return;
          this.readyState = this.OPEN;
          this.emit(new Event("open"));
        }); };
        stream.onMessage = (data) => this.enqueue(() => {
          if (this.readyState !== this.OPEN && this.readyState !== this.CLOSING) return;
          this.emit(new MessageEvent("message", { data: typeof data === "string" ? data
            : this.binaryType === "blob" ? new Blob([data.slice().buffer]) : data.slice().buffer }));
        });
        stream.onClose = (event) => {
          stream.rejection?.reset();
          void this.enqueue(() => this.finish(event.code, event.reason, event.clean));
        };
      } catch { void this.enqueue(() => this.finish(1006, "", false)); }
    });
  }

  private enqueue(action: () => void): Promise<void> {
    this.events = this.events.then(action);
    return this.events;
  }

  private emit(event: Event): void {
    this.dispatchEvent(event);
  }

  private finish(code: number, reason: string, clean: boolean): void {
    if (this.readyState === this.CLOSED) return;
    this.readyState = this.CLOSED;
    // Discarded sends still count after close, even though their payloads are never queued.
    if (code === 1006) this.emit(new Event("error"));
    this.emit(new CloseEvent("close", { code, reason, wasClean: clean }));
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.readyState === this.CONNECTING) throw new DOMException("Socket is connecting", "InvalidStateError");
    const size = typeof data === "string" ? new TextEncoder().encode(data).length : data instanceof Blob ? data.size : data.byteLength;
    if (this.readyState !== this.OPEN) { this.pendingBytes += size; return; }
    const stream = this.stream;
    if (!stream) return;
    // Capture the stream now. Neither Blob conversion nor backpressure can replay on a new mux.
    const message = typeof data === "string" || data instanceof Blob ? data : ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice() : new Uint8Array(data).slice();
    this.pendingBytes += size;
    this.outgoing = this.outgoing.then(async () => {
      const bytes = message instanceof Blob ? new Uint8Array(await message.arrayBuffer()) : message;
      if (stream.live && this.readyState !== this.CLOSED) {
        this.pendingBytes -= size;
        stream.send(bytes);
      }
    }).catch(() => this.finish(1006, "", false));
  }

  close(code?: number, reason = ""): void {
    if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) throw new DOMException("Invalid close code", "InvalidAccessError");
    if (new TextEncoder().encode(reason).length > 123) throw new DOMException("Close reason is too long", "SyntaxError");
    if (this.readyState === this.CLOSED || this.readyState === this.CLOSING) return;
    const connecting = this.readyState === this.CONNECTING;
    this.readyState = this.CLOSING;
    if (connecting) {
      this.stream?.reset();
      void this.enqueue(() => this.finish(1006, "", false));
    } else {
      this.outgoing = this.outgoing.then(() => { this.stream?.close(code ?? null, reason); });
    }
  }
}

/** SSE's line and unfinished-event storage are jointly bounded, including ignored fields. */
export const SSE_BUFFER_LIMIT = 1024 * 1024;

export class RelayEventSource extends EventTarget implements EventSourceLike {
  override addEventListener<K extends keyof EventSourceEventMap>(type: K, listener: (event: EventSourceEventMap[K]) => void, options?: boolean | AddEventListenerOptions): void;
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void;
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void {
    super.addEventListener(type, listener, options);
  }
  readyState = 0;
  declare onopen: EventSourceLike["onopen"];
  declare onmessage: EventSourceLike["onmessage"];
  declare onerror: EventSourceLike["onerror"];
  private readonly abort = new AbortController();

  constructor(transport: Transport, url: string) {
    super();
    eventProperties(this, ["open", "message", "error"]);
    void this.read(transport, url).catch(() => {
      if (this.readyState === 2) return;
      this.readyState = 2;
      this.abort.abort();
      this.emit(new Event("error"));
    });
  }

  private emit(event: Event): void {
    this.dispatchEvent(event);
  }

  private async read(transport: Transport, url: string): Promise<void> {
    const response = await transport.fetch(url, { signal: this.abort.signal, headers: { accept: "text/event-stream" } });
    if (this.readyState === 2) { await response.body?.cancel(); return; }
    if (response.status !== 200 || response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "text/event-stream" || !response.body) {
      await response.body?.cancel();
      throw new TypeError("Invalid relay event stream");
    }
    this.readyState = 1;
    this.emit(new Event("open"));
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let line = "";
    let data = "";
    let type = "";
    let id = "";
    let skipLf = false;
    const consume = (): void => {
      if (!line) {
        if (data) this.emit(new MessageEvent(type || "message", { data: data.slice(0, -1), lastEventId: id, origin: new URL(url, "https://relay.ovis.invalid").origin }));
        data = ""; type = "";
      } else {
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "data") data += value + "\n";
        else if (field === "event") type = value;
        else if (field === "id" && !value.includes("\0")) id = value;
      }
      line = "";
    };
    try {
      while (this.readyState === 1) {
        const next = await reader.read();
        if (next.done) throw new TypeError("Relay event stream ended");
        for (const character of decoder.decode(next.value, { stream: true })) {
          if (this.readyState !== 1) return;
          if (skipLf) { skipLf = false; if (character === "\n") continue; }
          if (character === "\r" || character === "\n") { consume(); skipLf = character === "\r"; }
          else line += character;
          if (line.length + data.length + type.length + id.length > SSE_BUFFER_LIMIT) throw new TypeError("Relay event exceeds buffer limit");
        }
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
  }

  close(): void { this.readyState = 2; this.abort.abort(); }
}
