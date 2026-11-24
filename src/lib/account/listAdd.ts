/**
 * A device that is in its account's signed list adds a PC to it (docs/account-list.md, "Adding a PC"): the PC posted
 * its keys and its card for the list, the device and the PC work out one number from that card, a person confirms it
 * at the PC and then presses Add here, and the device signs a `pc` entry with exactly the card the number came from.
 *
 * The account service only carries the messages of the comparison, and may be an end of it itself: a number that is
 * shown proves nothing, and only the person's two confirmations do, each for its own end. So this device shows a
 * number only for a card that holds for its own list and that PC's relay key, commits to its nonce before it has
 * seen the PC's, and signs only what the number was worked out from.
 */
import { cardBinding, cardHolds, type ListCard, type ListKind, type ListNames } from "../../../shared/account-list.ts";
import { hexToBytes } from "@noble/hashes/utils.js";
import { fromBase64Url, pairCommitment, pairDigits, randomPairNonce, toBase64Url } from "../../../shared/relay-pair-sas.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import type { AccountList, ListWriter } from "./accountList.ts";
import type { ListPost } from "./listAnswers.ts";
import { signedNamed, writeNamed, type WriteOptions, type WriteRefusal } from "./listWrite.ts";
import { AccountRefreshError, AccountServiceError, AccountServiceUnreachableError, SignedOutError } from "./service.ts";

/** A PC that asks to be added, whose card this device checked: it is that key's own, for this device's list and that relay key. */
export interface PostedPc {
  readonly list: string;
  readonly endpoint: string;
  /** The id that relay key gives. */
  readonly server_id: string;
  readonly key: string;
  readonly enc: string;
  readonly card: string;
}

const cardOf = (post: Pick<PostedPc, "key" | "enc" | "list" | "endpoint">): ListCard => ({ key: post.key, enc: post.enc, list: post.list, endpoint: post.endpoint, invite: null });

/**
 * The PCs that posted for the list this device follows and may write to, each with a card that holds. A post whose
 * card is not that key's, names another list, or whose id is not the one its relay key gives, is left out: nothing
 * is shown or started for it. None for a device that may not write.
 */
export async function postedPcs(list: AccountList, signal?: AbortSignal): Promise<PostedPc[]> {
  const writer = list.writer();
  if (writer === null) return [];
  const posts: PostedPc[] = [];
  for (const post of await writer.service.listPosts(writer.list, signal)) {
    const held: PostedPc = { list: writer.list, endpoint: post.endpoint, server_id: deriveServerId(hexToBytes(post.endpoint)), key: post.key, enc: post.enc, card: post.card };
    if (held.server_id === post.server_id && await cardHolds(cardOf(held), post.card)) posts.push(held);
  }
  return posts;
}

/**
 * Why no number came.
 *
 * - `no_list`: this device may not write to a list.
 * - `gone`: the PC posts no more, or posted other keys since: read the posts again.
 * - `spent`: too many numbers were asked for that PC for now.
 * - `silent`: the PC did not answer in time.
 * - `unreached`: the account service did not answer.
 */
export type NumberRefusal = "no_list" | "gone" | "spent" | "silent" | "unreached";

/** The number both screens show for one attempt, and what a later Add signs: the very post it was worked out from. */
export interface AddNumber {
  readonly post: PostedPc;
  readonly digits: string;
  /** Until when the PC takes a yes for this number, in ms by this device's clock. */
  readonly until: number;
}

export type NumberOutcome = { readonly shown: true; readonly number: AddNumber } | { readonly shown: false; readonly why: NumberRefusal };

/** A number lives this long from the PC's answer. */
export const NUMBER_MS = 120_000;
/** How long this device waits for the PC's answer to its commitment: the PC asks the account service every few seconds. */
export const NUMBER_WAIT_MS = 30_000;
/** How often it looks for that answer. */
const NUMBER_POLL_MS = 1_500;
/** How often the reveal goes again while the service still holds the attempt without the PC's answer. */
const REVEAL_SENDS = 3;

/** The pause between two looks for the PC's answer: inside a loop bounded by NUMBER_WAIT_MS. */
const pause = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason as Error); }, { once: true });
});

const refusalOf = (error: unknown): AccountServiceError | null => (error instanceof AccountServiceError && !(error instanceof AccountRefreshError) ? error : null);
const unanswered = (error: unknown): boolean => error instanceof AccountServiceUnreachableError || error instanceof AccountRefreshError
  || (error instanceof DOMException && error.name === "TimeoutError");

/**
 * Works out the number for `post` with the PC, through the account service: this device commits to a nonce of its
 * own, the PC answers with its nonce, the device reveals its own, and the number is what both give with the card's
 * binding. The commitment goes before the PC's nonce is known, and the reveal only after, so neither end, and nobody
 * between them, can steer the number. The number is shown from the PC's answer on; the PC shows it once the reveal
 * checked out. Only a sign-in that ended, or a cancel, throws.
 */
export async function numberWith(list: AccountList, post: PostedPc, options: { readonly signal?: AbortSignal; readonly wait?: (ms: number, signal?: AbortSignal) => Promise<void>; readonly now?: () => number; /** how long to wait for the PC's answer, NUMBER_WAIT_MS unless a caller says */ readonly waitMs?: number } = {}): Promise<NumberOutcome> {
  const wait = options.wait ?? pause;
  const now = options.now ?? Date.now;
  const writer = list.writer();
  if (writer === null || writer.list !== post.list) return { shown: false, why: "no_list" };
  const adder = writer.keys.key;
  const binding = cardBinding(cardOf(post));
  const mine = randomPairNonce();
  const message = { key: post.key, adder, commitment: toBase64Url(pairCommitment(binding, adder, mine)) };
  const refused = (error: unknown): NumberOutcome => {
    if (error instanceof SignedOutError || options.signal?.aborted === true) throw error;
    const said = refusalOf(error);
    if (said === null) { if (unanswered(error)) return { shown: false, why: "unreached" }; throw error; }
    return { shown: false, why: said.status === 409 && said.code === "post_changed" ? "gone" : said.status === 429 ? "spent" : "unreached" };
  };
  try { await writer.service.listAttempt(writer.list, post.endpoint, message, options.signal); } catch (error) { return refused(error); }
  // the PC's nonce, for this very commitment, read from the posts until it is there
  let theirs: Uint8Array | null = null;
  const deadline = now() + (options.waitMs ?? NUMBER_WAIT_MS);
  while (theirs === null) {
    let posts: readonly ListPost[];
    try { posts = await writer.service.listPosts(writer.list, options.signal); } catch (error) { return refused(error); }
    const seen = posts.find((each) => each.endpoint === post.endpoint);
    if (seen === undefined || seen.key !== post.key || seen.enc !== post.enc || seen.card !== post.card) return { shown: false, why: "gone" };
    // another attempt took this one's place (another device of the account asked for a number too): this one is over
    if (seen.attempt === null || seen.attempt.adder !== adder || seen.attempt.commitment !== message.commitment) return { shown: false, why: "gone" };
    if (seen.attempt.nonce !== null) { theirs = fromBase64Url(seen.attempt.nonce); break; }
    if (now() >= deadline) return { shown: false, why: "silent" };
    await wait(NUMBER_POLL_MS, options.signal);
  }
  const answered = now();
  const reveal = toBase64Url(mine);
  for (let sends = 1; ; sends += 1) {
    try { await writer.service.listAttempt(writer.list, post.endpoint, { ...message, reveal }, options.signal); break; } catch (error) {
      const said = refusalOf(error);
      // the service has not stored the PC's answer where this request landed yet: once more, a moment later
      if (said !== null && said.status === 409 && said.code === "attempt_changed" && sends < REVEAL_SENDS) { await wait(NUMBER_POLL_MS, options.signal); continue; }
      return said !== null && said.status === 409 ? { shown: false, why: "gone" } : refused(error);
    }
  }
  return { shown: true, number: { post, digits: pairDigits(binding, adder, mine, theirs), until: answered + NUMBER_MS } };
}

/** Why a PC was not added: what stops any write (listWrite.ts), or the account service did not admit the PC (`admit`, with its code). */
export type AddPcOutcome = { readonly added: true } | { readonly added: false; readonly why: WriteRefusal | "admit"; readonly code?: string; readonly retryAfterMs: number | null };

/**
 * The person pressed Add beside the number: the account admits the PC (the account service places a `pc` entry only
 * for a PC an own sign-in admitted), and this device signs the `pc` entry with exactly the card the number was worked
 * out from, the PC's name sealed and the epoch key wrapped to the PC's encryption key. The PC is added once this
 * device's own copy shows the entry. `admit`: the one-press admission, the caller's own (it may ask for a sign-in).
 * `member`: the member key the comparison (or the scan) began with; a device that holds another key now signs nothing
 * (`changed`), and neither does one whose account or list is not `expect`'s, before the admission too. `signal`: the
 * person's Cancel, checked before the admission, before signing and before sending.
 */
export async function addPostedPc(list: AccountList, post: PostedPc, names: ListNames | null, options: Pick<WriteOptions, "wait" | "expect" | "signal"> & { readonly admit: () => Promise<void>; readonly member?: string }): Promise<AddPcOutcome> {
  const { member, admit, ...writeOptions } = options;
  const changed = (writer: ListWriter | null): boolean => writer === null || writer.list !== post.list
    || (options.expect !== undefined && writer.account !== options.expect.account) || (member !== undefined && writer.keys.key !== member);
  options.signal?.throwIfAborted();
  // what the person pressed for, before anything goes: the account, the list and the member key it was shown for
  if (changed(list.writer())) return { added: false, why: "changed", retryAfterMs: null };
  const held = list.holdsPc(post.endpoint);
  if (!held) {
    try { await admit(); } catch (error) {
      if (error instanceof SignedOutError) throw error;
      const said = refusalOf(error);
      if (said === null && !unanswered(error)) throw error;
      return said === null ? { added: false, why: "unreached", retryAfterMs: null } : { added: false, why: "admit", code: said.code, retryAfterMs: said.retryAfterMs };
    }
  }
  const outcome = await writeNamed<true>(list, async (writer) => {
    // every try signs on a writer of the very account, list and member key the press was for (X3)
    if (changed(writer)) return { refused: "changed" };
    // the list holds that relay key already (this press, sent before): nothing more to sign
    const row = writer.state.pcs[post.endpoint];
    if (row !== undefined && row.removed === null && row.key === post.key) return { done: { seq: writer.state.footing.seq, hash: writer.state.footing.hash } };
    return { go: true };
  }, (writer) => signedNamed(writer, names, post.enc, (sealed): ListKind => ({ kind: "pc", key: post.key, endpoint: post.endpoint, enc: post.enc, card: post.card, sealed })), { ...writeOptions, operation: `add-pc:${post.endpoint}` });
  return outcome.written ? { added: true } : { added: false, why: outcome.why, retryAfterMs: outcome.retryAfterMs };
}
