/**
 * The fleet link's addition to the relay mux (docs/fleet-link.md): the `machine-key` AUTH scheme, the AUTH_OK a
 * machine gets, and the check of a machine's sign-in. It registers through the neutral MuxExtension hook of
 * shared/relay-mux.ts, so nothing of the fleet's wire contract is in shared/ or src/. Of the types 0x40-0x4f it reads
 * the five pipe frames of section 2 (0x40-0x44), ENROLL and ENROLL_OK of section 4 (0x45, 0x46) and FLEET_STATE (0x48,
 * todo 31), only on a session that selected `pipe-stream` (pipeMuxExtension), and PACE (0x47, todo 37), which the
 * controller writes and a machine reads: the controller's session refuses one a machine sends (server/relay/session.ts).
 * Every other type stays a protocol error.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { ExtensionStream, MuxStreamError } from "../../shared/relay-mux-engine.ts";
import type { MuxEngine } from "../../shared/relay-mux-engine.ts";
import { ENVELOPE_BYTES, FrameType, isDirectCarrier, MAX_FRAME_BYTES, MuxProtocolError, parseMetadata } from "../../shared/relay-mux.ts";
import type { ExtensionFrame, MuxExtension, SessionError, StreamError } from "../../shared/relay-mux.ts";
import { MAX_MACHINE_CARRIERS } from "./direct.ts";

/** The HELLO feature a machine offers and requires (docs/fleet-link.md section 1.3). */
export const PIPE_STREAM = "pipe-stream";
export const MACHINE_KEY = "machine-key";
/**
 * Features only a device offers: a HELLO that offers one of them beside PIPE_STREAM is a protocol error, since a
 * machine is never a device (section 1.3).
 */
const DEVICE_FEATURES: readonly string[] = [
  "pair-sas", "pair-intent-pc", "pair-intent-account", "pair-intent-pc-vouched", "account", "large-ws-messages",
  "server-time-header", "relay-hints", "direct-carrier", "direct-tailnet",
];
const AUTH_DOMAIN = "ovis-fleet-auth/1";
const MAX_INTEGER = Number.MAX_SAFE_INTEGER;

/** The pipe frames of docs/fleet-link.md section 2. */
export const PipeFrame = { OPEN: 0x40, ACCEPT: 0x41, DATA: 0x42, END: 0x43, ADVERT: 0x44 } as const;
/** The enrolment frames of section 4: session frames, on stream 0. */
export const EnrollFrame = { ENROLL: 0x45, ENROLL_OK: 0x46 } as const;
/** PACE (section 1.6 and todo 37): controller to machine only, on stream 0; a machine that sends one breaks the session. */
export const PACE_FRAME = 0x47;
/** FLEET_STATE (section 1.7): the controller's witness generation and its tag, controller to machine only. */
export const FLEET_STATE = 0x48;
export interface FleetState { readonly generation: number; readonly tag: string }
/** The AUTH feature of a machine that reads FLEET_STATE (todo 31): the controller sends it only then. */
export const FLEET_STATE_FEATURE = "fleet_state";
/** Pipes open at once on one machine session, named in WELCOME (section 1.2). */
export const MAX_PIPE_STREAMS = 16;
/** Each direction's window: 16 pipes reserve 12 MiB, the engine's receive reservation (Limits, decision 20). */
export const PIPE_WINDOW_BYTES = 768 * 1024;
export const PIPE_DATA_BYTES = MAX_FRAME_BYTES - ENVELOPE_BYTES;
/** The RESET codes a pipe takes (section 2); any other is a protocol error. */
export const PIPE_RESET_CODES = ["refused", "internal_error", "upstream_lost", "slow_consumer", "cancelled"] as const satisfies readonly StreamError[];
export type PipeResetCode = typeof PIPE_RESET_CODES[number];
const PIPE_ENDPOINTS: readonly string[] = ["bridge", "native"];
const METADATA_FRAME_BYTES = 1024;
export const PIPE_ADVERT_BYTES = 4096;
/**
 * Outgoing bytes one pipe queues at most: 16 pipes stay within the engine's 3 MiB for streams other than a terminal's,
 * so a pipe's write waits for room and is never refused (a pipe has no `resource_exhausted` RESET).
 */
const PIPE_QUEUE_BYTES = 192 * 1024;

export interface RelayPace {
  readonly generation: number; readonly per_minute: number; readonly burst: number; readonly slot: number;
  readonly span: number; readonly controller_ms: number; readonly rtt_ms: number;
}
/**
 * What a machine's agent can read, announced in AUTH's `features` (todo 37; todo 31 adds `fleet_state`): the controller
 * sends a frame a feature names only to a session that announced it. Unknown names are ignored; absent means none.
 */
export const PACE_FEATURE = "pace";
/**
 * GOAWAY's `reason` when the owner confirmed a pending machine (todo 37): only that GOAWAY carries it, so the agent dials
 * the relay at once after it, and after no other (a controller's shutdown sends none). An older agent ignores the key.
 */
export const GOAWAY_CONFIRMED = "confirmed";
const MAX_AUTH_FEATURES = 16;
export interface MachineAuth {
  readonly scheme: typeof MACHINE_KEY;
  readonly machine_id: string;
  readonly signature: string;
  /** The agent's features (`pace`: it reads PACE frames), as sent; absent from an agent older than todo 37. */
  readonly features?: readonly string[];
  /** Read and kept as it came; checked against the controller's witness by todo 31. */
  readonly seen_state?: { readonly generation: number; readonly tag: string };
}
export interface MachineAuthOk {
  readonly session_id: string;
  readonly machine_id: string;
  readonly role: "machine";
  /** Filled by todo 37. */
  readonly relay_pace?: RelayPace;
  /** The controller's direct carriers for this machine (todo 29): 1..4 distinct `ws://<private or Tailscale IPv4>:<port>`. */
  readonly direct?: readonly string[];
  /**
   * The machine is `pending` (todo 30): signed in, but no pipe opens to it until the owner confirms its batch. Only
   * `true` is ever written; a reader that does not know the field reads the machine as not pending.
   */
  readonly pending?: true;
}

/** The refusal causes of docs/fleet-link.md section 1 a sign-in can end with here. */
export type MachineCause = "signature" | "unknown" | "expired" | "rate_limited" | "wrong_scheme" | "revoked" | "quarantined" | "controller_limit" | "restored" | "fleet_token_required";

/** ENROLL (section 4): the invite, the new machine key's SPKI DER, the invite key's signature and the machine's clock. */
export interface Enroll { readonly invite_id: string; readonly machine_public_key: string; readonly signature: string; readonly now: number }
export interface EnrollOk { readonly machine_id: string }
export type MachineState = "pending" | "active" | "quarantined" | "revoked";
export interface MachineRecord {
  readonly machine_id: string;
  /** SubjectPublicKeyInfo DER of the machine's P-256 key, base64url. */
  readonly public_key: string;
  readonly state: MachineState;
}
/** What a machine session reads of the fleet store (todo 25 owns the store). */
export interface FleetDirectory {
  machines(): readonly MachineRecord[];
  /** Calls `change` after any record changes; returns the unsubscribe. */
  onChange(change: () => void): () => void;
  /** Whether the fleet is held for want of a token (server/fleet/gate.ts): every sign-in then ends `fleet_token_required`. */
  held?(): boolean;
}

function refuse(condition: unknown, message: string): asserts condition {
  if (!condition) throw new MuxProtocolError("protocol_error", message);
}
function hex(value: unknown, length: number): string {
  refuse(typeof value === "string" && value.length === length && /^[0-9a-f]+$/.test(value), "Invalid hex identifier");
  return value;
}
/** Canonical base64url of exactly `bytes` bytes, as shared/relay-mux.ts reads it. */
function base64url(value: unknown, bytes: number): string {
  refuse(typeof value === "string" && value.length === Math.ceil(bytes * 4 / 3) && /^[A-Za-z0-9_-]+$/.test(value), "Invalid base64url length or alphabet");
  refuse(Buffer.from(value, "base64url").toString("base64url") === value, "Noncanonical base64url");
  return value;
}
function integer(value: unknown, min: number, max: number): number {
  refuse(typeof value === "number" && Number.isInteger(value) && value >= min && value <= max, "Invalid integer");
  return value;
}
function object(value: unknown): { readonly [key: string]: unknown } {
  refuse(typeof value === "object" && value !== null && !Array.isArray(value), "Expected metadata object");
  return value as { readonly [key: string]: unknown };
}

function machineAuth(input: { readonly [key: string]: unknown }): MachineAuth | undefined {
  if (input.scheme !== MACHINE_KEY) return;
  const seen = input.seen_state === undefined ? undefined : object(input.seen_state);
  return {
    scheme: MACHINE_KEY, machine_id: hex(input.machine_id, 32), signature: base64url(input.signature, 64),
    ...(input.features === undefined ? {} : { features: authFeatures(input.features) }),
    ...(seen ? { seen_state: { generation: integer(seen.generation, 0, MAX_INTEGER), tag: base64url(seen.tag, 32) } } : {}),
  };
}
/** AUTH's `features`: at most 16 distinct names of 1 to 32 bytes of a-z, 0-9, `-` and `_` (todo 31's `fleet_state`), as given. */
function authFeatures(value: unknown): string[] {
  refuse(Array.isArray(value) && value.length <= MAX_AUTH_FEATURES, "Invalid features");
  const list = value as unknown[];
  refuse(list.every((name) => typeof name === "string" && /^[a-z0-9_-]{1,32}$/.test(name)) && new Set(list).size === list.length, "Invalid features");
  return list as string[];
}
/** A `relay_pace` or PACE payload in field-table order; throws protocol_error for a field out of its range. */
export function readRelayPace(value: unknown): RelayPace {
  const v = object(value);
  const span = integer(v.span, 1, 4096);
  const perMinute = integer(v.per_minute, 1, 600);
  // a cycle (span * 60000 / per_minute ms) of a minute at least: one relay dial a minute per machine at most (todo 37 (d))
  refuse(span >= perMinute, "Pace cycle under a minute");
  return {
    generation: integer(v.generation, 0, MAX_INTEGER), per_minute: perMinute, burst: integer(v.burst, 0, 600),
    slot: integer(v.slot, 0, span - 1), span, controller_ms: integer(v.controller_ms, 0, MAX_INTEGER), rtt_ms: integer(v.rtt_ms, 0, 60_000),
  };
}
function token(value: unknown, pattern: RegExp): string {
  refuse(typeof value === "string" && pattern.test(value), "Invalid value");
  return value;
}
const endpointName = (value: unknown) => token(value, /^[a-z0-9-]{1,32}$/);
const upDown = (value: unknown) => token(value, /^(?:up|down)$/) as "up" | "down";
const versionText = (value: unknown) => token(value, /^[0-9A-Za-z.+-]{1,64}$/);
const runtimeText = (value: unknown) => token(value, /^[A-Za-z0-9._:-]{1,64}$/);

/** PIPE_ADVERT (section 1.8): what the controller may open on this machine, with the secrets each endpoint needs. */
export interface PipeAdvert {
  readonly endpoints: readonly ("bridge" | "native")[];
  readonly runtime_id: string;
  readonly boot_id: string;
  readonly bridge_token?: string;
  readonly native_bearer?: string;
  readonly health: { readonly runtime: "up" | "down"; readonly bridge: "up" | "down" };
  readonly now: number;
  readonly versions: { readonly server: string; readonly link: string; readonly agent: string; readonly runtime: string };
}
/** The advert in field-table order, its canonical form; unknown keys are dropped. */
function pipeAdvert(v: { readonly [key: string]: unknown }): PipeAdvert {
  refuse(Array.isArray(v.endpoints) && v.endpoints.length >= 1 && v.endpoints.length <= 2, "Invalid endpoints");
  const endpoints = v.endpoints.map((endpoint) => token(endpoint, /^(?:bridge|native)$/) as "bridge" | "native");
  refuse(new Set(endpoints).size === endpoints.length, "Duplicate endpoint");
  const bridge = endpoints.includes("bridge");
  const native = endpoints.includes("native");
  refuse(bridge === (v.bridge_token !== undefined) && native === (v.native_bearer !== undefined), "Secret without its endpoint");
  const health = object(v.health);
  const versions = object(v.versions);
  return {
    endpoints, runtime_id: runtimeText(v.runtime_id), boot_id: runtimeText(v.boot_id),
    ...(bridge ? { bridge_token: hex(v.bridge_token, 64) } : {}),
    ...(native ? { native_bearer: token(v.native_bearer, /^[\x21-\x7e]{1,512}$/) } : {}),
    health: { runtime: upDown(health.runtime), bridge: upDown(health.bridge) },
    now: integer(v.now, 0, MAX_INTEGER),
    versions: { server: versionText(versions.server), link: versionText(versions.link), agent: versionText(versions.agent), runtime: versionText(versions.runtime) },
  };
}
/**
 * A pipe frame's payload (section 2 and the Fields table): `{endpoint}` for PIPE_OPEN, `{}` for PIPE_ACCEPT and
 * PIPE_END, the raw bytes for PIPE_DATA, the advert for PIPE_ADVERT; undefined for any other type.
 */
function pipeFrame(type: number, flags: number, streamId: number, payload: Uint8Array): unknown {
  const size = ENVELOPE_BYTES + payload.byteLength;
  if (type === PACE_FRAME) {
    refuse(flags === 0 && streamId === 0, "Session frame needs stream zero");
    refuse(size <= METADATA_FRAME_BYTES, "Invalid frame length");
    return readRelayPace(object(parseMetadata(payload)));
  }
  if (type < PipeFrame.OPEN || (type > EnrollFrame.ENROLL_OK && type !== FLEET_STATE)) return undefined;
  refuse(flags === 0, "Reserved flags");
  if (type === FLEET_STATE) {
    refuse(streamId === 0, "Session frame needs stream zero");
    refuse(size <= METADATA_FRAME_BYTES, "Invalid frame length");
    return fleetState(object(parseMetadata(payload)));
  }
  if (type === EnrollFrame.ENROLL || type === EnrollFrame.ENROLL_OK) {
    refuse(streamId === 0, "Session frame needs stream zero");
    refuse(size <= METADATA_FRAME_BYTES, "Invalid frame length");
    const v = object(parseMetadata(payload));
    return type === EnrollFrame.ENROLL ? enroll(v) : enrollOk(v);
  }
  if (type === PipeFrame.ADVERT) {
    refuse(streamId === 0, "Session frame needs stream zero");
    refuse(size <= PIPE_ADVERT_BYTES, "Invalid frame length");
    return pipeAdvert(object(parseMetadata(payload)));
  }
  refuse(streamId >= 2 && streamId <= 0x7ffffffe && streamId % 2 === 0, "Reserved stream id");
  switch (type) {
    case PipeFrame.OPEN:
      refuse(size <= METADATA_FRAME_BYTES, "Invalid frame length");
      return { endpoint: endpointName(object(parseMetadata(payload)).endpoint) };
    case PipeFrame.DATA:
      refuse(payload.byteLength > 0, "Empty DATA forbidden");
      return payload;
    default:
      refuse(payload.byteLength === 0, "Expected empty payload");
      return {};
  }
}

function enroll(v: { readonly [key: string]: unknown }): Enroll {
  return { invite_id: hex(v.invite_id, 16), machine_public_key: base64url(v.machine_public_key, 91), signature: base64url(v.signature, 64), now: integer(v.now, 0, MAX_INTEGER) };
}
function enrollOk(v: { readonly [key: string]: unknown }): EnrollOk {
  return { machine_id: hex(v.machine_id, 32) };
}
function fleetState(v: { readonly [key: string]: unknown }): FleetState {
  return { generation: integer(v.generation, 0, MAX_INTEGER), tag: base64url(v.tag, 32) };
}

function machineAuthOk(input: { readonly [key: string]: unknown }): MachineAuthOk | undefined {
  if (input.role !== "machine") return;
  return {
    session_id: hex(input.session_id, 32), machine_id: hex(input.machine_id, 32), role: "machine",
    ...(input.relay_pace === undefined ? {} : { relay_pace: readRelayPace(input.relay_pace) }),
    ...(input.direct === undefined ? {} : { direct: carriers(input.direct) }),
    ...(input.pending === undefined ? {} : { pending: pendingFlag(input.pending) }),
  };
}

function pendingFlag(value: unknown): true {
  refuse(value === true, "Invalid pending");
  return true;
}

function carriers(value: unknown): string[] {
  refuse(Array.isArray(value) && value.length >= 1 && value.length <= MAX_MACHINE_CARRIERS, "Invalid direct carriers");
  const list = value.map((carrier) => token(carrier, /^ws:\/\//));
  refuse(list.every(isDirectCarrier) && new Set(list).size === list.length, "Invalid direct carriers");
  return list;
}

function encodeFleetFrame(frame: ExtensionFrame): Uint8Array {
  if (frame.type === PipeFrame.DATA) {
    refuse(frame.payload instanceof Uint8Array, "Invalid DATA");
    return frame.payload;
  }
  if (frame.type === PipeFrame.ACCEPT || frame.type === PipeFrame.END) return new Uint8Array(0);
  const input = object(frame.payload);
  // the canonical form (docs/fleet-link.md, "Canonical encoding"): read back in field-table order
  const payload = frame.type === FrameType.AUTH ? machineAuth(input) : frame.type === FrameType.AUTH_OK ? machineAuthOk(input)
    : frame.type === PipeFrame.OPEN ? { endpoint: endpointName(input.endpoint) } : frame.type === PipeFrame.ADVERT ? pipeAdvert(input)
    : frame.type === EnrollFrame.ENROLL ? enroll(input) : frame.type === EnrollFrame.ENROLL_OK ? enrollOk(input)
    : frame.type === PACE_FRAME ? readRelayPace(input) : frame.type === FLEET_STATE ? fleetState(input) : undefined;
  refuse(payload !== undefined, "Not a fleet frame");
  return new TextEncoder().encode(JSON.stringify(payload));
}

/** A fleet controller's sessions before HELLO is read, and every session that did not select `pipe-stream`: sign-in only. */
export const fleetMuxExtension: MuxExtension = {
  metadata: (type, input) => type === FrameType.AUTH ? machineAuth(input) : type === FrameType.AUTH_OK ? machineAuthOk(input) : undefined,
  encode: encodeFleetFrame,
  limits: { max_pipe_streams: MAX_PIPE_STREAMS },
};
/** A machine session (`pipe-stream` selected): the sign-in, the pipe frames and the pipes as the engine's streams. */
export const pipeMuxExtension: MuxExtension = {
  ...fleetMuxExtension,
  frame: pipeFrame,
  streams: { open: PipeFrame.OPEN, data: PipeFrame.DATA, resets: PIPE_RESET_CODES },
};

export const machineAuthFrame = (payload: MachineAuth): ExtensionFrame => ({ extension: true, type: FrameType.AUTH, flags: 0, stream_id: 0, payload });
export const machineAuthOkFrame = (payload: MachineAuthOk): ExtensionFrame => ({ extension: true, type: FrameType.AUTH_OK, flags: 0, stream_id: 0, payload });
export const enrollFrame = (payload: Enroll): ExtensionFrame => ({ extension: true, type: EnrollFrame.ENROLL, flags: 0, stream_id: 0, payload });
export const enrollOkFrame = (payload: EnrollOk): ExtensionFrame => ({ extension: true, type: EnrollFrame.ENROLL_OK, flags: 0, stream_id: 0, payload });
export const fleetStateFrame = (payload: FleetState): ExtensionFrame => ({ extension: true, type: FLEET_STATE, flags: 0, stream_id: 0, payload });
export const paceFrame = (payload: RelayPace): ExtensionFrame => ({ extension: true, type: PACE_FRAME, flags: 0, stream_id: 0, payload });
/** The machine AUTH this extension read from `frame`, or undefined for any other frame. */
export function asMachineAuth(frame: ExtensionFrame): MachineAuth | undefined {
  if (frame.type !== FrameType.AUTH) return;
  try { return machineAuth(object(frame.payload)); } catch { return; }
}

/** What a HELLO asks for: a device session, a machine session, or the error that ends it (section 1.3). */
export function helloKind(features: readonly string[], required: readonly string[]): "device" | "machine" | SessionError {
  if (!features.includes(PIPE_STREAM)) return "device";
  if (features.some((feature) => DEVICE_FEATURES.includes(feature))) return "protocol_error";
  // a machine offers and requires it: offered alone it asks for neither a machine nor a device session (decision 22)
  if (!required.includes(PIPE_STREAM)) return "protocol_error";
  if (required.some((feature) => feature !== PIPE_STREAM)) return "unsupported_extension";
  return "machine";
}

const pipeFrameOf = (type: number, streamId: number, payload: unknown): ExtensionFrame => ({ extension: true, type, flags: 0, stream_id: streamId, payload });

/**
 * One pipe (section 2) on either end: the controller opens it (openPipe), the machine takes it (acceptPipe) and
 * answers with `accept()` or a RESET. Bytes in arrive on `readable`, credited only as they are read; bytes out go
 * with `write`, which waits while the window or the pipe's queue is full and resolves once its last byte is sent.
 * `end()` half-closes this end's direction; the pipe retires when both ends have ended and every byte was read,
 * or at a RESET. A carrier loss resets it `upstream_lost`.
 */
export class PipeStream extends ExtensionStream {
  readonly readable: ReadableStream<Uint8Array>;
  /** The machine answered PIPE_ACCEPT (on the controller). */
  onAccept: (() => void) | undefined;
  private readonly chunks: Uint8Array[] = [];
  private controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  private readPending: (() => void) | undefined;
  private readClosed = false;
  private writing: Promise<void> | undefined;
  private endQueued = false;
  private readonly waiting: (() => void)[] = [];
  private error: StreamError | undefined;

  constructor(engine: MuxEngine, readonly endpoint: string) {
    super(engine, PIPE_WINDOW_BYTES);
    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => { this.controller = controller; },
      pull: () => new Promise<void>((resolve) => { this.readPending = resolve; this.deliver(); }),
      cancel: () => { this.readClosed = true; this.reset("cancelled"); },
    }, { highWaterMark: 0 });
  }
  /** On the machine: answers the open; both windows open as PIPE_ACCEPT goes out. */
  accept(): void {
    refuse(this.engine.options.role === "client" && !this.accepted, "Invalid PIPE_ACCEPT");
    if (!this.live) return;
    this.accepted = true;
    this.sendWindow = PIPE_WINDOW_BYTES;
    this.engine.enqueue(this, pipeFrameOf(PipeFrame.ACCEPT, this.id ?? 2, {}), () => { this.receiveWindow = PIPE_WINDOW_BYTES; });
  }
  override reset(code: PipeResetCode = "cancelled"): void { this.engine.reset(this, code); }
  /** One write at a time: a second while one is pending is refused, so what a pipe holds stays bounded. */
  write(bytes: Uint8Array): Promise<void> {
    if (this.writing) return Promise.reject(new Error("A pipe write is already pending"));
    const writing = this.send(bytes).finally(() => { if (this.writing === writing) this.writing = undefined; });
    this.writing = writing;
    return writing;
  }
  private async send(bytes: Uint8Array): Promise<void> {
    if (!this.live || this.endQueued) throw new MuxStreamError(this.error ?? "cancelled");
    const sent = Promise.withResolvers<void>();
    if (!bytes.length) sent.resolve();
    for (let offset = 0; offset < bytes.length; offset += PIPE_DATA_BYTES) {
      const data = bytes.subarray(offset, offset + PIPE_DATA_BYTES);
      // no busy loop: woken by this pipe's next frame going out, or by its end
      while (this.live && this.queuedBytes + data.length > PIPE_QUEUE_BYTES) await new Promise<void>((resolve) => { this.waiting.push(resolve); });
      if (!this.live) { sent.reject(new MuxStreamError(this.error ?? "cancelled")); break; }
      const last = offset + data.length === bytes.length;
      this.engine.enqueue(this, pipeFrameOf(PipeFrame.DATA, this.id ?? 2, data), () => { this.wake(); if (last) sent.resolve(); }, (error) => sent.reject(error));
    }
    return sent.promise;
  }
  private wake(): void { for (const resolve of this.waiting.splice(0)) resolve(); }
  /** Half-closes this direction after any pending write. */
  async end(): Promise<void> {
    await this.writing?.catch(() => undefined);
    if (!this.live || this.endQueued) return;
    this.endQueued = true;
    this.engine.enqueue(this, pipeFrameOf(PipeFrame.END, this.id ?? 2, {}), () => { this.endedOut = true; this.engine.retire(this); });
  }
  receive(frame: ExtensionFrame): void {
    switch (frame.type) {
      case PipeFrame.ACCEPT:
        refuse(this.engine.options.role === "server" && !this.accepted, "Unexpected PIPE_ACCEPT");
        this.accepted = true;
        this.sendWindow = this.receiveWindow = PIPE_WINDOW_BYTES;
        this.onAccept?.();
        return;
      case PipeFrame.DATA: {
        // the engine checked the pipe's state and credit
        const data = (frame.payload as Uint8Array).slice();
        this.chunks.push(data);
        this.inboundBytes += data.length;
        this.deliver();
        return;
      }
      case PipeFrame.END:
        refuse(this.accepted && !this.endedIn, "Unexpected PIPE_END");
        this.endedIn = true;
        this.deliver();
        return;
      default: refuse(false, "Unexpected pipe frame");
    }
  }
  private deliver(): void {
    const chunk = this.readPending ? this.chunks.shift() : undefined;
    if (chunk) {
      this.inboundBytes -= chunk.length;
      this.controller?.enqueue(chunk);
      this.engine.consume(this, chunk.length);
      this.readPending?.();
      this.readPending = undefined;
    }
    if (this.endedIn && !this.chunks.length && !this.readClosed) {
      this.readClosed = true;
      this.controller?.close();
      this.readPending?.();
      this.readPending = undefined;
      this.engine.retire(this);
    }
  }
  fail(error: MuxStreamError): void {
    this.error = error.code;
    this.chunks.length = 0;
    this.inboundBytes = 0;
    if (!this.readClosed) this.controller?.error(error);
    this.readClosed = true;
    this.readPending?.();
    this.readPending = undefined;
    this.wake();
  }
}

/**
 * On the controller: opens a pipe to the machine's `endpoint` on the next even id. Throws MuxStreamError `refused`
 * when MAX_PIPE_STREAMS pipes are open or the window cannot be reserved, and MuxProtocolError on a session that is
 * not a signed-in machine session of this controller.
 */
export function openPipe(engine: MuxEngine, endpoint: string): PipeStream {
  endpointName(endpoint);
  if (engine.stats.streams >= MAX_PIPE_STREAMS) throw new MuxStreamError("refused");
  const stream = new PipeStream(engine, endpoint);
  engine.openExtension(stream, pipeFrameOf(PipeFrame.OPEN, 2, { endpoint }));
  return stream;
}

/**
 * On a machine, inside onExtension: takes the PIPE_OPEN `frame` as a pipe, not yet answered. Undefined leaves the
 * engine to answer RESET `refused`: an endpoint that is not one of `endpoints` (the latest advert's), or
 * MAX_PIPE_STREAMS pipes already open.
 */
export function acceptPipe(engine: MuxEngine, frame: ExtensionFrame, endpoints: readonly string[]): PipeStream | undefined {
  if (frame.type !== PipeFrame.OPEN) return undefined;
  const { endpoint } = frame.payload as { readonly endpoint: string };
  if (!PIPE_ENDPOINTS.includes(endpoint) || !endpoints.includes(endpoint) || engine.stats.streams >= MAX_PIPE_STREAMS) return undefined;
  const stream = new PipeStream(engine, endpoint);
  return engine.admitExtension(stream) ? stream : undefined;
}

/** The key's fingerprint: the first 16 bytes of SHA-256 over its SPKI DER, as hex (section 1.5). */
export const machineFingerprint = (spki: Uint8Array): string => createHash("sha256").update(spki).digest("hex").slice(0, 32);

/** The 113 signed bytes: domain, WELCOME nonce, controller server_id as ASCII hex, channel binding. */
export function machineAuthMessage(nonce: Uint8Array, serverId: string, binding: Uint8Array): Uint8Array {
  return Buffer.concat([Buffer.from(AUTH_DOMAIN), nonce, Buffer.from(serverId), binding]);
}

const same = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};
/**
 * The record of `machineId`, compared in constant time over every record (as server/devices.ts compares tokens), and
 * only when its key's fingerprint is that id: a record under another key's id counts as unknown.
 */
function recordOf(directory: FleetDirectory, machineId: string): MachineRecord | undefined {
  let found: MachineRecord | undefined;
  for (const record of directory.machines()) if (same(record.machine_id, machineId) && !found) found = record;
  if (!found || !same(machineFingerprint(Buffer.from(found.public_key, "base64url")), machineId)) return;
  return found;
}
/** Why `record` may not be signed in now, or undefined when it may (a pending machine signs in; todo 30 holds its pipes). */
const stateRefusal = (record: MachineRecord): "revoked" | "quarantined" | undefined =>
  record.state === "revoked" ? "revoked" : record.state === "quarantined" ? "quarantined" : undefined;

export type MachineSignIn = { readonly machineId: string } | { readonly code: "auth_failed" | "auth_revoked"; readonly cause: MachineCause };

/**
 * Checks a machine-key AUTH (section 1.5): the id is a machine of the store, the signature holds under its key over
 * this session's nonce, this controller's server_id and this channel's binding, and the machine is neither revoked nor
 * quarantined. The state is read again after WebCrypto, so a change during the check is not missed.
 */
export async function verifyMachineAuth(directory: FleetDirectory, auth: MachineAuth,
  session: { readonly nonce: Uint8Array; readonly serverId: string; readonly binding: Uint8Array | undefined }): Promise<MachineSignIn> {
  const record = recordOf(directory, auth.machine_id);
  if (!record) return { code: "auth_failed", cause: "unknown" };
  const signature = Buffer.from(auth.signature, "base64url");
  if (!session.binding || session.binding.length !== 32 || session.nonce.length !== 32 || signature.length !== 64) return { code: "auth_failed", cause: "signature" };
  let verified = false;
  try {
    const key = await crypto.subtle.importKey("spki", Buffer.from(record.public_key, "base64url"), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    verified = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature, new Uint8Array(machineAuthMessage(session.nonce, session.serverId, session.binding)));
  } catch (error) {
    if (!(error instanceof DOMException)) throw error;
  }
  if (!verified) return { code: "auth_failed", cause: "signature" };
  const current = recordOf(directory, auth.machine_id);
  if (!current || current.public_key !== record.public_key) return { code: "auth_revoked", cause: "revoked" };
  const refused = stateRefusal(current);
  return refused ? { code: "auth_revoked", cause: refused } : { machineId: current.machine_id };
}

/** Why a signed-in machine must leave now: its record is gone, its key replaced, or its state refused. */
export function machineRevoked(directory: FleetDirectory, machineId: string, publicKey: string): "revoked" | "quarantined" | undefined {
  const record = recordOf(directory, machineId);
  if (!record || record.public_key !== publicKey) return "revoked";
  return stateRefusal(record);
}
