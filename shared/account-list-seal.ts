/**
 * The names of a signed list, kept from the account service that stores it (docs/account-list.md,
 * "Names the service cannot read"): the epoch key, its wrap for each member, the link from an epoch
 * to the one before, and the `sealed` field of an entry. Nothing here says who is a member. What
 * cannot be opened is a result (`open: false`), never a throw, so a wrong or missing wrap can only
 * hide a name. No I/O; every use of a key goes through WebCrypto, where a device's key cannot be
 * exported.
 */
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { isListHash, isListPoint, LIST_BODY_MAX, type ListField, readFieldsUnder, writeFieldsUnder } from "./account-list-entry.ts";
import { SPKI_PREFIX } from "./account-records.ts";
import { fromBase64Url, toBase64Url } from "./relay-pair-sas.ts";

/** Starts the HKDF info of a wrap. */
export const LIST_WRAP_TAG = "ovis-list-wrap/1";
/** The HKDF info of the key that seals fields, and the start of a sealed field's additional data. */
export const LIST_SEAL_TAG = "ovis-list-seal/1";
/** Every sealed plaintext starts with these bytes; its fields follow in the form of an entry's. */
export const LIST_SEALED_PREFIX = "ovis-list-sealed/1";
/** The HKDF info of the key that encrypts the epoch key before, and the start of a link's additional data. */
export const LIST_EPOCH_LINK_TAG = "ovis-list-epoch-link/1";
/** The commitment to an epoch key is SHA-256 over these bytes, the epoch and the key. */
export const LIST_EPOCH_KEY_TAG = "ovis-list-epoch-key/1";
export const LIST_SEAL_VERSION = 1;
export const LIST_EPOCH_KEY_BYTES = 32;
/** A wrap: the version, the ephemeral point's X and Y, the encrypted key and its tag. */
export const LIST_WRAP_BYTES = 113;
export const LIST_WRAP_TEXT_LENGTH = 151;
/** A link: the version, the nonce, the encrypted key and its tag. */
export const LIST_EPOCH_LINK_BYTES = 61;
/** What a sealed field adds to its plaintext: the version, the nonce and the tag. */
export const LIST_SEALED_OVERHEAD = 29;
/** The most links one walkBack opens; a list with more epochs is walked on from the last key it reached. */
export const LIST_EPOCH_WALK_MAX = 1024;

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const POINT_BYTES = 64;
const NUMBER_END = 10 ** 15;
const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
/** HKDF with no salt is HKDF with a salt of 32 zero bytes (RFC 5869); written out, so every runtime is asked the same. */
const NO_SALT = new Uint8Array(32);
const ENTRY_0_LIST = new Uint8Array(32);
const WRAP_TAG = utf8ToBytes(LIST_WRAP_TAG);
const SEAL_TAG = utf8ToBytes(LIST_SEAL_TAG);
const LINK_TAG = utf8ToBytes(LIST_EPOCH_LINK_TAG);
const EPOCH_KEY_TAG = utf8ToBytes(LIST_EPOCH_KEY_TAG);
const SEALED_MIN = LIST_SEALED_OVERHEAD + LIST_SEALED_PREFIX.length;
/** PKCS8 up to the private value: SEQUENCE(135) { INTEGER 0, AlgorithmIdentifier { id-ecPublicKey, prime256v1 }, OCTET STRING(109) { SEQUENCE(107) { INTEGER 1, OCTET STRING(32) } } }. */
const SECRET_HEAD = Uint8Array.from([
  0x30, 0x81, 0x87, 0x02, 0x01, 0x00, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a,
  0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x04, 0x6d, 0x30, 0x6b, 0x02, 0x01, 0x01, 0x04, 0x20,
]);
/** After the private value: [1] { BIT STRING { 0 unused bits, 0x04 } }, then X and Y. */
const SECRET_MIDDLE = Uint8Array.from([0xa1, 0x44, 0x03, 0x42, 0x00, 0x04]);
const SECRET_POINT_AT = SECRET_HEAD.length + 32 + SECRET_MIDDLE.length;
export const LIST_STORED_KEY_BYTES = 138;
export const LIST_STORED_KEY_TEXT_LENGTH = 184;

/**
 * Why something does not open. Callers show the device or PC without its name; none of these says
 * anything about who is a member.
 * - `missing`: nothing was given (no wrap, no link, no key, no sealed field);
 * - `form`: the bytes, or what they are opened for, have not the form (a length, a version, a point off the curve, a plaintext that is no fields);
 * - `refused`: in form, but it does not open with this key for this place (another member's wrap, another list, seq or epoch, a changed byte);
 * - `other_key`: it opens, to a key that is not the one the list commits to for that epoch;
 * - `bound`: the walk back opened as many links as it may;
 * - `unavailable`: the runtime could not do it (no WebCrypto on a page on plain http); a fault of the place, not of the bytes.
 */
export type CannotOpen = "missing" | "form" | "refused" | "other_key" | "bound" | "unavailable";

export type Opened<T> = { readonly open: true; readonly value: T } | { readonly open: false; readonly why: CannotOpen };

export type ListSealReason = "argument" | "fields" | "secret";

/** Thrown only where something is made (sealed, wrapped, linked, a stored key read); opening never throws. */
export class ListSealError extends Error {
  constructor(readonly reason: ListSealReason, message: string) {
    super(message);
    this.name = "ListSealError";
  }
}

function refuse(reason: ListSealReason, message: string): never {
  throw new ListSealError(reason, message);
}

/** An epoch and its key: 32 random bytes. */
export interface EpochKey {
  readonly epoch: number;
  readonly key: Uint8Array;
}

/** A member's encryption key: the public half in the one spelling of a key, and the private half, which only derives. */
export interface MemberEncryptionKey {
  readonly key: string;
  readonly privateKey: CryptoKey;
}

/** Where an entry stands: its own clear `list` (empty in entry 0) and `seq`. */
export interface SealedPlace {
  readonly list: string;
  readonly seq: number;
}

/** What the entry that opened an epoch says in clear: the commitment to that epoch's key, and the link to the key before (none for epoch 0). */
export interface EpochOpening {
  readonly commitment: string;
  readonly link?: Uint8Array | null;
}

export interface MemberWrap {
  readonly member: string;
  readonly wrap: Uint8Array;
}

export interface MemberWraps {
  readonly wraps: readonly MemberWrap[];
  /** Members whose key is no point of the curve: nothing can be wrapped to them, and nothing else waits for them. */
  readonly unwrapped: readonly string[];
}

export interface NextEpoch extends MemberWraps {
  readonly epoch: EpochKey;
  readonly commitment: string;
  readonly link: Uint8Array;
}

export interface EpochWalk {
  /** The keys reached, from the given one down. */
  readonly keys: readonly EpochKey[];
  /** Null when the walk reached the epoch asked for; else the first epoch whose key it did not reach, and why. */
  readonly stopped: { readonly epoch: number; readonly why: CannotOpen } | null;
}

function closed(why: CannotOpen): { readonly open: false; readonly why: CannotOpen } {
  return { open: false, why };
}

function isListCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value < NUMBER_END;
}

function isEpochKey(value: EpochKey | null | undefined): value is EpochKey {
  return value !== null && value !== undefined && isListCount(value.epoch) && value.key instanceof Uint8Array && value.key.length === LIST_EPOCH_KEY_BYTES;
}

function isPlace(place: SealedPlace): boolean {
  return isListCount(place.seq) && (place.seq === 0 ? place.list === "" : isListHash(place.list));
}

function u64(value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value));
  return bytes;
}

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function spkiOf(point: Uint8Array): Uint8Array {
  return concatBytes(SPKI_PREFIX, point);
}

function wrapInfo(list: string, epoch: number, member: string, ephemeral: Uint8Array): Uint8Array {
  return concatBytes(WRAP_TAG, hexToBytes(list), u64(epoch), fromBase64Url(member), spkiOf(ephemeral));
}

function sealedData(place: SealedPlace, epoch: number): Uint8Array {
  return concatBytes(SEAL_TAG, place.seq === 0 ? ENTRY_0_LIST : hexToBytes(place.list), u64(place.seq), u64(epoch));
}

function linkData(list: string, epoch: number): Uint8Array {
  return concatBytes(LINK_TAG, hexToBytes(list), u64(epoch));
}

/** The key and nonce of one wrap. Its ephemeral key is used once, so the pair never comes twice. */
async function wrapCipher(subtle: SubtleCrypto, privateKey: CryptoKey, publicPoint: Uint8Array, info: Uint8Array): Promise<{ key: CryptoKey; iv: Uint8Array }> {
  const publicKey = await subtle.importKey("spki", new Uint8Array(spkiOf(publicPoint)), ECDH, false, []);
  const shared = await subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256);
  const material = await subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const derived = new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: NO_SALT, info: new Uint8Array(info) }, material, (32 + NONCE_BYTES) * 8));
  return { key: await subtle.importKey("raw", derived.slice(0, 32), "AES-GCM", false, ["encrypt", "decrypt"]), iv: derived.slice(32) };
}

/** One of the two keys an epoch key gives: fields are sealed under one, the key before under the other. */
async function epochCipher(subtle: SubtleCrypto, epochKey: Uint8Array, tag: Uint8Array): Promise<CryptoKey> {
  const material = await subtle.importKey("raw", new Uint8Array(epochKey), "HKDF", false, ["deriveKey"]);
  return await subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: NO_SALT, info: new Uint8Array(tag) }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

async function encrypt(subtle: SubtleCrypto, key: CryptoKey, iv: Uint8Array, data: Uint8Array | null, plaintext: Uint8Array): Promise<Uint8Array> {
  const params = { name: "AES-GCM", iv: new Uint8Array(iv), tagLength: TAG_BYTES * 8, ...(data ? { additionalData: new Uint8Array(data) } : {}) };
  return new Uint8Array(await subtle.encrypt(params, key, new Uint8Array(plaintext)));
}

/** Null when the tag does not hold: a verdict on the bytes, which a fault of the runtime is not. */
async function decrypt(subtle: SubtleCrypto, key: CryptoKey, iv: Uint8Array, data: Uint8Array | null, ciphertext: Uint8Array): Promise<Uint8Array | null> {
  const params = { name: "AES-GCM", iv: new Uint8Array(iv), tagLength: TAG_BYTES * 8, ...(data ? { additionalData: new Uint8Array(data) } : {}) };
  try {
    return new Uint8Array(await subtle.decrypt(params, key, new Uint8Array(ciphertext)));
  } catch (error) {
    if (error instanceof DOMException && error.name === "OperationError") return null;
    throw error;
  }
}

function webCrypto(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("WebCrypto is not available here (crypto.subtle is missing), so nothing of a list can be sealed or wrapped");
  return subtle;
}

/** Opening is total: whatever the runtime throws is `unavailable`, so no caller needs a try around a name. */
async function opening<T>(open: (subtle: SubtleCrypto) => Promise<Opened<T>>): Promise<Opened<T>> {
  try {
    return await open(webCrypto());
  } catch {
    return closed("unavailable");
  }
}

async function publicKeyOf(subtle: SubtleCrypto, key: CryptoKey): Promise<string> {
  return toBase64Url(new Uint8Array(await subtle.exportKey("spki", key)));
}

/** A device's encryption key. The private half cannot be exported: it is stored as the CryptoKey it is (IndexedDB), beside the public half. */
export async function generateDeviceEncryptionKey(): Promise<MemberEncryptionKey> {
  const subtle = webCrypto();
  const pair = await subtle.generateKey(ECDH, false, ["deriveBits"]);
  return { key: await publicKeyOf(subtle, pair.publicKey), privateKey: pair.privateKey };
}

function jwkPart(value: string | undefined): Uint8Array {
  const bytes = value === undefined || !/^[A-Za-z0-9_-]{43}$/.test(value) ? null : fromBase64Url(value);
  if (bytes === null || bytes.length !== 32) refuse("secret", "The runtime made a key that is not a P-256 private key");
  return bytes;
}

/**
 * An encryption key a PC keeps in a file: the public half, and `secret`, the private key as the
 * base64url of its one PKCS8 form (the join line's). The bytes are built here from the key's
 * values, never taken from an engine's PKCS8 export, so every runtime writes the same form.
 */
export async function generateStoredEncryptionKey(): Promise<{ readonly key: string; readonly secret: string }> {
  const subtle = webCrypto();
  const pair = await subtle.generateKey(ECDH, true, ["deriveBits"]);
  const jwk = await subtle.exportKey("jwk", pair.privateKey);
  const bytes = concatBytes(SECRET_HEAD, jwkPart(jwk.d), SECRET_MIDDLE, jwkPart(jwk.x), jwkPart(jwk.y));
  return { key: await publicKeyOf(subtle, pair.publicKey), secret: toBase64Url(bytes) };
}

/**
 * A stored key, read strictly: the one PKCS8 form in its one spelling, a private value from 1 to
 * n-1, and the public point that value gives (judged here, whatever the runtime's import checks).
 * Refuses `secret`, never with any part of the secret in the message.
 */
export async function readStoredEncryptionKey(secret: string): Promise<MemberEncryptionKey> {
  const subtle = webCrypto();
  const bytes = typeof secret === "string" && secret.length === LIST_STORED_KEY_TEXT_LENGTH && /^[A-Za-z0-9_-]+$/.test(secret) ? fromBase64Url(secret) : null;
  const inForm = bytes !== null && bytes.length === LIST_STORED_KEY_BYTES && toBase64Url(bytes) === secret
    && SECRET_HEAD.every((byte, index) => bytes[index] === byte) && SECRET_MIDDLE.every((byte, index) => bytes[SECRET_HEAD.length + 32 + index] === byte);
  if (bytes === null || !inForm) refuse("secret", "The stored key is not a P-256 private key in its one PKCS8 form");
  const d = bytes.subarray(SECRET_HEAD.length, SECRET_HEAD.length + 32);
  const point = bytes.subarray(SECRET_POINT_AT);
  if (!p256.utils.isValidSecretKey(d)) refuse("secret", "The stored key's private value is not from 1 to n-1 of P-256");
  const own = p256.getPublicKey(d, false).subarray(1);
  if (!own.every((byte, index) => point[index] === byte)) refuse("secret", "The stored key's public point is not its private value's");
  const privateKey = await subtle.importKey("pkcs8", new Uint8Array(bytes), ECDH, false, ["deriveBits"]);
  return { key: toBase64Url(spkiOf(point)), privateKey };
}

/** A new key for an epoch: epoch 0 with the list, the next one after each removal. */
export function newEpochKey(epoch: number): EpochKey {
  if (!isListCount(epoch)) refuse("argument", "An epoch is a number of the list: 0 or more, at most 15 digits");
  return { epoch, key: randomBytes(LIST_EPOCH_KEY_BYTES) };
}

/**
 * The commitment to an epoch's key, as a hash. The entry that opens the epoch carries it in clear,
 * under a member's signature; a key from a wrap or a link is taken only when it gives this hash.
 * Without it the service, which can wrap any key to a member, could hand a new member a key of
 * its own and read what that member seals.
 */
export function epochKeyCommitment(epoch: EpochKey): string {
  if (!isEpochKey(epoch)) refuse("argument", "An epoch key is an epoch number and 32 bytes");
  return bytesToHex(sha256(concatBytes(EPOCH_KEY_TAG, u64(epoch.epoch), epoch.key)));
}

/**
 * An epoch key wrapped to one member; null when the member's key is no point of the curve, so that
 * one member's bad key never stops an addition or a removal. Anyone can wrap, so a wrap proves
 * nothing: the reader checks the key against the list's commitment.
 */
export async function wrapEpochKey(given: { readonly list: string; readonly epoch: EpochKey; readonly member: string }): Promise<Uint8Array | null> {
  const subtle = webCrypto();
  const { list, member } = given;
  if (!isListHash(list)) refuse("argument", "list is a list id: 64 of 0-9a-f");
  if (!isEpochKey(given.epoch)) refuse("argument", "An epoch key is an epoch number and 32 bytes");
  const epoch: EpochKey = { epoch: given.epoch.epoch, key: new Uint8Array(given.epoch.key) };
  if (typeof member !== "string" || !isListPoint(member)) return null;
  const ephemeral = await subtle.generateKey(ECDH, false, ["deriveBits"]);
  const point = new Uint8Array(await subtle.exportKey("raw", ephemeral.publicKey)).subarray(1);
  const cipher = await wrapCipher(subtle, ephemeral.privateKey, fromBase64Url(member).subarray(SPKI_PREFIX.length), wrapInfo(list, epoch.epoch, member, point));
  return concatBytes(Uint8Array.of(LIST_SEAL_VERSION), point, await encrypt(subtle, cipher.key, cipher.iv, null, epoch.key));
}

/** An epoch key wrapped to each member of a set, each once. */
export async function wrapEpochKeyFor(given: { readonly list: string; readonly epoch: EpochKey; readonly members: readonly string[] }): Promise<MemberWraps> {
  const wraps: MemberWrap[] = [];
  const unwrapped: string[] = [];
  for (const member of new Set(given.members)) {
    const wrap = await wrapEpochKey({ list: given.list, epoch: given.epoch, member });
    if (wrap === null) unwrapped.push(member);
    else wraps.push({ member, wrap });
  }
  return { wraps, unwrapped };
}

/**
 * The epoch key a wrap holds for this member, when it is the one the list commits to for that
 * epoch. `commitment` comes from the entry that opened the epoch, never from the service's word.
 */
export async function openWrap(given: {
  readonly list: string; readonly epoch: number; readonly commitment: string; readonly wrap: Uint8Array | null | undefined; readonly member: MemberEncryptionKey;
}): Promise<Opened<EpochKey>> {
  return await opening<EpochKey>(async (subtle) => {
    const { list, epoch, commitment, member } = given;
    if (given.wrap === null || given.wrap === undefined) return closed("missing");
    const wrap = new Uint8Array(given.wrap);
    if (!isListHash(list) || !isListCount(epoch) || !isListHash(commitment) || typeof member?.key !== "string" || !isListPoint(member.key)) return closed("form");
    if (wrap.length !== LIST_WRAP_BYTES || wrap[0] !== LIST_SEAL_VERSION) return closed("form");
    const point = wrap.subarray(1, 1 + POINT_BYTES);
    if (!isListPoint(toBase64Url(spkiOf(point)))) return closed("form");
    const cipher = await wrapCipher(subtle, member.privateKey, point, wrapInfo(list, epoch, member.key, point));
    const key = await decrypt(subtle, cipher.key, cipher.iv, null, wrap.subarray(1 + POINT_BYTES));
    if (key === null) return closed("refused");
    const opened: EpochKey = { epoch, key };
    return epochKeyCommitment(opened) === commitment ? { open: true, value: opened } : closed("other_key");
  });
}

export function wrapToText(wrap: Uint8Array): string {
  if (wrap.length !== LIST_WRAP_BYTES) refuse("argument", `A wrap is ${LIST_WRAP_BYTES} bytes`);
  return toBase64Url(wrap);
}

/** A wrap's text, read strictly: 151 characters of base64url in their one spelling; null for anything else. What the bytes hold is openWrap's to say. */
export function wrapFromText(text: string): Uint8Array | null {
  if (typeof text !== "string" || text.length !== LIST_WRAP_TEXT_LENGTH || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const bytes = fromBase64Url(text);
  return bytes.length === LIST_WRAP_BYTES && toBase64Url(bytes) === text ? bytes : null;
}

/** The link an epoch's opening entry carries: the key of the epoch before, under the opened one. */
export async function linkEpochs(given: { readonly list: string; readonly opened: EpochKey; readonly previous: EpochKey }): Promise<Uint8Array> {
  const subtle = webCrypto();
  const { list } = given;
  if (!isListHash(list)) refuse("argument", "list is a list id: 64 of 0-9a-f");
  if (!isEpochKey(given.opened) || !isEpochKey(given.previous)) refuse("argument", "An epoch key is an epoch number and 32 bytes");
  if (given.opened.epoch !== given.previous.epoch + 1) refuse("argument", "A link goes from an epoch to the one before it");
  const opened: EpochKey = { epoch: given.opened.epoch, key: new Uint8Array(given.opened.key) };
  const previous = new Uint8Array(given.previous.key);
  const nonce = randomBytes(NONCE_BYTES);
  const key = await epochCipher(subtle, opened.key, LINK_TAG);
  return concatBytes(Uint8Array.of(LIST_SEAL_VERSION), nonce, await encrypt(subtle, key, nonce, linkData(list, opened.epoch), previous));
}

/** The key of the epoch before `from`, out of the link `from`'s opening entry carries, when it is the one the list commits to. */
export async function openLink(given: {
  readonly list: string; readonly from: EpochKey; readonly link: Uint8Array | null | undefined; readonly commitment: string;
}): Promise<Opened<EpochKey>> {
  return await opening<EpochKey>(async (subtle) => {
    const { list, commitment } = given;
    if (given.link === null || given.link === undefined) return closed("missing");
    const link = new Uint8Array(given.link);
    if (!isListHash(list) || !isListHash(commitment) || !isEpochKey(given.from) || given.from.epoch < 1) return closed("form");
    const from: EpochKey = { epoch: given.from.epoch, key: new Uint8Array(given.from.key) };
    if (link.length !== LIST_EPOCH_LINK_BYTES || link[0] !== LIST_SEAL_VERSION) return closed("form");
    const cipher = await epochCipher(subtle, from.key, LINK_TAG);
    const key = await decrypt(subtle, cipher, link.subarray(1, 1 + NONCE_BYTES), linkData(list, from.epoch), link.subarray(1 + NONCE_BYTES));
    if (key === null) return closed("refused");
    const before: EpochKey = { epoch: from.epoch - 1, key };
    return epochKeyCommitment(before) === commitment ? { open: true, value: before } : closed("other_key");
  });
}

/**
 * From one epoch key down to epoch `to` (0 when not given), through the links: `openings` holds
 * what the list says of each epoch, by its number. It stops where a link is missing or does not
 * open, and after `max` links (LIST_EPOCH_WALK_MAX at most); what it reached stays good, and a
 * caller walks on from the last key.
 */
export async function walkBack(given: {
  readonly list: string; readonly from: EpochKey; readonly to?: number; readonly openings: ReadonlyMap<number, EpochOpening>; readonly max?: number;
}): Promise<EpochWalk> {
  if (!isEpochKey(given.from) || !(given.openings instanceof Map)) return { keys: [], stopped: { epoch: 0, why: "form" } };
  const to = given.to ?? 0;
  const max = Math.min(isListCount(given.max) ? given.max : LIST_EPOCH_WALK_MAX, LIST_EPOCH_WALK_MAX);
  const openings = new Map(given.openings);
  let from: EpochKey = { epoch: given.from.epoch, key: new Uint8Array(given.from.key) };
  const keys: EpochKey[] = [from];
  if (!isListCount(to)) return { keys, stopped: { epoch: from.epoch, why: "form" } };
  if (to > from.epoch) return { keys, stopped: { epoch: to, why: "missing" } };
  for (let steps = 0; from.epoch > to; steps += 1) {
    const epoch = from.epoch - 1;
    if (steps >= max) return { keys, stopped: { epoch, why: "bound" } };
    const commitment = openings.get(epoch)?.commitment;
    if (commitment === undefined) return { keys, stopped: { epoch, why: "missing" } };
    const before = await openLink({ list: given.list, from, link: openings.get(from.epoch)?.link, commitment });
    if (!before.open) return { keys, stopped: { epoch, why: before.why } };
    from = before.value;
    keys.push(from);
  }
  return { keys, stopped: null };
}

/**
 * The value of an entry's `sealed` field: the named fields, under the epoch's key, for one place.
 * The nonce is 96 random bits, never made from `seq`: a member that signs entry n again after its
 * first try lost the place seals other fields for the same seq, and a nonce made from seq would
 * come twice under one key. Refuses `fields` for fields that are not in form or do not fit.
 * The caller gives the key of the list's current epoch, or seals nothing: under an earlier key a
 * member already removed would read the names, and nothing here knows which epoch is current.
 */
export async function sealFields(given: { readonly place: SealedPlace; readonly epoch: EpochKey; readonly fields: readonly ListField[] }): Promise<Uint8Array> {
  const subtle = webCrypto();
  const place: SealedPlace = { list: given.place.list, seq: given.place.seq };
  if (!isPlace(place)) refuse("argument", "A place is a seq and the list id, which is empty for entry 0 and for no other");
  if (!isEpochKey(given.epoch)) refuse("argument", "An epoch key is an epoch number and 32 bytes");
  const epoch: EpochKey = { epoch: given.epoch.epoch, key: new Uint8Array(given.epoch.key) };
  let plaintext: Uint8Array;
  try {
    plaintext = writeFieldsUnder(LIST_SEALED_PREFIX, given.fields);
  } catch {
    plaintext = refuse("fields", "The fields are not in the form of an entry's fields");
  }
  if (plaintext.length + LIST_SEALED_OVERHEAD > LIST_BODY_MAX) refuse("fields", `A sealed field is at most ${LIST_BODY_MAX} bytes`);
  const nonce = randomBytes(NONCE_BYTES);
  const key = await epochCipher(subtle, epoch.key, SEAL_TAG);
  return concatBytes(Uint8Array.of(LIST_SEAL_VERSION), nonce, await encrypt(subtle, key, nonce, sealedData(place, epoch.epoch), plaintext));
}

/** The fields a `sealed` value holds, for the place and the epoch its entry names in clear. */
export async function openSealed(given: {
  readonly place: SealedPlace; readonly epoch: EpochKey | null | undefined; readonly sealed: Uint8Array | null | undefined;
}): Promise<Opened<readonly ListField[]>> {
  return await opening<readonly ListField[]>(async (subtle) => {
    if (given.sealed === null || given.sealed === undefined || given.epoch === null || given.epoch === undefined) return closed("missing");
    const sealed = new Uint8Array(given.sealed);
    const place: SealedPlace = { list: given.place.list, seq: given.place.seq };
    if (!isPlace(place) || !isEpochKey(given.epoch)) return closed("form");
    const epoch: EpochKey = { epoch: given.epoch.epoch, key: new Uint8Array(given.epoch.key) };
    if (sealed.length < SEALED_MIN || sealed.length > LIST_BODY_MAX || sealed[0] !== LIST_SEAL_VERSION) return closed("form");
    const key = await epochCipher(subtle, epoch.key, SEAL_TAG);
    const plaintext = await decrypt(subtle, key, sealed.subarray(1, 1 + NONCE_BYTES), sealedData(place, epoch.epoch), sealed.subarray(1 + NONCE_BYTES));
    if (plaintext === null) return closed("refused");
    try {
      return { open: true, value: readFieldsUnder(LIST_SEALED_PREFIX, plaintext) };
    } catch {
      return closed("form");
    }
  });
}

/**
 * What follows a removal, given the members that stay: the next epoch's key, its commitment and
 * its link (both for the entry that opens the epoch) and its wrap for each member that stays. What
 * was sealed under the epoch before stays readable to the member that left; nothing under the new
 * key is.
 */
export async function nextEpoch(given: { readonly list: string; readonly current: EpochKey; readonly members: readonly string[] }): Promise<NextEpoch> {
  if (!isEpochKey(given.current)) refuse("argument", "An epoch key is an epoch number and 32 bytes");
  const current: EpochKey = { epoch: given.current.epoch, key: new Uint8Array(given.current.key) };
  const epoch = newEpochKey(current.epoch + 1);
  const link = await linkEpochs({ list: given.list, opened: epoch, previous: current });
  return { epoch, commitment: epochKeyCommitment(epoch), link, ...(await wrapEpochKeyFor({ list: given.list, epoch, members: given.members })) };
}
