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
import { lapsedRemovals, listClock, listView, readKind, sealEpoch, signListEntries, type ListKind, type Sealed } from "../../../shared/account-list.ts";
import { entryFromText, readBody } from "../../../shared/account-list-entry.ts";
import { newInvite } from "../../../shared/account-list-join.ts";
import type { ListPlace } from "../../../shared/account-list-signers.ts";
import type { AccountList, ListWriter } from "./accountList.ts";
import { WRITE_ENTRIES_MAX, placeOf, signedNamed, signedOn, signedWithEpoch, writeNamed, writeToList, type WriteOptions, type WriteRefusal, type Written } from "./listWrite.ts";
import { AccountRefreshError, AccountServiceError, AccountServiceUnreachableError, SignedOutError } from "./service.ts";

/**
 * How long an invite lasts, in seconds, from this device's own clock as it reads now (nothing else: neither the list's
 * time nor the floor it saved): a little under the fifteen minutes the account service keeps its own invite, so the
 * entry never outlives it.
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

/** An invite whose entry went out and whose placement is not known yet: its line is kept in memory until it is. */
export interface PendingInvite {
  readonly key: string;
  readonly line: string;
  readonly auto: boolean;
}

/**
 * Why no invite was made: what stops any write (listWrite.ts), or the account service made none (`service`, with its
 * code: `session_not_fresh`, `invites_full`, `pc_add_cap`, `rate_limited`, …). `unknown` comes with `pending`: the
 * entry may be in the list, so its line is neither shown nor dropped, and the service's invite is not ended. The caller
 * keeps it while its page is open and hands it to the next makeInvite, which settles it first.
 */
export type InviteOutcome =
  | { readonly made: true; readonly invite: MadeInvite }
  | { readonly made: false; readonly why: WriteRefusal | "service"; readonly code?: string; readonly retryAfterMs: number | null; readonly pending?: PendingInvite };

const operationOf = (auto: boolean): string => `invite:${auto ? "auto" : "plain"}`;

/**
 * Settles an invite whose placement was not known: the request kept for it goes again while the head it was signed on
 * stands, and the device's own copy, read from the log, says whether it holds the entry. `not_placed` only where the
 * log was read and neither holds it nor keeps a request for it: another entry took its place.
 */
async function settle(list: AccountList, pending: PendingInvite, options: Pick<WriteOptions, "wait" | "expect">): Promise<InviteOutcome | "not_placed"> {
  const shown = (): InviteOutcome | null => {
    const row = list.writer()?.state.invites[pending.key];
    return row === undefined ? null : { made: true, invite: { ...pending, exp: row.exp } };
  };
  const outcome = await writeToList<"nothing">(list, async (writer) => writer.state.invites[pending.key] !== undefined ? { done: placeOf(writer.state) } : { refused: "nothing" }, { ...options, operation: operationOf(pending.auto) });
  const held = shown();
  if (held !== null) return held;
  if (!outcome.written && outcome.why === "nothing") {
    const view = await list.sync({ read: true }).catch(() => list.view());
    if (view.reached && shown() === null) return "not_placed";
  }
  return { made: false, why: "unknown", retryAfterMs: null, pending };
}

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
export async function makeInvite(list: AccountList, options: { readonly auto: boolean; /** an invite an earlier call left not known: settled before anything else */ readonly pending?: PendingInvite } & Pick<WriteOptions, "wait" | "expect">): Promise<InviteOutcome> {
  if (options.pending !== undefined) {
    const settled = await settle(list, options.pending, options);
    if (settled !== "not_placed") return settled;
    // another entry took its place: its line opens nothing, and the account service's invite goes too
    await endAtService(list, options.pending.key);
  }
  // one key pair for the whole of it: a request signed again on a new head names the same invite
  const held: {
    invite: { readonly key: string; readonly line: string } | null;
    /** the key the account service made its invite for, whatever became of it since */
    kept: string | null;
    said: { readonly code: string; readonly retryAfterMs: number | null } | null;
  } = { invite: null, kept: null, said: null };
  type Invite = { readonly key: string; readonly line: string };
  const prepare = async (writer: ListWriter): Promise<{ readonly refused: WriteRefusal | "service" } | { readonly done: ListPlace } | { readonly go: Invite }> => {
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
    // the list holds it already: placed by a request whose answer was lost
    return writer.state.invites[held.invite.key] !== undefined ? { done: placeOf(writer.state) } : { go: held.invite };
  };
  const sign = async (writer: ListWriter, invite: Invite): Promise<Written> => {
    // ends by this device's own clock as it reads now: the list's time or a floor saved once never lengthens it
    const kind = (sealed: Sealed | null): ListKind => ({ kind: "invite", key: invite.key, exp: writer.issued_at + INVITE_S, uses: 1, auto: options.auto, sealed });
    // an invite a machine joins with by itself is wrapped the epoch's key, as a member that comes in is
    const request = options.auto ? await signedNamed(writer, null, invite.key, kind) : await signedOn(writer, [kind(null)]);
    return { ...request, invite: { key: invite.key, auto: options.auto } };
  };
  const { pending: _settled, ...writing } = options;
  const named = { ...writing, operation: operationOf(options.auto) };
  const outcome = options.auto
    ? await writeNamed<Invite, "service">(list, prepare, sign, named)
    : await writeToList<"service">(list, async (writer) => { const ready = await prepare(writer); return "go" in ready ? { request: await sign(writer, ready.go) } : ready; }, named);
  if (outcome.written && held.invite !== null) {
    const row = list.writer()?.state.invites[held.invite.key];
    if (row !== undefined) return { made: true, invite: { ...held.invite, exp: row.exp, auto: options.auto } };
  }
  // The entry went out and its placement is not known (no answer and no read of the log since, a request the service
  // kept asking for again, or a copy that does not show it yet): the line is the only copy of the invite's key, so it
  // is kept, not shown, and the service's invite stands until the next call settles it
  if (held.invite !== null && (outcome.written || outcome.why === "unknown" || outcome.why === "busy")) {
    return { made: false, why: "unknown", retryAfterMs: null, pending: { ...held.invite, auto: options.auto } };
  }
  if (outcome.written) return { made: false, why: "unknown", retryAfterMs: null };
  // nothing to show: the account service's invite, if one was made, redeems nothing more
  if (held.kept !== null) await endAtService(list, held.kept);
  if (outcome.why === "service" && held.said !== null) return { made: false, why: "service", code: held.said.code, retryAfterMs: held.said.retryAfterMs };
  return { made: false, why: outcome.why, ...(outcome.code === undefined ? {} : { code: outcome.code }), retryAfterMs: outcome.retryAfterMs };
}

/**
 * How an invite stands, as a device shows it: `used` where a PC joined with it, or its removal was placed with a `pc`
 * entry (a person's Add of the PC that joined with it); `revoked` only for a removal on its own, before its time was
 * over (a Revoke); `ended` for any other end (its placer left, or it went with a PC's removal).
 */
export type InviteState = "open" | "expired" | "used" | "revoked" | "ended";

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
 * the floor it saved and the list's own time: one past its `exp` is expired, never open, also after the clock was set
 * back. None for a device that may not write the list.
 */
export function invitesOf(list: AccountList, nowMs: number): ShownInvite[] {
  const writer = list.writer();
  if (writer === null) return [];
  const clock = listClock(writer.state, Math.floor(nowMs / 1000), writer.floor);
  return listView(writer.state).invites.map((row): ShownInvite => ({
    key: row.key, auto: row.auto, exp: row.exp, seq: row.seq, mine: row.by === writer.keys.key,
    state: row.refusal === "invite_spent" ? "used" : row.refusal === "invite_revoked" ? endOf(list, writer.state.signers[row.key]?.ended ?? null, row.exp)
      : row.refusal === "invite_expired" || (row.refusal === null && clock > row.exp) ? "expired" : row.refusal === null ? "open" : "ended",
  })).sort((a, b) => b.seq - a.seq);
}

/**
 * What the removal at place `ended` did to an invite, by the entries of this device's own copy around it: placed right
 * after a `pc` entry, it is the Add of the PC that joined with it (`used`); dated past the invite's time, the clean-up
 * of an invite that was over (`expired`); beside the removal of a PC, that PC's end (`ended`); on its own, a Revoke.
 */
function endOf(list: AccountList, ended: number | null, exp: number): InviteState {
  if (ended === null) return "ended";
  const kindAt = (text: string | undefined): { readonly kind: ListKind | null; readonly at: number } | null => {
    if (text === undefined) return null;
    try {
      const body = readBody(entryFromText(text).body);
      return { kind: readKind(body), at: body.issued_at };
    } catch { return null; }
  };
  const around = list.pageAfter(ended >= 2 ? ended - 2 : null, ended >= 1 ? 3 : 2)?.entries ?? [];
  const at = ended >= 1 ? 1 : 0;
  const [before, removal, after] = [at === 1 ? kindAt(around[0]) : null, kindAt(around[at]), kindAt(around[at + 1])];
  if (removal === null) return "ended";
  if (before?.kind?.kind === "pc") return "used";
  if (removal.at > exp) return "expired";
  const pcEnds = (entry: typeof before): boolean => entry?.kind?.kind === "remove" && "endpoint" in entry.kind;
  return pcEnds(before) || pcEnds(after) ? "ended" : "revoked";
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
    // A device whose clock reads far under the time it saved signs no clean-up (it cannot tell which of the two is
    // wrong), and with keys over their time still in no epoch may be opened: the removal goes alone, and a later
    // writer opens the epoch
    if (sealEpoch(after.state, clock) !== null || writer.adrift) return { request: await signedOn(writer, [remove]) };
    // with the epoch this request opens anyway, as many of the keys over their time as one request holds beside them
    const lapsed = lapsedRemovals(state, clock).filter((each) => !(each.kind === "remove" && "ends" in each && each.ends === key)).slice(0, WRITE_ENTRIES_MAX - 2);
    return { request: await signedWithEpoch(writer, current, [remove, ...lapsed]) };
  }, { ...options, operation: `revoke:${key}` });
  if (!outcome.written) return { revoked: false, why: outcome.why, retryAfterMs: outcome.retryAfterMs };
  await endAtService(list, key);
  return { revoked: true };
}
