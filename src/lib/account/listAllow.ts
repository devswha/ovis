/**
 * A device that is in its account's signed list lets another device in (docs/account-list.md, "Letting a device
 * in"): it signs a `device` entry for the key whose digits a person just compared, with the card that key's own
 * sign-in claimed, seals the newcomer's name, wraps the epoch key to it, and places all of it in one request.
 *
 * Every entry is signed through the kinds' writer, on this device's own state, and only when it would count there.
 * The account service's answer to the placement is trusted for nothing: the newcomer is in once this device's own
 * copy shows the entry at its place, and that place is what the newcomer is handed.
 */
import type { AccountOs } from "../../../shared/account-asker.ts";
import { namesFields, sealEpoch, type ListKind, type ListNames, type ListState, type Sealed } from "../../../shared/account-list.ts";
import { sealFields, wrapEpochKey, wrapToText, type EpochKey } from "../../../shared/account-list-seal.ts";
import type { AccountList, ListOffer, ListWriter } from "./accountList.ts";
import type { ListClaim } from "./listAnswers.ts";
import { listNames } from "./listGenesis.ts";
import { WRITE_RESENDS, WRITE_TRIES, overTime, placeOf, signedOn, signedWithEpoch, writeToList, type WriteRefusal, type Written } from "./listWrite.ts";

/** The device a person is letting in: the key it showed the PC it asked, and the name and system it gave the account service. */
export interface Newcomer {
  readonly key: string;
  readonly label: string;
  readonly os: AccountOs | null;
}

/** Why a device was not let into the list: what stops any write (listWrite.ts), or `removed`: the list put that key out before, and a key that is out never comes back. */
export type AllowRefusal = WriteRefusal | "removed";

export type AllowOutcome =
  | { readonly allowed: true; readonly offer: ListOffer }
  | { readonly allowed: false; readonly why: AllowRefusal; readonly retryAfterMs: number | null };

/** How often one Allow reads the list and signs anew, and how often one signed request is sent again (listWrite.ts). */
export const ALLOW_TRIES = WRITE_TRIES;
export const ALLOW_RESENDS = WRITE_RESENDS;

/**
 * The request that lets the newcomer in, signed on the writer's state. Where the kinds say names may be sealed, it
 * is the one entry, its names under the current epoch and that epoch's key wrapped to the newcomer. Where they say
 * no, the request first tidies up: a `remove` for every key whose time is over, one `epoch`, then the entry with its
 * names under the epoch that request opens, and the new key wrapped to everybody who is in after the whole of it. A
 * device that holds no key of the current epoch seals nothing and wraps nothing: the newcomer is let in all the same.
 */
async function written(writer: ListWriter, claim: ListClaim, names: ListNames | null): Promise<Written> {
  const { list, state, clock } = writer;
  const device = (sealed: Sealed | null): ListKind => ({ kind: "device", key: claim.key, power: "full", role: "drive", until: null, enc: claim.enc, card: claim.card, sealed, rotates: false });
  const seal = async (on: ListState, key: EpochKey, opens: string): Promise<Sealed | null> => names === null ? null
    : { epoch: key.epoch, bytes: await sealFields({ place: { list, seq: on.footing.seq + 1 }, epoch: key, commitment: opens, fields: namesFields(names) }) };
  const current = writer.epochs.get(state.epoch) ?? null;
  if (current === null) return signedOn(writer, [device(null)]);
  const where = sealEpoch(state, clock);
  if (where !== null) {
    const wrap = await wrapEpochKey({ list, epoch: current, member: claim.enc });
    return signedOn(writer, [device(await seal(state, current, where.opens))], wrap === null ? [] : [{ epoch: current.epoch, member: claim.enc, wrap: wrapToText(wrap) }]);
  }
  return signedWithEpoch(writer, current, overTime(state, clock).map((key): ListKind => ({ kind: "remove", ends: key })),
    (next) => [async (after) => device(await seal(after, next.epoch, next.commitment))]);
}

/**
 * Lets `newcomer` into the list this device follows. It reads the list first, signs on what it then holds, and
 * places the request. When the head moved under it, or the account service judged the request by a clock a moment
 * apart from this device's, it reads and signs again, ALLOW_TRIES times at most; while the service says it is
 * rebuilding the list, the same request goes again, ALLOW_RESENDS times at most. Only a sign-in that ended throws.
 */
export async function allowDevice(list: AccountList, newcomer: Newcomer, options: { readonly wait?: (ms: number) => Promise<void> } = {}): Promise<AllowOutcome> {
  const names = listNames(newcomer.label, newcomer.os);
  const outcome = await writeToList<"removed">(list, async (writer) => {
    const row = writer.state.signers[newcomer.key];
    // the list holds the key already: let in before (the place handed on is where this device stands now), or put out for good
    // (the place handed on is that of the entry that let it in, where this device's copy shows it)
    if (row !== undefined) return row.ended !== null || row.as !== "device" ? { refused: "removed" } : { done: list.placeAt(row.seq) ?? placeOf(writer.state) };
    const claim = (await writer.service.listClaims(writer.list)).find((each) => each.key === newcomer.key);
    if (claim === undefined) return { refused: "not_claimed" };
    return { request: await written(writer, claim, names) };
  }, options);
  return outcome.written ? { allowed: true, offer: { list: outcome.list, seq: outcome.place.seq, hash: outcome.place.hash } }
    : { allowed: false, why: outcome.why, retryAfterMs: outcome.retryAfterMs };
}
