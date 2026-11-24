/**
 * A device that is in its account's signed list makes an invite for a PC (docs/account-list.md, "Invites"): one key
 * pair made here, whose private half lives only in the line the person is shown. The account service is given the
 * public key (`POST /v1/pc-invites`), and the list gets an `invite` entry for that key, for one use, that ends within
 * fifteen minutes. The line is returned only once this device's own copy of the list shows the entry.
 *
 * An invite a machine joins with by itself (`auto`) also gets the current epoch's key wrapped to its key, so the PC
 * that joins reads the list's names. Revoking an invite is a `remove` of its key, and for such an invite the next
 * epoch after it.
 */
import { listView, sealEpoch, signListEntries, type ListKind, type Sealed } from "../../../shared/account-list.ts";
import { newInvite } from "../../../shared/account-list-join.ts";
import type { AccountList } from "./accountList.ts";
import { overTime, placeOf, signedNamed, signedOn, signedWithEpoch, writeToList, type WriteOptions, type WriteRefusal } from "./listWrite.ts";
import { AccountRefreshError, AccountServiceError, AccountServiceUnreachableError, SignedOutError } from "./service.ts";

/**
 * How long an invite lasts, in seconds, from the time this device judges by: a little under the fifteen minutes the
 * account service keeps its own invite, so the entry never outlives it.
 */
export const INVITE_S = 14 * 60;

/** An invite as its maker holds it for the moment it is shown: the line is the only copy of the private key. */
export interface MadeInvite {
  /** The invite's public key, as the list spells a key. */
  readonly key: string;
  readonly line: string;
  /** When it ends, in seconds since 1970, as the entry says. */
  readonly exp: number;
  readonly auto: boolean;
}

/**
 * Why no invite was made: what stops any write (listWrite.ts), or the account service made none (`service`, with its
 * code: `session_not_fresh`, `invites_full`, `pc_add_cap`, `rate_limited`, …).
 */
export type InviteOutcome =
  | { readonly made: true; readonly invite: MadeInvite }
  | { readonly made: false; readonly why: WriteRefusal | "service"; readonly code?: string; readonly retryAfterMs: number | null };

/** The account service's id of an invite this page made, by the invite's key: what ends the service's invite at a revoke. */
const serviceIds = new Map<string, string>();

const refusalOf = (error: unknown): AccountServiceError | null => (error instanceof AccountServiceError && !(error instanceof AccountRefreshError) ? error : null);
const unanswered = (error: unknown): boolean => error instanceof AccountServiceUnreachableError || error instanceof AccountRefreshError
  || (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError"));

/** Ends the account service's invite, where this page knows its id. What the service answers changes nothing here: the list's entry decides. */
async function endAtService(list: AccountList, key: string): Promise<void> {
  const id = serviceIds.get(key);
  const service = list.writer()?.service;
  if (id === undefined || service === undefined) return;
  serviceIds.delete(key);
  await service.endInvite(id).catch((error: unknown) => {
    if (error instanceof SignedOutError) return;
    console.info("Ovis: the account service's invite was not ended", error instanceof AccountServiceError ? error.code : error instanceof Error ? error.name : error);
  });
}

/**
 * Makes an invite for one PC. `auto`: the PC joins with it by itself (an agent sets it up); otherwise a device of the
 * account presses Add for the PC that joined. The account service's invite is made first, since it is what a PC
 * redeems, then the entry. Where either is refused nothing is shown: the service's invite is ended again, and the
 * key pair is gone with this call. Only a sign-in that ended throws.
 */
export async function makeInvite(list: AccountList, options: { readonly auto: boolean } & Pick<WriteOptions, "wait" | "expect">): Promise<InviteOutcome> {
  // one key pair for the whole of it: a request signed again on a new head names the same invite
  const held: {
    invite: { readonly key: string; readonly line: string } | null;
    /** the key the account service made its invite for, whatever became of it since */
    kept: string | null;
    said: { readonly code: string; readonly retryAfterMs: number | null } | null;
  } = { invite: null, kept: null, said: null };
  const outcome = await writeToList<"service">(list, async (writer) => {
    if (held.invite === null) {
      const session = await writer.service.session();
      if (session === undefined || session.account !== writer.account) return { refused: "changed" };
      const fresh = await newInvite(session.service, writer.account, writer.list);
      try {
        const kept = await writer.service.makeInvite(fresh.key, options.auto);
        serviceIds.set(fresh.key, kept.id);
        held.kept = fresh.key;
        // an invite for another account than this device's is no invite of this list: no line is shown for it
        if (kept.account !== writer.account) { held.said = { code: "invalid_answer", retryAfterMs: null }; return { refused: "service" }; }
      } catch (error) {
        if (error instanceof SignedOutError) throw error;
        const refused = refusalOf(error);
        if (refused === null) { if (unanswered(error)) return { refused: "unreached" }; throw error; }
        held.said = { code: refused.code, retryAfterMs: refused.retryAfterMs };
        return { refused: "service" };
      }
      held.invite = fresh;
    }
    const invite = held.invite;
    // the list holds it already: placed by a request whose answer was lost
    if (writer.state.invites[invite.key] !== undefined) return { done: placeOf(writer.state) };
    const kind = (sealed: Sealed | null): ListKind => ({ kind: "invite", key: invite.key, exp: writer.clock + INVITE_S, uses: 1, auto: options.auto, sealed });
    const request = options.auto ? await signedNamed(writer, null, invite.key, kind) : await signedOn(writer, [kind(null)]);
    return { request: { ...request, invite: { key: invite.key, auto: options.auto } } };
  }, options);
  if (outcome.written && held.invite !== null) {
    const row = list.writer()?.state.invites[held.invite.key];
    if (row !== undefined) return { made: true, invite: { ...held.invite, exp: row.exp, auto: options.auto } };
  }
  // nothing to show: the account service's invite, if one was made, redeems nothing more
  if (held.kept !== null) await endAtService(list, held.kept);
  // written, and this device's copy does not show the entry: not known, and no line for an invite it cannot see
  if (outcome.written) return { made: false, why: "unknown", retryAfterMs: null };
  if (outcome.why === "service" && held.said !== null) return { made: false, why: "service", code: held.said.code, retryAfterMs: held.said.retryAfterMs };
  return { made: false, why: outcome.why, ...(outcome.code === undefined ? {} : { code: outcome.code }), retryAfterMs: outcome.retryAfterMs };
}

/** How an invite stands, as a device shows it. */
export type InviteState = "open" | "expired" | "used" | "revoked";

export interface ShownInvite {
  readonly key: string;
  readonly auto: boolean;
  /** When it ends, in seconds since 1970. */
  readonly exp: number;
  /** The place of its entry: a later invite stands at a later place. */
  readonly seq: number;
  readonly state: InviteState;
  /** This device placed it. */
  readonly mine: boolean;
}

/**
 * The invites the list holds, the latest first, each as it stands at `nowMs` by this device's own clock held against
 * the time it judges by: one past its `exp` is expired, never open. None for a device that may not write the list.
 */
export function invitesOf(list: AccountList, nowMs: number): ShownInvite[] {
  const writer = list.writer();
  if (writer === null) return [];
  const clock = Math.max(writer.clock, Math.floor(nowMs / 1000));
  return listView(writer.state).invites.map((row): ShownInvite => ({
    key: row.key, auto: row.auto, exp: row.exp, seq: row.seq, mine: row.by === writer.keys.key,
    state: row.refusal === "invite_spent" ? "used" : row.refusal === "invite_expired" || (row.refusal === null && clock > row.exp) ? "expired" : row.refusal === null ? "open" : "revoked",
  })).sort((a, b) => b.seq - a.seq);
}

export type RevokeOutcome = { readonly revoked: true } | { readonly revoked: false; readonly why: WriteRefusal; readonly retryAfterMs: number | null };

/**
 * Revokes an invite: a `remove` of its key, so no PC joins with it any more, whoever holds the line. Where the kinds
 * say that the removal took a holder of the epoch's key out (an invite a machine joins with by itself), the next
 * epoch is opened in the same request and its key wrapped to everybody who stays. An invite that is out already is
 * revoked: nothing is signed. Only a sign-in that ended throws.
 */
export async function revokeInvite(list: AccountList, key: string, options: Pick<WriteOptions, "wait" | "expect"> = {}): Promise<RevokeOutcome> {
  const outcome = await writeToList(list, async (writer) => {
    const { state, clock } = writer;
    if (state.invites[key] === undefined || state.signers[key]?.ended !== null) return { done: placeOf(state) };
    const remove: ListKind = { kind: "remove", ends: key };
    const current = writer.epochs.get(state.epoch) ?? null;
    if (current === null) return { request: await signedOn(writer, [remove]) };
    // what the kinds say of the list after the removal: names may still be sealed, or the next epoch is called for
    const after = await signListEntries(state, [remove], { key: writer.keys.key, privateKey: writer.keys.signs }, writer.issued_at);
    if (sealEpoch(after.state, clock) !== null) return { request: await signedOn(writer, [remove]) };
    const lapsed = overTime(state, clock).filter((each) => each !== key).map((each): ListKind => ({ kind: "remove", ends: each }));
    return { request: await signedWithEpoch(writer, current, [remove, ...lapsed]) };
  }, options);
  if (!outcome.written) return { revoked: false, why: outcome.why, retryAfterMs: outcome.retryAfterMs };
  await endAtService(list, key);
  return { revoked: true };
}
