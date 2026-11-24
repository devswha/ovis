/**
 * How a device that is in its account's signed list places entries it signs (docs/account-list.md, "Letting a device
 * in" and "PCs of a list account"): it reads the list, signs on the state it then holds, and places the request.
 *
 * Every entry is signed through the kinds' writer, on this device's own state, and only when it would count there.
 * The account service's answer to the placement is trusted for nothing: the entries are placed once this device's own
 * copy shows the last of them at its place.
 */
import { ListWriteError, listView, signListEntries, wrapKeys, type ListKind, type ListState } from "../../../shared/account-list.ts";
import { nextEpoch, wrapEpochKeyFor, wrapToText, type EpochKey } from "../../../shared/account-list-seal.ts";
import type { ListPlace } from "../../../shared/account-list-signers.ts";
import type { AccountList, ListWriter } from "./accountList.ts";
import type { PlacedWrap } from "./listAnswers.ts";
import { AccountRefreshError, AccountServiceError, AccountServiceUnreachableError, SignedOutError } from "./service.ts";

/**
 * Why nothing was placed.
 *
 * - `no_list`: this device follows no list, is not in it with power `full`, or was shown another history: it signs nothing.
 * - `not_claimed`: the account service holds no claim of a key by a sign-in of the account, so it places no entry for it.
 * - `budget`: the list took as many changes as it takes for now; `retryAfterMs` says how long.
 * - `stopped`: the account service cannot change the list right now.
 * - `busy`: the list kept moving, or the account service kept asking for the request again, for every try.
 * - `refused`: the account service refused the entry, or this device would not count it.
 * - `unreached`: the account service did not answer.
 */
export type WriteRefusal = "no_list" | "not_claimed" | "budget" | "stopped" | "busy" | "refused" | "unreached";

/** How often one write reads the list and signs anew, after the head moved under it or the account service judged otherwise. */
export const WRITE_TRIES = 4;
/** How often one signed request is sent again while the account service says it is rebuilding the list. */
export const WRITE_RESENDS = 3;
/** The longest wait before a request is sent again, whatever the account service asks for. */
const RESEND_MAX_MS = 5_000;

/** The pause the account service asks for before the same request goes again: between the tries of a loop bounded by WRITE_RESENDS. */
const pause = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/** A request as signed: the entries, the wraps that go with them, and the place of the last entry. */
export interface Written {
  readonly entries: readonly string[];
  readonly wraps: readonly PlacedWrap[];
  readonly place: ListPlace;
}

/**
 * What a writer does on the state it holds now: a request to place, nothing (`done`: the list says so already, as
 * far as the place this device stands at), or a refusal of its own.
 */
export type WriteStep<Why extends string> = { readonly request: Written } | { readonly done: ListPlace } | { readonly refused: WriteRefusal | Why };

export type WriteOutcome<Why extends string> =
  | { readonly written: true; readonly list: string; readonly place: ListPlace }
  | { readonly written: false; readonly why: WriteRefusal | Why; readonly retryAfterMs: number | null };

export const placeOf = (state: ListState): ListPlace => ({ seq: state.footing.seq, hash: state.footing.hash });

/**
 * The keys whose time is over while they still hold the current epoch's key, by the clock the writer judges by: an
 * invite that a PC joins with by itself, past its `exp` with a use left, and a device that is in past its `until`.
 * While one of them is in, the kinds seal no name (sealEpoch).
 */
export function overTime(state: ListState, clock: number): string[] {
  const view = listView(state);
  return [
    ...view.invites.filter((row) => row.auto && state.signers[row.key]?.ended === null && row.joins < row.uses && clock > row.exp).map((row) => row.key),
    ...view.devices.filter((row) => row.ended === null && row.until !== null && !(clock < row.until)).map((row) => row.key),
  ];
}

/** A step of a request: a kind, or one made from the state the steps before it leave. */
export type Step = ListKind | ((state: ListState) => ListKind | Promise<ListKind>);

/** Signs the steps on the writer's state, as one request with no key to wrap. */
export async function signedOn(writer: ListWriter, steps: readonly Step[], wraps: readonly PlacedWrap[] = []): Promise<Written> {
  const result = await signListEntries(writer.state, steps, { key: writer.keys.key, privateKey: writer.keys.signs }, writer.issued_at);
  return { entries: result.entries.map((entry) => entry.text), wraps, place: placeOf(result.state) };
}

/**
 * Signs `before`, one `epoch`, and what `after` gives for the key of the epoch that request opens, and wraps that key
 * to everybody who is in after the whole of it. `current` is the key of the epoch that ends. The new key is made anew
 * for every request: a key whose wraps went out in a request that was not placed is never used.
 */
export async function signedWithEpoch(writer: ListWriter, current: EpochKey, before: readonly Step[], after: (next: { readonly epoch: EpochKey; readonly commitment: string }) => readonly Step[] = () => []): Promise<Written> {
  const { list, state, clock } = writer;
  const next = await nextEpoch({ list, current, members: [] });
  const result = await signListEntries(state, [
    ...before,
    (held) => ({ kind: "epoch", epoch: held.epoch, opens: next.commitment, link: next.link }),
    ...after(next),
  ], { key: writer.keys.key, privateKey: writer.keys.signs }, writer.issued_at);
  const wrapped = await wrapEpochKeyFor({ list, epoch: next.epoch, members: wrapKeys(result.state, clock) });
  return { entries: result.entries.map((entry) => entry.text), wraps: wrapped.wraps.map(({ member, wrap }) => ({ epoch: next.epoch.epoch, member, wrap: wrapToText(wrap) })), place: placeOf(result.state) };
}

/** The account service's own refusal of a request, as against no answer or a refresh that failed. */
const refusalOf = (error: unknown): AccountServiceError | null => (error instanceof AccountServiceError && !(error instanceof AccountRefreshError) ? error : null);

const unanswered = (error: unknown): boolean => error instanceof AccountServiceUnreachableError || error instanceof AccountRefreshError
  || (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError"));

/**
 * Places what `step` signs on the list this device follows. It reads the list first, and `step` signs on what the
 * device then holds. When the head moved under it, or the account service judged the request by a clock a moment
 * apart from this device's, it reads and signs again, WRITE_TRIES times at most; while the service says it is
 * rebuilding the list, the same request goes again, WRITE_RESENDS times at most. Only a sign-in that ended throws.
 */
export async function writeToList<Why extends string = never>(list: AccountList, step: (writer: ListWriter) => Promise<WriteStep<Why>>, options: { readonly wait?: (ms: number) => Promise<void> } = {}): Promise<WriteOutcome<Why>> {
  const wait = options.wait ?? pause;
  const refused = (why: WriteRefusal | Why, retryAfterMs: number | null = null): WriteOutcome<Why> => ({ written: false, why, retryAfterMs });
  for (let tries = 0; tries < WRITE_TRIES; tries += 1) {
    const view = await list.sync();
    const writer = list.writer();
    if (writer === null) return refused(view.status.at === "following" && !view.reached ? "unreached" : "no_list");
    let request: Written;
    try {
      const next = await step(writer);
      if ("done" in next) return { written: true, list: writer.list, place: next.done };
      if ("refused" in next) return refused(next.refused);
      ({ request } = next);
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
    for (let sends = 0; sends < WRITE_RESENDS; sends += 1) {
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
          if (sends + 1 < WRITE_RESENDS) await wait(Math.min(retryAfterMs ?? 1_000, RESEND_MAX_MS));
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
    // the answer is no word on what the list holds: the entries are placed once this device's own copy shows the last at its place
    await list.sync();
    if (list.holdsEntry(request.place)) return { written: true, list: writer.list, place: request.place };
  }
  return refused("busy");
}
