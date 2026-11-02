/**
 * The frames of a live voice call between a Pi pane and the phone, relayed by this server over
 * `/ws/pi-voice`: one JSON object per WebSocket message, every one carrying `v`.
 *
 * Pi (pi-better-openai's src/live/bridge/protocol.ts and src/live/remote/protocol.ts) sends the
 * phone the requests it makes of its audio device and the state of the call; the phone answers
 * and may ask to stop, mute or resume a parked call. This copy of the shapes is the contract on this side: the shared
 * `v` catches drift, unknown frames and fields are refused, and there is no field for a
 * credential or for audio (the audio goes from the phone to OpenAI, not through here).
 */

export const PI_VOICE_PATH = "/ws/pi-voice";
export const PI_VOICE_STATUS_PATH = "/api/pane/pi-voice";
export const PI_VOICE_VERSION = 1;
export const MAX_PI_VOICE_FRAME_BYTES = 1_048_576;

/** `parked`: the call is still there but its voice session sleeps while a long task runs; it comes back on its own or on `resume`. */
export type PiVoicePhase = "standby" | "connecting" | "listening" | "working" | "speaking" | "muted" | "error" | "parked";

/** What a phone tells Pi it can take, in `hello`: Pi sends `park` and `usage` only to a phone that listed them. */
export const PI_VOICE_FEATURES = ["park", "usage"] as const;

/** Why this server, not Pi, ended a call. */
export type PiVoiceEndCode = "not_pi" | "unavailable" | "busy" | "closed";

export type PiVoiceRequest =
  | { type: "request"; id: number; method: "open" | "createOffer" }
  | { type: "request"; id: number; method: "acceptAnswer"; sdp: string }
  | { type: "request"; id: number; method: "waitForOpen"; timeoutMs?: number };

export type PiReady = { type: "ready"; pid: number; pane?: string; busy: boolean };

/** What Pi may send the phone. */
export type PiToPhoneFrame =
  | PiVoiceRequest
  | { type: "activate" }
  | { type: "mute"; muted: boolean }
  | { type: "ping" }
  | { type: "close" }
  /** closes the peer connection and data channel, keeps the microphone, the speaker and this connection; only to a phone with the `park` feature */
  | { type: "park" }
  /** the call's billed connected seconds so far; only to a phone with the `usage` feature */
  | { type: "usage"; seconds: number }
  | { type: "phase"; phase: PiVoicePhase }
  | { type: "transcript"; role: "user" | "assistant"; text: string; turn: number; final: boolean }
  | { type: "transcript-clear" }
  | { type: "ended"; error?: string; code?: PiVoiceEndCode };

/** What the phone may send Pi. The relay sends `start` itself, so the phone cannot. */
export type PhoneToPiFrame =
  | { type: "hello"; features?: string[] }
  | { type: "response"; id: number; ok: true; sdp?: string }
  | { type: "response"; id: number; ok: false; error: string }
  | { type: "event"; payload: string }
  | { type: "levels"; input: number; output: number }
  | { type: "failure"; message: string }
  | { type: "stop" }
  | { type: "set-muted"; muted: boolean }
  /** asks Pi to reconnect a parked call now */
  | { type: "resume" };

/** The voices a live call can speak in: Pi's `LIVE_VOICE_OPTIONS` (src/live/voices.ts). */
export const PI_VOICES = ["arbor", "breeze", "cove", "ember", "juniper", "maple", "sol", "spruce", "vale"] as const;
export type PiVoice = (typeof PI_VOICES)[number];

export function isPiVoice(value: unknown): value is PiVoice {
  return typeof value === "string" && (PI_VOICES as readonly string[]).includes(value);
}

/** The relay's own frame to Pi, once it holds the connection: the voice the phone chose, if any. */
export type RelayToPiFrame = { type: "start"; voice?: PiVoice };

export type PiVoiceStatus = { available: boolean; busy: boolean };

export class PiVoiceProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiVoiceProtocolError";
  }
}

type Check = (value: unknown) => boolean;
type Shape = { required?: Record<string, Check>; optional?: Record<string, Check> };

const PHASES: ReadonlySet<unknown> = new Set<PiVoicePhase>(["standby", "connecting", "listening", "working", "speaking", "muted", "error", "parked"]);
const END_CODES: ReadonlySet<unknown> = new Set<PiVoiceEndCode>(["not_pi", "unavailable", "busy", "closed"]);
const MAX_TEXT = 1_048_576;
const MAX_MESSAGE = 2_048;
const MAX_TRANSCRIPT = 4_096;
const MAX_FEATURES = 8;
const MAX_FEATURE = 32;

const isBoolean: Check = (value) => typeof value === "boolean";
const isId: Check = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isText: Check = (value) => typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT;
const isMessage: Check = (value) => typeof value === "string" && value.length > 0 && value.length <= MAX_MESSAGE;
const isLevel: Check = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const isTimeout: Check = (value) => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 120_000;
const isTranscript: Check = (value) => typeof value === "string" && value.length <= MAX_TRANSCRIPT;
const isPid: Check = (value) => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const isPane: Check = (value) => typeof value === "string" && value.length > 0 && value.length <= 128;
const isRole: Check = (value) => value === "user" || value === "assistant";
const isSeconds: Check = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isFeatures: Check = (value) =>
  Array.isArray(value) && value.length <= MAX_FEATURES && value.every((item) => typeof item === "string" && item.length <= MAX_FEATURE);

const REQUESTS: Record<string, Shape> = {
  open: {},
  createOffer: {},
  acceptAnswer: { required: { sdp: isText } },
  waitForOpen: { optional: { timeoutMs: isTimeout } },
};

const PI_SHAPES: Record<string, Shape> = {
  ready: { required: { pid: isPid, busy: isBoolean }, optional: { pane: isPane } },
  activate: {},
  close: {},
  park: {},
  usage: { required: { seconds: isSeconds } },
  ping: {},
  mute: { required: { muted: isBoolean } },
  phase: { required: { phase: (value) => PHASES.has(value) } },
  transcript: { required: { role: isRole, text: isTranscript, turn: isId, final: isBoolean } },
  "transcript-clear": {},
  ended: { optional: { error: isMessage, code: (value) => END_CODES.has(value) } },
};

const PHONE_SHAPES: Record<string, Shape> = {
  hello: { optional: { features: isFeatures } },
  resume: {},
  event: { required: { payload: isText } },
  levels: { required: { input: isLevel, output: isLevel } },
  failure: { required: { message: isMessage } },
  stop: {},
  "set-muted": { required: { muted: isBoolean } },
};

const RESPONSE_SHAPES: Record<string, Shape> = {
  true: { optional: { sdp: isText } },
  false: { required: { error: isMessage } },
};

function parseObject(text: string): Record<string, unknown> {
  if (text.length > MAX_PI_VOICE_FRAME_BYTES) throw new PiVoiceProtocolError("frame too large");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new PiVoiceProtocolError("frame is not JSON"); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new PiVoiceProtocolError("frame is not an object");
  const frame = value as Record<string, unknown>;
  if (frame["v"] !== PI_VOICE_VERSION) throw new PiVoiceProtocolError("unsupported frame version");
  return frame;
}

function validate(frame: Record<string, unknown>, common: Record<string, Check>, shape: Shape | undefined): void {
  if (!shape) throw new PiVoiceProtocolError("unknown frame type");
  const fields = { ...common, ...shape.required, ...shape.optional };
  for (const key of Object.keys(frame)) {
    if (key !== "v" && key !== "type" && !Object.hasOwn(fields, key)) throw new PiVoiceProtocolError("unexpected field");
  }
  for (const [key, check] of Object.entries(fields)) {
    const present = Object.hasOwn(frame, key);
    const required = Object.hasOwn(common, key) || Object.hasOwn(shape.required ?? {}, key);
    if (present ? !check(frame[key]) : required) throw new PiVoiceProtocolError(`invalid ${key}`);
  }
}

function strip<T>(frame: Record<string, unknown>): T {
  const { v: _version, ...rest } = frame;
  return rest as T;
}

/** A frame Pi sent, or the `ready` it opens with. */
export function parsePiFrame(text: string): PiReady | PiToPhoneFrame {
  const frame = parseObject(text);
  const type = typeof frame["type"] === "string" ? frame["type"] : "";
  if (type === "request") {
    const method = typeof frame["method"] === "string" ? frame["method"] : "";
    validate(frame, { id: isId, method: (value) => value === method }, Object.hasOwn(REQUESTS, method) ? REQUESTS[method] : undefined);
  } else {
    validate(frame, {}, Object.hasOwn(PI_SHAPES, type) ? PI_SHAPES[type] : undefined);
  }
  return strip(frame);
}

/** A frame the phone sent. */
export function parsePhoneFrame(text: string): PhoneToPiFrame {
  const frame = parseObject(text);
  const type = typeof frame["type"] === "string" ? frame["type"] : "";
  if (type === "response") {
    const ok = typeof frame["ok"] === "boolean" ? String(frame["ok"]) : "";
    validate(frame, { id: isId, ok: isBoolean }, Object.hasOwn(RESPONSE_SHAPES, ok) ? RESPONSE_SHAPES[ok] : undefined);
  } else {
    validate(frame, {}, Object.hasOwn(PHONE_SHAPES, type) ? PHONE_SHAPES[type] : undefined);
  }
  return strip(frame);
}

export function encodePiVoiceFrame(frame: PhoneToPiFrame | PiToPhoneFrame | PiReady | RelayToPiFrame): string {
  return JSON.stringify({ v: PI_VOICE_VERSION, ...frame });
}
