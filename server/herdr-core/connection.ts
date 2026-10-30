/**
 * One framed connection to herdr-core (`hc`), the runtime the Herdr desktop app runs its
 * terminals on. It goes through `hc connect`, which speaks hc's protocol over stdin/stdout and
 * resolves the core's endpoint the way every hc command does (HC_SESSION, HC_SOCKET, its config),
 * so this side never guesses a socket path.
 *
 * The protocol (herdr-core schema/README.md, generation 1): a `hello` line in plain JSON-RPC
 * switches the connection to framed mode, where every frame is
 * `[channel u32 LE][kind u8][len u32 LE][payload]`. Channel 0 carries JSON-RPC both ways and its
 * calls run side by side; `terminal.attach` and `events.subscribe` answer with a channel of their
 * own, which carries the stream (raw terminal bytes, or one JSON-RPC notification per line).
 */

export const HC_GENERATION = 1;
const DEFAULT_TIMEOUT_MS = 10_000;
const HEADER_BYTES = 9;
/** hc's own ceiling for one frame's payload */
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

export const FRAME_DATA = 0;
export const FRAME_CREDIT = 1;
export const FRAME_CLOSE = 2;

export class HcError extends Error {
  /** hc's stable `data.kind` (`not_found`, `blocked`, `unavailable`, …), or this side's own */
  readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.name = "HcError";
    this.kind = kind;
  }
}

export function encodeFrame(channel: number, kind: number, payload: Uint8Array | string): Uint8Array {
  const body = typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
  const frame = new Uint8Array(HEADER_BYTES + body.length);
  const view = new DataView(frame.buffer);
  view.setUint32(0, channel, true);
  frame[4] = kind;
  view.setUint32(5, body.length, true);
  frame.set(body, HEADER_BYTES);
  return frame;
}

export interface Frame { channel: number; kind: number; payload: Uint8Array }

/**
 * Splits a byte stream into frames; a frame split across reads waits for the rest. A length past
 * hc's ceiling cannot be a frame of this protocol: `onInvalid` hears it once and the reader stops.
 */
export function makeFrameReader(onFrame: (frame: Frame) => void, onInvalid: (reason: string) => void): (chunk: Uint8Array) => void {
  let pending = new Uint8Array(0);
  let failed = false;
  return (chunk) => {
    if (failed) return;
    let buffer: Uint8Array;
    if (pending.length === 0) buffer = chunk;
    else {
      buffer = new Uint8Array(pending.length + chunk.length);
      buffer.set(pending);
      buffer.set(chunk, pending.length);
    }
    let offset = 0;
    while (buffer.length - offset >= HEADER_BYTES) {
      const view = new DataView(buffer.buffer, buffer.byteOffset + offset, HEADER_BYTES);
      const length = view.getUint32(5, true);
      if (length > MAX_PAYLOAD_BYTES) {
        failed = true;
        onInvalid(`a ${length}-byte frame is over hc's ${MAX_PAYLOAD_BYTES}-byte limit`);
        return;
      }
      if (buffer.length - offset < HEADER_BYTES + length) break;
      const payload = buffer.slice(offset + HEADER_BYTES, offset + HEADER_BYTES + length);
      onFrame({ channel: view.getUint32(0, true), kind: buffer[offset + 4]!, payload });
      offset += HEADER_BYTES + length;
    }
    // the stdout pipe may reuse its buffer: keep a copy of the partial tail
    pending = buffer.slice(offset);
  };
}

export interface ChannelHandlers {
  onData: (payload: Uint8Array) => void;
  /** the stream is over: hc's JSON reason when it sent one, or this side's when the line went */
  onClose: (reason: Record<string, unknown> | null) => void;
}

export interface Channel {
  readonly id: number;
  write: (payload: Uint8Array | string) => void;
  close: () => void;
}

interface PendingCall {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** a call that answers with a stream registers it before anything reads the stream's first frame */
  channel?: ChannelHandlers;
}

/** What spawns `hc connect`: tests hand in a fake core. */
export interface HcTransport {
  readable: ReadableStream<Uint8Array>;
  write: (bytes: Uint8Array) => void;
  exited: Promise<unknown>;
  kill: () => void;
}

export function spawnHcConnect(bin: string): HcTransport {
  const child = Bun.spawn([bin, "connect"], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  return {
    readable: child.stdout,
    write: (bytes) => {
      child.stdin.write(bytes);
      void child.stdin.flush();
    },
    exited: child.exited,
    kill: () => child.kill(),
  };
}

interface Line {
  transport: HcTransport;
  /** the hello answer: version and features of the core behind it */
  hello: Promise<HelloInfo>;
  pending: Map<number, PendingCall>;
  channels: Map<number, ChannelHandlers>;
  dead: boolean;
}

export interface HelloInfo { version: string; core: { id: string; name: string } }

/**
 * A lazily opened, self-replacing line to hc: the first call starts `hc connect`, and a line that
 * ended (hc restarted, `hc connect` died) fails what was waiting on it and is opened again by the
 * next call. Streams on it end with it; their owners open them again.
 */
export class HcConnection {
  private line: Line | null = null;
  private nextId = 1;
  private readonly spawn: () => HcTransport;

  constructor(spawn: () => HcTransport) {
    this.spawn = spawn;
  }

  /** The core's identity, from the hello of the current (or a fresh) line. */
  hello(): Promise<HelloInfo> {
    return this.current().hello;
  }

  call<T = unknown>(method: string, params: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    return this.request<T>(method, params, timeoutMs);
  }

  /**
   * A call that answers with a channel (`terminal.attach`, `events.subscribe`): `handlers` hear
   * the stream from its first frame on, and the returned channel writes to it.
   */
  async open<T extends { channel: number }>(method: string, params: Record<string, unknown>, handlers: ChannelHandlers, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<{ result: T; channel: Channel }> {
    const line = this.current();
    const result = await this.request<T>(method, params, timeoutMs, handlers, line);
    const id = result.channel;
    return {
      result,
      channel: {
        id,
        write: (payload) => {
          if (!line.dead && line.channels.has(id)) line.transport.write(encodeFrame(id, FRAME_DATA, payload));
        },
        close: () => {
          if (line.dead || !line.channels.delete(id)) return;
          line.transport.write(encodeFrame(id, FRAME_CLOSE, new Uint8Array(0)));
        },
      },
    };
  }

  close(): void {
    const line = this.line;
    this.line = null;
    if (line) this.end(line, "closed", "the hc connection was closed");
  }

  private async request<T>(method: string, params: Record<string, unknown>, timeoutMs: number, channel?: ChannelHandlers, given?: Line): Promise<T> {
    const line = given ?? this.current();
    await line.hello;
    if (line.dead) throw new HcError("closed", `hc closed the connection before ${method} was sent`);
    const id = this.nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    const timer = setTimeout(() => {
      line.pending.delete(id);
      reject(new HcError("timeout", `hc ${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    line.pending.set(id, { resolve: resolve as (result: unknown) => void, reject, timer, ...(channel ? { channel } : {}) });
    line.transport.write(encodeFrame(0, FRAME_DATA, JSON.stringify({ jsonrpc: "2.0", id, method, params })));
    return promise;
  }

  private current(): Line {
    if (this.line && !this.line.dead) return this.line;
    const transport = this.spawn();
    const { promise: hello, resolve: helloDone, reject: helloFailed } = Promise.withResolvers<HelloInfo>();
    // a hello nobody awaited yet must not surface as an unhandled rejection
    hello.catch(() => {});
    const line: Line = { transport, hello, pending: new Map(), channels: new Map(), dead: false };
    this.line = line;
    const readFrame = makeFrameReader((frame) => this.onFrame(line, frame), (reason) => this.end(line, "bad_frame", `hc sent an invalid frame (${reason})`));
    void (async () => {
      const reader = transport.readable.getReader();
      const decoder = new TextDecoder();
      let plain = "";
      let framed = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (framed) { readFrame(value); continue; }
          // the hello's answer is the one plain line; every byte after its newline is framed
          const end = value.indexOf(0x0a);
          if (end === -1) { plain += decoder.decode(value, { stream: true }); continue; }
          plain += decoder.decode(value.subarray(0, end));
          framed = true;
          const info = parseHello(plain);
          if (typeof info === "string") { helloFailed(new HcError("bad_hello", info)); this.end(line, "bad_hello", info); return; }
          helloDone(info);
          if (end + 1 < value.length) readFrame(value.subarray(end + 1));
        }
      } catch {
        /* the pipe broke: the line ends below */
      }
      helloFailed(new HcError("closed", "hc connect ended before it answered hello"));
      this.end(line, "closed", "hc connect ended");
    })();
    void transport.exited.then(() => {
      helloFailed(new HcError("closed", "hc connect ended before it answered hello"));
      this.end(line, "closed", "hc connect ended");
    }, () => {});
    transport.write(new TextEncoder().encode(`${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "hello", params: { generation: HC_GENERATION, framed: true } })}\n`));
    return line;
  }

  private onFrame(line: Line, frame: Frame): void {
    if (line.dead) return;
    if (frame.channel === 0) {
      if (frame.kind === FRAME_DATA) this.onMessage(line, frame.payload);
      return;
    }
    const handlers = line.channels.get(frame.channel);
    if (frame.kind === FRAME_DATA) {
      // credit back what was taken: hc holds a stream at 256 KiB unacknowledged
      line.transport.write(encodeFrame(frame.channel, FRAME_CREDIT, credit(frame.payload.length)));
      handlers?.onData(frame.payload);
    } else if (frame.kind === FRAME_CLOSE) {
      line.channels.delete(frame.channel);
      handlers?.onClose(parseReason(frame.payload));
    }
  }

  private onMessage(line: Line, payload: Uint8Array): void {
    let message: { id?: unknown; result?: unknown; error?: { message?: unknown; data?: { kind?: unknown } } };
    try {
      message = JSON.parse(new TextDecoder().decode(payload));
    } catch {
      this.end(line, "bad_frame", "hc sent a message that is not JSON");
      return;
    }
    if (typeof message.id !== "number") return;
    const call = line.pending.get(message.id);
    if (!call) return;
    line.pending.delete(message.id);
    clearTimeout(call.timer);
    if (message.error) {
      const kind = typeof message.error.data?.kind === "string" ? message.error.data.kind : "error";
      call.reject(new HcError(kind, typeof message.error.message === "string" ? message.error.message : "hc refused the call"));
      return;
    }
    const channel = (message.result as { channel?: unknown } | null)?.channel;
    if (call.channel && typeof channel === "number") line.channels.set(channel, call.channel);
    call.resolve(message.result);
  }

  private end(line: Line, kind: string, message: string): void {
    if (line.dead) return;
    line.dead = true;
    if (this.line === line) this.line = null;
    for (const call of line.pending.values()) {
      clearTimeout(call.timer);
      call.reject(new HcError(kind, message));
    }
    line.pending.clear();
    const channels = [...line.channels.values()];
    line.channels.clear();
    for (const handlers of channels) handlers.onClose({ reason: "connection_lost" });
    try { line.transport.kill(); } catch { /* already gone */ }
  }
}

function credit(bytes: number): Uint8Array {
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setUint32(0, bytes, true);
  return payload;
}

function parseReason(payload: Uint8Array): Record<string, unknown> | null {
  if (payload.length === 0) return null;
  try {
    const reason: unknown = JSON.parse(new TextDecoder().decode(payload));
    return typeof reason === "object" && reason !== null && !Array.isArray(reason) ? reason as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** The hello's answer, or why it is not one this side can speak to. */
export function parseHello(text: string): HelloInfo | string {
  let message: { result?: { generation?: unknown; framed?: unknown; version?: unknown; core?: { id?: unknown; name?: unknown } }; error?: { message?: unknown } };
  try {
    message = JSON.parse(text);
  } catch {
    return "hc answered hello with something that is not JSON";
  }
  if (message.error) return `hc refused hello: ${typeof message.error.message === "string" ? message.error.message : "no reason given"}`;
  const result = message.result;
  if (result?.generation !== HC_GENERATION) return `hc speaks protocol generation ${String(result?.generation)}; Ovis speaks ${HC_GENERATION}`;
  if (result.framed !== true) return "hc did not switch the connection to framed mode";
  if (typeof result.version !== "string" || typeof result.core?.id !== "string" || typeof result.core.name !== "string") return "hc's hello is missing its version or core";
  return { version: result.version, core: { id: result.core.id, name: result.core.name } };
}
