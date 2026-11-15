/**
 * The fleet's owner key and its first member (docs/fleet-link.md, "Owner key and members"). A machine pins the OWNER key,
 * not one controller: the controller's own key travels as a member record the owner key signed, so a later member list
 * adds controllers without enrolling machines again. With one member nothing visible changes: the machine still finishes
 * its handshake only with the pinned controller key, and refuses a controller the owner key did not sign.
 *
 * The owner key is an Ed25519 key made once per fleet, by the explicit step that turns the fleet on: `ovis-server fleet
 * owner` on the controller (server/fleet/cli.ts), never as a side effect of anything else. Its secret half is
 * `<state>/fleet/owner.json` (0600, written once, never replaced), and its recovery phrase is shown once by that step,
 * only to a terminal or to a file the operator names (0600). No HTTP answer, log line or error carries either; minting
 * invites before the step is refused `owner_key_missing`.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign as signBytes } from "node:crypto";
import { linkSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { deriveServerId } from "../../shared/relay-server-proof.ts";
import { preparePrivateState, syncDirectory } from "../private-state.ts";

export const MEMBER_DOMAIN = "ovis-fleet-member/1";
/** `opener`: may open pipes to others (a controller); `worker`: may be opened. Later versions add `answer_only`. */
export const MEMBER_CLASSES = ["opener", "worker"] as const;
export type MemberClass = typeof MEMBER_CLASSES[number];

/** One member of the fleet, as the owner key signs it (field order is the canonical form). */
export interface MemberRecord {
  readonly v: 1;
  readonly server_id: string;
  readonly server_public_key: string;
  readonly class: MemberClass;
  /** may open pipes to other members */
  readonly open: boolean;
  /** may change the member list (todo 31 and later) */
  readonly write: boolean;
}
/** What an invite and a machine's fleet.json carry: the owner key's public half and the first member, signed. */
export interface OwnerBlock {
  readonly public_key: string;
  readonly member: MemberRecord;
  readonly signature: string;
}

/** Why an owner block was refused: malformed, or the pinned controller is not a member the owner key signed. */
export class OwnerError extends Error {
  constructor(readonly code: "invalid_owner" | "controller_not_member", message: string) {
    super(message);
    this.name = "OwnerError";
  }
}

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** The bytes the owner key signs: the domain, then the record's canonical JSON. */
export function memberBytes(member: MemberRecord): Uint8Array {
  const canonical: MemberRecord = { v: 1, server_id: member.server_id, server_public_key: member.server_public_key, class: member.class, open: member.open, write: member.write };
  return new Uint8Array(Buffer.concat([Buffer.from(MEMBER_DOMAIN), Buffer.from(JSON.stringify(canonical))]));
}

const canonical64 = (text: unknown, bytes: number, url: boolean): text is string => {
  if (typeof text !== "string") return false;
  const decoded = Buffer.from(text, url ? "base64url" : "base64");
  return decoded.length === bytes && decoded.toString(url ? "base64url" : "base64") === text;
};

function member(value: unknown): MemberRecord {
  const bad = (why: string): never => { throw new OwnerError("invalid_owner", `owner.member ${why}`); };
  if (typeof value !== "object" || value === null || Array.isArray(value)) bad("is not an object");
  const v = value as Record<string, unknown>;
  if (v["v"] !== 1) bad("is not version 1");
  const key = v["server_public_key"];
  if (!canonical64(key, 32, false)) bad("server_public_key is not 32 bytes of base64");
  if (v["server_id"] !== deriveServerId(Buffer.from(key as string, "base64"))) bad("server_id is not the one its key derives");
  if (!(MEMBER_CLASSES as readonly unknown[]).includes(v["class"])) bad("class is not opener or worker");
  if (typeof v["open"] !== "boolean" || typeof v["write"] !== "boolean") bad("open and write are not booleans");
  return { v: 1, server_id: v["server_id"] as string, server_public_key: key as string, class: v["class"] as MemberClass, open: v["open"] as boolean, write: v["write"] as boolean };
}

const littleEndian = (bytes: Uint8Array): bigint => bytes.reduceRight((value, byte) => (value << 8n) | BigInt(byte), 0n);

/**
 * Whether `signature` (raw, 64 bytes) is the owner key's over `message`, checked as the link agent's ed25519-dalek
 * `verify_strict` checks it: canonical encodings of the key, R and S (S < L), neither the key nor R of small order, and
 * the cofactorless equation `[S]B == R + [k]A` (k = SHA-512(R || A || message) mod L). noble's own check multiplies by
 * the cofactor, so without the last step a key or an R with a component of order 8 (a mixed-order point) passes here
 * and fails there; vectors `owner-mixed-order-key` and `owner-mixed-order-R` hold both readers to refusing them. A lax
 * check also accepts the identity point as a key with (identity || 0) as a signature over ANY message.
 */
export function ownerVerifies(ownerPublicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  try {
    if (ownerPublicKey.length !== 32 || signature.length !== 64) return false;
    const key = ed25519.Point.fromBytes(ownerPublicKey, false);
    const r = ed25519.Point.fromBytes(signature.subarray(0, 32), false);
    if (key.isSmallOrder() || r.isSmallOrder()) return false;
    if (!ed25519.verify(signature, message, ownerPublicKey, { zip215: false })) return false;
    const k = littleEndian(createHash("sha512").update(signature.subarray(0, 32)).update(ownerPublicKey).update(message).digest()) % ed25519.Point.Fn.ORDER;
    return ed25519.Point.BASE.multiplyUnsafe(littleEndian(signature.subarray(32))).equals(r.add(key.multiplyUnsafe(k)));
  } catch { return false; }
}

/**
 * An owner block as an invite or fleet.json carries it, checked against the controller the file pins: the record is
 * signed by the owner key and names exactly that controller key as a member that may open. OwnerError otherwise.
 */
export function parseOwner(value: unknown, controller: { readonly server_id: string; readonly server_public_key: string }): OwnerBlock {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new OwnerError("invalid_owner", "owner is not an object");
  const v = value as Record<string, unknown>;
  if (!canonical64(v["public_key"], 32, true)) throw new OwnerError("invalid_owner", "owner.public_key is not 32 bytes of base64url");
  if (!canonical64(v["signature"], 64, true)) throw new OwnerError("invalid_owner", "owner.signature is not 64 bytes of base64url");
  const record = member(v["member"]);
  const block: OwnerBlock = { public_key: v["public_key"] as string, member: record, signature: v["signature"] as string };
  if (!ownerVerifies(Buffer.from(block.public_key, "base64url"), memberBytes(record), Buffer.from(block.signature, "base64url"))) {
    throw new OwnerError("controller_not_member", "the controller's member record is not signed by the owner key");
  }
  if (record.server_public_key !== controller.server_public_key || record.server_id !== controller.server_id || !record.open) {
    throw new OwnerError("controller_not_member", "the pinned controller is not a member the owner key signed as one that may open");
  }
  return block;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** The owner key's 32-byte seed as words to write down: Crockford base32 of the seed and 2 check bytes, in groups of four. */
export function recoveryPhrase(seed: Uint8Array): string {
  const bytes = Buffer.concat([seed, createHash("sha256").update(seed).digest().subarray(0, 2)]);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += CROCKFORD[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out.match(/.{1,4}/g)!.join("-");
}
/** The seed a recovery phrase holds, or undefined when it is not one (a typo fails its check bytes). */
export function seedFromPhrase(phrase: string): Uint8Array | undefined {
  const text = phrase.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text) {
    const digit = CROCKFORD.indexOf(char);
    if (digit < 0) return undefined;
    value = ((value << 5) | digit) & 0xffff;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  if (out.length !== 34) return undefined;
  const seed = Uint8Array.from(out.slice(0, 32));
  const check = createHash("sha256").update(seed).digest().subarray(0, 2);
  return check[0] === out[32] && check[1] === out[33] ? seed : undefined;
}

export interface OwnerKey {
  readonly publicKey: string;
  sign(message: Uint8Array): Uint8Array;
  /** The block an invite carries for `controller`: the owner key's public half and the controller as the first member. */
  block(controller: { readonly server_id: string; readonly server_public_key: string }): OwnerBlock;
}

function ownerKey(seed: Uint8Array): OwnerKey {
  const privateKey = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const publicKey = Buffer.from(spki.subarray(spki.length - 32)).toString("base64url");
  const sign = (message: Uint8Array) => new Uint8Array(signBytes(null, message, privateKey));
  return {
    publicKey, sign,
    block(controller) {
      const record: MemberRecord = { v: 1, server_id: controller.server_id, server_public_key: controller.server_public_key, class: "opener", open: true, write: true };
      return { public_key: publicKey, member: record, signature: Buffer.from(sign(memberBytes(record))).toString("base64url") };
    },
  };
}

/** The owner key of the fleet whose store is `storePath` (server/fleet/store.ts): `<state>/fleet/owner.json`. */
export const ownerKeyPath = (storePath: string) => join(dirname(storePath), "owner.json");

function readOwner(path: string): Uint8Array {
  const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const seed = value["seed"];
  if (value["v"] !== 1 || !canonical64(seed, 32, true) || !canonical64(value["public_key"], 32, true)) throw new Error("owner.json is not an owner key");
  const bytes = Buffer.from(seed as string, "base64url");
  if (ownerKey(bytes).publicKey !== value["public_key"]) throw new Error("owner.json's public key is not its seed's");
  return bytes;
}

/** The fleet's owner key at `path`, or undefined when the fleet was not turned on yet; throws when the file is not one. */
export function loadOwnerKey(path: string): OwnerKey | undefined {
  try { return ownerKey(readOwner(path)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Puts the owner key a recovery phrase holds back at `path` (todo 31: `ovis fleet on --restore`), written once as
 * createOwnerKey writes it. `restored` when it was made, `existed` when that very key is there already; `other` when
 * another owner key is there, which is never replaced (an owner key changes only by turning a fleet on anew).
 */
export function restoreOwnerKey(path: string, seed: Uint8Array): { readonly kind: "restored" | "existed" | "other"; readonly key: OwnerKey } {
  const key = ownerKey(seed);
  const held = loadOwnerKey(path);
  if (held) return { kind: held.publicKey === key.publicKey ? "existed" : "other", key: held };
  const temporary = preparePrivateState(path, { v: 1, public_key: key.publicKey, seed: Buffer.from(seed).toString("base64url") });
  try {
    try { linkSync(temporary, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const other = ownerKey(readOwner(path));
      return { kind: other.publicKey === key.publicKey ? "existed" : "other", key: other };
    }
  } finally {
    unlinkSync(temporary);
  }
  syncDirectory(dirname(path), process.platform);
  return { kind: "restored", key };
}

/**
 * Turns the fleet on (server/fleet/cli.ts, `ovis-server fleet owner`): makes the owner key at `path` once (0600,
 * flushed, never replacing another creator's file) and returns its recovery phrase, the only time it exists outside the
 * key file. When the key is there already it returns it with `existed` and no phrase. `beforeLink` gets the phrase while
 * the key is written but not yet in place: it puts the phrase where it goes (a synced file, a terminal) and may throw,
 * which makes no key; so a crash at any point leaves no key whose phrase never left this process (todo 31).
 */
export function createOwnerKey(path: string, beforeLink?: (phrase: string) => void): { readonly key: OwnerKey; readonly recovery_phrase: string } | { readonly key: OwnerKey; readonly existed: true } {
  const held = loadOwnerKey(path);
  if (held) return { key: held, existed: true };
  const seed = randomBytes(32);
  const key = ownerKey(seed);
  const temporary = preparePrivateState(path, { v: 1, public_key: key.publicKey, seed: seed.toString("base64url") });
  try {
    beforeLink?.(recoveryPhrase(seed));
    try { linkSync(temporary, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return { key: ownerKey(readOwner(path)), existed: true };
    }
  } finally {
    unlinkSync(temporary);
  }
  syncDirectory(dirname(path), process.platform);
  const phrase = recoveryPhrase(seed);
  seed.fill(0);
  return { key, recovery_phrase: phrase };
}
