/**
 * A PC that joined with an invite a device of the account made, and waits for Add (docs/account-list.md,
 * "Invites"). The account service says which PC used an invite, and that is only its word: a service that lies could
 * name a PC of its own. So a device offers Add for a posted PC only on evidence the service cannot make: the invite's
 * own key signed for that very PC and that very card, and the device's own copy of the list holds that invite as
 * open, placed by a member, waiting for Add.
 *
 * The line never leaves the PC it was typed at. What it signs there is a redeem message (shared/account-list-invite.ts)
 * for the account, the PC's id and relay key, and a challenge made from the list's id and the PC's card.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { cardBinding, cardHolds, inviteRefusal, listView, type ListNames } from "../../../shared/account-list.ts";
import { verifyInviteRedeem } from "../../../shared/account-list-invite.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import type { AccountList } from "./accountList.ts";
import { addPostedPc, type AddPcOutcome, type PostedPc } from "./listAdd.ts";
import type { ListPost } from "./listAnswers.ts";
import type { WriteOptions } from "./listWrite.ts";

/** What the challenge an invite's line signs for a PC is made under: the PC makes it the same way. */
const LINE_CHALLENGE_PREFIX = "ovis-list-join/1";

/**
 * The challenge an invite's line signs to say that the PC with this card joins `list` with it: 32 hex digits made
 * from the list's id and the binding of the PC's card for that list.
 */
export function lineChallenge(list: string, pc: { readonly key: string; readonly enc: string; readonly endpoint: string }): string {
  const binding = cardBinding({ key: pc.key, enc: pc.enc, list, endpoint: pc.endpoint, invite: null });
  return bytesToHex(sha256(concatBytes(utf8ToBytes(LINE_CHALLENGE_PREFIX), utf8ToBytes(list), binding))).slice(0, 32);
}

/** A posted PC that the line of an open invite of this device's list signed for. */
export interface InvitedPc extends PostedPc {
  /** The invite's public key. */
  readonly invite: string;
}

/**
 * Of `posts`, the PCs this device may offer Add for with no number: each with a card that holds for this device's
 * list and its own relay key, an invite that the device's own copy holds as open at `nowMs`, placed by a member and
 * not one a PC joins with by itself, and that invite's signature over this account, this PC and this card. None for a
 * device that may not write the list.
 */
export async function invitedPcs(list: AccountList, posts: readonly ListPost[], nowMs: number): Promise<InvitedPc[]> {
  const writer = list.writer();
  if (writer === null) return [];
  const clock = Math.max(writer.clock, Math.floor(nowMs / 1000));
  const open = new Map(listView(writer.state).invites
    .filter((row) => !row.auto && row.joins < row.uses && clock <= row.exp && inviteRefusal(writer.state, row.key) === null)
    .map((row) => [row.key, row]));
  const found: InvitedPc[] = [];
  for (const post of posts) {
    if (post.invite === undefined || post.invite_proof === undefined || !open.has(post.invite)) continue;
    if (deriveServerId(hexToBytes(post.endpoint)) !== post.server_id) continue;
    if (!await cardHolds({ key: post.key, enc: post.enc, list: writer.list, endpoint: post.endpoint, invite: null }, post.card)) continue;
    let signed = false;
    try {
      signed = await verifyInviteRedeem({ account: writer.account, server_id: post.server_id, public_key: post.endpoint, challenge_id: lineChallenge(writer.list, post) }, post.invite_proof, post.invite);
    } catch { signed = false; }
    if (signed) found.push({ list: writer.list, endpoint: post.endpoint, server_id: post.server_id, key: post.key, enc: post.enc, card: post.card, invite: post.invite });
  }
  return found;
}

/**
 * The person pressed Add for a PC that joined with their invite: the account admits the PC, and this device signs its
 * `pc` entry with the card the line signed for, and ends the invite's key in the same request, so nobody else joins
 * with that line. No number is compared: the line's own signature is what says that this PC is the one. Answers as
 * addPostedPc does; only a sign-in that ended throws.
 */
export async function addInvitedPc(list: AccountList, pc: InvitedPc, names: ListNames | null, options: Pick<WriteOptions, "wait" | "expect"> & { readonly admit: () => Promise<void> }): Promise<AddPcOutcome> {
  return addPostedPc(list, pc, names, { ...options, then: [{ kind: "remove", ends: pc.invite }] });
}
