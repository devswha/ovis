/**
 * How a device that is in its account's signed list places entries it signs (docs/account-list.md, "Letting a device
 * in" and "PCs of a list account"): it reads the list, signs on the state it then holds, and places the request.
 *
 * Every entry is signed through the kinds' writer, on this device's own state, and only when it would count there.
 * The account service's answer to the placement is trusted for nothing: the entries are placed once this device's own
 * copy shows the last of them at its place.
 */
import { ListWriteError, signListEntries, wrapKeys, type ListKind, type ListState } from "../../../shared/account-list.ts";
import { nextEpoch, wrapEpochKeyFor, wrapToText, type EpochKey } from "../../../shared/account-list-seal.ts";
import type { ListPlace } from "../../../shared/account-list-signers.ts";
import type { AccountList, AccountListView, ListWriter } from "./accountList.ts";
import type { PlacedWrap } from "./listAnswers.ts";
import { AccountRefreshError, AccountServiceError, AccountServiceUnreachableError, SignedOutError } from "./service.ts";

/**
 * Why nothing was placed.
 *
 * - `no_list`: this device follows no list of the account, or is in none.
 * - `blocked`: it follows a list and may not write to it: it is not in with power `full`, it was shown another
 *   history, it stopped at an entry this build cannot place, or its copy does not read. Never taken for `no_list`:
 *   an account with a list lets nobody in by the ways from before it had one.
 * - `clock`: the account service judged the request by another time than this device's own, which signs no time on
 *   the service's word: this device's clock looks wrong.
 * - `not_claimed`: the account service holds no claim of a key by a sign-in of the account, so it places no entry for it.
 * - `budget`: the list took as many changes as it takes for now; `retryAfterMs` says how long.
 * - `stopped`: the account service cannot change the list right now.
 * - `busy`: the list kept moving, or the account service kept asking for the request again, for every try.
 * - `refused`: the account service refused the entry, or this device would not count it.
 * - `unreached`: the account service did not answer, and nothing was sent that could have been placed.
 * - `unknown`: the request went out, no answer came, and the list could not be read since: whether the entries were
 *   placed is not known yet.
 * - `changed`: the account or the list is no longer the one the write was begun for (WriteOptions.expect): nothing was signed.
 * - `behind`: a member of a later level wrote, and this build signs nobody in on what it holds until it is updated
 *   (it still signs a removal, and the epoch after one).
 */
export type WriteRefusal = "no_list" | "blocked" | "clock" | "not_claimed" | "budget" | "stopped" | "busy" | "refused" | "unreached" | "unknown" | "changed" | "behind";

/** How long one placement waits for its answer: after it, the log says whether the entries were placed. */
const PLACE_MS = 30_000;

/** The most entries one request places (the account service takes no more). */
export const WRITE_ENTRIES_MAX = 16;

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

export interface WriteOptions {
  readonly wait?: (ms: number) => Promise<void>;
  /**
   * The account and the list the write was begun for: what the person saw when they pressed. Held against the writer
   * after every read, so a sign-in that another tab changed, or another list, ends the write with nothing signed.
   */
  readonly expect?: { readonly account: string; /** absent: whichever list of that account the device follows at the first read */ readonly list?: string | undefined };
  /** The writer to sign on, read after each read of the list: for a device's removal of its own key, `list.writer({ self: true })`. The list's own by default. */
  readonly writer?: () => ListWriter | null;
  /**
   * The write is over once the account service took the request, and the list is not read after it. Only for a
   * device's removal of its own key, after which it may be signed out and reads nothing: it then forgets its key
   * whatever the list says, so an answer that lied leaves a key in the list that nobody holds. For any other write
   * the device's own copy must show the entry.
   */
  readonly trustPlaced?: boolean;
}

/** The account service's own refusal of a request, as against no answer or a refresh that failed. */
const refusalOf = (error: unknown): AccountServiceError | null => (error instanceof AccountServiceError && !(error instanceof AccountRefreshError) ? error : null);

const unanswered = (error: unknown): boolean => error instanceof AccountServiceUnreachableError || error instanceof AccountRefreshError
  || (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError"));

/** Whether this device holds a list of its account: it then goes by it, also where it cannot write to it. */
export function holdsList(view: AccountListView): boolean {
  const { status } = view;
  return status.at === "damaged" || status.at === "newer_save" || (status.at === "following" && status.standing !== "out" && status.standing !== "waiting");
}

/**
 * Places what `step` signs on the list this device follows. It reads the list first, and `step` signs on what the
 * device then holds. One signature per place: the request as signed goes again, WRITE_RESENDS times at most, while
 * the device's own copy shows the head it was signed on (the service is rebuilding the list or asks for the request
 * again, no answer came, the log does not show the entries yet); only when the copy shows a new head is another
 * signed, WRITE_TRIES times at most. A request the service judged by another time than this device's is not signed
 * again (`clock`). Only a sign-in that ended throws.
 */
export async function writeToList<Why extends string = never>(list: AccountList, step: (writer: ListWriter) => Promise<WriteStep<Why>>, options: WriteOptions = {}): Promise<WriteOutcome<Why>> {
  const wait = options.wait ?? pause;
  const refused = (why: WriteRefusal | Why, retryAfterMs: number | null = null): WriteOutcome<Why> => ({ written: false, why, retryAfterMs });
  for (let tries = 0; tries < WRITE_TRIES; tries += 1) {
    const view = await list.sync();
    const writer = (options.writer ?? (() => list.writer()))();
    if (options.expect !== undefined && (view.account !== options.expect.account || (writer !== null && (writer.account !== options.expect.account || (options.expect.list !== undefined && writer.list !== options.expect.list))))) return refused("changed");
    if (writer === null) {
      // a device that holds a list goes by it also where it cannot write: only one with no list of its own has none
      const { status } = view;
      const holds = holdsList(view);
      return refused(!holds ? "no_list" : status.at === "following" && status.standing === "in" && status.trouble === null && !view.reached ? "unreached" : "blocked");
    }
    let request: Written;
    try {
      const next = await step(writer);
      if ("done" in next) return { written: true, list: writer.list, place: next.done };
      if ("refused" in next) return refused(next.refused);
      ({ request } = next);
    } catch (error) {
      if (error instanceof SignedOutError) throw error;
      // an entry this device would not count is not signed: a card that is not that key's, most of all
      if (error instanceof ListWriteError) return refused(error.reason === "behind" ? "behind" : "refused");
      if (unanswered(error) || refusalOf(error) !== null) return refused("unreached");
      throw error;
    }
    // One signature per place: the request as signed goes again while this device's own copy shows the head it was
    // signed on, and another is signed only after the copy shows a new head.
    const signedOn = writer.state.footing;
    const current = options.writer ?? (() => list.writer());
    const movedNow = (): boolean => {
      const now = current();
      return now === null || now.list !== writer.list || now.state.footing.seq !== signedOn.seq || now.state.footing.hash !== signedOn.hash;
    };
    let moved = false;
    let retryAfterMs: number | null = null;
    for (let sends = 0; sends < WRITE_RESENDS && !moved; sends += 1) {
      // whether the answer proves that nothing was placed: only `409 head_moved` does, of those that lead on to a read
      let unplaced = false;
      try {
        await writer.service.placeEntries(writer.list, request.entries, request.wraps, AbortSignal.timeout(PLACE_MS));
        if (options.trustPlaced === true) return { written: true, list: writer.list, place: request.place };
      } catch (error) {
        if (error instanceof SignedOutError) throw error;
        const said = refusalOf(error);
        // No answer, one that does not read, or a gateway's: the request may have been placed all the same, and the
        // log below says which
        if (said === null && !unanswered(error) && !(error instanceof SyntaxError)) throw error;
        if (said !== null) {
          if ((said.status === 503 && said.code === "list_rebuilding") || (said.status === 409 && said.code === "try_again")) {
            // the same request again, the same signatures, after the pause the account service asks for; unless a read
            // of this device's moved its head meanwhile, and then another is signed on that head
            ({ retryAfterMs } = said);
            if (sends + 1 < WRITE_RESENDS) await wait(Math.min(retryAfterMs ?? 1_000, RESEND_MAX_MS));
            moved = movedNow();
            continue;
          }
          if (said.status === 503 && said.code === "list_stopped") return refused("stopped");
          // the list's own budget of additions, as against a request too many: each by its code, with the wait it names
          if (said.status === 429) return refused(said.code === "entry_budget" ? "budget" : "busy", said.retryAfterMs);
          if (said.status === 403 && said.code === "not_claimed") return refused("not_claimed");
          // The account service's clock says otherwise of an epoch, or of the entry's time, than this device's did. The
          // device signs nothing by the service's clock, and no second entry on a head that did not move: it says so
          if (said.status === 400 && said.code === "entry_refused"
            && (said.reason === "epoch_not_needed" || said.reason === "epoch_stale" || said.reason === "epoch_no_use" || said.reason === "issued_at_ahead")) return refused("clock");
          unplaced = said.status === 409 && said.code === "head_moved";
          // any other refusal of the service's own says that it placed nothing; a 5xx may be a gateway's, after a commit
          if (!unplaced && said.status < 500) return refused("refused");
        }
      }
      // Placed, refused for a head that moved, or no answer to rely on: this device's own copy says which, from the
      // log itself, whatever head the account service names. Its answer is no word on what the list holds.
      const after = await list.sync({ read: true });
      if (list.holdsEntry(request.place)) return { written: true, list: writer.list, place: request.place };
      // the log could not be read: whether the entries were placed is not known yet, and nothing else is signed
      if (!after.reached) return refused(unplaced ? "unreached" : "unknown");
      moved = movedNow();
    }
    if (!moved) return refused("busy", retryAfterMs);
  }
  return refused("busy");
}
