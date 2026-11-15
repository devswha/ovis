/**
 * Writes the fleet link's shared test vectors, server/fleet/vectors/*.json (docs/fleet-link.md,
 * "Vector files"), from fixed inputs. `--check` builds them in memory and exits 1 when a file on
 * disk differs from what it builds.
 *
 * TEST-ONLY: every key, secret, nonce and token below is derived from a fixed label so the files are
 * byte-exact on every run. None of them may ever be used outside tests.
 *
 * Signatures are deterministic: ECDSA P-256 with RFC 6979 nonces (@noble/curves), Ed25519 by
 * definition. Each signature is also checked with WebCrypto before anything is written, so a vector
 * can only say "verifies" or "does not verify" when WebCrypto agrees.
 */
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { p256 } from "@noble/curves/nist.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_CARRIER_BINARY_BYTES, MAX_CARRIER_TEXT_BYTES, openClientSecureChannel } from "../shared/relay-e2ee.ts";
import type { Transport } from "../shared/relay-e2ee.ts";
import { decodeFrame, encodeExtensionFrame, encodeFrame, FrameType, LIMITS_V1, MAX_FRAME_BYTES } from "../shared/relay-mux.ts";
import type { MuxFrame } from "../shared/relay-mux.ts";
import { deriveServerId } from "../shared/relay-server-proof.ts";
import { CipherState, createNoiseInitiator, createNoiseResponder, NoiseProtocolError } from "../shared/vendor/paseo-e2ee/noise/index.ts";
import { decodeProtectedRecord, encodeProtectedRecord, MAX_CHUNK_DATA_BYTES } from "../shared/vendor/paseo-e2ee/protected-records.ts";
import type { FrameKind } from "../shared/vendor/paseo-e2ee/protected-records.ts";
import { paceFrame, pipeMuxExtension } from "../server/fleet/mux-ext.ts";
import type { RelayPace } from "../server/fleet/mux-ext.ts";
import { defaultPaceSlot, nextPaceInstant, relayPace } from "../server/fleet/relay-pace.ts";

const DIR = join(import.meta.dir, "..", "server", "fleet", "vectors");
const TEST_ONLY = "Every key, secret, nonce and token in this file is a fixed test value derived from a label by scripts/fleet-vectors.ts. Never use one outside tests.";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = { [key: string]: Json };
type Direction = "machine_to_controller" | "controller_to_machine" | "file";
interface Refuse { stage: "decode" | "verify" | "session"; kind: "session_error" | "reset" | "invalid_invite" | "invalid_file"; code: string; message?: string }
interface Case {
  name: string; frame: string; type: number | null; stream_id: number | null; direction: Direction;
  context: Obj; bytes: Uint8Array; parse?: Obj; refuse?: Refuse; effect?: string; limit?: string; canonical?: false;
}

const utf8 = (text: string) => new TextEncoder().encode(text);
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
};
const u64be = (value: number) => { const out = new Uint8Array(8); new DataView(out.buffer).setBigUint64(0, BigInt(value)); return out; };
const u32be = (value: number) => { const out = new Uint8Array(4); new DataView(out.buffer).setUint32(0, value); return out; };
/** A fixed 32-byte test value; the label says what it stands for. */
const label = (name: string) => sha256(utf8(`ovis-fleet-vectors/test-only/${name}`));
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`fleet-vectors: ${message}`);
}

/** The 8-byte mux envelope (shared/relay-mux.ts:519-526) and a payload. */
function frame(type: number, streamId: number, payload: Uint8Array, flags = 0): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  const view = new DataView(out.buffer);
  out[0] = 1; out[1] = type; view.setUint16(2, flags); view.setUint32(4, streamId);
  out.set(payload, 8);
  return out;
}
const json = (type: number, streamId: number, payload: Json) => frame(type, streamId, utf8(JSON.stringify(payload)));
/** A frame today's codec already reads: encoded by it, so these bytes are the real ones. */
function existing(value: MuxFrame): Uint8Array {
  const bytes = encodeFrame(value);
  decodeFrame(bytes);
  return bytes;
}

const T = {
  PIPE_OPEN: 0x40, PIPE_ACCEPT: 0x41, PIPE_DATA: 0x42, PIPE_END: 0x43,
  PIPE_ADVERT: 0x44, ENROLL: 0x45, ENROLL_OK: 0x46, PACE: 0x47, FLEET_STATE: 0x48,
} as const;
for (const type of Object.values(T)) assert(!(Object.values(FrameType) as number[]).includes(type), `type ${type} is in use`);

// ---- keys and sessions (TEST-ONLY) ----
const SPKI_PREFIX = Uint8Array.from([0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00]);
interface Machine { secret: Uint8Array; spki: Uint8Array; id: string }
function machine(name: string): Machine {
  const secret = label(`machine/${name}`);
  const spki = concat(SPKI_PREFIX, p256.getPublicKey(secret, false));
  return { secret, spki, id: fingerprint(spki) };
}
/** docs/fleet-link.md section 1: the first 16 bytes of SHA-256 over the SPKI DER, as hex. */
const fingerprint = (spki: Uint8Array) => hex(sha256(spki)).slice(0, 32);
interface Controller { publicKey: Uint8Array; serverId: string }
function controller(name: string): Controller {
  const publicKey = x25519.getPublicKey(label(`controller/${name}`));
  return { publicKey, serverId: deriveServerId(publicKey) };
}
/** shared/relay-e2ee.ts:72-85 */
const bindingOf = (serverPublicKey: Uint8Array, message1: Uint8Array, message2: Uint8Array) =>
  sha256(concat(utf8("ovis-relay-channel-binding/1"), serverPublicKey, u32be(message1.length), message1, u32be(message2.length), message2));
const session = (c: Controller, name: string) =>
  bindingOf(c.publicKey, concat(label(`session/${name}/1`), label(`session/${name}/1b`)), concat(label(`session/${name}/2`), label(`session/${name}/2b`)));

const CTRL = controller("main");
const ROTATED = controller("rotated");
const OTHER = controller("other");
const A = machine("a");
const B = machine("b");
const NONCE = label("welcome-nonce/1");
const NONCE_OTHER = label("welcome-nonce/2");
const S1 = session(CTRL, "1");
const S2 = session(CTRL, "2");
const SR = session(ROTATED, "1");
const WITNESS_KEY = label("witness-key");
const NOW_S = 1767225600;
/** docs/fleet-link.md, Limits: 16 pipes of 768 KiB fill the engine's 12 MiB receive reservation (owner decision 2026-11-12). */
const PIPE_WINDOW_BYTES = 768 * 1024;
const NOW_MS = NOW_S * 1000;

const authMessage = (nonce: Uint8Array, serverId: string, binding: Uint8Array) =>
  concat(utf8("ovis-fleet-auth/1"), nonce, utf8(serverId), binding);
const deviceMessage = (nonce: Uint8Array, serverId: string) => concat(utf8("ovis-relay-auth/1"), nonce, utf8(serverId));
const signP256 = (m: Machine, message: Uint8Array) => p256.sign(message, m.secret);
const stateTag = (key: Uint8Array, serverId: string, generation: number) => hmac(sha256, key, concat(utf8(serverId), u64be(generation)));

async function p256Holds(spki: Uint8Array, signature: Uint8Array, message: Uint8Array): Promise<boolean> {
  const key = await crypto.subtle.importKey("spki", new Uint8Array(spki), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, new Uint8Array(signature), new Uint8Array(message));
}
async function ed25519Holds(publicKey: Uint8Array, signature: Uint8Array, message: Uint8Array): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", new Uint8Array(publicKey), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, new Uint8Array(signature), new Uint8Array(message));
  } catch { return false; }
}

const before = (selected: string[] = ["pipe-stream"]): Obj => ({ state: "before_auth", selected });
const after = (extra: Obj = {}): Obj => ({ state: "after_auth", selected: ["pipe-stream"], ...extra });
const protocolError = (stage: Refuse["stage"] = "session"): Refuse => ({ stage, kind: "session_error", code: "protocol_error" });

async function authFile(): Promise<Obj> {
  const cases: Case[] = [];
  const hello = { protocol: "ovis-mux", versions: [1], features: ["pipe-stream"], required_features: ["pipe-stream"] } as const;
  const helloBytes = existing({ type: FrameType.HELLO, flags: 0, stream_id: 0, payload: hello });
  cases.push({ name: "auth/hello/machine", frame: "HELLO", type: 0x01, stream_id: 0, direction: "machine_to_controller", context: { state: "before_auth", selected: [] }, bytes: helloBytes, parse: { ...hello, versions: [1], features: ["pipe-stream"], required_features: ["pipe-stream"] }, effect: "the controller requires and keeps pipe-stream for this session" });
  const mixed = { protocol: "ovis-mux", versions: [1], features: ["pipe-stream", "pair-sas"], required_features: ["pipe-stream"] } as const;
  cases.push({ name: "auth/hello/machine-and-device-feature", frame: "HELLO", type: 0x01, stream_id: 0, direction: "machine_to_controller", context: { state: "before_auth", selected: [] }, bytes: existing({ type: FrameType.HELLO, flags: 0, stream_id: 0, payload: mixed }), parse: { protocol: "ovis-mux", versions: [1], features: ["pipe-stream", "pair-sas"], required_features: ["pipe-stream"] }, refuse: protocolError() });
  const offered = { protocol: "ovis-mux", versions: [1], features: ["pipe-stream"], required_features: [] } as const;
  cases.push({ name: "auth/hello/offered-not-required", frame: "HELLO", type: 0x01, stream_id: 0, direction: "machine_to_controller", context: { state: "before_auth", selected: [] }, bytes: existing({ type: FrameType.HELLO, flags: 0, stream_id: 0, payload: offered }), parse: { protocol: "ovis-mux", versions: [1], features: ["pipe-stream"], required_features: [] }, refuse: protocolError() });
  cases.push({ name: "auth/hello/controller-without-fleet", frame: "HELLO", type: 0x01, stream_id: 0, direction: "machine_to_controller", context: { state: "before_auth", selected: [], controller: "no fleet extension registered" }, bytes: helloBytes, parse: { protocol: "ovis-mux", versions: [1], features: ["pipe-stream"], required_features: ["pipe-stream"] }, refuse: { stage: "session", kind: "session_error", code: "unsupported_extension" } });

  const limits = { ...LIMITS_V1, max_pipe_streams: 16 };
  const welcome = { protocol: "ovis-mux", version: 1, features: [], limits, nonce: b64u(NONCE), server_version: "0.5.0", relay_protocol: 1, min_supported_client: "0.4.21" };
  const welcomeBytes = json(0x02, 0, welcome);
  decodeFrame(welcomeBytes);
  cases.push({ name: "auth/welcome/machine", frame: "WELCOME", type: 0x02, stream_id: 0, direction: "controller_to_machine", context: { state: "before_auth", selected: [] }, bytes: welcomeBytes, parse: welcome as unknown as Obj });

  const base: Obj = { nonce: b64u(NONCE), server_id: CTRL.serverId, binding_hex: hex(S1), machine_public_key: b64u(A.spki), store: { [A.id]: "active" } };
  const authBytes = (payload: Obj) => json(0x03, 0, payload);
  const auth = (machineId: string, signature: Uint8Array, extra: Obj = {}): Obj => ({ scheme: "machine-key", machine_id: machineId, signature: b64u(signature), ...extra });
  const good = signP256(A, authMessage(NONCE, CTRL.serverId, S1));
  assert(await p256Holds(A.spki, good, authMessage(NONCE, CTRL.serverId, S1)), "good AUTH signature");
  const signedNote = (message: Uint8Array) => ({ signed_hex: hex(message) });

  const accept = auth(A.id, good);
  cases.push({ name: "auth/machine-key/accept", frame: "AUTH", type: 0x03, stream_id: 0, direction: "machine_to_controller", context: { ...before(), ...base, ...signedNote(authMessage(NONCE, CTRL.serverId, S1)) }, bytes: authBytes(accept), parse: accept, effect: "AUTH_OK with role machine" });

  const seen = (generation: number, key = WITNESS_KEY) => ({ generation, tag: b64u(stateTag(key, CTRL.serverId, generation)) });
  const withSeen = auth(A.id, good, { seen_state: seen(7) });
  cases.push({ name: "auth/machine-key/seen-state", frame: "AUTH", type: 0x03, stream_id: 0, direction: "machine_to_controller", context: { ...before(), ...base, witness_key_hex: hex(WITNESS_KEY), store_generation: 7, tag_input_hex: hex(concat(utf8(CTRL.serverId), u64be(7))) }, bytes: authBytes(withSeen), parse: withSeen, effect: "seen_state verifies and is not above the store's generation: AUTH_OK" });
  // todo 37: the agent names what it reads beyond every agent's frames; the controller sends PACE only to `pace`
  const withPace = auth(A.id, good, { features: ["pace"] });
  cases.push({ name: "auth/machine-key/features-pace", frame: "AUTH", type: 0x03, stream_id: 0, direction: "machine_to_controller", context: { ...before(), ...base, ...signedNote(authMessage(NONCE, CTRL.serverId, S1)) }, bytes: authBytes(withPace), parse: withPace, effect: "AUTH_OK, then PACE frames to this session (todo 37); the signature covers the same 113 bytes, not features" });
  const withFleetState = auth(A.id, good, { features: ["pace", "fleet_state"], seen_state: seen(7) });
  cases.push({ name: "auth/machine-key/features-fleet-state", frame: "AUTH", type: 0x03, stream_id: 0, direction: "machine_to_controller", context: { ...before(), ...base, witness_key_hex: hex(WITNESS_KEY), store_generation: 7 }, bytes: authBytes(withFleetState), parse: withFleetState, effect: "AUTH_OK, then FLEET_STATE to this session (todo 31); an AUTH without `fleet_state` gets none" });
  const withUnknown = auth(A.id, good, { features: ["pace", "later-feature"] });
  cases.push({ name: "auth/machine-key/features-unknown-ignored", frame: "AUTH", type: 0x03, stream_id: 0, direction: "machine_to_controller", context: { ...before(), ...base }, bytes: authBytes(withUnknown), parse: withUnknown, effect: "AUTH_OK; a name this controller does not know is ignored" });
  cases.push({ name: "auth/machine-key/features-not-a-list", frame: "AUTH", type: 0x03, stream_id: 0, direction: "machine_to_controller", context: { ...before(), ...base }, bytes: authBytes(auth(A.id, good, { features: "pace" })), refuse: protocolError("decode") });
  cases.push({ name: "auth/machine-key/features-duplicate", frame: "AUTH", type: 0x03, stream_id: 0, direction: "machine_to_controller", context: { ...before(), ...base }, bytes: authBytes(auth(A.id, good, { features: ["pace", "pace"] })), refuse: protocolError("decode") });
  cases.push({ name: "auth/machine-key/features-bad-name", frame: "AUTH", type: 0x03, stream_id: 0, direction: "machine_to_controller", context: { ...before(), ...base }, bytes: authBytes(auth(A.id, good, { features: ["Pace"] })), refuse: protocolError("decode") });
  const newer = auth(A.id, good, { seen_state: seen(9) });
  cases.push({ name: "auth/machine-key/seen-state-newer-than-store", frame: "AUTH", type: 0x03, stream_id: 0, direction: "machine_to_controller", context: { ...before(), ...base, witness_key_hex: hex(WITNESS_KEY), store_generation: 7 }, bytes: authBytes(newer), parse: newer, refuse: { stage: "session", kind: "session_error", code: "auth_failed", message: "restored" }, effect: "the controller holds its fleet as rolled back (todo 31)" });
  const forged = auth(A.id, good, { seen_state: seen(9, label("witness-key/forged")) });
  cases.push({ name: "auth/machine-key/seen-state-bad-tag", frame: "AUTH", type: 0x03, stream_id: 0, direction: "machine_to_controller", context: { ...before(), ...base, witness_key_hex: hex(WITNESS_KEY), store_generation: 7 }, bytes: authBytes(forged), parse: forged, effect: "the tag does not verify: seen_state is ignored and AUTH_OK follows" });

  const refusedSignature = async (name: string, signer: Machine, message: Uint8Array, why: string) => {
    const signature = signP256(signer, message);
    assert(!(await p256Holds(A.spki, signature, authMessage(NONCE, CTRL.serverId, S1))), `${name} must not verify`);
    const payload = auth(A.id, signature);
    cases.push({ name, frame: "AUTH", type: 0x03, stream_id: 0, direction: "machine_to_controller", context: { ...before(), ...base, ...signedNote(message), why }, bytes: authBytes(payload), parse: payload, refuse: { stage: "verify", kind: "session_error", code: "auth_failed", message: "signature" } });
  };
  await refusedSignature("auth/machine-key/wrong-nonce", A, authMessage(NONCE_OTHER, CTRL.serverId, S1), "signed over another session's WELCOME nonce");
  await refusedSignature("auth/machine-key/wrong-server-id", A, authMessage(NONCE, OTHER.serverId, S1), "signed for another controller's server_id");
  await refusedSignature("auth/machine-key/wrong-binding", A, authMessage(NONCE, CTRL.serverId, S2), "replayed from another connection: its channel binding");
  await refusedSignature("auth/machine-key/wrong-key", B, authMessage(NONCE, CTRL.serverId, S1), "machine_id of A, signed by B's key");
  await refusedSignature("auth/machine-key/device-domain", A, deviceMessage(NONCE, CTRL.serverId), "the device-key message (ovis-relay-auth/1), not the machine one");
  {
    const message = authMessage(NONCE, CTRL.serverId, S1);
    const signature = signP256(A, message);
    const rotatedMessage = authMessage(NONCE, ROTATED.serverId, SR);
    assert(!(await p256Holds(A.spki, signature, rotatedMessage)), "rotated controller must not verify");
    const payload = auth(A.id, signature);
    cases.push({ name: "auth/machine-key/rotated-controller", frame: "AUTH", type: 0x03, stream_id: 0, direction: "machine_to_controller", context: { ...before(), ...base, server_id: ROTATED.serverId, binding_hex: hex(SR), ...signedNote(message), why: "signed for the controller's key before it rotated, presented to the rotated one" }, bytes: authBytes(payload), parse: payload, refuse: { stage: "verify", kind: "session_error", code: "auth_failed", message: "signature" } });
  }
  {
    const text = JSON.stringify(auth(A.id, good)).replace(b64u(good), b64u(good).slice(0, 85));
    cases.push({ name: "auth/machine-key/truncated-signature", frame: "AUTH", type: 0x03, stream_id: 0, direction: "machine_to_controller", context: { ...before(), ...base }, bytes: frame(0x03, 0, utf8(text)), refuse: { stage: "decode", kind: "session_error", code: "protocol_error" } });
    const whole = authBytes(accept);
    cases.push({ name: "auth/machine-key/truncated-frame", frame: "AUTH", type: 0x03, stream_id: 0, direction: "machine_to_controller", context: { ...before(), ...base }, bytes: whole.subarray(0, whole.length - 10), refuse: { stage: "decode", kind: "session_error", code: "protocol_error" } });
    const scheme = { scheme: "machine-keys", machine_id: A.id, signature: b64u(good) };
    cases.push({ name: "auth/machine-key/unknown-scheme", frame: "AUTH", type: 0x03, stream_id: 0, direction: "machine_to_controller", context: before(), bytes: authBytes(scheme), refuse: { stage: "decode", kind: "session_error", code: "protocol_error" } });
  }
  {
    const signature = signP256(B, authMessage(NONCE, CTRL.serverId, S1));
    const payload = auth(B.id, signature);
    cases.push({ name: "auth/machine-key/unknown-machine", frame: "AUTH", type: 0x03, stream_id: 0, direction: "machine_to_controller", context: { ...before(), ...base }, bytes: authBytes(payload), parse: payload, refuse: { stage: "session", kind: "session_error", code: "auth_failed", message: "unknown" } });
  }
  cases.push({ name: "auth/machine-key/revoked", frame: "AUTH", type: 0x03, stream_id: 0, direction: "machine_to_controller", context: { ...before(), ...base, store: { [A.id]: "revoked" } }, bytes: authBytes(accept), parse: accept, refuse: { stage: "session", kind: "session_error", code: "auth_revoked", message: "revoked" } });
  cases.push({ name: "auth/machine-key/quarantined", frame: "AUTH", type: 0x03, stream_id: 0, direction: "machine_to_controller", context: { ...before(), ...base, store: { [A.id]: "quarantined" } }, bytes: authBytes(accept), parse: accept, refuse: { stage: "session", kind: "session_error", code: "auth_revoked", message: "quarantined" } });
  cases.push({ name: "auth/machine-key/fleet-token-required", frame: "AUTH", type: 0x03, stream_id: 0, direction: "machine_to_controller", context: { ...before(), ...base, store: { [A.id]: "active" }, fleet: { token: false } }, bytes: authBytes(accept), parse: accept, refuse: { stage: "session", kind: "session_error", code: "auth_failed", message: "fleet_token_required" }, effect: "the controller has no OVIS_TOKEN (todo 60): no AUTH_OK, nothing counted; the machine keeps dialing" });
  cases.push({ name: "auth/machine-key/controller-limit", frame: "AUTH", type: 0x03, stream_id: 0, direction: "machine_to_controller", context: { ...before(), ...base, store: { [A.id]: "active" }, fleet: { max: 1, signed_in_others: 1 } }, bytes: authBytes(accept), parse: accept, refuse: { stage: "session", kind: "session_error", code: "resource_exhausted", message: "controller_limit" }, effect: "OVIS_FLEET_MAX machines hold a session already: no AUTH_OK, nothing counted" });
  cases.push({ name: "auth/machine-key/without-pipe-stream", frame: "AUTH", type: 0x03, stream_id: 0, direction: "machine_to_controller", context: { ...before([]), ...base }, bytes: authBytes(accept), parse: accept, refuse: { stage: "session", kind: "session_error", code: "auth_failed", message: "wrong_scheme" } });
  {
    const device = { scheme: "device-key", device_id: "0123456789abcdef", signature: b64u(signP256(A, deviceMessage(NONCE, CTRL.serverId))) } as const;
    cases.push({ name: "auth/device-key/in-machine-session", frame: "AUTH", type: 0x03, stream_id: 0, direction: "machine_to_controller", context: { ...before(), ...base }, bytes: existing({ type: FrameType.AUTH, flags: 0, stream_id: 0, payload: device }), parse: { ...device }, refuse: { stage: "session", kind: "session_error", code: "auth_failed", message: "wrong_scheme" } });
  }

  const pace = { generation: 1, per_minute: 24, burst: 4, slot: 7, span: 100, controller_ms: NOW_MS, rtt_ms: 42 };
  const ok = { session_id: hex(label("session-id")).slice(0, 32), machine_id: A.id, role: "machine", relay_pace: pace };
  cases.push({ name: "auth/auth-ok/machine-with-pace", frame: "AUTH_OK", type: 0x04, stream_id: 0, direction: "controller_to_machine", context: before(), bytes: json(0x04, 0, ok), parse: ok, effect: "the machine keeps relay_pace in fleet.json (todo 37)" });
  const plain = { session_id: ok.session_id, machine_id: A.id, role: "machine" };
  cases.push({ name: "auth/auth-ok/machine", frame: "AUTH_OK", type: 0x04, stream_id: 0, direction: "controller_to_machine", context: before(), bytes: json(0x04, 0, plain), parse: plain });
  const carriers = ["ws://192.168.1.20:7319", "ws://172.17.0.1:7319", "ws://100.101.102.103:7319"];
  const withDirect = { ...plain, direct: carriers };
  cases.push({ name: "auth/auth-ok/machine-with-direct", frame: "AUTH_OK", type: 0x04, stream_id: 0, direction: "controller_to_machine", context: before(), bytes: json(0x04, 0, withDirect), parse: withDirect, effect: "the machine dials these direct carriers from now on and saves them as fleet.json controller.direct (todo 29)" });
  for (const [name, direct] of [
    ["direct-empty", []], ["direct-public-address", ["ws://203.0.113.5:7319"]], ["direct-loopback", ["ws://127.0.0.1:7319"]],
    ["direct-host-name", ["ws://controller.lan:7319"]], ["direct-duplicate", ["ws://172.17.0.1:7319", "ws://172.17.0.1:7319"]],
    ["direct-five-carriers", [...carriers, "ws://10.0.0.7:7319", "ws://10.0.0.8:7319"]],
  ] as const) cases.push({ name: `auth/auth-ok/${name}`, frame: "AUTH_OK", type: 0x04, stream_id: 0, direction: "controller_to_machine", context: before(), bytes: json(0x04, 0, { ...plain, direct: [...direct] }), refuse: protocolError("decode") });
  const pending = { ...withDirect, pending: true };
  cases.push({ name: "auth/auth-ok/machine-pending", frame: "AUTH_OK", type: 0x04, stream_id: 0, direction: "controller_to_machine", context: before(), bytes: json(0x04, 0, pending), parse: pending, effect: "ovis-link status says pending-confirmation until a session's AUTH_OK no longer says pending" });
  for (const [name, value] of [["pending-false", false], ["pending-string", "true"], ["pending-number", 1]] as const) {
    cases.push({ name: `auth/auth-ok/${name}`, frame: "AUTH_OK", type: 0x04, stream_id: 0, direction: "controller_to_machine", context: before(), bytes: json(0x04, 0, { ...plain, pending: value }), refuse: protocolError("decode") });
  }
  cases.push({ name: "auth/auth-ok/pace-slot-outside-span", frame: "AUTH_OK", type: 0x04, stream_id: 0, direction: "controller_to_machine", context: before(), bytes: json(0x04, 0, { ...ok, relay_pace: { ...pace, slot: 100 } }), refuse: protocolError("decode") });

  // SESSION_ERROR both ways: the link agent ends a session with it (section 3) and reads the cause of a refusal (section 1)
  const machineError = { code: "protocol_error", message: "Not a frame for a machine" } as const;
  const refusal = { code: "auth_failed", message: "signature" } as const;
  const sessionError = (payload: { code: "protocol_error" | "auth_failed"; message: string }) => existing({ type: FrameType.SESSION_ERROR, flags: 0, stream_id: 0, payload });
  cases.push(
    { name: "auth/session-error/from-machine", frame: "SESSION_ERROR", type: 0x05, stream_id: 0, direction: "machine_to_controller", context: after(), bytes: sessionError(machineError), parse: { ...machineError }, effect: "the controller ends the session and forgets the machine's advert" },
    { name: "auth/session-error/cause", frame: "SESSION_ERROR", type: 0x05, stream_id: 0, direction: "controller_to_machine", context: before(), bytes: sessionError(refusal), parse: { ...refusal }, effect: "the machine ends the session and reports the cause signature" },
    { name: "auth/session-error/unknown-code", frame: "SESSION_ERROR", type: 0x05, stream_id: 0, direction: "controller_to_machine", context: before(), bytes: json(0x05, 0, { code: "not_a_code", message: "" }), refuse: protocolError("decode") },
  );

  const state = seen(7);
  cases.push({ name: "auth/fleet-state/accept", frame: "FLEET_STATE", type: T.FLEET_STATE, stream_id: 0, direction: "controller_to_machine", context: after({ server_id: CTRL.serverId, witness_key_hex: hex(WITNESS_KEY) }), bytes: json(T.FLEET_STATE, 0, state), parse: state, effect: "the machine keeps the newest and presents it as seen_state" });
  cases.push({ name: "auth/fleet-state/short-tag", frame: "FLEET_STATE", type: T.FLEET_STATE, stream_id: 0, direction: "controller_to_machine", context: after(), bytes: json(T.FLEET_STATE, 0, { generation: 7, tag: b64u(stateTag(WITNESS_KEY, CTRL.serverId, 7).subarray(0, 31)) }), refuse: protocolError("decode") });
  cases.push({ name: "auth/fleet-state/from-machine", frame: "FLEET_STATE", type: T.FLEET_STATE, stream_id: 0, direction: "machine_to_controller", context: after(), bytes: json(T.FLEET_STATE, 0, state), parse: state, refuse: protocolError() });
  cases.push({ name: "auth/fleet-state/before-auth", frame: "FLEET_STATE", type: T.FLEET_STATE, stream_id: 0, direction: "controller_to_machine", context: before(), bytes: json(T.FLEET_STATE, 0, state), parse: state, refuse: protocolError() });

  const httpOpen = { device_id: "0000000000000000", method: "GET", target: "/api/health", headers: [], body: "none" } as const;
  const wsOpen = { device_id: "0000000000000000", target: "/ws", headers: [], protocols: [] } as const;
  const pair = { code: "123456", label: "machine", public_key: b64u(A.spki) } as const;
  const pairRequest = { label: "machine", public_key: b64u(A.spki), commitment: b64u(label("commitment")) } as const;
  const httpBytes = existing({ type: FrameType.HTTP_OPEN, flags: 0, stream_id: 1, payload: httpOpen });
  const wsBytes = existing({ type: FrameType.WS_OPEN, flags: 0, stream_id: 1, payload: wsOpen });
  const pairBytes = existing({ type: FrameType.PAIR, flags: 0, stream_id: 0, payload: pair });
  const pairRequestBytes = existing({ type: FrameType.PAIR_REQUEST, flags: 0, stream_id: 0, payload: pairRequest });
  const wrongScheme: Refuse = { stage: "session", kind: "session_error", code: "auth_failed", message: "wrong_scheme" };
  cases.push(
    { name: "auth/never/http-open-from-machine", frame: "HTTP_OPEN", type: 0x10, stream_id: 1, direction: "machine_to_controller", context: after(), bytes: httpBytes, parse: { ...httpOpen, headers: [] }, refuse: protocolError() },
    { name: "auth/never/ws-open-from-machine", frame: "WS_OPEN", type: 0x20, stream_id: 1, direction: "machine_to_controller", context: after(), bytes: wsBytes, parse: { ...wsOpen, headers: [], protocols: [] }, refuse: protocolError() },
    { name: "auth/never/pair-before-auth", frame: "PAIR", type: 0x0a, stream_id: 0, direction: "machine_to_controller", context: before(), bytes: pairBytes, parse: { ...pair }, refuse: wrongScheme, effect: "no approval prompt is shown" },
    { name: "auth/never/pair-after-auth", frame: "PAIR", type: 0x0a, stream_id: 0, direction: "machine_to_controller", context: after(), bytes: pairBytes, parse: { ...pair }, refuse: protocolError() },
    { name: "auth/never/pair-request-before-auth", frame: "PAIR_REQUEST", type: 0x0b, stream_id: 0, direction: "machine_to_controller", context: before(), bytes: pairRequestBytes, parse: { ...pairRequest }, refuse: wrongScheme, effect: "no approval prompt is shown" },
    { name: "auth/never/pair-request-after-auth", frame: "PAIR_REQUEST", type: 0x0b, stream_id: 0, direction: "machine_to_controller", context: after(), bytes: pairRequestBytes, parse: { ...pairRequest }, refuse: protocolError() },
    { name: "auth/never/http-open-to-machine", frame: "HTTP_OPEN", type: 0x10, stream_id: 1, direction: "controller_to_machine", context: after(), bytes: httpBytes, parse: { ...httpOpen, headers: [] }, refuse: protocolError() },
    { name: "auth/never/ws-open-to-machine", frame: "WS_OPEN", type: 0x20, stream_id: 1, direction: "controller_to_machine", context: after(), bytes: wsBytes, parse: { ...wsOpen, headers: [], protocols: [] }, refuse: protocolError() },
    { name: "auth/never/auth-after-auth", frame: "AUTH", type: 0x03, stream_id: 0, direction: "machine_to_controller", context: after(), bytes: authBytes(accept), parse: accept, refuse: protocolError(), effect: "a second sign-in on a signed-in session: the engine's setup check refuses it" },
    { name: "auth/never/hello-after-auth", frame: "HELLO", type: 0x01, stream_id: 0, direction: "machine_to_controller", context: after(), bytes: helloBytes, parse: { protocol: "ovis-mux", versions: [1], features: ["pipe-stream"], required_features: ["pipe-stream"] }, refuse: protocolError() },
    { name: "auth/never/unassigned-type-from-machine", frame: "UNASSIGNED", type: 0x49, stream_id: 0, direction: "machine_to_controller", context: after({ extension: "registered" }), bytes: json(0x49, 0, {}), refuse: protocolError("decode") },
    { name: "auth/never/unassigned-type-to-machine", frame: "UNASSIGNED", type: 0x4f, stream_id: 0, direction: "controller_to_machine", context: after({ extension: "registered" }), bytes: json(0x4f, 0, {}), refuse: protocolError("decode") },
  );

  const fixture = JSON.parse(readFileSync(join(import.meta.dir, "..", "shared", "vendor", "paseo-e2ee", "noise", "fixtures", "nk-25519-chachapoly-sha256.json"), "utf8")) as { vectors: { resp_static: string; messages: { ciphertext: string }[] }[] };
  const nk = fixture.vectors[0]!;
  const responder = x25519.getPublicKey(Buffer.from(nk.resp_static, "hex"));
  const m1 = Buffer.from(nk.messages[0]!.ciphertext, "hex");
  const m2 = Buffer.from(nk.messages[1]!.ciphertext, "hex");
  const derivations: Obj = {
    channel_binding: {
      note: "The formula of shared/relay-e2ee.ts:72-85 on the first two messages of the vendored NK fixture, used here only as bytes.",
      domain: "ovis-relay-channel-binding/1",
      server_public_key_hex: hex(responder), message_1_hex: hex(m1), message_2_hex: hex(m2),
      binding_hex: hex(bindingOf(responder, m1, m2)),
    },
    controller: { server_public_key: b64(CTRL.publicKey), server_id: CTRL.serverId, rotated_server_id: ROTATED.serverId, other_server_id: OTHER.serverId },
    machine_a: { private_scalar_hex: hex(A.secret), spki: b64u(A.spki), machine_id: A.id },
    machine_b: { private_scalar_hex: hex(B.secret), spki: b64u(B.spki), machine_id: B.id },
    auth_message: { layout: "\"ovis-fleet-auth/1\" || nonce (32) || server_id (32 ASCII) || binding (32)", accept_hex: hex(authMessage(NONCE, CTRL.serverId, S1)), signature: b64u(good) },
    fleet_state_tag: { layout: "HMAC-SHA256(witness_key, server_id (32 ASCII) || generation (u64 big-endian))", witness_key_hex: hex(WITNESS_KEY), server_id: CTRL.serverId, generation: 7, tag: state.tag },
  };
  return file("auth.json", derivations, cases);
}

function pipeFile(): Obj {
  const cases: Case[] = [];
  const advertBoth = { endpoints: ["bridge", "native"], selected: ["pipe-stream"] };
  const c2m = "controller_to_machine" as const;
  const m2c = "machine_to_controller" as const;
  const open = (endpoint: string) => utf8(JSON.stringify({ endpoint }));
  cases.push(
    { name: "pipe/open/bridge", frame: "PIPE_OPEN", type: T.PIPE_OPEN, stream_id: 2, direction: c2m, context: after({ advert: advertBoth.endpoints, open_pipes: 0, last_pipe_id: 0 }), bytes: frame(T.PIPE_OPEN, 2, open("bridge")), parse: { endpoint: "bridge" }, effect: "the agent connects its configured loopback bridge port and answers PIPE_ACCEPT" },
    { name: "pipe/open/native", frame: "PIPE_OPEN", type: T.PIPE_OPEN, stream_id: 4, direction: c2m, context: after({ advert: advertBoth.endpoints, open_pipes: 1, last_pipe_id: 2 }), bytes: frame(T.PIPE_OPEN, 4, open("native")), parse: { endpoint: "native" }, effect: "the agent connects the runtime's Unix socket and answers PIPE_ACCEPT" },
    { name: "pipe/open/odd-id", frame: "PIPE_OPEN", type: T.PIPE_OPEN, stream_id: 3, direction: c2m, context: after(), bytes: frame(T.PIPE_OPEN, 3, open("bridge")), refuse: protocolError("decode") },
    { name: "pipe/open/stream-zero", frame: "PIPE_OPEN", type: T.PIPE_OPEN, stream_id: 0, direction: c2m, context: after(), bytes: frame(T.PIPE_OPEN, 0, open("bridge")), refuse: protocolError("decode") },
    { name: "pipe/open/not-consecutive", frame: "PIPE_OPEN", type: T.PIPE_OPEN, stream_id: 8, direction: c2m, context: after({ advert: advertBoth.endpoints, open_pipes: 2, last_pipe_id: 4 }), bytes: frame(T.PIPE_OPEN, 8, open("bridge")), parse: { endpoint: "bridge" }, refuse: protocolError() },
    { name: "pipe/open/unknown-endpoint", frame: "PIPE_OPEN", type: T.PIPE_OPEN, stream_id: 6, direction: c2m, context: after({ advert: advertBoth.endpoints, open_pipes: 2, last_pipe_id: 4 }), bytes: frame(T.PIPE_OPEN, 6, open("shell")), parse: { endpoint: "shell" }, refuse: { stage: "session", kind: "reset", code: "refused" }, effect: "no process is started" },
    { name: "pipe/open/not-advertised", frame: "PIPE_OPEN", type: T.PIPE_OPEN, stream_id: 2, direction: c2m, context: after({ advert: ["bridge"], open_pipes: 0, last_pipe_id: 0 }), bytes: frame(T.PIPE_OPEN, 2, open("native")), parse: { endpoint: "native" }, refuse: { stage: "session", kind: "reset", code: "refused" } },
    { name: "pipe/open/seventeenth", frame: "PIPE_OPEN", type: T.PIPE_OPEN, stream_id: 34, direction: c2m, context: after({ advert: advertBoth.endpoints, open_pipes: 16, last_pipe_id: 32 }), bytes: frame(T.PIPE_OPEN, 34, open("bridge")), parse: { endpoint: "bridge" }, refuse: { stage: "session", kind: "reset", code: "refused" }, limit: "max_pipe_streams" },
    { name: "pipe/open/bad-endpoint-name", frame: "PIPE_OPEN", type: T.PIPE_OPEN, stream_id: 2, direction: c2m, context: after(), bytes: frame(T.PIPE_OPEN, 2, open("Bridge")), refuse: protocolError("decode") },
    { name: "pipe/open/flags", frame: "PIPE_OPEN", type: T.PIPE_OPEN, stream_id: 2, direction: c2m, context: after(), bytes: frame(T.PIPE_OPEN, 2, open("bridge"), 1), refuse: protocolError("decode") },
    { name: "pipe/open/without-pipe-stream", frame: "PIPE_OPEN", type: T.PIPE_OPEN, stream_id: 2, direction: c2m, context: { state: "after_auth", selected: [] }, bytes: frame(T.PIPE_OPEN, 2, open("bridge")), refuse: protocolError("decode") },
    { name: "pipe/open/from-machine", frame: "PIPE_OPEN", type: T.PIPE_OPEN, stream_id: 2, direction: m2c, context: after(), bytes: frame(T.PIPE_OPEN, 2, open("bridge")), parse: { endpoint: "bridge" }, refuse: protocolError() },
    { name: "pipe/open/before-auth", frame: "PIPE_OPEN", type: T.PIPE_OPEN, stream_id: 2, direction: c2m, context: before(), bytes: frame(T.PIPE_OPEN, 2, open("bridge")), parse: { endpoint: "bridge" }, refuse: protocolError() },
  );

  cases.push(
    { name: "pipe/accept/accept", frame: "PIPE_ACCEPT", type: T.PIPE_ACCEPT, stream_id: 2, direction: m2c, context: after({ opened: true }), bytes: frame(T.PIPE_ACCEPT, 2, new Uint8Array(0)), parse: {}, effect: "both directions get a 768 KiB window" },
    { name: "pipe/accept/with-payload", frame: "PIPE_ACCEPT", type: T.PIPE_ACCEPT, stream_id: 2, direction: m2c, context: after({ opened: true }), bytes: frame(T.PIPE_ACCEPT, 2, Uint8Array.of(0)), refuse: protocolError("decode") },
    { name: "pipe/accept/from-controller", frame: "PIPE_ACCEPT", type: T.PIPE_ACCEPT, stream_id: 2, direction: c2m, context: after({ opened: true }), bytes: frame(T.PIPE_ACCEPT, 2, new Uint8Array(0)), parse: {}, refuse: protocolError() },
  );

  const small = utf8("echo hello\n");
  const largest = Uint8Array.from({ length: 16376 }, (_, i) => i % 251);
  const tooLarge = Uint8Array.from({ length: 16377 }, (_, i) => i % 251);
  cases.push(
    { name: "pipe/data/small", frame: "PIPE_DATA", type: T.PIPE_DATA, stream_id: 2, direction: c2m, context: after({ accepted: true }), bytes: frame(T.PIPE_DATA, 2, small), parse: { data: hex(small) } },
    { name: "pipe/data/largest", frame: "PIPE_DATA", type: T.PIPE_DATA, stream_id: 2, direction: m2c, context: after({ accepted: true }), bytes: frame(T.PIPE_DATA, 2, largest), parse: { data: hex(largest) } },
    { name: "pipe/data/too-large", frame: "PIPE_DATA", type: T.PIPE_DATA, stream_id: 2, direction: m2c, context: after({ accepted: true }), bytes: frame(T.PIPE_DATA, 2, tooLarge), refuse: protocolError("decode"), limit: "pipe_data_bytes" },
    { name: "pipe/data/empty", frame: "PIPE_DATA", type: T.PIPE_DATA, stream_id: 2, direction: c2m, context: after({ accepted: true }), bytes: frame(T.PIPE_DATA, 2, new Uint8Array(0)), refuse: protocolError("decode") },
    { name: "pipe/data/before-accept", frame: "PIPE_DATA", type: T.PIPE_DATA, stream_id: 2, direction: c2m, context: after({ accepted: false }), bytes: frame(T.PIPE_DATA, 2, small), parse: { data: hex(small) }, refuse: protocolError() },
    { name: "pipe/data/over-window", frame: "PIPE_DATA", type: T.PIPE_DATA, stream_id: 2, direction: c2m, context: after({ accepted: true, received: PIPE_WINDOW_BYTES, credited: 0 }), bytes: frame(T.PIPE_DATA, 2, small), parse: { data: hex(small) }, refuse: { stage: "session", kind: "session_error", code: "flow_control_error" }, limit: "pipe_window_bytes" },
    { name: "pipe/end/accept", frame: "PIPE_END", type: T.PIPE_END, stream_id: 2, direction: c2m, context: after({ accepted: true }), bytes: frame(T.PIPE_END, 2, new Uint8Array(0)), parse: {}, effect: "the controller's direction is closed; the pipe retires once the machine ends too" },
    { name: "pipe/end/second", frame: "PIPE_END", type: T.PIPE_END, stream_id: 2, direction: c2m, context: after({ accepted: true, ended_by_sender: true }), bytes: frame(T.PIPE_END, 2, new Uint8Array(0)), parse: {}, refuse: protocolError() },
    { name: "pipe/end/with-payload", frame: "PIPE_END", type: T.PIPE_END, stream_id: 2, direction: c2m, context: after({ accepted: true }), bytes: frame(T.PIPE_END, 2, Uint8Array.of(0)), refuse: protocolError("decode") },
    { name: "pipe/credit/accept", frame: "CREDIT", type: FrameType.CREDIT, stream_id: 2, direction: m2c, context: after({ accepted: true, sent: 131072 }), bytes: frame(FrameType.CREDIT, 2, u64be(65536)), parse: { consumed: "65536" } },
    { name: "pipe/credit/even-id-without-pipe-stream", frame: "CREDIT", type: FrameType.CREDIT, stream_id: 2, direction: m2c, context: { state: "after_auth", selected: [] }, bytes: frame(FrameType.CREDIT, 2, u64be(65536)), refuse: protocolError("decode") },
  );

  for (const code of ["refused", "internal_error", "upstream_lost", "slow_consumer", "cancelled"]) {
    const payload = { code, message: "" };
    cases.push({ name: `pipe/reset/${code.replace(/_/g, "-")}`, frame: "RESET", type: FrameType.RESET, stream_id: 2, direction: code === "refused" || code === "upstream_lost" ? m2c : c2m, context: after(), bytes: json(FrameType.RESET, 2, payload), parse: payload });
  }
  cases.push({ name: "pipe/reset/other-code", frame: "RESET", type: FrameType.RESET, stream_id: 2, direction: m2c, context: after(), bytes: json(FrameType.RESET, 2, { code: "bad_request", message: "" }), parse: { code: "bad_request", message: "" }, refuse: protocolError() });
  const goaway = { code: "shutdown", last_open_id: 4, drain_ms: 5000 };
  cases.push({ name: "pipe/goaway/machine", frame: "GOAWAY", type: FrameType.GOAWAY, stream_id: 0, direction: m2c, context: after({ last_pipe_id: 6 }), bytes: json(FrameType.GOAWAY, 0, goaway), parse: goaway, effect: "the controller resets pipe 6 refused and opens no more" });
  const exhausted = { code: "id_exhausted", last_open_id: 0x7ffffffe, drain_ms: 5000 };
  // todo 37: only the owner's confirmation of a pending machine names a reason; the machine dials the relay at once after it
  const confirmedGoaway = { code: "shutdown", last_open_id: 0, drain_ms: 1000, reason: "confirmed" };
  cases.push({ name: "pipe/goaway/confirmed", frame: "GOAWAY", type: FrameType.GOAWAY, stream_id: 0, direction: c2m, context: after(), bytes: json(FrameType.GOAWAY, 0, confirmedGoaway), parse: confirmedGoaway, effect: "the pending machine drains, then dials the relay once at once (not at its next instant) and signs in again" });
  const shutdownGoaway = { code: "shutdown", last_open_id: 0, drain_ms: 0 };
  cases.push({ name: "pipe/goaway/controller-shutdown", frame: "GOAWAY", type: FrameType.GOAWAY, stream_id: 0, direction: c2m, context: after(), bytes: json(FrameType.GOAWAY, 0, shutdownGoaway), parse: shutdownGoaway, effect: "no reason: the machine, pending or not, dials the relay at its next instant" });
  const laterReason = { code: "shutdown", last_open_id: 0, drain_ms: 0, reason: "later-reason" };
  cases.push({ name: "pipe/goaway/unknown-reason", frame: "GOAWAY", type: FrameType.GOAWAY, stream_id: 0, direction: c2m, context: after(), bytes: json(FrameType.GOAWAY, 0, laterReason), parse: laterReason, effect: "a reason the machine does not act on: as no reason" });
  cases.push({ name: "pipe/goaway/bad-reason", frame: "GOAWAY", type: FrameType.GOAWAY, stream_id: 0, direction: c2m, context: after(), bytes: json(FrameType.GOAWAY, 0, { ...shutdownGoaway, reason: "Confirmed!" }), refuse: protocolError("decode") });
  cases.push({ name: "pipe/goaway/id-exhausted", frame: "GOAWAY", type: FrameType.GOAWAY, stream_id: 0, direction: c2m, context: after({ last_pipe_id: 0x7ffffffe }), bytes: json(FrameType.GOAWAY, 0, exhausted), parse: exhausted, effect: "the machine opens a new session" });

  // keepalive and receipts as a machine session carries them (the link agent answers PING and sends RECEIVED)
  const probe = 0x0123456789abcdefn;
  const counter = (type: typeof FrameType.PING | typeof FrameType.PONG | typeof FrameType.RECEIVED, payload: bigint) => existing({ type, flags: 0, stream_id: 0, payload });
  cases.push(
    { name: "pipe/ping/from-controller", frame: "PING", type: FrameType.PING, stream_id: 0, direction: c2m, context: after(), bytes: counter(FrameType.PING, probe), parse: { probe: probe.toString() }, effect: "the machine answers PONG with the same probe" },
    { name: "pipe/ping/short", frame: "PING", type: FrameType.PING, stream_id: 0, direction: c2m, context: after(), bytes: frame(FrameType.PING, 0, Uint8Array.of(1, 2, 3, 4)), refuse: protocolError("decode") },
    { name: "pipe/pong/from-machine", frame: "PONG", type: FrameType.PONG, stream_id: 0, direction: m2c, context: after(), bytes: counter(FrameType.PONG, probe), parse: { probe: probe.toString() }, effect: "answers the controller's PING" },
    { name: "pipe/received/from-machine", frame: "RECEIVED", type: FrameType.RECEIVED, stream_id: 0, direction: m2c, context: after({ controller_sent: 2 }), bytes: counter(FrameType.RECEIVED, 2n), parse: { frames: "2" }, effect: "releases the receipt budget of the controller's first two frames" },
    { name: "pipe/received/from-controller", frame: "RECEIVED", type: FrameType.RECEIVED, stream_id: 0, direction: c2m, context: after({ machine_sent: 3 }), bytes: counter(FrameType.RECEIVED, 3n), parse: { frames: "3" }, effect: "releases the receipt budget of the machine's first three frames" },
    { name: "pipe/received/beyond-sent", frame: "RECEIVED", type: FrameType.RECEIVED, stream_id: 0, direction: c2m, context: after({ machine_sent: 3 }), bytes: counter(FrameType.RECEIVED, 4n), parse: { frames: "4" }, refuse: protocolError() },
  );

  const advert = {
    endpoints: ["bridge", "native"], runtime_id: "rt-01J9ZK3V7Q", boot_id: "boot-7f3a9c2e",
    bridge_token: hex(label("bridge-token")), native_bearer: `ovb_${b64u(label("native-bearer"))}`,
    health: { runtime: "up", bridge: "up" }, now: NOW_S,
    versions: { server: "0.5.0", link: "0.5.0", agent: "0.5.0", runtime: "0.9.1" },
  };
  const advertBytes = (payload: Obj) => json(T.PIPE_ADVERT, 0, payload);
  const { native_bearer: _bearer, ...bridgeOnly } = { ...advert, endpoints: ["bridge"], health: { runtime: "down", bridge: "up" } };
  const decodeRefuse = protocolError("decode");
  cases.push(
    { name: "pipe/advert/both", frame: "PIPE_ADVERT", type: T.PIPE_ADVERT, stream_id: 0, direction: m2c, context: after(), bytes: advertBytes(advert), parse: advert, effect: "replaces the previous advert whole; the secrets stay in memory" },
    { name: "pipe/advert/bridge-only", frame: "PIPE_ADVERT", type: T.PIPE_ADVERT, stream_id: 0, direction: m2c, context: after(), bytes: advertBytes(bridgeOnly), parse: bridgeOnly },
    { name: "pipe/advert/unknown-key", frame: "PIPE_ADVERT", type: T.PIPE_ADVERT, stream_id: 0, direction: m2c, context: after(), bytes: advertBytes({ ...advert, zone: "rack-4" }), parse: advert, canonical: false, effect: "an unknown key is ignored" },
    { name: "pipe/advert/missing-native-bearer", frame: "PIPE_ADVERT", type: T.PIPE_ADVERT, stream_id: 0, direction: m2c, context: after(), bytes: advertBytes({ ...bridgeOnly, endpoints: ["bridge", "native"] }), refuse: decodeRefuse },
    { name: "pipe/advert/bearer-without-native", frame: "PIPE_ADVERT", type: T.PIPE_ADVERT, stream_id: 0, direction: m2c, context: after(), bytes: advertBytes({ ...advert, endpoints: ["bridge"] }), refuse: decodeRefuse },
    { name: "pipe/advert/unknown-endpoint", frame: "PIPE_ADVERT", type: T.PIPE_ADVERT, stream_id: 0, direction: m2c, context: after(), bytes: advertBytes({ ...advert, endpoints: ["bridge", "shell"] }), refuse: decodeRefuse, limit: "advert_endpoints" },
    { name: "pipe/advert/repeated-endpoint", frame: "PIPE_ADVERT", type: T.PIPE_ADVERT, stream_id: 0, direction: m2c, context: after(), bytes: advertBytes({ ...bridgeOnly, endpoints: ["bridge", "bridge"] }), refuse: decodeRefuse, limit: "advert_endpoints" },
    { name: "pipe/advert/bearer-too-long", frame: "PIPE_ADVERT", type: T.PIPE_ADVERT, stream_id: 0, direction: m2c, context: after(), bytes: advertBytes({ ...advert, native_bearer: "b".repeat(513) }), refuse: decodeRefuse, limit: "native_bearer_bytes" },
    { name: "pipe/advert/short-bridge-token", frame: "PIPE_ADVERT", type: T.PIPE_ADVERT, stream_id: 0, direction: m2c, context: after(), bytes: advertBytes({ ...advert, bridge_token: advert.bridge_token.slice(0, 63) }), refuse: decodeRefuse },
    { name: "pipe/advert/before-auth", frame: "PIPE_ADVERT", type: T.PIPE_ADVERT, stream_id: 0, direction: m2c, context: before(), bytes: advertBytes(advert), parse: advert, refuse: protocolError() },
    { name: "pipe/advert/from-controller", frame: "PIPE_ADVERT", type: T.PIPE_ADVERT, stream_id: 0, direction: c2m, context: after(), bytes: advertBytes(advert), parse: advert, refuse: protocolError() },
  );
  const padded = advertBytes({ ...advert, pad: "p".repeat(4096) });
  assert(padded.length > 4096 && padded.length <= 16384, "oversized advert fits a mux frame");
  cases.push({ name: "pipe/advert/too-large", frame: "PIPE_ADVERT", type: T.PIPE_ADVERT, stream_id: 0, direction: m2c, context: after(), bytes: padded, refuse: decodeRefuse, limit: "pipe_advert_bytes" });
  return file("pipe-frames.json", { data_pattern: "pipe/data/largest and too-large carry byte i = i mod 251" }, cases);
}

const INVITE_ID = hex(label("invite-id")).slice(0, 16);
const SECRET = label("invite-secret");
const inviteSeed = (secret: Uint8Array, id: string) => hkdf(sha256, secret, new Uint8Array(0), utf8(`ovis-fleet-invite/1${id}`), 32);
const enrollMessage = (binding: Uint8Array, spki: Uint8Array, id: string) => concat(utf8("ovis-fleet-enroll/1"), binding, spki, utf8(id));

async function enrollFile(): Promise<Obj> {
  const cases: Case[] = [];
  const seed = inviteSeed(SECRET, INVITE_ID);
  const invitePublic = ed25519.getPublicKey(seed);
  const C = machine("enrolling");
  const D = machine("second");
  const E1 = session(CTRL, "enroll-1");
  const E2 = session(CTRL, "enroll-2");
  const EXP = NOW_S + 3600;
  const enroll = async (name: string, o: { secret?: Uint8Array; id?: string; signedSpki?: Uint8Array; spki?: Uint8Array; signedBinding: Uint8Array; checkBinding: Uint8Array; store?: Obj; now?: number; tries?: number; state?: string; direction?: Direction; refuse?: Refuse; effect?: string; limit?: string; pad?: number; truncate?: boolean; fleet?: Obj }) => {
    const id = o.id ?? INVITE_ID;
    const secret = o.secret ?? SECRET;
    const spki = o.spki ?? C.spki;
    const signedSpki = o.signedSpki ?? spki;
    const signature = ed25519.sign(enrollMessage(o.signedBinding, signedSpki, id), inviteSeed(secret, id));
    const payload: Obj = { invite_id: id, machine_public_key: b64u(spki), signature: b64u(signature), now: NOW_S };
    const stored = id === INVITE_ID;
    const holds = await ed25519Holds(invitePublic, signature, enrollMessage(o.checkBinding, spki, id));
    const decodeStage = o.refuse?.stage === "decode";
    const context: Obj = {
      state: o.state ?? "before_auth", selected: ["pipe-stream"], controller_now: o.now ?? NOW_S, tries_before: o.tries ?? 0,
      store: o.store ?? (stored ? { invite: "unused", exp: EXP } : {}),
      ...(o.fleet ? { fleet: o.fleet } : {}),
      ...(decodeStage ? {} : { signed: { secret: b64u(secret), invite_id: id, binding_hex: hex(o.signedBinding), machine_public_key: b64u(signedSpki) } }),
      ...(stored && !decodeStage ? { verifier: { invite_public_key_hex: hex(invitePublic), binding_hex: hex(o.checkBinding), holds } } : {}),
    };
    let bytes = json(T.ENROLL, 0, o.pad ? { ...payload, pad: "p".repeat(o.pad) } : payload);
    if (o.truncate) bytes = frame(T.ENROLL, 0, utf8(JSON.stringify(payload).replace(b64u(signature), b64u(signature).slice(0, 85))));
    cases.push({ name, frame: "ENROLL", type: T.ENROLL, stream_id: 0, direction: o.direction ?? "machine_to_controller", context, bytes, ...(decodeStage ? {} : { parse: payload }), ...(o.refuse ? { refuse: o.refuse } : {}), ...(o.effect ? { effect: o.effect } : {}), ...(o.limit ? { limit: o.limit } : {}) });
    return holds;
  };
  const failed = (message: string, stage: Refuse["stage"] = "session"): Refuse => ({ stage, kind: "session_error", code: "auth_failed", message });

  assert(await enroll("enroll/accept", { signedBinding: E1, checkBinding: E1, effect: "the machine is recorded pending and ENROLL_OK names its machine_id" }), "accepted ENROLL verifies");
  assert(await enroll("enroll/retry-same-key", { signedBinding: E2, checkBinding: E2, store: { invite: "used", exp: EXP, machine_public_key: b64u(C.spki) }, effect: "the same ENROLL_OK as the first time" }), "retry verifies");
  assert(await enroll("enroll/second-key", { spki: D.spki, signedBinding: E2, checkBinding: E2, store: { invite: "used", exp: EXP, machine_public_key: b64u(C.spki) }, refuse: { stage: "session", kind: "session_error", code: "auth_revoked", message: "quarantined" }, effect: "the slot is quarantined and an alert raised" }), "second key verifies");
  assert(!(await enroll("enroll/wrong-secret", { secret: label("invite-secret/other"), signedBinding: E1, checkBinding: E1, refuse: failed("signature", "verify") })), "wrong secret fails");
  assert(!(await enroll("enroll/other-machine-key", { signedSpki: D.spki, signedBinding: E1, checkBinding: E1, refuse: failed("signature", "verify") })), "other key fails");
  assert(!(await enroll("enroll/replayed-on-another-session", { signedBinding: E1, checkBinding: E2, refuse: failed("signature", "verify") })), "replay fails");
  const offCurve = concat(SPKI_PREFIX, Uint8Array.of(4), new Uint8Array(31), Uint8Array.of(1), new Uint8Array(31), Uint8Array.of(1));
  let pointRefused = false;
  try { await crypto.subtle.importKey("spki", offCurve, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]); } catch { pointRefused = true; }
  assert(pointRefused, "WebCrypto refuses the off-curve key");
  assert(await enroll("enroll/machine-key-not-on-curve", { spki: offCurve, signedBinding: E1, checkBinding: E1, refuse: failed("signature", "verify"), effect: "the invite signature holds, but the machine key cannot be imported" }), "off-curve invite signature holds");
  await enroll("enroll/unknown-invite", { id: hex(label("invite-id/unknown")).slice(0, 16), secret: label("invite-secret/unknown"), signedBinding: E1, checkBinding: E1, refuse: failed("unknown") });
  assert(await enroll("enroll/expired", { now: EXP + 1, signedBinding: E1, checkBinding: E1, refuse: failed("expired") }), "expired verifies");
  assert(await enroll("enroll/fleet-token-required", { signedBinding: E1, checkBinding: E1, fleet: { token: false }, refuse: failed("fleet_token_required"), effect: "the controller has no OVIS_TOKEN (todo 60): the invite is not looked at, nothing is counted or written" }), "held ENROLL verifies");
  // the budget refuses only an ENROLL whose signature does not hold: a valid one past it is still taken (todo 30, N3)
  assert(!(await enroll("enroll/sixth-try", { tries: 5, secret: label("invite-secret/other"), signedBinding: E1, checkBinding: E1, refuse: failed("rate_limited"), limit: "enroll_tries_per_invite" })), "sixth try fails its signature");
  assert(await enroll("enroll/valid-past-tries", { tries: 5, signedBinding: E1, checkBinding: E1, effect: "five refused tries came before: a valid ENROLL is still taken, the machine recorded pending" }), "valid past tries verifies");
  await enroll("enroll/truncated-signature", { truncate: true, signedBinding: E1, checkBinding: E1, refuse: protocolError("decode") });
  await enroll("enroll/too-large", { pad: 900, signedBinding: E1, checkBinding: E1, refuse: protocolError("decode"), limit: "metadata_frame_bytes" });
  await enroll("enroll/after-auth", { state: "after_auth", signedBinding: E1, checkBinding: E1, refuse: protocolError() });
  await enroll("enroll/to-machine", { direction: "controller_to_machine", signedBinding: E1, checkBinding: E1, refuse: protocolError() });
  const tooLarge = cases.find((entry) => entry.name === "enroll/too-large")!;
  assert(tooLarge.bytes.length > 1024, "too-large ENROLL exceeds 1024 bytes");

  const ok = { machine_id: C.id };
  cases.push({ name: "enroll/enroll-ok/accept", frame: "ENROLL_OK", type: T.ENROLL_OK, stream_id: 0, direction: "controller_to_machine", context: before(), bytes: json(T.ENROLL_OK, 0, ok), parse: ok, effect: "the machine stores machine_id, deletes the invite secret and signs in with AUTH on this session" });
  cases.push({ name: "enroll/enroll-ok/from-machine", frame: "ENROLL_OK", type: T.ENROLL_OK, stream_id: 0, direction: "machine_to_controller", context: before(), bytes: json(T.ENROLL_OK, 0, ok), parse: ok, refuse: protocolError() });

  const derivations: Obj = {
    invite: {
      secret: b64u(SECRET), invite_id: INVITE_ID, info_hex: hex(utf8(`ovis-fleet-invite/1${INVITE_ID}`)),
      seed_hex: hex(seed), public_key_hex: hex(invitePublic),
    },
    enroll_message: { layout: "\"ovis-fleet-enroll/1\" || binding (32) || machine public key SPKI DER (91) || invite id (16 ASCII)", accept_hex: hex(enrollMessage(E1, C.spki, INVITE_ID)) },
    machine_enrolling: { private_scalar_hex: hex(C.secret), spki: b64u(C.spki), machine_id: C.id },
    machine_second: { private_scalar_hex: hex(D.secret), spki: b64u(D.spki), machine_id: D.id },
    sessions: { enroll_1_binding_hex: hex(E1), enroll_2_binding_hex: hex(E2) },
  };
  return file("enroll.json", derivations, cases);
}

/**
 * The owner key (docs/fleet-link.md, "Owner key and members"): an Ed25519 key whose public half a machine pins; the
 * controller travels as its first member, a record the owner key signed over "ovis-fleet-member/1" || canonical JSON.
 */
const OWNER_SEED = label("owner-seed");
const OTHER_OWNER_SEED = label("owner-seed/other");
const memberRecord = (c: Controller, open = true) => ({ v: 1, server_id: c.serverId, server_public_key: b64(c.publicKey), class: "opener", open, write: true });
const memberMessage = (record: Obj) => concat(utf8("ovis-fleet-member/1"), utf8(JSON.stringify(record)));
/** The owner block for controller `c`: signed with `signer` (the owner's seed unless a test signs with another). */
/**
 * An owner block whose public key is the identity point (small order) with a signature (identity || S = 0) that a lax
 * Ed25519 check accepts over ANY message: both readers must refuse it (strict verification, as ed25519-dalek's).
 */
function smallOrderOwner(c: Controller): Obj {
  const identity = new Uint8Array(32);
  identity[0] = 1;
  const signature = new Uint8Array(64);
  signature[0] = 1;
  return { public_key: b64u(identity), member: memberRecord(c), signature: b64u(signature) };
}
/** A point of order 8: adding it to a key or to R gives a mixed-order point (todo 31, from the last check of todo 30). */
const TORSION_8 = ed25519.Point.fromHex("c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a");
const ED_L = ed25519.Point.Fn.ORDER;
const littleEndian = (bytes: Uint8Array) => bytes.reduceRight((n, byte) => (n << 8n) | BigInt(byte), 0n);
const scalarBytes = (n: bigint) => Uint8Array.from({ length: 32 }, (_, i) => Number((n >> BigInt(8 * i)) & 255n));
/** Whether `[S]B == R + [k]A` holds without the cofactor, as ed25519-dalek's `verify_strict` checks. */
function cofactorless(publicKey: Uint8Array, signature: Uint8Array, message: Uint8Array): boolean {
  const k = littleEndian(sha512(concat(signature.subarray(0, 32), publicKey, message))) % ED_L;
  const r = ed25519.Point.fromBytes(signature.subarray(0, 32));
  return ed25519.Point.BASE.multiplyUnsafe(littleEndian(signature.subarray(32))).equals(r.add(ed25519.Point.fromBytes(publicKey).multiplyUnsafe(k)));
}
/**
 * Owner blocks whose signature a cofactored check accepts (the owner's scalar signed the record) while the cofactorless
 * check refuses it: `key`, the owner key plus a point of order 8; `R`, a nonce point plus one. Both readers refuse both.
 */
function mixedOrderOwner(c: Controller, part: "key" | "R"): Obj {
  const { scalar } = ed25519.utils.getExtendedPublicKey(OWNER_SEED);
  const record = memberRecord(c);
  const message = memberMessage(record);
  const base = ed25519.Point.BASE;
  const publicKey = part === "key" ? base.multiply(scalar).add(TORSION_8).toBytes() : base.multiply(scalar).toBytes();
  for (let round = 0; ; round++) {
    const r = littleEndian(sha512(concat(label(`owner-mixed-order-${part}/${round}`), message))) % ED_L;
    const point = part === "R" ? base.multiply(r).add(TORSION_8).toBytes() : base.multiply(r).toBytes();
    const k = littleEndian(sha512(concat(point, publicKey, message))) % ED_L;
    // with a mixed-order key only k = 0 mod 8 would hold cofactorless: such a round is skipped
    if (part === "key" && k % 8n === 0n) continue;
    const signature = concat(point, scalarBytes((r + k * scalar) % ED_L));
    assert(ed25519.verify(signature, message, publicKey, { zip215: false }), `owner-mixed-order-${part} passes the cofactored check`);
    assert(!cofactorless(publicKey, signature, message), `owner-mixed-order-${part} fails the cofactorless check`);
    return { public_key: b64u(publicKey), member: record, signature: b64u(signature) };
  }
}
function ownerBlock(c: Controller, signer: Uint8Array = OWNER_SEED, open = true, version = 1): Obj {
  const record = { ...memberRecord(c, open), v: version };
  return { public_key: b64u(ed25519.getPublicKey(OWNER_SEED)), member: record, signature: b64u(ed25519.sign(memberMessage(record), signer)) };
}

function inviteFile(): Obj {
  const invite = {
    v: 1, id: INVITE_ID, slot: 3,
    controller: { server_id: CTRL.serverId, server_public_key: b64(CTRL.publicKey), relay: "wss://relay.ovis.example", direct: ["ws://192.168.1.20:17421", "ws://build-01.lan:17421"] },
    owner: ownerBlock(CTRL),
    secret: b64u(SECRET), exp: NOW_S + 3600,
  };
  const cases: Case[] = [];
  const bytes = (value: Json) => utf8(JSON.stringify(value));
  const bad = { stage: "decode", kind: "invalid_invite", code: "invalid_invite" } as const;
  const item = (name: string, value: Json, accepted: boolean): Case => ({ name, frame: "INVITE", type: null, stream_id: null, direction: "file", context: { mode: "0600" }, bytes: bytes(value), ...(accepted ? { parse: value as Obj } : { refuse: bad }) });
  const ctl = invite.controller;
  cases.push(
    item("invite/accept", invite, true),
    item("invite/direct-only", { ...invite, controller: { ...ctl, relay: null, direct: ["ws://100.101.102.103:17421"] } }, true),
    item("invite/version-2", { ...invite, v: 2 }, false),
    item("invite/short-secret", { ...invite, secret: b64u(SECRET.subarray(0, 31)) }, false),
    item("invite/server-id-mismatch", { ...invite, controller: { ...ctl, server_id: OTHER.serverId } }, false),
    item("invite/relay-not-wss", { ...invite, controller: { ...ctl, relay: "https://relay.ovis.example" } }, false),
    item("invite/public-direct-address", { ...invite, controller: { ...ctl, direct: ["ws://8.8.8.8:17421"] } }, false),
    item("invite/no-carrier", { ...invite, controller: { ...ctl, relay: null, direct: [] } }, false),
    item("invite/too-many-direct", { ...invite, controller: { ...ctl, direct: [1, 2, 3, 4, 5].map((n) => `ws://192.168.1.${n}:17421`) } }, false),
    item("invite/too-large", { ...invite, note: "n".repeat(4096) }, false),
    item("invite/no-owner", { ...invite, owner: undefined as unknown as Json }, false),
    item("invite/owner-signed-by-other-key", { ...invite, owner: ownerBlock(CTRL, OTHER_OWNER_SEED) }, false),
    item("invite/controller-rotated", { ...invite, controller: { ...ctl, server_id: OTHER.serverId, server_public_key: b64(OTHER.publicKey) } }, false),
    item("invite/member-may-not-open", { ...invite, owner: ownerBlock(CTRL, OWNER_SEED, false) }, false),
    item("invite/member-version-2", { ...invite, owner: ownerBlock(CTRL, OWNER_SEED, true, 2) }, false),
    item("invite/owner-small-order-key", { ...invite, owner: smallOrderOwner(CTRL) }, false),
    item("invite/owner-mixed-order-key", { ...invite, owner: mixedOrderOwner(CTRL, "key") }, false),
    item("invite/owner-mixed-order-r", { ...invite, owner: mixedOrderOwner(CTRL, "R") }, false),
  );
  cases.push(...inviteLines(bytes(invite)));
  const record = memberRecord(CTRL);
  const owner = { seed_hex: hex(OWNER_SEED), public_key: b64u(ed25519.getPublicKey(OWNER_SEED)), member_message_hex: hex(memberMessage(record)), signature: b64u(ed25519.sign(memberMessage(record), OWNER_SEED)) };
  return file("invite.json", { note: "secret is the same as enroll.json derivations.invite.secret", owner }, cases);
}

/**
 * The invite's single-line form (docs/fleet-link.md section 4): `ovis-invite:1:` and the file's bytes in canonical unpadded
 * base64url, at most INVITE_LINE_MAX bytes once the ASCII whitespace around it is dropped. A line that decodes is read as
 * the file it decodes to (`parse.file_hex`), so a tampered byte is the invite reader's refusal, not the line's.
 */
const INVITE_LINE_PREFIX = "ovis-invite:1:";
const INVITE_LINE_MAX = INVITE_LINE_PREFIX.length + Math.ceil(4096 * 4 / 3);
function inviteLines(file: Uint8Array): Case[] {
  const body = b64u(file);
  const line = `${INVITE_LINE_PREFIX}${body}`;
  assert(body.length % 4 !== 0, "the accepted invite's line has a last group to pad and to give unused bits");
  const bad = { stage: "decode", kind: "invalid_invite", code: "invalid_invite" } as const;
  const context = { max_bytes: INVITE_LINE_MAX };
  const accepted = (name: string, text: string, decoded: Uint8Array = file): Case => ({ name, frame: "INVITE_LINE", type: null, stream_id: null, direction: "file", context, bytes: utf8(text), parse: { file_hex: hex(decoded) } });
  const refused = (name: string, text: string): Case => ({ name, frame: "INVITE_LINE", type: null, stream_id: null, direction: "file", context, bytes: utf8(text), refuse: bad });
  // the last symbol with unused bits set: decodes to the same bytes under a lax decoder, so only canonical readers refuse it
  const last = body.at(-1)!;
  const URL_SYMBOLS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const loose = `${body.slice(0, -1)}${URL_SYMBOLS[URL_SYMBOLS.indexOf(last) | 1]}`;
  assert(loose !== body, "the accepted invite's last symbol has a free low bit");
  // one byte changed inside the owner's signature: the line is still canonical, the file it gives is refused
  const text = new TextDecoder().decode(file);
  const at = text.indexOf("\"signature\":\"") + "\"signature\":\"".length;
  const tampered = utf8(`${text.slice(0, at)}${text[at] === "A" ? "B" : "A"}${text.slice(at + 1)}`);
  return [
    accepted("invite_line/accept", line),
    accepted("invite_line/surrounding-whitespace", ` \t${line}\r\n`),
    { ...accepted("invite_line/tampered-byte", `${INVITE_LINE_PREFIX}${b64u(tampered)}`, tampered), refuse: { stage: "verify", kind: "invalid_invite", code: "invalid_invite" } },
    refused("invite_line/wrong-version", `ovis-invite:2:${body}`),
    refused("invite_line/no-prefix", body),
    refused("invite_line/padded", `${line}${"=".repeat(4 - (body.length % 4))}`),
    refused("invite_line/standard-alphabet", `${INVITE_LINE_PREFIX}+/${body.slice(2)}`),
    refused("invite_line/unused-bits-set", `${INVITE_LINE_PREFIX}${loose}`),
    refused("invite_line/inner-space", `${line.slice(0, 40)} ${line.slice(40)}`),
    refused("invite_line/empty", INVITE_LINE_PREFIX),
    refused("invite_line/too-long", `${INVITE_LINE_PREFIX}${"A".repeat(INVITE_LINE_MAX - INVITE_LINE_PREFIX.length + 1)}`),
  ];
}

function paceFile(): Obj {
  const cases: Case[] = [];
  // the two profiles of todo 37, as the controller computes them (server/fleet/relay-pace.ts)
  const hostedProfile = relayPace(30);
  const flagsProfile = relayPace(120);
  const hosted = { generation: 1, per_minute: hostedProfile.machine_per_minute, burst: hostedProfile.burst, slot: 7, span: 100, controller_ms: NOW_MS, rtt_ms: 42 };
  const flags = { generation: 2, per_minute: flagsProfile.machine_per_minute, burst: flagsProfile.burst, slot: 99, span: 100, controller_ms: NOW_MS + 600000, rtt_ms: 18 };
  // an accepted PACE is the controller's own encoder's bytes; a refused one is written by hand, since the encoder refuses it
  const pace = (payload: Obj) => {
    try { return encodeExtensionFrame(paceFrame(payload as unknown as RelayPace), pipeMuxExtension); }
    catch { return json(T.PACE, 0, payload); }
  };
  cases.push(
    { name: "pace/hosted", frame: "PACE", type: T.PACE, stream_id: 0, direction: "controller_to_machine", context: after(), bytes: pace(hosted), parse: hosted, effect: "the machine keeps offset = controller_ms - its monotonic clock at receipt, error bound rtt_ms" },
    { name: "pace/fleet-flags", frame: "PACE", type: T.PACE, stream_id: 0, direction: "controller_to_machine", context: after(), bytes: pace(flags), parse: flags },
    { name: "pace/from-machine", frame: "PACE", type: T.PACE, stream_id: 0, direction: "machine_to_controller", context: after(), bytes: pace(hosted), parse: hosted, refuse: protocolError() },
    { name: "pace/before-auth", frame: "PACE", type: T.PACE, stream_id: 0, direction: "controller_to_machine", context: before(), bytes: pace(hosted), parse: hosted, refuse: protocolError() },
    { name: "pace/slot-not-below-span", frame: "PACE", type: T.PACE, stream_id: 0, direction: "controller_to_machine", context: after(), bytes: pace({ ...hosted, slot: 100 }), refuse: protocolError("decode") },
    { name: "pace/per-minute-zero", frame: "PACE", type: T.PACE, stream_id: 0, direction: "controller_to_machine", context: after(), bytes: pace({ ...hosted, per_minute: 0 }), refuse: protocolError("decode") },
    { name: "pace/cycle-under-a-minute", frame: "PACE", type: T.PACE, stream_id: 0, direction: "controller_to_machine", context: after(), bytes: pace({ ...hosted, slot: 7, span: 10 }), refuse: protocolError("decode") },
    { name: "pace/rtt-above-pong-deadline", frame: "PACE", type: T.PACE, stream_id: 0, direction: "controller_to_machine", context: after(), bytes: pace({ ...hosted, rtt_ms: 60001 }), refuse: protocolError("decode") },
  );
  const next = (slot: number, span: number, spacing: number, loss: number) => nextPaceInstant({ slot, span, spacing_ms: spacing }, loss);
  const derivations: Obj = {
    note: "Restates todo 37's formulas as numbers; todo 37 owns them.",
    profiles: [{ ...hostedProfile }, { ...flagsProfile }],
    default_slot: { machine_id: A.id, rule: "first four hex digits of machine_id, mod 100", slot: defaultPaceSlot(A.id) },
    next_instant: [
      { slot: 7, span: 100, spacing_ms: 2500, loss_controller_ms: NOW_MS, instant_controller_ms: next(7, 100, 2500, NOW_MS) },
      { slot: 99, span: 100, spacing_ms: 625, loss_controller_ms: NOW_MS + 1, instant_controller_ms: next(99, 100, 625, NOW_MS + 1) },
    ],
  };
  return file("pace.json", derivations, cases);
}

// ---- records.json: the Noise NK handshake and protected records of shared/vendor/paseo-e2ee ----

const PROLOGUE = utf8("paseo-relay-e2ee/1");
/** secure-channel.ts encodeParams: version 1, flag 0x01 binary ciphertext. The link agent offers it; the daemon echoes it. */
const PARAMS = Uint8Array.of(0x01, 0x01);
const MAX_NONCE = (1n << 64n) - 1n;
const keyPair = (secretKey: Uint8Array) => ({ secretKey: secretKey.slice(), publicKey: x25519.getPublicKey(secretKey) });
/** Large frames carry byte i = i mod 251, named by length so the file stays small. */
const pattern = (length: number) => Uint8Array.from({ length }, (_, i) => i % 251);
type Data = { kind: FrameKind; data_hex: string } | { kind: FrameKind; length: number; pattern: "mod251" };
const dataOf = (kind: FrameKind, bytes: Uint8Array): Data =>
  bytes.length > 64 && bytes.every((byte, i) => byte === i % 251) ? { kind, length: bytes.length, pattern: "mod251" } : { kind, data_hex: hex(bytes) };
/** What the TypeScript code throws for an input, as the error text both implementations report. */
function refusal(run: () => unknown): string {
  try { run(); } catch (error) {
    assert(error instanceof NoiseProtocolError, `expected a NoiseProtocolError, got ${String(error)}`);
    return error.message;
  }
  throw new Error("fleet-vectors: expected a refusal");
}

/** The reference handshake, run again from fixed keys for every case so each starts from the same state. */
function handshake(responderSecret = label("records/responder-static"), pinned = x25519.getPublicKey(label("records/responder-static"))) {
  const initiator = createNoiseInitiator({ remoteStatic: pinned, prologue: PROLOGUE, ephemeral: keyPair(label("records/initiator-ephemeral")) });
  const responder = createNoiseResponder({ localStatic: keyPair(responderSecret), prologue: PROLOGUE, ephemeral: keyPair(label("records/responder-ephemeral")) });
  const message1 = initiator.writeMessage(PARAMS);
  return { initiator, responder, message1 };
}
function opened() {
  const { initiator, responder, message1 } = handshake();
  assert(hex(responder.readMessage(message1)) === hex(PARAMS), "responder reads the offered parameters");
  const message2 = responder.writeMessage(PARAMS);
  assert(hex(initiator.readMessage(message2)) === hex(PARAMS), "initiator reads the selected parameters");
  const hash = initiator.handshakeHash();
  assert(hex(hash) === hex(responder.handshakeHash()), "both ends hold one handshake hash");
  return { message1, message2, hash, initiator: initiator.split(), responder: responder.split() };
}

/** shared/relay-e2ee.ts guardCarrier, run for real: the close reason a client gives a carrier message of `bytes` bytes. */
async function carrierRefusal(bytes: number): Promise<string | null> {
  let reason: string | null = null;
  const transport: Transport = {
    send: () => {},
    close: (code, why) => { reason ??= why ?? ""; queueMicrotask(() => transport.onclose?.(code ?? 1000, why ?? "")); },
    onmessage: null, onclose: null, onerror: null,
  };
  const channel = await openClientSecureChannel(transport, { daemonPublicKeyB64: b64(x25519.getPublicKey(label("records/responder-static"))) });
  transport.onmessage?.({ data: new ArrayBuffer(bytes), isBinary: true });
  const refused: string | null = reason;
  channel.close();
  return refused;
}

async function recordsFile(): Promise<Obj> {
  const responderSecret = label("records/responder-static");
  const responderPublic = x25519.getPublicKey(responderSecret);
  const session = opened();
  const binding = bindingOf(responderPublic, session.message1, session.message2);

  // The transcript: what each end sends, in order, on the channel the derivations open.
  const records: Obj[] = [];
  const send = (name: string, direction: "initiator_to_responder" | "responder_to_initiator", kind: FrameKind, data: Uint8Array) => {
    const toResponder = direction === "initiator_to_responder";
    const wire = encodeProtectedRecord(kind, data, toResponder ? session.initiator.send : session.responder.send);
    const decoded = decodeProtectedRecord(wire, toResponder ? session.responder.receive : session.initiator.receive);
    assert(decoded.kind === kind && hex(decoded.data) === hex(data), `${name} round-trips`);
    assert(wire.length <= MAX_CARRIER_BINARY_BYTES, `${name} fits a carrier message`);
    records.push({ name, direction, ...dataOf(kind, data), wire_hex: hex(wire) });
    return wire;
  };
  send("records/transcript/initiator-first", "initiator_to_responder", "binary", utf8("ovis-link records/1"));
  const first = send("records/transcript/responder-binary", "responder_to_initiator", "binary", Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0));
  const second = send("records/transcript/responder-text", "responder_to_initiator", "text", utf8("{\"hello\":\"link\"}"));
  send("records/transcript/initiator-text", "initiator_to_responder", "text", utf8("text from the link agent"));
  send("records/transcript/responder-empty", "responder_to_initiator", "binary", new Uint8Array(0));
  send("records/transcript/initiator-largest-mux-frame", "initiator_to_responder", "binary", pattern(MAX_FRAME_BYTES));
  send("records/transcript/responder-largest-mux-frame", "responder_to_initiator", "binary", pattern(MAX_FRAME_BYTES));

  const cases: Obj[] = [];
  // Handshake: the initiator writes message 1 from the fixed ephemeral and reads this message 2.
  const handshakeCase = (name: string, why: string, message2: Uint8Array, pinned = responderPublic) => {
    const { initiator } = handshake(responderSecret, pinned);
    const error = refusal(() => initiator.readMessage(message2));
    cases.push({ name, stage: "handshake", why, input: { pinned_responder_public_hex: hex(pinned), message_2_hex: hex(message2) }, expect: { refuse: { error } } });
  };
  const flipped = (bytes: Uint8Array, at: number) => { const out = bytes.slice(); out[at]! ^= 0x01; return out; };
  handshakeCase("records/handshake/message-2-flipped-ciphertext-byte", "one bit of message 2's encrypted payload changed", flipped(session.message2, 40));
  handshakeCase("records/handshake/message-2-flipped-ephemeral-byte", "one bit of the responder's ephemeral key changed", flipped(session.message2, 0));
  handshakeCase("records/handshake/message-2-truncated", "message 2 cut inside the ephemeral key", session.message2.subarray(0, 20));
  {
    // a responder holding another static key answers a message 1 that was written to it
    const otherSecret = label("records/responder-other");
    const other = handshake(otherSecret, x25519.getPublicKey(otherSecret));
    other.responder.readMessage(other.message1);
    const answer = other.responder.writeMessage(PARAMS);
    handshakeCase("records/handshake/wrong-responder-key", "message 2 from a responder with another static key than the pinned one", answer);
  }

  // Records: delivered in this order to the initiator of a fresh run of the derivations' handshake.
  const recordCase = (name: string, why: string, deliver: Uint8Array[]) => {
    const { initiator } = opened();
    const frames: Obj[] = [];
    let refuse: Obj | undefined;
    for (const [step, wire] of deliver.entries()) {
      if (wire.length > MAX_CARRIER_BINARY_BYTES) { refuse = { step, error: "carrier" }; break; }
      try {
        const frame = decodeProtectedRecord(wire, initiator.receive);
        frames.push(dataOf(frame.kind, frame.data));
      } catch (error) {
        assert(error instanceof NoiseProtocolError, `${name}: ${String(error)}`);
        refuse = { step, error: error.message };
        break;
      }
    }
    cases.push({ name, stage: "record", why, input: { deliver_hex: deliver.map(hex) }, expect: refuse ? { frames, refuse } : { frames } });
  };
  recordCase("records/record/in-order", "the responder's first two records, in order", [first, second]);
  recordCase("records/record/replayed", "the first record delivered twice: its nonce was used", [first, first]);
  recordCase("records/record/out-of-order", "the second record before the first", [second, first]);
  recordCase("records/record/truncated", "the first record without its last byte", [first.subarray(0, first.length - 1)]);
  recordCase("records/record/length-prefix-only", "one byte of the length prefix", [first.subarray(0, 1)]);
  recordCase("records/record/flipped-byte", "one bit of the first record's ciphertext changed", [flipped(first, 4)]);
  {
    const fresh = opened();
    const tooLarge = encodeProtectedRecord("binary", pattern(MAX_FRAME_BYTES + 1), fresh.responder.send);
    assert(tooLarge.length === MAX_CARRIER_BINARY_BYTES + 1, "the oversized record is one byte above the carrier limit");
    const reason = await carrierRefusal(tooLarge.length);
    assert(reason !== null && (await carrierRefusal(MAX_CARRIER_BINARY_BYTES)) === null, "shared/relay-e2ee.ts refuses exactly the oversized carrier message");
    recordCase("records/record/over-carrier-limit", "a valid record of a mux frame one byte too large: refused before it is decrypted", [tooLarge]);
    const entry = cases.at(-1) as { expect: { refuse: Obj } };
    entry.expect.refuse["error"] = reason;
  }

  // Codec: one record through a bare CipherState at a given key and counter, with no carrier limit.
  const codecKey = label("records/codec-key");
  const cipher = (nonce: bigint) => { const state = new CipherState(); state.initializeKey(codecKey.slice(), nonce); return state; };
  const encodeCase = (name: string, why: string, nonce: bigint, kind: FrameKind, data: Uint8Array) => {
    const sender = cipher(nonce);
    let wire: Uint8Array | undefined;
    const error = (() => { try { wire = encodeProtectedRecord(kind, data, sender); return undefined; } catch (thrown) { assert(thrown instanceof NoiseProtocolError, name); return thrown.message; } })();
    cases.push({ name, stage: "encode", why, input: { key_hex: hex(codecKey), nonce: nonce.toString(), frame: dataOf(kind, data) }, expect: wire ? { wire_hex: hex(wire), next_nonce: sender.nonce().toString() } : { refuse: { error: error! } } });
    return wire;
  };
  /** `from` names an encode case whose wire this case reads, cut to `wire.length` bytes, so large records appear once. */
  const decodeCase = (name: string, why: string, nonce: bigint, wire: Uint8Array, from?: string) => {
    const receiver = cipher(nonce);
    let frame: { kind: FrameKind; data: Uint8Array } | undefined;
    const error = (() => { try { frame = decodeProtectedRecord(wire, receiver); return undefined; } catch (thrown) { assert(thrown instanceof NoiseProtocolError, name); return thrown.message; } })();
    const source: Obj = from ? { wire_from: from, wire_length: wire.length } : { wire_hex: hex(wire) };
    cases.push({ name, stage: "decode", why, input: { key_hex: hex(codecKey), nonce: nonce.toString(), ...source }, expect: frame ? { frame: dataOf(frame.kind, frame.data), next_nonce: receiver.nonce().toString() } : { refuse: { error: error! } } });
  };
  const twoChunks = encodeCase("records/codec/two-chunks", "a frame one byte above a chunk's data, split in two chunks", 0n, "binary", pattern(MAX_CHUNK_DATA_BYTES + 1))!;
  decodeCase("records/codec/two-chunks-decoded", "the two-chunk record read back", 0n, twoChunks, "records/codec/two-chunks");
  decodeCase("records/codec/second-chunk-dropped", "the two-chunk record without its final chunk", 0n, twoChunks.subarray(0, 2 + MAX_CHUNK_DATA_BYTES + 6 + 16), "records/codec/two-chunks");
  const below = encodeCase("records/nonce/encrypt-below-maximum", "the last nonce a sender may use: 2^64 - 2", MAX_NONCE - 1n, "binary", utf8("last"))!;
  encodeCase("records/nonce/encrypt-at-maximum", "the counter at 2^64 - 1, reserved by Noise: nothing is sent", MAX_NONCE, "binary", utf8("never"));
  decodeCase("records/nonce/decrypt-below-maximum", "the last record a receiver may accept", MAX_NONCE - 1n, below);
  decodeCase("records/nonce/decrypt-at-maximum", "a receiver whose counter reached 2^64 - 1 accepts nothing", MAX_NONCE, below);
  // chunks the encoder never writes, sealed by hand under the codec key, as a forger with the key could
  const chunk = (kind: number, flags: number, total: number, data: Uint8Array) => {
    const plaintext = concat(Uint8Array.of(kind, flags), u32be(total), data);
    const ciphertext = cipher(0n).encryptWithAd(new Uint8Array(0), plaintext);
    return concat(Uint8Array.of(ciphertext.length >> 8, ciphertext.length & 0xff), ciphertext);
  };
  decodeCase("records/codec/reserved-flag", "a chunk with flag 0x04 set", 0n, chunk(1, 0x07, 2, Uint8Array.of(9, 9)));
  decodeCase("records/codec/unknown-kind", "a chunk of kind 2", 0n, chunk(2, 0x03, 2, Uint8Array.of(9, 9)));
  decodeCase("records/codec/not-first", "a single chunk without FIRST", 0n, chunk(1, 0x02, 2, Uint8Array.of(9, 9)));
  decodeCase("records/codec/length-mismatch", "a header that claims more bytes than the record holds", 0n, chunk(1, 0x03, 3, Uint8Array.of(9, 9)));
  decodeCase("records/codec/short-chunk-length", "a length prefix below a chunk's header and tag", 0n, Uint8Array.of(0, 21, ...new Uint8Array(21)));

  const derivations: Obj = {
    protocol: "Noise_NK_25519_ChaChaPoly_SHA256",
    prologue_hex: hex(PROLOGUE),
    responder_static_secret_hex: hex(responderSecret),
    responder_static_public_hex: hex(responderPublic),
    initiator_ephemeral_secret_hex: hex(label("records/initiator-ephemeral")),
    responder_ephemeral_secret_hex: hex(label("records/responder-ephemeral")),
    offered_params_hex: hex(PARAMS),
    selected_params_hex: hex(PARAMS),
    message_1_hex: hex(session.message1),
    message_2_hex: hex(session.message2),
    handshake_hash_hex: hex(session.hash),
    channel_binding: { layout: "SHA-256(\"ovis-relay-channel-binding/1\" || responder static public (32) || u32be(len) || message 1 || u32be(len) || message 2), shared/relay-e2ee.ts channelBinding", binding_hex: hex(binding) },
    limits: {
      max_chunk_data_bytes: MAX_CHUNK_DATA_BYTES, max_mux_frame_bytes: MAX_FRAME_BYTES,
      max_carrier_binary_bytes: MAX_CARRIER_BINARY_BYTES, max_carrier_text_bytes: MAX_CARRIER_TEXT_BYTES,
      max_nonce: MAX_NONCE.toString(),
    },
    data_pattern: "a frame given as {length, pattern: mod251} carries byte i = i mod 251",
  };
  return { file: "records.json", contract: "docs/fleet-link.md", generated_by: "scripts/fleet-vectors.ts", test_only: TEST_ONLY, derivations, records, cases };
}


// ---- machine-files.json: the two files ovis-link run reads from its state folder (todo 24) ----
function machineFilesFile(): Obj {
  const cases: Case[] = [];
  const bytes = (value: Json) => utf8(JSON.stringify(value));
  const item = (name: string, frame: "FLEET_FILE" | "ADVERT_FILE", value: Json, code: string | null): Case => ({
    name, frame, type: null, stream_id: null, direction: "file", context: { mode: "0600", max_bytes: 16384 }, bytes: bytes(value),
    ...(code === null ? { parse: value as Obj } : { refuse: { stage: "decode", kind: "invalid_file", code } }),
  });
  const ctl = { server_id: CTRL.serverId, server_public_key: b64(CTRL.publicKey), relay: "wss://relay.ovis.example", direct: ["ws://192.168.1.20:7319", "ws://build-01.lan:7319"] };
  const fleet = { v: 1, controller: ctl, owner: ownerBlock(CTRL), machine_key_file: "/home/ovis/.local/share/ovis-fleet/machine.key" };
  const fleetBad = "invalid_fleet";
  cases.push(
    item("files/fleet/accept", "FLEET_FILE", fleet, null),
    item("files/fleet/direct-only", "FLEET_FILE", { ...fleet, controller: { ...ctl, relay: null, direct: ["ws://100.101.102.103:7319"] } }, null),
    item("files/fleet/loopback-relay", "FLEET_FILE", { ...fleet, controller: { ...ctl, relay: "ws://127.0.0.1:8787", direct: [] } }, null),
    // the relay pace the agent saved from its controller's PACE (todo 37)
    item("files/fleet/with-relay-pace", "FLEET_FILE", { ...fleet, relay_pace: { generation: 2, per_minute: 96, burst: 22, slot: 41, span: 100, controller_ms: NOW_MS, rtt_ms: 18 } }, null),
    item("files/fleet/version-2", "FLEET_FILE", { ...fleet, v: 2 }, fleetBad),
    item("files/fleet/key-mismatch", "FLEET_FILE", { ...fleet, controller: { ...ctl, server_public_key: b64(OTHER.publicKey) } }, "controller_key_mismatch"),
    item("files/fleet/relay-not-wss", "FLEET_FILE", { ...fleet, controller: { ...ctl, relay: "https://relay.ovis.example" } }, fleetBad),
    item("files/fleet/relay-with-path", "FLEET_FILE", { ...fleet, controller: { ...ctl, relay: "wss://relay.ovis.example/v1" } }, fleetBad),
    item("files/fleet/plain-relay-off-loopback", "FLEET_FILE", { ...fleet, controller: { ...ctl, relay: "ws://192.168.1.5:8787" } }, fleetBad),
    item("files/fleet/public-direct-address", "FLEET_FILE", { ...fleet, controller: { ...ctl, direct: ["ws://8.8.8.8:7319"] } }, fleetBad),
    item("files/fleet/too-many-direct", "FLEET_FILE", { ...fleet, controller: { ...ctl, direct: [1, 2, 3, 4, 5].map((n) => `ws://192.168.1.${n}:7319`) } }, fleetBad),
    item("files/fleet/no-carrier", "FLEET_FILE", { ...fleet, controller: { ...ctl, relay: null, direct: [] } }, fleetBad),
    item("files/fleet/relative-key-file", "FLEET_FILE", { ...fleet, machine_key_file: "machine.key" }, fleetBad),
    item("files/fleet/too-large", "FLEET_FILE", { ...fleet, note: "n".repeat(16384) }, fleetBad),
    item("files/fleet/with-invite", "FLEET_FILE", { ...fleet, invite: { id: INVITE_ID, secret: b64u(SECRET) } }, null),
    item("files/fleet/invite-short-secret", "FLEET_FILE", { ...fleet, invite: { id: INVITE_ID, secret: b64u(SECRET.subarray(0, 31)) } }, fleetBad),
    item("files/fleet/invite-without-id", "FLEET_FILE", { ...fleet, invite: { secret: b64u(SECRET) } }, fleetBad),
    item("files/fleet/no-owner", "FLEET_FILE", { ...fleet, owner: undefined as unknown as Json }, fleetBad),
    item("files/fleet/owner-signed-by-other-key", "FLEET_FILE", { ...fleet, owner: ownerBlock(CTRL, OTHER_OWNER_SEED) }, "controller_not_member"),
    item("files/fleet/member-may-not-open", "FLEET_FILE", { ...fleet, owner: ownerBlock(CTRL, OWNER_SEED, false) }, "controller_not_member"),
    item("files/fleet/owner-small-order-key", "FLEET_FILE", { ...fleet, owner: smallOrderOwner(CTRL) }, "controller_not_member"),
    item("files/fleet/owner-mixed-order-key", "FLEET_FILE", { ...fleet, owner: mixedOrderOwner(CTRL, "key") }, "controller_not_member"),
    item("files/fleet/owner-mixed-order-r", "FLEET_FILE", { ...fleet, owner: mixedOrderOwner(CTRL, "R") }, "controller_not_member"),
    item("files/fleet/member-version-2", "FLEET_FILE", { ...fleet, owner: ownerBlock(CTRL, OWNER_SEED, true, 2) }, fleetBad),
    item("files/fleet/controller-rotated", "FLEET_FILE", { ...fleet, controller: { ...ctl, server_id: OTHER.serverId, server_public_key: b64(OTHER.publicKey) } }, "controller_not_member"),
  );
  const versions = { server: "0.5.0", agent: "0.5.0", runtime: "0.9.1" };
  const advert = {
    v: 1, runtime_id: "rt-fleet-1", boot_id: "boot-1", bridge_port: 17421, bridge_token: hex(label("advert/bridge-token")),
    native_bearer: `ovb_${b64u(label("advert/native-bearer"))}`, native_socket: "/run/user/1000/ovis-runtime/default.sock", runtime_down: false, versions,
  };
  const { native_bearer: _bearer, native_socket: _socket, ...bridgeOnly } = advert;
  const { bridge_port: _port, bridge_token: _token, ...nativeOnly } = advert;
  const advertBad = "invalid_advert";
  cases.push(
    item("files/advert/accept", "ADVERT_FILE", advert, null),
    item("files/advert/bridge-only", "ADVERT_FILE", bridgeOnly, null),
    item("files/advert/runtime-down", "ADVERT_FILE", { ...nativeOnly, runtime_down: true }, null),
    item("files/advert/version-2", "ADVERT_FILE", { ...advert, v: 2 }, advertBad),
    item("files/advert/port-without-token", "ADVERT_FILE", { ...nativeOnly, bridge_port: 17421 }, advertBad),
    item("files/advert/short-token", "ADVERT_FILE", { ...advert, bridge_token: advert.bridge_token.slice(1) }, advertBad),
    item("files/advert/bearer-with-space", "ADVERT_FILE", { ...advert, native_bearer: "ovb has space" }, advertBad),
    item("files/advert/no-endpoint", "ADVERT_FILE", { v: 1, runtime_id: "rt-fleet-1", boot_id: "boot-1", versions }, advertBad),
    item("files/advert/relative-socket", "ADVERT_FILE", { ...advert, native_socket: "core.sock" }, advertBad),
    item("files/advert/runtime-down-not-boolean", "ADVERT_FILE", { ...advert, runtime_down: "yes" }, advertBad),
    item("files/advert/no-versions", "ADVERT_FILE", { ...bridgeOnly, versions: undefined as unknown as Json }, advertBad),
    item("files/advert/too-large", "ADVERT_FILE", { ...advert, note: "n".repeat(16384) }, advertBad),
  );
  return file("machine-files.json", { note: "fleet.json's controller is auth.json's; ovis-link run reads both files through its private-file reader (regular file, mode 0600 or stricter, no symbolic link, at most max_bytes)" }, cases);
}

function file(name: string, derivations: Obj, cases: Case[]): Obj {
  return {
    file: name, contract: "docs/fleet-link.md", generated_by: "scripts/fleet-vectors.ts", test_only: TEST_ONLY,
    derivations,
    cases: cases.map((entry) => ({
      name: entry.name, frame: entry.frame, type: entry.type, stream_id: entry.stream_id, direction: entry.direction,
      context: entry.context, bytes: hex(entry.bytes),
      expect: {
        ...(entry.parse ? { parse: entry.parse } : {}),
        ...(entry.refuse ? { refuse: entry.refuse as unknown as Obj } : {}),
        ...(entry.effect ? { effect: entry.effect } : {}),
      },
      ...(entry.limit ? { limit: entry.limit } : {}),
      ...(entry.canonical === false ? { canonical: false } : {}),
    })),
  };
}

const files = [await authFile(), pipeFile(), await enrollFile(), inviteFile(), machineFilesFile(), paceFile(), await recordsFile()];
const check = process.argv.includes("--check");
let differ = 0;
for (const data of files) {
  const path = join(DIR, String(data["file"]));
  const text = `${JSON.stringify(data, null, 2)}\n`;
  if (!check) { writeFileSync(path, text); continue; }
  let current: string | null = null;
  try { current = readFileSync(path, "utf8"); } catch { /* missing counts as different */ }
  if (current !== text) { differ++; console.log(`DIFFERS ${data["file"]}`); }
}
const count = files.reduce((sum, data) => sum + (data["cases"] as Json[]).length, 0);
if (!check) console.log(`fleet vectors: wrote ${files.length} files, ${count} cases`);
else if (differ) { console.log(`fleet vectors: ${differ} of ${files.length} files differ from what scripts/fleet-vectors.ts generates`); process.exit(1); }
else console.log(`fleet vectors: ${files.length} files, ${count} cases, equal to what scripts/fleet-vectors.ts generates`);
