// SPDX-License-Identifier: FSL-1.1-MIT
import { describe, expect, test } from "bun:test";
import { sha256 } from "@noble/hashes/sha2.js";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  APPROVE_PREFIX, APPROVE_WRONG_TRIES, ApproveError, approvalBinding, approvalCheckDigits, approvalCommitment, approvalDigits, approverChallenge,
  approverCheck, approverDigits, approverOffer, approverStart, approverTake, isDeviceLabel, messageToText, readMessage, readMessageBody, responderAnswer,
  responderReveal, responderStart, responderTake, responderTry, signMessage, writeMessageBody,
  type AnswerMessage, type ApproveErrorCode, type ApproveMessage, type ApproveRefusalCode, type ApproverState, type OfferMessage, type ResponderState, type SignedMessage, type Take,
} from "./account-list-approve.ts";
import { entryFromText, entryHash, entryHolds, firstState, readBody, writeFieldsUnder, type HeldEntry } from "./account-list-entry.ts";
import { fromBase64Url, toBase64Url } from "./relay-pair-sas.ts";

const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;
const DIR = join(import.meta.dir, "account-list-vectors", "approve");
const encoder = new TextEncoder();

interface KeyPair { readonly pkcs8: string; readonly spki: string }
interface EntryForm { readonly fields: [string, string][]; readonly body: string; readonly signature: string; readonly text: string; readonly hash: string }
interface MessageForm { readonly step: ApproveMessage["step"]; readonly fields: [string, string][]; readonly body: string; readonly signature: string; readonly text: string }
interface ApproveVector {
  readonly name: string;
  readonly keys: Readonly<Record<string, KeyPair>>;
  readonly list: { readonly entries: readonly EntryForm[] };
  readonly messages: readonly MessageForm[];
  readonly placed: EntryForm | null;
  readonly expect: { readonly binding: string; readonly commitment: string; readonly digits: string; readonly check: string } | { readonly stops: { readonly step: ApproveMessage["step"]; readonly code: ApproveRefusalCode } };
}
const vectors = readdirSync(DIR).filter((file) => file.endsWith(".json")).sort()
  .map((file) => JSON.parse(readFileSync(join(DIR, file), "utf8")) as ApproveVector);
const transcript = vectors.find((vector) => vector.name === "transcript");
if (!transcript || !("digits" in transcript.expect) || !transcript.placed) throw new Error("approve/transcript.json is missing or incomplete");
const want = transcript.expect;
const pairOf = (vector: ApproveVector, name: string): KeyPair => vector.keys[`TEST-ONLY-${name}`] ?? (() => { throw new Error(`no key ${name}`); })();
const keyA = pairOf(transcript, "A").spki;
const keyN = pairOf(transcript, "N").spki;

const isOffer = (message: SignedMessage): message is SignedMessage<OfferMessage> => message.message.step === "offer";
function code(run: () => unknown): ApproveErrorCode | "none" {
  try {
    run();
  } catch (error) {
    if (error instanceof ApproveError) return error.code;
    throw error;
  }
  return "none";
}
async function asyncCode(run: () => Promise<unknown>): Promise<ApproveErrorCode | "none"> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ApproveError) return error.code;
    throw error;
  }
  return "none";
}
const outcome = <S>(take: Take<S>): string => (take.outcome === "refused" ? take.code : take.outcome);
function stateOf<S>(take: Take<S>): S {
  if (take.outcome === "refused") throw new Error(`refused ${take.code}`);
  return take.state;
}

/** The vectors' TEST ONLY keys: every test runs on fixed keys and fixed nonces, so no assertion rests on a value drawn at random. */
const otherVector = vectors.find((vector) => vector.name === "answer-signature-other-key");
if (!otherVector) throw new Error("approve/answer-signature-other-key.json is missing");
async function fixedDevice(vector: ApproveVector, name: string) {
  const pair = pairOf(vector, name);
  return { key: pair.spki, priv: await crypto.subtle.importKey("pkcs8", fromBase64Url(pair.pkcs8) as Uint8Array<ArrayBuffer>, P256, false, ["sign"]) };
}
const deviceA = await fixedDevice(transcript, "A");
const deviceN = await fixedDevice(transcript, "N");
const deviceE = await fixedDevice(otherVector, "E");
/** The one seam to fixed random values: the bytes every draw of this call returns. */
const fixed = (bytes: Uint8Array) => ({ fixedRandomForTests: () => bytes });
const nonce = (fill: number) => new Uint8Array(32).fill(fill);
const LIST = "0f484e9226ad290aaac6dea9244aced4e2b7b97297ecd8d52d437a57c33e5383";
const OFFER = "0123456789abcdef0123456789abcdef";

/** One approval between A and N, on fixed keys and nonces, up to the point both could show their digits. */
async function approval(options: { list?: string; offer?: string; headSeq?: number } = {}) {
  const a = deviceA;
  const n = deviceN;
  const base = { list: options.list ?? LIST, offer: options.offer ?? OFFER };
  const offer = await signMessage({ step: "offer", key: a.key, ...base, head_hash: LIST, head_seq: options.headSeq ?? 4 }, a.priv);
  let stateA = approverStart(offer);
  let stateN = stateOf(responderTake(responderStart(n.key), offer));
  const answered = responderAnswer(stateN, base.offer, "Kim's phone", fixed(nonce(7)));
  stateN = answered.state;
  const answer = await signMessage(answered.message, n.priv);
  stateA = stateOf(approverTake(stateA, answer));
  const challenge = await signMessage(approverChallenge(stateA, n.key, fixed(nonce(9))), a.priv);
  stateA = stateOf(approverTake(stateA, challenge));
  stateN = stateOf(responderTake(stateN, challenge));
  const reveal = await signMessage(responderReveal(stateN, base.offer), n.priv);
  stateA = stateOf(approverTake(stateA, reveal));
  return { a, n, offer, answer, challenge, reveal, stateA, stateN };
}

describe("the vectors of approve/", () => {
  test("every key is TEST ONLY; every refusal vector starts with an offer and has no placed entry", () => {
    for (const vector of vectors) {
      expect(Object.keys(vector.keys).every((name) => name.startsWith("TEST-ONLY-"))).toBe(true);
      expect(vector.messages[0]?.step).toBe("offer");
      if ("stops" in vector.expect) {
        expect(vector.placed).toBeNull();
        expect(vector.messages.at(-1)?.step).toBe(vector.expect.stops.step);
      }
    }
    expect(vectors.length).toBeGreaterThan(10);
  });

  test("transcript: the list holds, and the offer's list and head are real", async () => {
    const [first, ...rest] = transcript.list.entries;
    if (!first) throw new Error("no entry 0");
    let held: HeldEntry = (await firstState(entryFromText(first.text), first.hash)).first;
    for (const entry of rest) held = await entryHolds(entryFromText(entry.text), held);
    const offer = await readMessage(transcript.messages[0]?.text ?? "");
    if (!isOffer(offer)) throw new Error("not an offer");
    expect(offer.message.list).toBe(held.list);
    expect(offer.message.head_hash).toBe(held.hash);
    expect(offer.message.head_seq).toBe(held.body.seq);
    expect(offer.message.key).toBe(keyA);
    expect(first.text).toBe(`${first.body}.${first.signature}`);
  });

  test("transcript: each message reads from its text, verifies, shows its fields, and is written again to the same bytes", async () => {
    for (const form of transcript.messages) {
      const message = await readMessage(form.text);
      expect(form.text).toBe(`${form.body}.${form.signature}`);
      expect(message.message.step).toBe(form.step);
      expect(toBase64Url(message.body)).toBe(form.body);
      expect(toBase64Url(writeMessageBody(message.message))).toBe(form.body);
      expect(messageToText(message)).toBe(form.text);
      const fields = Object.fromEntries(form.fields);
      expect(Object.keys(fields)).toEqual([...Object.keys(fields)].sort());
      expect(fields.step).toBe(form.step);
      expect(fields.key).toBe(message.message.key);
    }
    expect(transcript.messages.map((form) => form.step)).toEqual(["offer", "answer", "challenge", "reveal"]);
  });

  test("transcript: the binding, the commitment, the six and the three digits, and both sides' matching to the device entry A places", async () => {
    const [offerText, answerText, challengeText, revealText] = transcript.messages.map((form) => form.text);
    const offer = await readMessage(offerText ?? "");
    if (!isOffer(offer)) throw new Error("not an offer");
    const binding = approvalBinding(offer);
    expect(toBase64Url(binding)).toBe(want.binding);
    expect(binding).toEqual(sha256(fromBase64Url(transcript.messages[0]?.body ?? "")));
    const answer = await readMessage(answerText ?? "");
    const challenge = await readMessage(challengeText ?? "");
    const reveal = await readMessage(revealText ?? "");
    if (answer.message.step !== "answer" || challenge.message.step !== "challenge" || reveal.message.step !== "reveal") throw new Error("steps out of order");
    const nNonce = reveal.message.nonce;
    const aNonce = challenge.message.nonce;
    expect(toBase64Url(approvalCommitment(binding, keyN, nNonce))).toBe(want.commitment);
    expect(toBase64Url(answer.message.commitment)).toBe(want.commitment);
    expect(approvalDigits(binding, keyN, nNonce, aNonce)).toBe(want.digits);
    expect(approvalCheckDigits(binding, keyN, nNonce, aNonce)).toBe(want.check);
    expect(want.digits).toMatch(/^[0-9]{6}$/);
    expect(want.check).toMatch(/^[0-9]{3}$/);

    let a = approverStart(offer);
    let n = stateOf(responderTake(responderStart(keyN), offer));
    const answered = responderAnswer(n, offer.message.offer, answer.message.label, fixed(nNonce));
    expect(writeMessageBody(answered.message)).toEqual(answer.body);
    n = answered.state;
    expect(outcome(responderTake(n, answer))).toBe("repeat");
    a = stateOf(approverTake(a, answer));
    expect(approverDigits(a, keyN)).toBeNull();
    expect(writeMessageBody(approverChallenge(a, keyN, fixed(aNonce)))).toEqual(challenge.body);
    a = stateOf(approverTake(a, challenge));
    n = stateOf(responderTake(n, challenge));
    expect(approverDigits(a, keyN)).toBeNull();
    expect(writeMessageBody(responderReveal(n, offer.message.offer))).toEqual(reveal.body);
    expect(outcome(responderTake(n, reveal))).toBe("repeat");
    a = stateOf(approverTake(a, reveal));
    expect(approverDigits(a, keyN)).toBe(want.digits);
    const tried = responderTry(n, want.digits);
    if (tried.outcome !== "match") throw new Error(tried.outcome);
    expect(tried.check).toBe(want.check);
    const checked = approverCheck(a, keyN, tried.check);
    if (checked.outcome !== "right") throw new Error("wrong");
    expect(checked.adds).toEqual({ key: keyN, label: answer.message.label });

    const last = transcript.list.entries.at(-1);
    if (!last || !transcript.placed) throw new Error("no head");
    const before = await entryHolds(entryFromText(transcript.list.entries[0]?.text ?? ""), null);
    const placed = await entryHolds(entryFromText(transcript.placed.text), before);
    expect(placed.hash).toBe(transcript.placed.hash);
    expect(placed.body.kind).toBe("device");
    expect(placed.body.signer).toBe(keyA);
    expect(placed.body.adds).toEqual({ key: keyN, power: "full" });
    expect(placed.body.own.map((field) => [field.name, new TextDecoder().decode(field.value)])).toEqual([["label", answer.message.label]]);
    expect(readBody(fromBase64Url(transcript.placed.body)).prev).toBe(last.hash);
    expect(entryHash(fromBase64Url(last.body))).toBe(last.hash);
  });

  for (const vector of vectors.filter((candidate) => "stops" in candidate.expect)) {
    test(`${vector.name}: every message but the last is taken by A; the last is refused by the side it goes to`, async () => {
      if (!("stops" in vector.expect)) return;
      const keyNOf = pairOf(vector, "N").spki;
      const got = await asyncCode(async () => {
        const read: SignedMessage[] = [];
        for (const form of vector.messages) read.push(await readMessage(form.text));
        const [first, ...others] = read;
        const last = others.pop();
        if (!first || !isOffer(first) || !last) throw new Error("a refusal vector is an offer and at least one more message");
        let a = approverStart(first);
        for (const message of others) a = stateOf(approverTake(a, message));
        let take: Take<ApproverState> | Take<ResponderState>;
        if (last.message.step === "offer" || last.message.step === "challenge") {
          let n = responderStart(keyNOf);
          for (const message of read.slice(0, -1)) if (message.message.step === "offer") n = stateOf(responderTake(n, message));
          take = responderTake(n, last);
        } else {
          take = approverTake(a, last);
        }
        if (take.outcome === "refused") throw new ApproveError(take.code, "refused");
      });
      expect(got).toBe(vector.expect.stops.code);
    });
  }
});

describe("a message: its form", () => {
  const offerPairs = (over: Record<string, string> = {}): [string, string][] => Object.entries({ head_hash: LIST, head_seq: "4", key: keyA, list: LIST, offer: OFFER, step: "offer", ...over });
  const body = (pairs: [string, string][]) => writeFieldsUnder(APPROVE_PREFIX, pairs.map(([name, value]) => ({ name, value: encoder.encode(value) })));
  const bodyCode = (pairs: [string, string][]) => code(() => readMessageBody(body(pairs)));

  test("the smallest offer reads, and each field out of form or out of its step is refused", () => {
    expect(bodyCode(offerPairs())).toBe("none");
    expect(bodyCode(offerPairs({ head_seq: "0" }))).toBe("none");
    for (const pairs of [
      offerPairs().filter(([name]) => name !== "head_seq"),
      offerPairs().filter(([name]) => name !== "step"),
      offerPairs().filter(([name]) => name !== "key"),
      [...offerPairs(), ["label", "x"]] as [string, string][],
      offerPairs({ step: "offers" }),
      offerPairs({ step: "" }),
      offerPairs({ head_seq: "04" }),
      offerPairs({ head_seq: "1000000000000000" }),
      offerPairs({ head_hash: LIST.toUpperCase() }),
      offerPairs({ head_hash: "" }),
      offerPairs({ list: "" }),
      offerPairs({ list: LIST.slice(1) }),
      offerPairs({ offer: OFFER.toUpperCase() }),
      offerPairs({ offer: OFFER.slice(1) }),
      offerPairs({ offer: `${OFFER}0` }),
      offerPairs({ key: `${keyA.slice(0, -1)}h` }),
      offerPairs({ key: keyA.slice(1) }),
    ]) expect(bodyCode(pairs)).toBe("message_malformed");
  });

  const answerPairs = (over: Record<string, string> = {}): [string, string][] => Object.entries({ commitment: toBase64Url(nonce(1)), key: keyN, label: "Kim's phone", list: LIST, offer: OFFER, step: "answer", ...over });
  test("an answer's commitment and label", () => {
    expect(bodyCode(answerPairs())).toBe("none");
    const overs: Record<string, string>[] = [
      { commitment: toBase64Url(new Uint8Array(31)) }, { commitment: toBase64Url(new Uint8Array(33)) }, { commitment: `${toBase64Url(nonce(1))}=` },
      { commitment: `${toBase64Url(nonce(1)).slice(0, -1)}B` }, { commitment: toBase64Url(nonce(1)).replace(/^./, "+") },
      { label: "" }, { label: "x".repeat(49) }, { label: " Kim" }, { label: "Kim " }, { label: "Kim  phone" }, { label: "Kim\tphone" }, { label: "Kim\u0007" },
      { label: "\uFEFFKim" },
    ];
    for (const over of overs) expect(bodyCode(answerPairs(over))).toBe("message_malformed");
    expect(bodyCode(answerPairs({ label: "x".repeat(48) }))).toBe("none");
    expect(bodyCode(answerPairs({ label: "김의 휴대폰 📱" }))).toBe("none");
    const notUtf8 = writeFieldsUnder(APPROVE_PREFIX, answerPairs().map(([name, value]) => ({ name, value: name === "label" ? Uint8Array.of(0x4b, 0xff) : encoder.encode(value) })));
    expect(code(() => readMessageBody(notUtf8))).toBe("message_malformed");
  });

  test("a label is checked before it is encoded: a lone surrogate is refused, not turned into U+FFFD", () => {
    expect(isDeviceLabel("Kim\uD800")).toBe(false);
    expect(code(() => writeMessageBody({ step: "answer", key: keyN, list: LIST, offer: OFFER, commitment: nonce(1), label: "Kim\uD800" }))).toBe("message_malformed");
  });

  test("a challenge's to and nonce, a reveal's nonce", () => {
    const challenge = (over: Record<string, string> = {}): [string, string][] => Object.entries({ key: keyA, list: LIST, nonce: toBase64Url(nonce(2)), offer: OFFER, step: "challenge", to: keyN, ...over });
    expect(bodyCode(challenge())).toBe("none");
    expect(bodyCode(challenge({ to: "" }))).toBe("message_malformed");
    expect(bodyCode(challenge({ nonce: toBase64Url(new Uint8Array(16)) }))).toBe("message_malformed");
    expect(bodyCode(challenge().filter(([name]) => name !== "to"))).toBe("message_malformed");
    const reveal = (over: Record<string, string> = {}): [string, string][] => Object.entries({ key: keyN, list: LIST, nonce: toBase64Url(nonce(2)), offer: OFFER, step: "reveal", ...over });
    expect(bodyCode(reveal())).toBe("none");
    expect(bodyCode([...reveal(), ["to", keyA]])).toBe("message_malformed");
  });

  test("the prefix: an entry's body is no message, and a message is no entry", () => {
    const entryBody = fromBase64Url(transcript.list.entries[0]?.body ?? "");
    expect(code(() => readMessageBody(entryBody))).toBe("message_malformed");
    const messageBody = fromBase64Url(transcript.messages[0]?.body ?? "");
    expect(() => readBody(messageBody)).toThrow();
    expect(code(() => readMessageBody(new Uint8Array(0)))).toBe("message_malformed");
    expect(code(() => readMessageBody(encoder.encode("ovis-list-approve/2")))).toBe("message_malformed");
  });

  test("a message's text: the one text of an entry, and a signature by its own key", async () => {
    const good = transcript.messages[1]?.text ?? "";
    expect(await asyncCode(() => readMessage(good))).toBe("none");
    for (const text of [`${good}.`, `${good}\n`, ` ${good}`, good.replace(".", ".."), `.${good.split(".")[1]}`, `${good.split(".")[0]}.`, `${good}=`])
      expect(await asyncCode(() => readMessage(text))).toBe("message_malformed");
    const [bodyText = "", signatureText = ""] = good.split(".");
    const flipped = fromBase64Url(signatureText);
    flipped[5] = (flipped[5] ?? 0) ^ 1;
    expect(await asyncCode(() => readMessage(`${bodyText}.${toBase64Url(flipped)}`))).toBe("signature_invalid");
    const bodyBytes = fromBase64Url(bodyText);
    const other = deviceE;
    const byOther = new Uint8Array(await crypto.subtle.sign(SIGN, other.priv, new Uint8Array(bodyBytes)));
    expect(await asyncCode(() => readMessage(`${bodyText}.${toBase64Url(byOther)}`))).toBe("signature_invalid");
  });

  test("signing with a key that is not the message's own is refused", async () => {
    const other = deviceE;
    expect(await asyncCode(() => signMessage({ step: "reveal", key: keyN, list: LIST, offer: OFFER, nonce: nonce(1) }, other.priv))).toBe("signature_invalid");
  });
});

describe("the digits", () => {
  test("the check digits: SHA-256 over the domain, the binding, N's key, N's nonce and A's nonce; first 8 bytes big-endian mod 1000", () => {
    const binding = nonce(3);
    const digest = sha256(new Uint8Array([...encoder.encode("ovis-list-approve-check/1"), ...binding, ...encoder.encode(keyN), ...nonce(4), ...nonce(5)]));
    const value = new DataView(digest.buffer, digest.byteOffset, 8).getBigUint64(0);
    expect(approvalCheckDigits(binding, keyN, nonce(4), nonce(5))).toBe(String(value % 1000n).padStart(3, "0"));
    expect(() => approvalCheckDigits(nonce(3).subarray(1), keyN, nonce(4), nonce(5))).toThrow(TypeError);
  });

  test("a swapped key, list or head changes the six and the three digits", async () => {
    const a = deviceA;
    const n = deviceN;
    const other = deviceE;
    const offerOf = (over: Partial<OfferMessage> = {}) => signMessage({ step: "offer", key: a.key, list: LIST, offer: OFFER, head_hash: LIST, head_seq: 4, ...over }, over.key === other.key ? other.priv : a.priv);
    const digitsOf = async (offer: Promise<SignedMessage<OfferMessage>>, nKey = n.key) => {
      const binding = approvalBinding(await offer);
      return `${approvalDigits(binding, nKey, nonce(7), nonce(9))}/${approvalCheckDigits(binding, nKey, nonce(7), nonce(9))}`;
    };
    const base = await digitsOf(offerOf());
    const swapped = [
      await digitsOf(offerOf(), other.key),
      await digitsOf(offerOf({ key: other.key })),
      await digitsOf(offerOf({ list: entryHash(encoder.encode("another list")) })),
      await digitsOf(offerOf({ head_hash: entryHash(encoder.encode("another head")) })),
      await digitsOf(offerOf({ head_seq: 5 })),
      await digitsOf(offerOf({ offer: "f".repeat(32) })),
    ];
    for (const digits of swapped) {
      expect(digits.split("/")[0]).not.toBe(base.split("/")[0]);
      expect(digits.split("/")[1]).not.toBe(base.split("/")[1]);
    }
  });
});

describe("what A takes", () => {
  test("no digits before the reveal held; a reveal that does not hold against the commitment is refused and shows none", async () => {
    const run = await approval();
    let a = approverStart(run.offer);
    a = stateOf(approverTake(a, run.answer));
    expect(approverDigits(a, run.n.key)).toBeNull();
    expect(code(() => approverCheck(a, run.n.key, "123"))).toBe("step_order");
    a = stateOf(approverTake(a, run.challenge));
    expect(approverDigits(a, run.n.key)).toBeNull();
    const lying = await signMessage({ step: "reveal", key: run.n.key, list: LIST, offer: OFFER, nonce: nonce(8) }, run.n.priv);
    const take = approverTake(a, lying);
    expect(outcome(take)).toBe("commitment_mismatch");
    expect(take.state).toBe(a);
    expect(approverDigits(take.state, run.n.key)).toBeNull();
    expect(approverDigits(stateOf(approverTake(a, run.reveal)), run.n.key)).toBe(approvalDigits(approvalBinding(run.offer), run.n.key, nonce(7), nonce(9)));
  });

  test("a step sent twice alike is a repeat that changes nothing; changed, step_taken; before its predecessor, step_order", async () => {
    const run = await approval();
    for (const message of [run.offer, run.answer, run.challenge, run.reveal]) {
      const take = approverTake(run.stateA, message);
      expect(outcome(take)).toBe("repeat");
      expect(take.state).toBe(run.stateA);
    }
    const fresh = approverStart(run.offer);
    expect(outcome(approverTake(fresh, run.challenge))).toBe("step_order");
    expect(outcome(approverTake(fresh, run.reveal))).toBe("step_order");
    const changed = await signMessage({ step: "challenge", key: run.a.key, list: LIST, offer: OFFER, nonce: nonce(10), to: run.n.key }, run.a.priv);
    expect(outcome(approverTake(run.stateA, changed))).toBe("step_taken");
    expect(code(() => approverChallenge(run.stateA, run.n.key, fixed(nonce(10))))).toBe("step_taken");
    expect(code(() => approverChallenge(fresh, run.n.key, fixed(nonce(10))))).toBe("step_order");
  });

  test("a message of another offer or list, or signed by the wrong participant", async () => {
    const run = await approval();
    const a = approverStart(run.offer);
    const otherOffer = await signMessage({ ...run.answer.message, offer: "f".repeat(32) }, run.n.priv);
    const otherList = await signMessage({ ...run.answer.message, list: entryHash(encoder.encode("another list")) }, run.n.priv);
    expect(outcome(approverTake(a, otherOffer))).toBe("offer_mismatch");
    expect(outcome(approverTake(a, otherList))).toBe("offer_mismatch");
    const withAnswer = stateOf(approverTake(a, run.answer));
    const byN = await signMessage({ step: "challenge", key: run.n.key, list: LIST, offer: OFFER, nonce: nonce(9), to: run.n.key }, run.n.priv);
    expect(outcome(approverTake(withAnswer, byN))).toBe("signature_invalid");
    const stranger = deviceE;
    const strangerReveal = await signMessage({ step: "reveal", key: stranger.key, list: LIST, offer: OFFER, nonce: nonce(7) }, stranger.priv);
    expect(outcome(approverTake(stateOf(approverTake(withAnswer, run.challenge)), strangerReveal))).toBe("step_order");
  });

  test("one wrong entry ends the offer: nothing more is taken and nothing is placed", async () => {
    const run = await approval();
    const check = approvalCheckDigits(approvalBinding(run.offer), run.n.key, nonce(7), nonce(9));
    const wrong = String((Number(check) + 1) % 1000).padStart(3, "0");
    const result = approverCheck(run.stateA, run.n.key, wrong);
    expect(result.outcome).toBe("wrong");
    expect(result.state.ended).toBe("wrong_check");
    expect(outcome(approverTake(result.state, run.reveal))).toBe("offer_closed");
    expect(code(() => approverCheck(result.state, run.n.key, check))).toBe("offer_closed");
    expect(code(() => approverChallenge(result.state, run.n.key, fixed(nonce(1))))).toBe("offer_closed");
  });

  test("the right entry places the device of that answer, with its label; the offer is then over", async () => {
    const run = await approval();
    const check = approvalCheckDigits(approvalBinding(run.offer), run.n.key, nonce(7), nonce(9));
    const result = approverCheck(run.stateA, run.n.key, check);
    if (result.outcome !== "right") throw new Error("wrong");
    expect(result.adds).toEqual({ key: run.n.key, label: "Kim's phone" });
    expect(result.state.ended).toBe("placed");
    expect(outcome(approverTake(result.state, run.answer))).toBe("offer_closed");
  });

  test("a second device that answers the same offer gets nothing placed by the first one's digits", async () => {
    const run = await approval();
    const second = deviceE;
    const answer = await signMessage({ step: "answer", key: second.key, list: LIST, offer: OFFER, commitment: approvalCommitment(approvalBinding(run.offer), second.key, nonce(11)), label: "Not mine" }, second.priv);
    let a = stateOf(approverTake(run.stateA, answer));
    a = stateOf(approverTake(a, await signMessage(approverChallenge(a, second.key, fixed(nonce(12))), run.a.priv)));
    a = stateOf(approverTake(a, await signMessage({ step: "reveal", key: second.key, list: LIST, offer: OFFER, nonce: nonce(11) }, second.priv)));
    expect(a.answers.map((held) => held.answer.message.key)).toEqual([run.n.key, second.key]);
    const firstCheck = approvalCheckDigits(approvalBinding(run.offer), run.n.key, nonce(7), nonce(9));
    const secondCheck = approvalCheckDigits(approvalBinding(run.offer), second.key, nonce(11), nonce(12));
    expect(secondCheck).not.toBe(firstCheck);
    expect(approverCheck(a, second.key, firstCheck).outcome).toBe("wrong");
    const right = approverCheck(a, run.n.key, firstCheck);
    if (right.outcome !== "right") throw new Error("wrong");
    expect(right.adds.key).toBe(run.n.key);
  });

  test("three check digits typed: anything but three of 0-9 is the caller's fault and ends nothing", async () => {
    const run = await approval();
    for (const typed of ["", "12", "1234", "12a", " 12", "١٢٣", "+12"]) {
      expect(code(() => approverCheck(run.stateA, run.n.key, typed))).toBe("digits_malformed");
    }
    expect(run.stateA.ended).toBe("open");
  });
});

describe("what N takes", () => {
  test("its own answer and reveal as the service shows them are repeats; another device's are signed by the wrong participant", async () => {
    const run = await approval();
    expect(outcome(responderTake(run.stateN, run.offer))).toBe("repeat");
    expect(outcome(responderTake(run.stateN, run.answer))).toBe("repeat");
    expect(outcome(responderTake(run.stateN, run.challenge))).toBe("repeat");
    expect(outcome(responderTake(run.stateN, run.reveal))).toBe("repeat");
    const second = deviceE;
    const answer = await signMessage({ ...run.answer.message, key: second.key }, second.priv);
    expect(outcome(responderTake(run.stateN, answer))).toBe("signature_invalid");
    const revealByOther = await signMessage({ ...run.reveal.message, key: second.key }, second.priv);
    expect(outcome(responderTake(run.stateN, revealByOther))).toBe("signature_invalid");
    const changedAnswer = await signMessage({ ...run.answer.message, label: "Kim's tablet" }, run.n.priv);
    expect(outcome(responderTake(run.stateN, changedAnswer))).toBe("step_taken");
    const changedReveal = await signMessage({ ...run.reveal.message, nonce: nonce(1) }, run.n.priv);
    expect(outcome(responderTake(run.stateN, changedReveal))).toBe("step_taken");
  });

  test("a challenge: only by the offer's key, only to N, only after N answered, only once", async () => {
    const run = await approval();
    const n0 = stateOf(responderTake(responderStart(run.n.key), run.offer));
    expect(outcome(responderTake(n0, run.challenge))).toBe("step_order");
    const answered = responderAnswer(n0, OFFER, "Kim's phone", fixed(nonce(7))).state;
    expect(code(() => responderReveal(answered, OFFER))).toBe("step_order");
    const byN = await signMessage({ ...run.challenge.message, key: run.n.key }, run.n.priv);
    expect(outcome(responderTake(answered, byN))).toBe("signature_invalid");
    const stranger = deviceE;
    const toStranger = await signMessage({ ...run.challenge.message, to: stranger.key }, run.a.priv);
    expect(outcome(responderTake(answered, toStranger))).toBe("challenge_other_key");
    const changed = await signMessage({ ...run.challenge.message, nonce: nonce(1) }, run.a.priv);
    expect(outcome(responderTake(run.stateN, changed))).toBe("step_taken");
    const unknown = await signMessage({ ...run.challenge.message, offer: "f".repeat(32) }, run.a.priv);
    expect(outcome(responderTake(run.stateN, unknown))).toBe("offer_mismatch");
    const otherList = await signMessage({ ...run.challenge.message, list: entryHash(encoder.encode("another list")) }, run.a.priv);
    expect(outcome(responderTake(run.stateN, otherList))).toBe("offer_mismatch");
    expect(code(() => responderAnswer(run.stateN, OFFER, "Kim's phone", fixed(nonce(7))))).toBe("step_taken");
    expect(code(() => responderAnswer(run.stateN, "f".repeat(32), "Kim's phone", fixed(nonce(7))))).toBe("offer_mismatch");
  });

  test("an offer of another list never matches the digits of the person's own offer", async () => {
    const run = await approval();
    const thief = deviceE;
    const fake = await signMessage({ step: "offer", key: thief.key, list: entryHash(encoder.encode("the thief's list")), offer: "e".repeat(32), head_hash: LIST, head_seq: 0 }, thief.priv);
    let n = stateOf(responderTake(run.stateN, fake));
    const answered = responderAnswer(n, fake.message.offer, "Kim's phone", fixed(nonce(20)));
    n = answered.state;
    n = stateOf(responderTake(n, await signMessage({ step: "challenge", key: thief.key, list: fake.message.list, offer: fake.message.offer, nonce: nonce(21), to: run.n.key }, thief.priv)));
    const real = approverDigits(run.stateA, run.n.key);
    if (real === null) throw new Error("no digits");
    const tried = responderTry(n, real);
    if (tried.outcome !== "match") throw new Error(tried.outcome);
    expect(tried.offer).toBe(OFFER);
    const fakeDigits = approvalDigits(approvalBinding(fake), run.n.key, nonce(20), nonce(21));
    expect(fakeDigits).not.toBe(real);
  });

  test("a wrong try, then three: N drops its answers and every offer it holds; the dropped offer is never taken again; a new offer answered anew matches", async () => {
    const run = await approval();
    const right = approverDigits(run.stateA, run.n.key);
    if (right === null) throw new Error("no digits");
    const wrong = String((Number(right) + 1) % 1_000_000).padStart(6, "0");
    let n = run.stateN;
    for (let attempt = 1; attempt < APPROVE_WRONG_TRIES; attempt++) {
      const tried = responderTry(n, wrong);
      if (tried.outcome !== "wrong") throw new Error(tried.outcome);
      expect(tried.triesLeft).toBe(APPROVE_WRONG_TRIES - attempt);
      n = tried.state;
    }
    const ended = responderTry(n, wrong);
    if (ended.outcome !== "ended") throw new Error(ended.outcome);
    n = ended.state;
    expect(n.offers).toEqual([]);
    expect(n.dropped).toEqual([OFFER]);
    expect(responderTry(n, right).outcome).toBe("wrong");
    expect(outcome(responderTake(n, run.offer))).toBe("offer_closed");
    expect(outcome(responderTake(n, run.challenge))).toBe("offer_closed");
    expect(code(() => responderAnswer(n, OFFER, "Kim's phone", fixed(nonce(7))))).toBe("offer_closed");

    const offer = await signMessage({ step: "offer", key: run.a.key, list: LIST, offer: "a".repeat(32), head_hash: LIST, head_seq: 4 }, run.a.priv);
    n = stateOf(responderTake(responderStart(run.n.key), offer));
    n = { ...n, dropped: [OFFER] };
    const answered = responderAnswer(n, offer.message.offer, "Kim's phone", fixed(nonce(30)));
    n = answered.state;
    let a = stateOf(approverTake(approverStart(offer), await signMessage(answered.message, run.n.priv)));
    const challenge = await signMessage(approverChallenge(a, run.n.key, fixed(nonce(31))), run.a.priv);
    a = stateOf(approverTake(a, challenge));
    n = stateOf(responderTake(n, challenge));
    a = stateOf(approverTake(a, await signMessage(responderReveal(n, offer.message.offer), run.n.priv)));
    const digits = approverDigits(a, run.n.key);
    if (digits === null) throw new Error("no digits");
    expect(responderTry(n, digits).outcome).toBe("match");
  });

  test("two answers whose six digits both equal the typed ones: a wrong try", async () => {
    // The transcript's keys and nonces, so the search below is the same on every run.
    const privateOf = (name: string) => crypto.subtle.importKey("pkcs8", fromBase64Url(pairOf(transcript, name).pkcs8) as Uint8Array<ArrayBuffer>, P256, false, ["sign"]);
    const privA = await privateOf("A");
    const [offer, , challenge, reveal] = await Promise.all(transcript.messages.map((form) => readMessage(form.text)));
    if (!offer || !isOffer(offer) || challenge?.message.step !== "challenge" || reveal?.message.step !== "reveal") throw new Error("transcript");
    let n = stateOf(responderTake(responderStart(keyN), offer));
    n = responderAnswer(n, offer.message.offer, "Kim's phone", fixed(reveal.message.nonce)).state;
    n = stateOf(responderTake(n, challenge));
    expect(responderTry(n, want.digits).outcome).toBe("match");
    const second = await signMessage({ ...offer.message, offer: "b".repeat(32) }, privA);
    n = stateOf(responderTake(n, second));
    n = responderAnswer(n, second.message.offer, "Kim's phone", fixed(nonce(40))).state;
    // A's nonce for the second offer: 186220 as a big-endian 32-bit number, then zeros, found once by a search
    // of counters as the first whose six digits equal the transcript's.
    const aNonce = new Uint8Array(32);
    new DataView(aNonce.buffer).setUint32(0, 186220);
    expect(approvalDigits(approvalBinding(second), keyN, nonce(40), aNonce)).toBe(want.digits);
    n = stateOf(responderTake(n, await signMessage({ step: "challenge", key: keyA, list: offer.message.list, offer: second.message.offer, nonce: aNonce, to: keyN }, privA)));
    const tried = responderTry(n, want.digits);
    expect(tried.outcome).toBe("wrong");
  });

  test("six digits typed: anything but six of 0-9 is the caller's fault and is no wrong try", async () => {
    const run = await approval();
    for (const typed of ["", "12345", "1234567", "12345a", " 12345", "١٢٣٤٥٦", "+12345", "12345\n"]) {
      expect(code(() => responderTry(run.stateN, typed))).toBe("digits_malformed");
    }
    expect(run.stateN.wrongTries).toBe(0);
  });
});

describe("a message wrong in two ways takes the first name of the order (sheet entry 48)", () => {
  const firstOf = async (text: string, judge: (message: SignedMessage) => Take<ApproverState> | Take<ResponderState>) =>
    asyncCode(async () => {
      const take = judge(await readMessage(text));
      if (take.outcome === "refused") throw new ApproveError(take.code, "refused");
    });
  const otherList = entryHash(encoder.encode("another list"));
  const flipSignature = (text: string) => {
    const [body = "", signature = ""] = text.split(".");
    const bytes = fromBase64Url(signature);
    bytes[9] = (bytes[9] ?? 0) ^ 1;
    return `${body}.${toBase64Url(bytes)}`;
  };
  const droppedN = (run: Awaited<ReturnType<typeof approval>>): ResponderState => ({ ...run.stateN, offers: [], dropped: [OFFER] });

  test("message_malformed before signature_invalid: a field its step does not name, signed by another key", async () => {
    const run = await approval();
    const stranger = deviceE;
    const pairs: [string, string][] = Object.entries({ commitment: toBase64Url(nonce(1)), key: run.n.key, label: "Kim's phone", list: LIST, nonce: toBase64Url(nonce(2)), offer: OFFER, step: "answer" });
    const body = writeFieldsUnder(APPROVE_PREFIX, pairs.map(([name, value]) => ({ name, value: encoder.encode(value) })));
    const signature = new Uint8Array(await crypto.subtle.sign(SIGN, stranger.priv, new Uint8Array(body)));
    expect(await asyncCode(() => readMessage(`${toBase64Url(body)}.${toBase64Url(signature)}`))).toBe("message_malformed");
  });

  test("signature_invalid (does not verify) before offer_closed: a broken signature on a message of a dropped offer", async () => {
    const run = await approval();
    expect(await firstOf(flipSignature(messageToText(run.challenge)), (message) => responderTake(droppedN(run), message))).toBe("signature_invalid");
  });

  test("offer_closed before offer_mismatch: on N a dropped offer of another list; on A an ended offer and another offer", async () => {
    const run = await approval();
    const challenge = await signMessage({ ...run.challenge.message, list: otherList }, run.a.priv);
    expect(outcome(responderTake(droppedN(run), challenge))).toBe("offer_closed");
    const ended = { ...run.stateA, ended: "wrong_check" as const };
    const answer = await signMessage({ ...run.answer.message, offer: "f".repeat(32) }, run.n.priv);
    expect(outcome(approverTake(ended, answer))).toBe("offer_closed");
  });

  test("offer_mismatch before signature_invalid (the wrong participant): a challenge of another list by N's own key", async () => {
    const run = await approval();
    const byN = await signMessage({ ...run.challenge.message, key: run.n.key, list: otherList }, run.n.priv);
    expect(outcome(approverTake(run.stateA, byN))).toBe("offer_mismatch");
    expect(outcome(responderTake(run.stateN, byN))).toBe("offer_mismatch");
    const offerOtherList = await signMessage({ ...run.offer.message, key: run.n.key, list: otherList }, run.n.priv);
    expect(outcome(responderTake(run.stateN, offerOtherList))).toBe("offer_mismatch");
  });

  test("signature_invalid (the wrong participant) before challenge_other_key, and before step_taken for an offer", async () => {
    const run = await approval();
    const stranger = deviceE;
    const byN = await signMessage({ ...run.challenge.message, key: run.n.key, to: stranger.key }, run.n.priv);
    expect(outcome(responderTake(run.stateN, byN))).toBe("signature_invalid");
    const offerByStranger = await signMessage({ ...run.offer.message, key: stranger.key, head_seq: 9 }, stranger.priv);
    expect(outcome(approverTake(run.stateA, offerByStranger))).toBe("signature_invalid");
    expect(outcome(responderTake(run.stateN, offerByStranger))).toBe("signature_invalid");
  });

  test("challenge_other_key before step_order: a challenge to another key, before N answered", async () => {
    const run = await approval();
    const stranger = deviceE;
    const unanswered = stateOf(responderTake(responderStart(run.n.key), run.offer));
    const toStranger = await signMessage({ ...run.challenge.message, to: stranger.key }, run.a.priv);
    expect(outcome(responderTake(unanswered, toStranger))).toBe("challenge_other_key");
  });

  test("step_taken before commitment_mismatch: a changed reveal whose nonce does not hold either (as the vector reveal-changed)", async () => {
    const run = await approval();
    const changed = await signMessage({ ...run.reveal.message, nonce: nonce(1) }, run.n.priv);
    expect(outcome(approverTake(run.stateA, changed))).toBe("step_taken");
    expect(outcome(approverTake(stateOf(approverTake(stateOf(approverTake(approverStart(run.offer), run.answer)), run.challenge)), changed))).toBe("commitment_mismatch");
  });
});

describe("the library's own random values", () => {
  test("by default each offer id and each nonce is drawn fresh: two offers, two answers and two challenges share none", async () => {
    const head = { key: deviceA.key, list: LIST, head_hash: LIST, head_seq: 4 };
    const first = approverOffer(head);
    const second = approverOffer(head);
    expect(first.offer).toMatch(/^[0-9a-f]{32}$/);
    expect(first.offer).not.toBe(second.offer);
    const offers = [await signMessage(first, deviceA.priv), await signMessage(second, deviceA.priv)];
    let n = responderStart(deviceN.key);
    for (const offer of offers) n = responderAnswer(stateOf(responderTake(n, offer)), offer.message.offer, "Kim's phone").state;
    const [nonceOne, nonceTwo] = n.offers.map((held) => toBase64Url(held.answer?.nonce ?? new Uint8Array(0)));
    expect(nonceOne).toHaveLength(43);
    expect(nonceOne).not.toBe(nonceTwo);
    const offer = offers[0];
    if (!offer) throw new Error("no offer");
    let a = approverStart(offer);
    for (const answerer of [deviceN, deviceE]) {
      const answer = await signMessage({ step: "answer", key: answerer.key, list: LIST, offer: offer.message.offer, commitment: nonce(1), label: "Kim's phone" }, answerer.priv);
      a = stateOf(approverTake(a, answer));
    }
    const challenges = [approverChallenge(a, deviceN.key), approverChallenge(a, deviceE.key)];
    expect(toBase64Url(challenges[0]?.nonce ?? new Uint8Array(0))).not.toBe(toBase64Url(challenges[1]?.nonce ?? new Uint8Array(0)));
  });

  test("the seam for fixed values gives exactly what it returns, and a draw of another length is a fault", () => {
    const offer = approverOffer({ key: deviceA.key, list: LIST, head_hash: LIST, head_seq: 4 }, fixed(new Uint8Array(16).fill(0xab)));
    expect(offer.offer).toBe("ab".repeat(16));
    expect(() => approverOffer({ key: deviceA.key, list: LIST, head_hash: LIST, head_seq: 4 }, fixed(nonce(1)))).toThrow(TypeError);
  });

  test("the library keeps copies: a caller that changes its buffers afterwards changes nothing the library holds", async () => {
    const run = await approval();
    // a message the caller signed, then changed
    const reveal = { step: "reveal" as const, key: deviceN.key, list: LIST, offer: OFFER, nonce: nonce(7) };
    const signed = await signMessage(reveal, deviceN.priv);
    reveal.nonce.fill(0);
    expect(signed.message.nonce).toEqual(nonce(7));
    // a fixed draw the caller wipes after the answer
    const drawn = nonce(7);
    const n0 = stateOf(responderTake(responderStart(deviceN.key), run.offer));
    const answered = responderAnswer(n0, OFFER, "Kim's phone", fixed(drawn));
    drawn.fill(0);
    answered.message.commitment.fill(0);
    expect(outcome(responderTake(answered.state, run.answer))).toBe("repeat");
    const withChallenge = stateOf(responderTake(answered.state, run.challenge));
    const revealed = responderReveal(withChallenge, OFFER);
    revealed.nonce.fill(0);
    expect(responderReveal(withChallenge, OFFER).nonce).toEqual(nonce(7));
    // a signed message A took, whose buffers the caller then changes
    const shown = await readMessage(messageToText(run.answer));
    const a = stateOf(approverTake(approverStart(run.offer), shown));
    shown.body.fill(0);
    if (shown.message.step !== "answer") throw new Error("not an answer");
    shown.message.commitment.fill(0);
    expect(outcome(approverTake(a, run.answer))).toBe("repeat");
    expect(outcome(approverTake(stateOf(approverTake(a, run.challenge)), run.reveal))).toBe("taken");
  });
});

describe("the writer reads back what it wrote", () => {
  test("a value out of the form of its field is refused by the writer, as the reader would", () => {
    const base = { key: keyN, list: LIST, offer: OFFER };
    for (const message of [
      { step: "reveal", ...base, key: "not a key" },
      { step: "reveal", ...base, list: LIST.toUpperCase() },
      { step: "reveal", ...base, offer: OFFER.toUpperCase() },
      { step: "reveal", ...base, nonce: new Uint8Array(31) },
      { step: "challenge", ...base, key: keyA, nonce: nonce(1), to: "not a key" },
      { step: "offer", ...base, key: keyA, head_hash: "", head_seq: 4 },
      { step: "offer", ...base, key: keyA, head_hash: LIST, head_seq: -1 },
      { step: "answer", ...base, commitment: new Uint8Array(33), label: "Kim's phone" },
    ] as const) {
      const full: ApproveMessage = message.step === "reveal" ? { nonce: nonce(1), ...message } : message;
      expect(code(() => writeMessageBody(full))).toBe("message_malformed");
    }
  });
});

describe("leading zeros are kept", () => {
  test("a fixed approval whose six digits are 073571 and whose check digits are 069: both sides show and take them with the zero", async () => {
    // The transcript's keys, offer 888...8, N's nonce all 31s, A's nonce 56 as a big-endian 32-bit number then zeros.
    const offer = await signMessage({ step: "offer", key: deviceA.key, list: LIST, offer: "8".repeat(32), head_hash: LIST, head_seq: 4 }, deviceA.priv);
    const aNonce = new Uint8Array(32);
    new DataView(aNonce.buffer).setUint32(0, 56);
    let n = stateOf(responderTake(responderStart(deviceN.key), offer));
    const answered = responderAnswer(n, offer.message.offer, "Kim's phone", fixed(nonce(31)));
    n = answered.state;
    let a = stateOf(approverTake(approverStart(offer), await signMessage(answered.message, deviceN.priv)));
    const challenge = await signMessage(approverChallenge(a, deviceN.key, fixed(aNonce)), deviceA.priv);
    a = stateOf(approverTake(a, challenge));
    n = stateOf(responderTake(n, challenge));
    a = stateOf(approverTake(a, await signMessage(responderReveal(n, offer.message.offer), deviceN.priv)));
    expect(approverDigits(a, deviceN.key)).toBe("073571");
    const tried = responderTry(n, "073571");
    if (tried.outcome !== "match") throw new Error(tried.outcome);
    expect(tried.check).toBe("069");
    expect(approverCheck(a, deviceN.key, "069").outcome).toBe("right");
  });
});

describe("the library's bytes are its own, a node Buffer included", () => {
  const offerHead = { key: deviceA.key, list: LIST, head_hash: LIST, head_seq: 4 };

  test("a Buffer from the seam: wiped after the draw, N's nonce and A's challenge keep the drawn bytes", async () => {
    const run = await approval();
    const nBuffer = Buffer.alloc(32, 7);
    const n0 = stateOf(responderTake(responderStart(deviceN.key), run.offer));
    const answered = responderAnswer(n0, OFFER, "Kim's phone", { fixedRandomForTests: () => nBuffer });
    nBuffer.fill(0);
    expect(answered.state.offers[0]?.answer?.nonce).toEqual(nonce(7));
    const aBuffer = Buffer.alloc(32, 9);
    const a = approverStart(run.offer);
    const withAnswer = stateOf(approverTake(a, run.answer));
    const challenge = approverChallenge(withAnswer, deviceN.key, { fixedRandomForTests: () => aBuffer });
    aBuffer.fill(0);
    expect(challenge.nonce).toEqual(nonce(9));
  });

  test("a Buffer in a message the caller built and signed: wiped afterwards, the signed message and what A took keep its bytes", async () => {
    const run = await approval();
    const commitment = Buffer.alloc(32);
    commitment.set(approvalCommitment(approvalBinding(run.offer), deviceN.key, nonce(7)));
    const handBuilt: AnswerMessage = { step: "answer", key: deviceN.key, list: LIST, offer: OFFER, commitment, label: "Kim's phone" };
    const signed = await signMessage(handBuilt, deviceN.priv);
    let a = stateOf(approverTake(approverStart(run.offer), signed));
    commitment.fill(0);
    expect(signed.message.commitment).toEqual(approvalCommitment(approvalBinding(run.offer), deviceN.key, nonce(7)));
    a = stateOf(approverTake(a, run.challenge));
    expect(outcome(approverTake(a, run.reveal))).toBe("taken");
  });

  test("what the library hands out is a copy: a message's byte field, a body, a signature, N's nonce", async () => {
    const run = await approval();
    const signed = run.answer;
    if (signed.message.step !== "answer") throw new Error("not an answer");
    const commitment = signed.message.commitment;
    signed.message.commitment.fill(0);
    expect(signed.message.commitment).toEqual(commitment);
    const text = messageToText(signed);
    signed.body.fill(0);
    signed.signature.fill(0);
    expect(messageToText(signed)).toBe(text);
    const held = run.stateN.offers[0]?.answer;
    if (!held) throw new Error("no answer");
    held.nonce.fill(0);
    expect(held.nonce).toEqual(nonce(7));
    expect(responderReveal(run.stateN, OFFER).nonce).toEqual(nonce(7));
  });

  test("every state the library returns is frozen, all the way down; its bytes are read out as copies", async () => {
    const run = await approval();
    const deeplyFrozen = (value: object): boolean => Object.isFrozen(value) && Reflect.ownKeys(value).every((name) => {
      const inner: unknown = Object.getOwnPropertyDescriptor(value, name)?.value;
      return typeof inner !== "object" || inner === null || deeplyFrozen(inner);
    });
    const states: object[] = [run.stateA, run.stateN, approverStart(run.offer), responderStart(deviceN.key)];
    const check = approvalCheckDigits(approvalBinding(run.offer), deviceN.key, nonce(7), nonce(9));
    states.push(approverCheck(run.stateA, deviceN.key, check).state, approverCheck(run.stateA, deviceN.key, check === "000" ? "001" : "000").state);
    const digits = approverDigits(run.stateA, deviceN.key) ?? "";
    states.push(responderTry(run.stateN, digits).state);
    let n = run.stateN;
    for (let attempt = 0; attempt < APPROVE_WRONG_TRIES; attempt++) {
      const tried = responderTry(n, digits === "000000" ? "000001" : "000000");
      states.push(tried.state);
      n = tried.state;
    }
    states.push(responderAnswer(stateOf(responderTake(responderStart(deviceN.key), run.offer)), OFFER, "Kim's phone", fixed(nonce(7))).state);
    states.push(approverTake(approverStart(run.offer), run.answer).state, responderTake(responderStart(deviceN.key), run.offer).state);
    const signed = await signMessage({ step: "reveal", key: deviceN.key, list: LIST, offer: OFFER, nonce: nonce(7) }, deviceN.priv);
    states.push(signed, await readMessage(messageToText(signed)));
    expect(Reflect.set(signed, "message", run.reveal.message)).toBe(false);
    for (const state of states) expect(deeplyFrozen(state)).toBe(true);
    expect(Reflect.set(run.stateA, "ended", "placed")).toBe(false);
    expect(Reflect.set(run.stateA.answers, "0", run.stateA.answers[0])).toBe(false);
    expect(Reflect.set(run.stateA.offer, "body", new Uint8Array(0))).toBe(false);
    expect(Reflect.set(run.stateA.offer.message, "offer", "f".repeat(32))).toBe(false);
    expect(Reflect.set(run.stateN, "wrongTries", 0)).toBe(false);
    run.stateA.offer.body.fill(0);
    run.stateA.answers[0]?.challenge?.message.nonce.fill(0);
    expect(approverDigits(run.stateA, deviceN.key)).toBe(digits);
  });

  test("a draw of only zero bytes is a fault of the source: no offer id, nonce or challenge is made from it", async () => {
    const run = await approval();
    const isFault = (make: () => unknown) => {
      try {
        make();
      } catch (error) {
        return error instanceof Error && !(error instanceof ApproveError) && !(error instanceof TypeError);
      }
      return false;
    };
    expect(isFault(() => approverOffer(offerHead, fixed(new Uint8Array(16))))).toBe(true);
    const n0 = stateOf(responderTake(responderStart(deviceN.key), run.offer));
    expect(isFault(() => responderAnswer(n0, OFFER, "Kim's phone", fixed(new Uint8Array(32))))).toBe(true);
    const a = stateOf(approverTake(approverStart(run.offer), run.answer));
    expect(isFault(() => approverChallenge(a, deviceN.key, fixed(new Uint8Array(32))))).toBe(true);
    const one = new Uint8Array(32);
    one[31] = 1;
    expect(approverChallenge(a, deviceN.key, fixed(one)).nonce).toEqual(one);
  });
});

describe("a label's characters (sheet entry 65)", () => {
  test("U+00A0 and U+3000 inside, a byte order mark (EF BB BF) at the start, U+2028: each makes an answer message_malformed", () => {
    const labelBody = (label: Uint8Array) => writeFieldsUnder(APPROVE_PREFIX, [
      { name: "commitment", value: encoder.encode(toBase64Url(nonce(1))) }, { name: "key", value: encoder.encode(keyN) }, { name: "label", value: label },
      { name: "list", value: encoder.encode(LIST) }, { name: "offer", value: encoder.encode(OFFER) }, { name: "step", value: encoder.encode("answer") },
    ]);
    expect(code(() => readMessageBody(labelBody(encoder.encode("Kim's phone"))))).toBe("none");
    for (const label of [
      encoder.encode("Kim\u00A0phone"), encoder.encode("Kim\u3000phone"), Uint8Array.of(0xef, 0xbb, 0xbf, 0x4b, 0x69, 0x6d), encoder.encode("Kim\u2028phone"),
    ]) expect(code(() => readMessageBody(labelBody(label)))).toBe("message_malformed");
    for (const text of ["Kim\u00A0phone", "Kim\u3000phone", "\uFEFFKim", "Kim\u2028phone"]) expect(isDeviceLabel(text)).toBe(false);
  });
});

describe("a signed message is its body", () => {
  test("a byte field the caller changes between the call and the first await: the signed message keeps what was signed", async () => {
    const run = await approval();
    const a = stateOf(approverTake(approverStart(run.offer), run.answer));
    const fields = approverChallenge(a, deviceN.key, fixed(nonce(9)));
    const pending = signMessage(fields, deviceA.priv);
    fields.nonce.fill(0);
    const signed = await pending;
    expect(signed.message.nonce).toEqual(nonce(9));
    expect(writeMessageBody(signed.message)).toEqual(signed.body);
  });

  test("a byte field whose buffer the caller resizes to nothing in that gap: the signed message keeps its 32 bytes", async () => {
    const buffer = new ArrayBuffer(32, { maxByteLength: 64 });
    const commitment = new Uint8Array(buffer);
    commitment.set(nonce(3));
    const pending = signMessage({ step: "answer", key: deviceN.key, list: LIST, offer: OFFER, commitment, label: "Kim's phone" }, deviceN.priv);
    buffer.resize(0);
    expect(commitment.length).toBe(0);
    const signed = await pending;
    expect(signed.message.commitment).toEqual(nonce(3));
    expect(writeMessageBody(signed.message)).toEqual(signed.body);
  });

  test("a draw that is no Uint8Array is a fault: an ArrayBuffer, a SharedArrayBuffer, a Uint16Array, a plain array", () => {
    const head = { key: deviceA.key, list: LIST, head_hash: LIST, head_seq: 4 };
    const faults = [
      // @ts-expect-error a JavaScript caller past the types
      () => approverOffer(head, { fixedRandomForTests: (length: number) => new ArrayBuffer(length) }),
      // @ts-expect-error a JavaScript caller past the types
      () => approverOffer(head, { fixedRandomForTests: (length: number) => new SharedArrayBuffer(length) }),
      // @ts-expect-error a JavaScript caller past the types
      () => approverOffer(head, { fixedRandomForTests: (length: number) => new Uint16Array(length).fill(1) }),
      // @ts-expect-error a JavaScript caller past the types
      () => approverOffer(head, { fixedRandomForTests: (length: number) => Array.from({ length }, () => 1) }),
    ];
    for (const make of faults) expect(make).toThrow(TypeError);
  });

  test("a byte field that is no Uint8Array is a fault: a Uint16Array, a Float64Array, a plain array", async () => {
    const base = { step: "reveal" as const, key: deviceN.key, list: LIST, offer: OFFER };
    // @ts-expect-error a JavaScript caller past the types
    expect(() => writeMessageBody({ ...base, nonce: new Uint16Array(32).fill(1) })).toThrow(TypeError);
    // @ts-expect-error a JavaScript caller past the types
    expect(() => writeMessageBody({ ...base, nonce: new Float64Array(32).fill(1) })).toThrow(TypeError);
    // @ts-expect-error a JavaScript caller past the types
    expect(() => writeMessageBody({ ...base, nonce: Array.from({ length: 32 }, () => 1) })).toThrow(TypeError);
    // @ts-expect-error a JavaScript caller past the types
    await expect(signMessage({ ...base, nonce: new Uint16Array(32).fill(1) }, deviceN.priv)).rejects.toThrow(TypeError);
    // @ts-expect-error a JavaScript caller past the types
    await expect(signMessage({ step: "answer", key: deviceN.key, list: LIST, offer: OFFER, commitment: Array.from({ length: 32 }, () => 1), label: "Kim's phone" }, deviceN.priv)).rejects.toThrow(TypeError);
  });

  test("a field a state lacks is never read from Object.prototype", async () => {
    const run = await approval();
    const names = ["challenge", "reveal", "answer"] as const;
    const values = { challenge: run.challenge, reveal: run.reveal, answer: { message: run.answer.message, nonce: nonce(7) } };
    try {
      for (const name of names) Object.defineProperty(Object.prototype, name, { value: values[name], configurable: true, writable: true });
      const a = stateOf(approverTake(approverStart(run.offer), run.answer));
      expect(code(() => approverChallenge(a, deviceN.key, fixed(nonce(9))))).toBe("none");
      expect(approverDigits(a, deviceN.key)).toBeNull();
      expect(outcome(approverTake(a, run.reveal))).toBe("step_order");
      const n = stateOf(responderTake(responderStart(deviceN.key), run.offer));
      expect(outcome(responderTake(n, run.challenge))).toBe("step_order");
      expect(code(() => responderReveal(n, OFFER))).toBe("step_order");
    } finally {
      for (const name of names) Reflect.deleteProperty(Object.prototype, name);
    }
    expect(Object.hasOwn(Object.prototype, "challenge")).toBe(false);
  });

  test("the field objects returned to be signed are frozen", async () => {
    const run = await approval();
    const a = stateOf(approverTake(approverStart(run.offer), run.answer));
    const n0 = stateOf(responderTake(responderStart(deviceN.key), run.offer));
    for (const fields of [
      approverOffer({ key: deviceA.key, list: LIST, head_hash: LIST, head_seq: 4 }),
      approverChallenge(a, deviceN.key),
      responderReveal(run.stateN, OFFER),
      responderAnswer(n0, OFFER, "Kim's phone").message,
    ]) {
      expect(Object.isFrozen(fields)).toBe(true);
      expect(Reflect.set(fields, "offer", "f".repeat(32))).toBe(false);
    }
  });
});

