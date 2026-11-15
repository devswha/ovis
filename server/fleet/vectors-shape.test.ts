/**
 * The shape of the fleet link's shared test vectors (docs/fleet-link.md, "Vector files"). No codec is
 * used here: each codec's own vector test is written by the todo that implements it. What this checks:
 * every file parses, every case names a frame, its type, its bytes and what a receiver must do with
 * them, and the invite key and every ENROLL signature in enroll.json reproduce from their inputs with
 * WebCrypto alone.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dir, "vectors");
const FILES = ["auth.json", "enroll.json", "invite.json", "machine-files.json", "pace.json", "pipe-frames.json"] as const;
/** Noise records, not mux frames: its own shape, checked below, and its bytes by the Rust tests of crates/fleet-link. */
const RECORDS = "records.json";
const RECORD_STAGES = ["handshake", "record", "encode", "decode"];
const DIRECTIONS = ["machine_to_controller", "controller_to_machine", "file"];
const STAGES = ["decode", "verify", "session"];
const KINDS = ["session_error", "reset", "invalid_invite", "invalid_file"];

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);
const utf8 = (text: string) => new TextEncoder().encode(text);
const fromHex = (hex: string): Uint8Array<ArrayBuffer> => new Uint8Array((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));
const toHex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const fromB64u = (text: string): Uint8Array<ArrayBuffer> => new Uint8Array([...atob(text.replace(/-/g, "+").replace(/_/g, "/"))].map((c) => c.charCodeAt(0)));
const toB64u = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const concat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
};

function load(file: string): { data?: Obj; error?: string } {
  try {
    const data: unknown = JSON.parse(readFileSync(join(DIR, file), "utf8"));
    return isObj(data) ? { data } : { error: "not a JSON object" };
  } catch (error) { return { error: String(error) }; }
}
const loaded = Object.fromEntries([...FILES, RECORDS].map((file) => [file, load(file)]));
const casesOf = (file: string): Obj[] => {
  const cases = loaded[file]?.data?.["cases"];
  return Array.isArray(cases) ? cases.filter(isObj) : [];
};

/** Seed of the invite's Ed25519 key: HKDF-SHA256(secret, salt empty, "ovis-fleet-invite/1" || invite id, 32). */
async function inviteSeed(secret: Uint8Array<ArrayBuffer>, inviteId: string): Promise<Uint8Array<ArrayBuffer>> {
  const ikm = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"]);
  const info = utf8(`ovis-fleet-invite/1${inviteId}`);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info }, ikm, 256));
}
/** RFC 8032 seed as PKCS#8 (RFC 8410), the form WebCrypto imports an Ed25519 private key in. */
function seedKey(seed: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const prefix = fromHex("302e020100300506032b657004220420");
  return crypto.subtle.importKey("pkcs8", concat(prefix, seed), { name: "Ed25519" }, true, ["sign"]);
}
async function publicFromSeed(seed: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const jwk = await crypto.subtle.exportKey("jwk", await seedKey(seed));
  return fromB64u(jwk.x ?? "");
}
const enrollMessage = (binding: Uint8Array, spki: Uint8Array, inviteId: string) =>
  concat(utf8("ovis-fleet-enroll/1"), binding, spki, utf8(inviteId));

describe("fleet link vectors", () => {
  it("are exactly the seven files of the contract", () => {
    expect(readdirSync(DIR).filter((name) => name.endsWith(".json")).sort()).toEqual([...FILES, RECORDS].sort());
  });

  it("give every case a name used once across all files", () => {
    const records = loaded[RECORDS]?.data ?? {};
    const transcript = Array.isArray(records["records"]) ? records["records"].filter(isObj) : [];
    const names = [...FILES, RECORDS].flatMap((file) => casesOf(file).map((entry) => entry["name"])).concat(transcript.map((entry) => entry["name"]));
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
  });
});

for (const file of FILES) {
  describe(file, () => {
    it("parses, says it is test-only and holds cases", () => {
      expect(loaded[file]?.error).toBeUndefined();
      const data = loaded[file]?.data ?? {};
      expect(data["file"]).toBe(file);
      expect(String(data["test_only"])).toContain("test");
      expect(casesOf(file).length).toBeGreaterThan(0);
    });

    for (const entry of casesOf(file)) {
      const name = String(entry["name"]);
      it(name, () => {
        expect(name).toMatch(/^[a-z0-9_]+\/[a-z0-9_/-]+$/);
        expect(String(entry["frame"])).toMatch(/^[A-Z][A-Z0-9_]*$/);
        expect(DIRECTIONS).toContain(entry["direction"] as string);
        const type = entry["type"];
        if (entry["direction"] === "file") expect(type).toBeNull();
        else expect(Number.isInteger(type) && (type as number) >= 1 && (type as number) <= 0xff).toBe(true);
        const bytes = entry["bytes"];
        expect(typeof bytes === "string" && /^(?:[0-9a-f]{2})+$/.test(bytes)).toBe(true);
        const expected = entry["expect"];
        expect(isObj(expected)).toBe(true);
        const { parse, refuse } = expected as Obj;
        expect(parse !== undefined || refuse !== undefined).toBe(true);
        if (refuse !== undefined) {
          expect(isObj(refuse)).toBe(true);
          const r = refuse as Obj;
          expect(STAGES).toContain(r["stage"] as string);
          expect(KINDS).toContain(r["kind"] as string);
          expect(String(r["code"])).toMatch(/^[a-z_]+$/);
          // a frame the codec refuses has no parse; one refused later was parsed first
          if (r["stage"] === "decode") expect(parse).toBeUndefined();
          else expect(isObj(parse)).toBe(true);
        } else expect(isObj(parse)).toBe(true);
        const frame = fromHex(String(bytes));
        if (typeof type === "number" && (refuse as Obj | undefined)?.["stage"] !== "decode") {
          // the 8-byte envelope: version 1, type, u16 flags, u32 stream id, all big-endian
          expect(frame.length).toBeGreaterThanOrEqual(8);
          expect(frame[0]).toBe(1);
          expect(frame[1]).toBe(type);
          expect(new DataView(frame.buffer).getUint32(4)).toBe(entry["stream_id"] as number);
        }
      });
    }
  });
}

describe(RECORDS, () => {
  const data = loaded[RECORDS]?.data ?? {};
  it("parses, says it is test-only and holds a handshake, a transcript and cases", () => {
    expect(loaded[RECORDS]?.error).toBeUndefined();
    expect(data["file"]).toBe(RECORDS);
    expect(String(data["test_only"])).toContain("test");
    const derivations = isObj(data["derivations"]) ? data["derivations"] : {};
    for (const key of ["message_1_hex", "message_2_hex", "responder_static_public_hex", "initiator_ephemeral_secret_hex", "handshake_hash_hex"]) {
      expect(String(derivations[key])).toMatch(/^(?:[0-9a-f]{2})+$/);
    }
    expect(Array.isArray(data["records"]) && data["records"].length > 0).toBe(true);
    expect(casesOf(RECORDS).length).toBeGreaterThan(0);
  });

  for (const entry of casesOf(RECORDS)) {
    it(String(entry["name"]), () => {
      expect(String(entry["name"])).toMatch(/^records\/[a-z0-9_/-]+$/);
      expect(RECORD_STAGES).toContain(entry["stage"] as string);
      expect(isObj(entry["input"]) && isObj(entry["expect"])).toBe(true);
      const refuse = (entry["expect"] as Obj)["refuse"];
      if (refuse !== undefined) expect(String((refuse as Obj)["error"]).length).toBeGreaterThan(0);
    });
  }
});

describe("enroll.json reproduces with WebCrypto", () => {
  const data = loaded["enroll.json"]?.data ?? {};
  const invite = isObj(data["derivations"]) && isObj(data["derivations"]["invite"]) ? data["derivations"]["invite"] : undefined;

  it("derives the invite key from its secret", async () => {
    expect(invite).toBeDefined();
    const { secret, invite_id, info_hex, seed_hex, public_key_hex } = invite as Record<string, string>;
    expect(toHex(utf8(`ovis-fleet-invite/1${invite_id}`))).toBe(info_hex!);
    const seed = await inviteSeed(fromB64u(secret!), invite_id!);
    expect(toHex(seed)).toBe(seed_hex!);
    expect(toHex(await publicFromSeed(seed))).toBe(public_key_hex!);
  });

  for (const entry of casesOf("enroll.json")) {
    const context = isObj(entry["context"]) ? entry["context"] : {};
    const signed = context["signed"];
    if (!isObj(signed)) continue;
    const name = String(entry["name"]);
    it(`${name}: signature`, async () => {
      const parse = (entry["expect"] as Obj)["parse"] as Record<string, string>;
      const seed = await inviteSeed(fromB64u(String(signed["secret"])), String(signed["invite_id"]));
      const message = enrollMessage(fromHex(String(signed["binding_hex"])), fromB64u(String(signed["machine_public_key"])), String(signed["invite_id"]));
      const signature = toB64u(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, await seedKey(seed), message)));
      expect(parse["signature"]).toBe(signature);
      expect(new TextDecoder().decode(fromHex(String(entry["bytes"])).subarray(8))).toContain(`"signature":"${signature}"`);
      const verifier = context["verifier"];
      if (!isObj(verifier)) return;
      // what the controller checks: its stored public key, this session's binding, the frame's own key and id
      const key = await crypto.subtle.importKey("raw", fromHex(String(verifier["invite_public_key_hex"])), { name: "Ed25519" }, false, ["verify"]);
      const checked = enrollMessage(fromHex(String(verifier["binding_hex"])), fromB64u(parse["machine_public_key"]!), parse["invite_id"]!);
      const holds = await crypto.subtle.verify({ name: "Ed25519" }, key, fromB64u(signature), checked);
      expect(holds).toBe(verifier["holds"] as boolean);
    });
  }
});
