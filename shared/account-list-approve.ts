// SPDX-License-Identifier: FSL-1.1-MIT
/**
 * Adding a device by approval (contract section 4): two devices, A that is in and the new N, exchange
 * four messages through the account service, and the person types N's six digits on N and N's three
 * check digits back on A. A message is a body `ovis-list-approve/1` and fields in the entry's field
 * form, signed by the key in its field `key` as an entry is, and one text on the wire as an entry is.
 * Here: writing, reading, signing and verifying a message, the binding, the commitment, the six and
 * the three digits, and each side's matching rules as functions of its state. No I/O, no clock.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { ACCOUNT_LABEL_MAX } from "./account-records.ts";
import {
  ListEntryError, entryFromText, entryToText, isListHash, isListKey, isListNumber, readFieldsUnder, verifySignature, writeFieldsUnder,
  type ListField,
} from "./account-list-entry.ts";
import { PAIR_NONCE_BYTES, commitmentHolds, fromBase64Url, pairCommitment, pairDigits, toBase64Url } from "./relay-pair-sas.ts";

export const APPROVE_PREFIX = "ovis-list-approve/1";
/** The domain of the three check digits. */
export const APPROVE_CHECK_DOMAIN = "ovis-list-approve-check/1";
/** Wrong tries of the six digits on N before its part ends. */
export const APPROVE_WRONG_TRIES = 3;

export type ApproveStep = "offer" | "answer" | "challenge" | "reveal";

/**
 * Why a message is not taken: the contract's eight names. `signature_invalid` also names a message
 * signed by the wrong participant (another device's answer or reveal shown to N among them).
 */
export type ApproveRefusalCode =
  | "message_malformed" | "signature_invalid" | "offer_mismatch" | "step_order" | "step_taken" | "challenge_other_key"
  | "commitment_mismatch" | "offer_closed";
/** A refusal, or `digits_malformed`: typed input that is not six (or three) digits, the caller's error and no wrong try. */
export type ApproveErrorCode = ApproveRefusalCode | "digits_malformed";

export class ApproveError extends Error {
  constructor(readonly code: ApproveErrorCode, message: string) {
    super(message);
    this.name = "ApproveError";
  }
}

function refuse(code: ApproveErrorCode, message: string): never {
  throw new ApproveError(code, message);
}
function malformed(message: string): never {
  return refuse("message_malformed", message);
}

interface MessageBase {
  /** The sender's key, which signs the message. */
  readonly key: string;
  /** The list id. */
  readonly list: string;
  /** 32 of `0-9a-f`, drawn by A: it alone names the offer. */
  readonly offer: string;
}
export interface OfferMessage extends MessageBase {
  readonly step: "offer";
  readonly head_hash: string;
  readonly head_seq: number;
}
export interface AnswerMessage extends MessageBase {
  readonly step: "answer";
  readonly commitment: Uint8Array;
  /** N's name. */
  readonly label: string;
}
export interface ChallengeMessage extends MessageBase {
  readonly step: "challenge";
  /** A's nonce. */
  readonly nonce: Uint8Array;
  /** The key of the answer this challenges. */
  readonly to: string;
}
export interface RevealMessage extends MessageBase {
  readonly step: "reveal";
  /** N's nonce. */
  readonly nonce: Uint8Array;
}
export type ApproveMessage = OfferMessage | AnswerMessage | ChallengeMessage | RevealMessage;

const VERIFIED: unique symbol = Symbol("verified");
/** A message whose signature verified under its own `key`: made only by readMessage and signMessage. */
export interface SignedMessage<M extends ApproveMessage = ApproveMessage> {
  readonly message: M;
  readonly body: Uint8Array;
  readonly signature: Uint8Array;
  readonly [VERIFIED]: true;
}

const P256_SIGN = { name: "ECDSA", hash: "SHA-256" } as const;
const COMMON = ["key", "list", "offer", "step"] as const;
const OWN: { readonly [S in ApproveStep]: readonly string[] } = {
  offer: ["head_hash", "head_seq"],
  answer: ["commitment", "label"],
  challenge: ["nonce", "to"],
  reveal: ["nonce"],
};
const NONCE_TEXT_LENGTH = 43;
/** An offer id is 16 random bytes, written as 32 of 0-9a-f. */
const OFFER_ID_BYTES = 16;
const CHECK_DOMAIN = utf8ToBytes(APPROVE_CHECK_DOMAIN);

/** 32 of `0-9a-f`. */
export function isOfferId(text: string): boolean {
  return /^[0-9a-f]{32}$/.test(text);
}

/** A device's name (section 2, rule 1): 1 to 48 UTF-16 units, no control character and no lone surrogate, white space as single spaces, none at the ends. */
export function isDeviceLabel(text: string): boolean {
  return text.length >= 1 && text.length <= ACCOUNT_LABEL_MAX && !/[\p{Cc}\p{Cs}]/u.test(text) && text === text.replace(/\s+/g, " ").trim();
}

/** 32 bytes as base64url in their one spelling, or null. */
function nonceBytes(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length !== NONCE_TEXT_LENGTH) return null;
  const bytes = fromBase64Url(text);
  return bytes.length === PAIR_NONCE_BYTES && toBase64Url(bytes) === text ? bytes : null;
}

/** Bytes as one character each, so a byte above 0x7f never matches a form. */
function latin1(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return text;
}

/** A message's body, read strictly: the prefix, the field form, exactly the fields of its step, each in its form. Refuses `message_malformed`. */
export function readMessageBody(body: Uint8Array): ApproveMessage {
  let fields: ListField[];
  try {
    fields = readFieldsUnder(APPROVE_PREFIX, body);
  } catch (error) {
    if (error instanceof ListEntryError) malformed(`Not a message in the field form: ${error.message}`);
    throw error;
  }
  const values = new Map(fields.map((field) => [field.name, field.value]));
  const step = latin1(values.get("step") ?? malformed("Every message carries step"));
  if (step !== "offer" && step !== "answer" && step !== "challenge" && step !== "reveal") malformed("step is offer, answer, challenge or reveal");
  const names = [...COMMON, ...OWN[step]];
  for (const name of names) if (!values.has(name)) malformed(`A message of step ${step} carries ${name}`);
  for (const field of fields) if (!names.includes(field.name)) malformed(`A message of step ${step} carries no ${field.name}`);
  const text = (name: string): string => latin1(values.get(name) ?? malformed(`A message carries ${name}`));
  const key = (name: string): string => {
    const value = text(name);
    return isListKey(value) ? value : malformed(`${name} is a key in its one spelling`);
  };
  const nonce = (name: string): Uint8Array => nonceBytes(text(name)) ?? malformed(`${name} is 32 bytes as base64url in their one spelling`);
  const base = { key: key("key"), list: text("list"), offer: text("offer") };
  if (!isListHash(base.list)) malformed("list is a list id");
  if (!isOfferId(base.offer)) malformed("offer is 32 of 0-9a-f");
  switch (step) {
    case "offer": {
      const head_hash = text("head_hash");
      if (!isListHash(head_hash)) malformed("head_hash is a hash");
      const head_seq = text("head_seq");
      if (!isListNumber(head_seq)) malformed("head_seq is a number");
      return { step, ...base, head_hash, head_seq: Number(head_seq) };
    }
    case "answer": {
      let label: string;
      try {
        label = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(values.get("label"));
      } catch {
        return malformed("label is UTF-8");
      }
      if (!isDeviceLabel(label)) malformed("label is a device's name");
      return { step, ...base, commitment: nonce("commitment"), label };
    }
    case "challenge":
      return { step, ...base, nonce: nonce("nonce"), to: key("to") };
    case "reveal":
      return { step, ...base, nonce: nonce("nonce") };
  }
}

/** The one body of a message; refuses `message_malformed` for a message out of form (a label with a lone surrogate among them). */
export function writeMessageBody(message: ApproveMessage): Uint8Array {
  const field = (name: string, value: string): ListField => ({ name, value: utf8ToBytes(value) });
  /** A byte field that is no Uint8Array (a JavaScript caller past the types) is a fault, never encoded. */
  const bytes = (name: string, value: unknown): string => {
    if (!(value instanceof Uint8Array)) throw new TypeError(`${name} is a Uint8Array`);
    return toBase64Url(value);
  };
  if (message.step === "answer" && !isDeviceLabel(message.label)) malformed("label is a device's name");
  const own: ListField[] = message.step === "offer" ? [field("head_hash", message.head_hash), field("head_seq", String(message.head_seq))]
    : message.step === "answer" ? [field("commitment", bytes("commitment", message.commitment)), field("label", message.label)]
    : message.step === "challenge" ? [field("nonce", bytes("nonce", message.nonce)), field("to", message.to)]
    : [field("nonce", bytes("nonce", message.nonce))];
  let body: Uint8Array;
  try {
    body = writeFieldsUnder(APPROVE_PREFIX, [field("key", message.key), field("list", message.list), field("offer", message.offer), field("step", message.step), ...own]);
  } catch (error) {
    if (error instanceof ListEntryError) malformed(`Not a message in the field form: ${error.message}`);
    throw error;
  }
  readMessageBody(body);
  return body;
}

/**
 * A copy of `bytes` in a buffer of its own: every place the library hands out bytes, or takes a draw,
 * goes through here; every other byte array it keeps it made itself (a body it wrote or decoded, the
 * fields read back from one, a hash). `new Uint8Array(typedArray)` allocates a new ArrayBuffer and copies the elements into
 * it (ECMAScript, InitializeTypedArrayFromTypedArray), and returns a plain Uint8Array whatever subclass
 * it is given; so a node Buffer, whose own `slice()` is a view of the same memory, is copied too.
 */
function ownBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

/**
 * A message as the library holds it: frozen, each byte field handed out as a fresh
 * copy on every read. Its input is always the library's own: a message read back from a body it made or
 * checked, or the fields of N's answer it computed itself.
 */
function sealMessage<M extends ApproveMessage>(message: M): M {
  const sealed = { ...message };
  for (const [name, value] of Object.entries(sealed)) {
    if (value instanceof Uint8Array) Object.defineProperty(sealed, name, { get: () => ownBytes(value), enumerable: true });
  }
  Object.freeze(sealed);
  return sealed;
}

/**
 * Freezes a state and every object and array in it, and takes the prototype of each object away, so a
 * field it lacks reads as undefined whatever `Object.prototype` holds. It holds no byte array as a value:
 * those sit behind getters that hand out copies.
 */
function frozen<T extends object>(value: T): T {
  if (!Array.isArray(value)) Object.setPrototypeOf(value, null);
  for (const name of Reflect.ownKeys(value)) {
    const inner: unknown = Object.getOwnPropertyDescriptor(value, name)?.value;
    if (typeof inner === "object" && inner !== null && !Object.isFrozen(inner)) frozen(inner);
  }
  Object.freeze(value);
  return value;
}

/**
 * A signed message whose signature verified under its own `key`: frozen, its body and
 * signature (made by signMessage or decoded by readMessage, never a caller's) handed out as copies. Its
 * message is the one read back from that body, sealed before the first await by the caller.
 */
async function verified(message: ApproveMessage, body: Uint8Array, signature: Uint8Array): Promise<SignedMessage> {
  if (!(await verifySignature(body, signature, message.key))) refuse("signature_invalid", "The signature is not the key's over this message");
  const signed: SignedMessage = { message, get body() { return ownBytes(body); }, get signature() { return ownBytes(signature); }, [VERIFIED]: true };
  Object.freeze(signed);
  return signed;
}

/**
 * Signs a message with the private half of its `key` (ECDSA P-256 SHA-256, `r || s`). The caller's
 * object is read once, synchronously, to write the body; the signed message is that body read back,
 * so nothing the caller changes after the call reaches it.
 */
export async function signMessage(message: OfferMessage, privateKey: CryptoKey): Promise<SignedMessage<OfferMessage>>;
export async function signMessage(message: AnswerMessage, privateKey: CryptoKey): Promise<SignedMessage<AnswerMessage>>;
export async function signMessage(message: ChallengeMessage, privateKey: CryptoKey): Promise<SignedMessage<ChallengeMessage>>;
export async function signMessage(message: RevealMessage, privateKey: CryptoKey): Promise<SignedMessage<RevealMessage>>;
export async function signMessage(message: ApproveMessage, privateKey: CryptoKey): Promise<SignedMessage>;
export async function signMessage(message: ApproveMessage, privateKey: CryptoKey): Promise<SignedMessage> {
  const body = writeMessageBody(message);
  const signed = sealMessage(readMessageBody(body));
  const signature = new Uint8Array(await crypto.subtle.sign(P256_SIGN, privateKey, new Uint8Array(body)));
  return verified(signed, body, signature);
}

/** A message's one text, read strictly and verified under its own `key`. Refuses `message_malformed` or `signature_invalid`. */
export async function readMessage(text: string): Promise<SignedMessage> {
  let parts: { body: Uint8Array; signature: Uint8Array };
  try {
    parts = entryFromText(text);
  } catch (error) {
    if (error instanceof ListEntryError) malformed(`Not a message's text: ${error.message}`);
    throw error;
  }
  return verified(sealMessage(readMessageBody(parts.body)), parts.body, parts.signature);
}

/** The one text of a message: base64url of its body, `.`, base64url of its signature. */
export function messageToText(message: SignedMessage): string {
  return entryToText({ body: message.body, signature: message.signature });
}

/** The binding: SHA-256 of the offer's body, which covers the list, A's key, A's head and the offer. */
export function approvalBinding(offer: SignedMessage<OfferMessage>): Uint8Array {
  return sha256(offer.body);
}

/** N's commitment to its nonce: today's pairCommitment over the binding and N's key. */
export function approvalCommitment(binding: Uint8Array, nKey: string, nNonce: Uint8Array): Uint8Array {
  return pairCommitment(binding, nKey, nNonce);
}

/** The six digits A shows and the person types on N: today's pairDigits. */
export function approvalDigits(binding: Uint8Array, nKey: string, nNonce: Uint8Array, aNonce: Uint8Array): string {
  return pairDigits(binding, nKey, nNonce, aNonce);
}

/** The three check digits N shows and the person types on A: SHA-256(domain || binding || N's key || N's nonce || A's nonce), its first 8 bytes big-endian, modulo 1000. */
export function approvalCheckDigits(binding: Uint8Array, nKey: string, nNonce: Uint8Array, aNonce: Uint8Array): string {
  if (binding.length !== 32 || nNonce.length !== PAIR_NONCE_BYTES || aNonce.length !== PAIR_NONCE_BYTES) throw new TypeError("Invalid approval input");
  const digest = sha256(concatBytes(CHECK_DOMAIN, binding, utf8ToBytes(nKey), nNonce, aNonce));
  const value = new DataView(digest.buffer, digest.byteOffset, 8).getBigUint64(0);
  return String(value % 1000n).padStart(3, "0");
}

/**
 * A message wrong in more than one way takes the first of: `message_malformed`; `signature_invalid`
 * (does not verify: readMessage); `offer_closed`; `offer_mismatch`; `signature_invalid` (the wrong
 * participant); `challenge_other_key`; `step_order`; `step_taken`; `commitment_mismatch`.
 */
/** What a side does with a message it is shown: takes it, finds it is one it already took (no change), or refuses it (no change). */
export type Take<S> =
  | { readonly outcome: "taken" | "repeat"; readonly state: S }
  | { readonly outcome: "refused"; readonly code: ApproveRefusalCode; readonly state: S };

type OfStep<S extends ApproveStep> = SignedMessage<Extract<ApproveMessage, { readonly step: S }>>;
const ofStep = <S extends ApproveStep>(shown: SignedMessage, step: S): shown is OfStep<S> => shown.message.step === step;
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((byte, index) => byte === b[index]);
const taken = <S>(state: S): Take<S> => ({ outcome: "taken", state });
const repeat = <S>(state: S): Take<S> => ({ outcome: "repeat", state });
const refused = <S>(state: S, code: ApproveRefusalCode): Take<S> => ({ outcome: "refused", code, state });
/** A step already held: the same body again changes nothing, another body for it is `step_taken`. */
const again = <S>(state: S, held: Uint8Array, shown: Uint8Array): Take<S> => (sameBytes(held, shown) ? repeat(state) : refused(state, "step_taken"));

/**
 * Where an approval's random values come from. An ordinary caller passes nothing: every offer id and
 * nonce is then drawn fresh from the runtime's secure source, so no value serves two offers, answers
 * or challenges.
 */
export interface ApproveRandom {
  /** Only for vectors and tests that need fixed values: the bytes to use in place of a fresh draw of `length` bytes. */
  readonly fixedRandomForTests?: (length: number) => Uint8Array;
}

/** `length` random bytes of the library's own. A draw of only zero bytes is a fault of the source, never a value. */
function draw(length: number, random: ApproveRandom | undefined): Uint8Array {
  const given: unknown = random?.fixedRandomForTests ? random.fixedRandomForTests(length) : crypto.getRandomValues(new Uint8Array(length));
  if (!(given instanceof Uint8Array)) throw new TypeError("A draw is a Uint8Array");
  const bytes = ownBytes(given);
  if (bytes.length !== length) throw new TypeError(`A draw is ${length} bytes, not ${bytes.length}`);
  if (bytes.every((byte) => byte === 0)) throw new Error("The random source gave only zero bytes: it is broken, and nothing is drawn from it");
  return bytes;
}

function typedDigits(typed: string, count: 3 | 6): void {
  if (!new RegExp(`^[0-9]{${count}}$`).test(typed)) refuse("digits_malformed", `The digits typed are ${count} of 0-9`);
}

// ---- A: the device that is in, and placed the offer ----

export interface ApproverAnswer {
  readonly answer: SignedMessage<AnswerMessage>;
  readonly challenge?: SignedMessage<ChallengeMessage>;
  /** Taken only once its nonce held against the answer's commitment. */
  readonly reveal?: SignedMessage<RevealMessage>;
}

/** A's state, frozen; its bytes are read out as copies. */
export interface ApproverState {
  readonly offer: SignedMessage<OfferMessage>;
  /** In the order taken. */
  readonly answers: readonly ApproverAnswer[];
  /** `wrong_check`: one wrong entry of the check digits ended the offer; `placed`: the right one did. */
  readonly ended: "open" | "wrong_check" | "placed";
}

/** The fields of A's offer, for A to sign: A's key, the list and A's head, and an offer id drawn here. */
export function approverOffer(head: { readonly key: string; readonly list: string; readonly head_hash: string; readonly head_seq: number }, random?: ApproveRandom): OfferMessage {
  const offer: OfferMessage = { step: "offer", key: head.key, list: head.list, offer: bytesToHex(draw(OFFER_ID_BYTES, random)), head_hash: head.head_hash, head_seq: head.head_seq };
  writeMessageBody(offer);
  Object.freeze(offer);
  return offer;
}

export function approverStart(offer: SignedMessage<OfferMessage>): ApproverState {
  return frozen({ offer, answers: [], ended: "open" });
}

const withAnswer = (state: ApproverState, key: string, change: (held: ApproverAnswer) => ApproverAnswer): ApproverState => frozen({
  ...state, answers: state.answers.map((held) => (held.answer.message.key === key ? change(held) : held)),
});

/**
 * What A takes: an answer signed by its own key; a challenge signed by the offer's key to an answer it
 * holds (its own, as the service stores it); a reveal signed by an answer's key after that answer's
 * challenge, whose nonce holds against the answer's commitment. Each of this offer and list, and the
 * next step for its answer.
 */
export function approverTake(state: ApproverState, shown: SignedMessage): Take<ApproverState> {
  const offer = state.offer.message;
  if (state.ended !== "open") return refused(state, "offer_closed");
  if (shown.message.list !== offer.list || shown.message.offer !== offer.offer) return refused(state, "offer_mismatch");
  const holdsKey = (key: string) => state.answers.find((held) => held.answer.message.key === key);
  if (ofStep(shown, "offer")) {
    if (shown.message.key !== offer.key) return refused(state, "signature_invalid");
    return again(state, state.offer.body, shown.body);
  }
  if (ofStep(shown, "answer")) {
    const held = holdsKey(shown.message.key);
    if (held) return again(state, held.answer.body, shown.body);
    return taken(frozen({ ...state, answers: [...state.answers, { answer: shown }] }));
  }
  if (ofStep(shown, "challenge")) {
    const { key, to } = shown.message;
    if (key !== offer.key) return refused(state, "signature_invalid");
    const held = holdsKey(to);
    if (!held) return refused(state, "step_order");
    if (held.challenge) return again(state, held.challenge.body, shown.body);
    return taken(withAnswer(state, to, (answer) => ({ ...answer, challenge: shown })));
  }
  if (!ofStep(shown, "reveal")) throw new TypeError("A message of no step");
  const { key, nonce } = shown.message;
  const held = holdsKey(key);
  if (!held?.challenge) return refused(state, "step_order");
  if (held.reveal) return again(state, held.reveal.body, shown.body);
  if (!commitmentHolds(held.answer.message.commitment, approvalBinding(state.offer), key, nonce)) return refused(state, "commitment_mismatch");
  return taken(withAnswer(state, key, (answer) => ({ ...answer, reveal: shown })));
}

/** The fields of A's challenge to the answer of `to`, with A's nonce drawn here, for A to sign; A then takes its signed challenge as the service shows it. */
export function approverChallenge(state: ApproverState, to: string, random?: ApproveRandom): ChallengeMessage {
  if (state.ended !== "open") refuse("offer_closed", "The offer has ended");
  const held = state.answers.find((answer) => answer.answer.message.key === to) ?? refuse("step_order", "No answer of that key is held");
  if (held.challenge) refuse("step_taken", "That answer has its challenge");
  const { key, list, offer } = state.offer.message;
  const challenge: ChallengeMessage = { step: "challenge", key, list, offer, nonce: draw(PAIR_NONCE_BYTES, random), to };
  Object.freeze(challenge);
  return challenge;
}

/** The six digits A shows for the answer of `key`: null until its reveal has held against its commitment. */
export function approverDigits(state: ApproverState, key: string): string | null {
  const held = state.answers.find((answer) => answer.answer.message.key === key);
  if (!held?.challenge || !held.reveal) return null;
  return approvalDigits(approvalBinding(state.offer), key, held.reveal.message.nonce, held.challenge.message.nonce);
}

export type ApproverCheck =
  | { readonly outcome: "right"; readonly state: ApproverState; readonly adds: { readonly key: string; readonly label: string } }
  | { readonly outcome: "wrong"; readonly state: ApproverState };

/**
 * The three check digits the person typed on A for the answer whose six digits A showed. The right
 * ones: A places `device` for that key and label. A wrong entry ends the offer. Throws
 * `digits_malformed` for anything but three digits, `step_order` before A could show the six.
 */
export function approverCheck(state: ApproverState, key: string, typed: string): ApproverCheck {
  typedDigits(typed, 3);
  if (state.ended !== "open") refuse("offer_closed", "The offer has ended");
  const held = state.answers.find((answer) => answer.answer.message.key === key);
  if (!held?.challenge || !held.reveal) return refuse("step_order", "No digits were shown for that answer");
  const check = approvalCheckDigits(approvalBinding(state.offer), key, held.reveal.message.nonce, held.challenge.message.nonce);
  if (typed !== check) return { outcome: "wrong", state: frozen({ ...state, ended: "wrong_check" }) };
  return { outcome: "right", state: frozen({ ...state, ended: "placed" }), adds: { key, label: held.answer.message.label } };
}

// ---- N: the new device ----

export interface ResponderOffer {
  readonly offer: SignedMessage<OfferMessage>;
  /** N's answer and the nonce it committed to, which only N holds until its reveal. */
  readonly answer?: { readonly message: AnswerMessage; readonly nonce: Uint8Array };
  readonly challenge?: SignedMessage<ChallengeMessage>;
}

/** N's state, frozen; its bytes are read out as copies. */
export interface ResponderState {
  /** N's key. */
  readonly key: string;
  readonly offers: readonly ResponderOffer[];
  /** Offers N dropped after three wrong tries: never taken again. */
  readonly dropped: readonly string[];
  readonly wrongTries: number;
}

export function responderStart(key: string): ResponderState {
  return frozen({ key, offers: [], dropped: [], wrongTries: 0 });
}

const withOffer = (state: ResponderState, id: string, change: (held: ResponderOffer) => ResponderOffer): ResponderState => frozen({
  ...state, offers: state.offers.map((held) => (held.offer.message.offer === id ? change(held) : held)),
});

/**
 * What N takes: an offer, signed by its own key; a challenge signed by the offer's key, of an offer it
 * holds and answered, to N's key, the first for that answer. Its own answer and reveal, as the service
 * shows them, are repeats of what it wrote; another device's are signed by the wrong participant.
 */
export function responderTake(state: ResponderState, shown: SignedMessage): Take<ResponderState> {
  const message = shown.message;
  if (state.dropped.includes(message.offer)) return refused(state, "offer_closed");
  const held = state.offers.find((offer) => offer.offer.message.offer === message.offer);
  if (ofStep(shown, "offer")) {
    if (held && held.offer.message.list !== message.list) return refused(state, "offer_mismatch");
    if (held && shown.message.key !== held.offer.message.key) return refused(state, "signature_invalid");
    if (held) return again(state, held.offer.body, shown.body);
    return taken(frozen({ ...state, offers: [...state.offers, { offer: shown }] }));
  }
  if (!held || held.offer.message.list !== message.list) return refused(state, "offer_mismatch");
  if (ofStep(shown, "challenge")) {
    if (shown.message.key !== held.offer.message.key) return refused(state, "signature_invalid");
    if (shown.message.to !== state.key) return refused(state, "challenge_other_key");
    if (!held.answer) return refused(state, "step_order");
    if (held.challenge) return again(state, held.challenge.body, shown.body);
    return taken(withOffer(state, message.offer, (offer) => ({ ...offer, challenge: shown })));
  }
  if (message.key !== state.key) return refused(state, "signature_invalid");
  if (ofStep(shown, "answer")) return held.answer ? again(state, writeMessageBody(held.answer.message), shown.body) : refused(state, "step_taken");
  if (!held.answer || !held.challenge) return refused(state, "step_order");
  return again(state, writeMessageBody(responderReveal(state, message.offer)), shown.body);
}

/** N's answer to an offer it holds: the fields to sign, with its commitment to a nonce drawn here, which N keeps. */
export function responderAnswer(state: ResponderState, offer: string, label: string, random?: ApproveRandom): { readonly state: ResponderState; readonly message: AnswerMessage } {
  if (state.dropped.includes(offer)) refuse("offer_closed", "N dropped that offer");
  const held = state.offers.find((candidate) => candidate.offer.message.offer === offer) ?? refuse("offer_mismatch", "N holds no such offer");
  if (held.answer) refuse("step_taken", "N answered that offer");
  const nNonce = draw(PAIR_NONCE_BYTES, random);
  const written: AnswerMessage = { step: "answer", key: state.key, list: held.offer.message.list, offer, commitment: approvalCommitment(approvalBinding(held.offer), state.key, nNonce), label };
  writeMessageBody(written);
  const message = sealMessage(written);
  const answer = { message, get nonce() { return ownBytes(nNonce); } };
  return { state: withOffer(state, offer, (candidate) => ({ ...candidate, answer })), message };
}

/** N's reveal of its nonce, once it took the challenge to its answer. */
export function responderReveal(state: ResponderState, offer: string): RevealMessage {
  const held = state.offers.find((candidate) => candidate.offer.message.offer === offer) ?? refuse("offer_mismatch", "N holds no such offer");
  if (!held.answer || !held.challenge) refuse("step_order", "N reveals only after the challenge to its answer");
  const reveal: RevealMessage = { step: "reveal", key: state.key, list: held.offer.message.list, offer, nonce: held.answer.nonce };
  Object.freeze(reveal);
  return reveal;
}

export type ResponderTry =
  | { readonly outcome: "match"; readonly state: ResponderState; readonly offer: string; readonly check: string }
  | { readonly outcome: "wrong"; readonly state: ResponderState; readonly triesLeft: number }
  | { readonly outcome: "ended"; readonly state: ResponderState };

/**
 * The six digits the person typed on N, compared with those of each of N's answers that has its
 * challenge. Exactly one match shows that answer's three check digits; none, or more than one, is a
 * wrong try. The third wrong try ends N's part: N drops its answers and every offer it holds, and only
 * a new offer, answered anew, can match. Throws `digits_malformed` for anything but six digits.
 */
export function responderTry(state: ResponderState, typed: string): ResponderTry {
  typedDigits(typed, 6);
  const matches = state.offers.filter((held) => held.answer && held.challenge
    && approvalDigits(approvalBinding(held.offer), state.key, held.answer.nonce, held.challenge.message.nonce) === typed);
  const [match] = matches;
  if (matches.length === 1 && match?.answer && match.challenge) {
    const check = approvalCheckDigits(approvalBinding(match.offer), state.key, match.answer.nonce, match.challenge.message.nonce);
    return { outcome: "match", state, offer: match.offer.message.offer, check };
  }
  const wrongTries = state.wrongTries + 1;
  if (wrongTries < APPROVE_WRONG_TRIES) return { outcome: "wrong", state: frozen({ ...state, wrongTries }), triesLeft: APPROVE_WRONG_TRIES - wrongTries };
  const dropped = [...state.dropped, ...state.offers.map((held) => held.offer.message.offer)];
  return { outcome: "ended", state: frozen({ key: state.key, offers: [], dropped, wrongTries: 0 }) };
}
