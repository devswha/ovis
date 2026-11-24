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
import {
  ListWriteError, listView, namesFields, sealEpoch, signListEntries, wrapKeys,
  type ListKind, type ListNames, type ListState, type Sealed,
} from "../../../shared/account-list.ts";
import { nextEpoch, sealFields, wrapEpochKey, wrapEpochKeyFor, wrapToText, type EpochKey } from "../../../shared/account-list-seal.ts";
import type { ListPlace } from "../../../shared/account-list-signers.ts";
import type { AccountList, ListOffer, ListWriter } from "./accountList.ts";
import type { ListClaim, PlacedWrap } from "./listAnswers.ts";
import { listNames } from "./listGenesis.ts";
import { AccountRefreshError, AccountServiceError, AccountServiceUnreachableError, SignedOutError } from "./service.ts";

/** The device a person is letting in: the key it showed the PC it asked, and the name and system it gave the account service. */
export interface Newcomer {
  readonly key: string;
  readonly label: string;
  readonly os: AccountOs | null;
}

/**
 * Why a device was not let into the list.
 *
 * - `no_list`: this device follows no list, is not in it with power `full`, or was shown another history: it signs nothing.
 * - `not_claimed`: the account service holds no claim of that key by a sign-in of the account, so it places no entry for it.
 * - `removed`: the list put that key out before, and a key that is out never comes back.
 * - `budget`: the list took as many additions as it takes for now; `retryAfterMs` says how long.
 * - `stopped`: the account service cannot change the list right now.
 * - `busy`: the list kept moving, or the account service kept asking for the request again, for every try.
 * - `refused`: the account service refused the entry, or this device would not count it.
 * - `unreached`: the account service did not answer.
 */
export type AllowRefusal = "no_list" | "not_claimed" | "removed" | "budget" | "stopped" | "busy" | "refused" | "unreached";

export type AllowOutcome =
  | { readonly allowed: true; readonly offer: ListOffer }
  | { readonly allowed: false; readonly why: AllowRefusal; readonly retryAfterMs: number | null };

/** How often one Allow reads the list and signs anew, after the head moved under it or the account service judged otherwise. */
export const ALLOW_TRIES = 4;
/** How often one signed request is sent again while the account service says it is rebuilding the list. */
export const ALLOW_RESENDS = 3;
/** The longest wait before a request is sent again, whatever the account service asks for. */
const RESEND_MAX_MS = 5_000;

/** The pause the account service asks for before the same request goes again: between the tries of a loop bounded by ALLOW_RESENDS. */
const pause = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

const refused = (why: AllowRefusal, retryAfterMs: number | null = null): AllowOutcome => ({ allowed: false, why, retryAfterMs });

/**
 * The keys whose time is over while they still hold the current epoch's key, by the clock the writer judges by: an
 * invite that a PC joins with by itself, past its `exp` with a use left, and a device that is in past its `until`.
 * While one of them is in, the kinds seal no name (sealEpoch).
 */
function overTime(state: ListState, clock: number): string[] {
  const view = listView(state);
  return [
    ...view.invites.filter((row) => row.auto && state.signers[row.key]?.ended === null && row.joins < row.uses && clock > row.exp).map((row) => row.key),
    ...view.devices.filter((row) => row.ended === null && row.until !== null && !(clock < row.until)).map((row) => row.key),
  ];
}

interface Written {
  readonly entries: readonly string[];
  readonly wraps: readonly PlacedWrap[];
  /** The place of the newcomer's own entry, the last of the request. */
  readonly place: ListPlace;
}

/**
 * The request that lets the newcomer in, signed on the writer's state. Where the kinds say names may be sealed, it
 * is the one entry, its names under the current epoch and that epoch's key wrapped to the newcomer. Where they say
 * no, the request first tidies up: a `remove` for every key whose time is over, one `epoch`, then the entry with its
 * names under the epoch that request opens, and the new key wrapped to everybody who is in after the whole of it. A
 * device that holds no key of the current epoch seals nothing and wraps nothing: the newcomer is let in all the same.
 */
async function written(writer: ListWriter, claim: ListClaim, names: ListNames | null): Promise<Written> {
  const { list, state, clock } = writer;
  const signer = { key: writer.keys.key, privateKey: writer.keys.signs };
  const device = (sealed: Sealed | null): ListKind => ({ kind: "device", key: claim.key, power: "full", role: "drive", until: null, enc: claim.enc, card: claim.card, sealed, rotates: false });
  const seal = async (on: ListState, key: EpochKey, opens: string): Promise<Sealed | null> => names === null ? null
    : { epoch: key.epoch, bytes: await sealFields({ place: { list, seq: on.footing.seq + 1 }, epoch: key, commitment: opens, fields: namesFields(names) }) };
  const done = (result: Awaited<ReturnType<typeof signListEntries>>, wraps: readonly PlacedWrap[]): Written =>
    ({ entries: result.entries.map((entry) => entry.text), wraps, place: { seq: result.state.footing.seq, hash: result.state.footing.hash } });

  const current = writer.epochs.get(state.epoch) ?? null;
  if (current === null) return done(await signListEntries(state, [device(null)], signer, writer.issued_at), []);
  const where = sealEpoch(state, clock);
  if (where !== null) {
    const wrap = await wrapEpochKey({ list, epoch: current, member: claim.enc });
    return done(await signListEntries(state, [device(await seal(state, current, where.opens))], signer, writer.issued_at),
      wrap === null ? [] : [{ epoch: current.epoch, member: claim.enc, wrap: wrapToText(wrap) }]);
  }
  // made anew for every request: a key whose wraps went out in a request that was not placed is never used
  const next = await nextEpoch({ list, current, members: [] });
  const result = await signListEntries(state, [
    ...overTime(state, clock).map((key): ListKind => ({ kind: "remove", ends: key })),
    (after) => ({ kind: "epoch", epoch: after.epoch, opens: next.commitment, link: next.link }),
    async (after) => device(await seal(after, next.epoch, next.commitment)),
  ], signer, writer.issued_at);
  const wrapped = await wrapEpochKeyFor({ list, epoch: next.epoch, members: wrapKeys(result.state, clock) });
  return done(result, wrapped.wraps.map(({ member, wrap }) => ({ epoch: next.epoch.epoch, member, wrap: wrapToText(wrap) })));
}

/** The account service's own refusal of a request, as against no answer or a refresh that failed. */
const refusalOf = (error: unknown): AccountServiceError | null => (error instanceof AccountServiceError && !(error instanceof AccountRefreshError) ? error : null);

const unanswered = (error: unknown): boolean => error instanceof AccountServiceUnreachableError || error instanceof AccountRefreshError
  || (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError"));

/**
 * Lets `newcomer` into the list this device follows. It reads the list first, signs on what it then holds, and
 * places the request. When the head moved under it, or the account service judged the request by a clock a moment
 * apart from this device's, it reads and signs again, ALLOW_TRIES times at most; while the service says it is
 * rebuilding the list, the same request goes again, ALLOW_RESENDS times at most. Only a sign-in that ended throws.
 */
export async function allowDevice(list: AccountList, newcomer: Newcomer, options: { readonly wait?: (ms: number) => Promise<void> } = {}): Promise<AllowOutcome> {
  const wait = options.wait ?? pause;
  const names = listNames(newcomer.label, newcomer.os);
  for (let tries = 0; tries < ALLOW_TRIES; tries += 1) {
    const view = await list.sync();
    const writer = list.writer();
    if (writer === null) return refused(view.status.at === "following" && !view.reached ? "unreached" : "no_list");
    const row = writer.state.signers[newcomer.key];
    // the list holds the key already: let in before (the place handed on is where this device stands now), or put out for good
    if (row !== undefined) {
      if (row.ended !== null || row.as !== "device") return refused("removed");
      return { allowed: true, offer: { list: writer.list, seq: writer.state.footing.seq, hash: writer.state.footing.hash } };
    }
    let request: Written;
    try {
      const claim = (await writer.service.listClaims(writer.list)).find((each) => each.key === newcomer.key);
      if (claim === undefined) return refused("not_claimed");
      request = await written(writer, claim, names);
    } catch (error) {
      if (error instanceof SignedOutError) throw error;
      // an entry this device would not count is not signed: a card that is not that key's, most of all
      if (error instanceof ListWriteError) return refused("refused");
      if (unanswered(error) || refusalOf(error) !== null) return refused("unreached");
      throw error;
    }
    let placed = false;
    let again = false;
    let retryAfterMs: number | null = null;
    for (let sends = 0; sends < ALLOW_RESENDS; sends += 1) {
      try {
        await writer.service.placeEntries(writer.list, request.entries, request.wraps);
        placed = true;
        break;
      } catch (error) {
        if (error instanceof SignedOutError) throw error;
        const said = refusalOf(error);
        if (said === null) {
          if (unanswered(error)) return refused("unreached");
          throw error;
        }
        if (said.status === 503 && said.code === "list_rebuilding") {
          // the same request again, the same signatures, after the pause the account service asks for
          ({ retryAfterMs } = said);
          if (sends + 1 < ALLOW_RESENDS) await wait(Math.min(retryAfterMs ?? 1_000, RESEND_MAX_MS));
          continue;
        }
        if (said.status === 503 && said.code === "list_stopped") return refused("stopped");
        if (said.status === 429) return refused("budget", said.retryAfterMs);
        if (said.status === 403 && said.code === "not_claimed") return refused("not_claimed");
        // the head moved, or the service's clock says otherwise of an epoch than this device's did: read and sign again
        const moved = said.status === 409 && (said.code === "head_moved" || said.code === "try_again");
        const judged = said.status === 400 && said.code === "entry_refused" && (said.reason === "epoch_not_needed" || said.reason === "epoch_stale" || said.reason === "epoch_no_use");
        if (!moved && !judged) return refused(said.status >= 500 ? "unreached" : "refused");
        again = true;
        break;
      }
    }
    if (!placed && !again) return refused("busy", retryAfterMs);
    if (again) continue;
    // the answer is no word on who is in: the newcomer is in once this device's own copy shows the entry at its place
    await list.sync();
    if (list.holdsEntry(request.place)) return { allowed: true, offer: { list: writer.list, seq: request.place.seq, hash: request.place.hash } };
  }
  return refused("busy");
}
