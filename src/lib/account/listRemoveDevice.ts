/**
 * A device that is in its account's signed list puts members out of it (docs/account-list.md, "Putting a member
 * out"): it signs a `remove` that ends a key, then the `epoch` the kinds call for, with the new epoch's key wrapped
 * to everybody who stays, and places all of it in one request. The same request tidies up what may no longer hold
 * the current epoch's key: an invite past its `exp`, a borrowed browser past its `until`.
 *
 * Every entry is signed through the kinds' writer, on this device's own state, and only when it would count there.
 * A key that is ended never comes back: nothing here signs it in again. The account service's answer to the
 * placement is trusted for nothing: a member is out once this device's own copy shows its removal at its place.
 */
import { listClock, listView, pcRemoval, sealEpoch, signListEntry, wrapKeys, type ListKind, type ListState } from "../../../shared/account-list.ts";
import { nextEpoch, wrapEpochKeyFor, wrapToText } from "../../../shared/account-list-seal.ts";
import type { AccountList, AccountListView, ListWriter } from "./accountList.ts";
import type { PlacedWrap } from "./listAnswers.ts";
import { placeOf, writeToList, type WriteOptions, type WriteRefusal, type Written } from "./listWrite.ts";

/**
 * A member that came in through another key: a device it let in, a key with no name it added, or a PC it added or
 * whose invite it placed. `via` is the key it came in through.
 */
export type Arrival =
  | { readonly kind: "device"; readonly key: string; readonly seq: number; readonly via: string }
  | { readonly kind: "signer"; readonly key: string; readonly seq: number; readonly via: string }
  | { readonly kind: "pc"; readonly endpoint: string; readonly seq: number; readonly via: string };

/**
 * What came in through `key` and is still in, in the order it came in: whatever that key let in, and whatever came
 * in through those in turn, also through a member that is out already (whoever it let in may still be in). This
 * device (`self`) is never among them, and neither is what came in through it: the person removing a key trusts the
 * device they remove it from. Devices and PCs that were in the account before the list (`carried`) came in through
 * nobody.
 */
export function cameInThrough(state: ListState, key: string, self: string | null): Arrival[] {
  const view = listView(state);
  const placer = (signer: string | null): string | null => (signer === null ? null : state.signers[signer]?.by ?? null);
  // keys with no name, in or out: listView names only those in
  const nameless = Object.entries(state.signers).filter(([, row]) => row.as === null).map(([signer, row]) => ({ key: signer, seq: row.seq, by: row.by, out: row.ended !== null }));
  const found: Arrival[] = [];
  const seen = new Set<string>([key]);
  const from = [key];
  for (let via = from.shift(); via !== undefined; via = from.shift()) {
    // `live`: offered to the person; whether in or out, what it let in is followed
    const take = (arrival: Arrival, signs: string | null, live: boolean): void => {
      const id = arrival.kind === "pc" ? `pc:${arrival.endpoint}` : arrival.key;
      if (seen.has(id) || (arrival.kind !== "pc" && arrival.key === self)) return;
      seen.add(id);
      if (live) found.push(arrival);
      if (signs !== null && signs !== self) from.push(signs);
    };
    for (const row of view.devices) if (!row.carried && row.by === via) take({ kind: "device", key: row.key, seq: row.seq, via }, row.key, row.ended === null);
    for (const row of nameless) if (row.by === via) take({ kind: "signer", key: row.key, seq: row.seq, via }, row.key, !row.out);
    for (const row of view.pcs) {
      if (row.how === "carried") continue;
      // a PC a person added came in through the key that signed its `pc`; one that joined, through whoever placed its invite
      const by = row.how === "added" ? placer(row.key) : placer(row.invite);
      if (by === via) take({ kind: "pc", endpoint: row.endpoint, seq: row.seq, via }, row.how === "added" ? row.key : null, row.removed === null);
    }
  }
  return found.sort((a, b) => a.seq - b.seq);
}

/**
 * The keys whose time is over by `clock` and that still hold the current epoch's key, in the order to put them out:
 * every device that is in at or past its `until`, and every invite that a PC joins with by itself which is in, still
 * has a use and is past its `exp`. Exactly the set of the kinds layer's `lapsedRemovals` (shared/account-list.ts,
 * PR #4593), which this gives way to once that reaches this branch. A plain invite holds no key and lets nobody in by
 * itself, so it is left alone.
 */
export function overdueKeys(state: ListState, clock: number): string[] {
  const view = listView(state);
  return [
    ...view.devices.filter((row) => row.ended === null && row.until !== null && !(clock < row.until)).map((row) => row.key),
    ...view.invites.filter((row) => row.auto && state.signers[row.key]?.ended === null && row.joins < row.uses && clock > row.exp).map((row) => row.key),
  ];
}

/** Who a removal puts out: keys (a device, a key with no name) and PCs by their relay key. */
export interface Removal {
  readonly keys: readonly string[];
  readonly pcs: readonly string[];
}

/**
 * The account, the list and the member key a write began with (the lead's X3): a write compares them again after
 * every read of the list, and ends with nothing signed where another sign-in or another list took their place.
 */
export interface WriteScope {
  readonly account: string;
  readonly list: string;
  readonly member: string;
}

/** The scope of what the page shows now: the account and list it follows and this device's key in it; null where it is in none. */
export function scopeOf(view: AccountListView): WriteScope | null {
  const self = view.devices.find((device) => device.self);
  return view.account === null || view.status.at !== "following" || view.status.standing !== "in" || self === undefined ? null
    : { account: view.account, list: view.status.list, member: self.key };
}

/**
 * Why nothing, or not everything, was put out: the write loop's reasons (listWrite.ts, WriteRefusal), or `changed`:
 * another sign-in, another list or another key stood in the write's place by its next read. `placed`: how many of
 * the members asked for went in parts that were placed before the refusal.
 */
export type RemoveOutcome =
  | { readonly removed: true }
  | { readonly removed: false; readonly why: WriteRefusal | "changed" | "unconfirmed"; readonly retryAfterMs: number | null; readonly placed: number; readonly unconfirmed?: readonly string[] };

/** The most entries one request carries (the account service's bound). */
export const BATCH_ENTRIES_MAX = 16;
/** The most requests one removal places, each the next part of it. */
const PARTS_MAX = 64;

/** A request signed on a writer's state; `whole`: it holds all that was asked; `asked`: how many asked-for members it puts out. */
export interface Signed extends Written {
  readonly whole: boolean;
  readonly asked: number;
}

/**
 * The clock a writer judges whose time is over by (the lead's X1): its own, never the account service's, held against
 * the list's own time. The writer dates entries by `issued_at`, which is never ahead of this device's own clock.
 */
export const judgeClock = (writer: ListWriter): number => listClock(writer.state, writer.issued_at, null);

/**
 * The request that puts out what `removal` names and is still in, then opens the next epoch where the kinds call for
 * one and this device holds the current epoch's key (`epoch`: false for a device that puts itself out, which leaves
 * the next epoch to one that stays). With `tidy`, what is over its time goes too, in the room that is left: the
 * removal asked for and its epoch always fit (the lead's X4), and the rest is tidied later. Null when nothing is left
 * to put out. A removal too long for one request is placed in parts, the epoch with the last.
 */
export async function removalRequest(writer: ListWriter, removal: Removal, options: { readonly epoch: boolean; readonly tidy: boolean }): Promise<Signed | null> {
  const { list, issued_at } = writer;
  const clock = judgeClock(writer);
  const signer = { key: writer.keys.key, privateKey: writer.keys.signs };
  let after = writer.state;
  const entries: string[] = [];
  const sign = async (kind: ListKind): Promise<void> => {
    const written = await signListEntry(after, kind, signer, issued_at);
    entries.push(written.text);
    after = written.state;
  };
  const current = writer.epochs.get(writer.state.epoch) ?? null;
  // room for the epoch at the end, where this device can open it
  const room = BATCH_ENTRIES_MAX - (options.epoch && current !== null ? 1 : 0);
  const steps: (() => ListKind[])[] = [
    ...removal.keys.map((key) => () => (after.signers[key] !== undefined && after.signers[key].ended === null ? [{ kind: "remove", ends: key } as const] : [])),
    ...removal.pcs.map((endpoint) => () => pcRemoval(after, endpoint)),
  ];
  let whole = true;
  let asked = 0;
  for (const step of steps) {
    const kinds = step();
    if (entries.length + kinds.length > room) { whole = false; break; }
    for (const kind of kinds) await sign(kind);
    if (kinds.length > 0) asked += 1;
  }
  if (whole && options.tidy) {
    for (const key of overdueKeys(after, clock)) {
      if (entries.length >= room) break;
      await sign({ kind: "remove", ends: key });
    }
  }
  let wraps: PlacedWrap[] = [];
  // the epoch goes with the last part, and only where nobody who stays could seal under the current one
  if (whole && options.epoch && current !== null && sealEpoch(after, issued_at) === null) {
    // made anew for every request: a key whose wraps went out in a request that was not placed is never used
    const next = await nextEpoch({ list, current, members: [] });
    await sign({ kind: "epoch", epoch: after.epoch, opens: next.commitment, link: next.link });
    const wrapped = await wrapEpochKeyFor({ list, epoch: next.epoch, members: wrapKeys(after, clock) });
    wraps = wrapped.wraps.map(({ member, wrap }) => ({ epoch: next.epoch.epoch, member, wrap: wrapToText(wrap) }));
  }
  if (entries.length === 0) return null;
  return { entries, wraps, place: placeOf(after), whole, asked };
}

/**
 * Places what `build` signs on the list as this device holds it, through the one write loop (listWrite.ts), part
 * after part until `build` has nothing left to sign. Every read must still show `scope`, or nothing more is signed.
 * Only a sign-in that ended throws.
 */
async function placeParts(list: AccountList, scope: WriteScope | null, build: (writer: ListWriter) => Promise<Signed | null>, options: WriteOptions, guard?: (writer: ListWriter) => "unconfirmed" | null): Promise<RemoveOutcome> {
  let placed = 0;
  for (let parts = 0; parts < PARTS_MAX; parts += 1) {
    let whole = true;
    let asked = 0;
    const outcome = await writeToList<"changed" | "unconfirmed">(list, async (writer) => {
      if (scope !== null && (writer.account !== scope.account || writer.list !== scope.list || writer.keys.key !== scope.member)) return { refused: "changed" };
      const refused = guard?.(writer) ?? null;
      if (refused !== null) return { refused };
      const request = await build(writer);
      if (request === null) return { done: placeOf(writer.state) };
      ({ whole, asked } = request);
      return { request };
    }, options);
    if (!outcome.written) return { removed: false, why: outcome.why, retryAfterMs: outcome.retryAfterMs, placed };
    placed += asked;
    if (whole) return { removed: true };
  }
  return { removed: false, why: "busy", retryAfterMs: null, placed };
}

/**
 * Puts out the keys and PCs that `removal` names, in one request with the epoch after it, and what is over its time
 * with them where there is room. A key that is out already is passed by; with nothing left the outcome is `removed`.
 * `scope`: what the write was begun for (scopeOf the view the person acted on); null takes the first read's.
 */
export function removeFromList(list: AccountList, removal: Removal, options: Pick<WriteOptions, "wait"> & { readonly scope?: WriteScope | null } = {}): Promise<RemoveOutcome> {
  return placeParts(list, options.scope ?? scopeOf(list.view()), (writer) => removalRequest(writer, removal, { epoch: true, tidy: true }), options);
}

/**
 * Sign out every device's removal: every other device the list holds, in one request with the epoch. `confirmed`: the
 * devices the person's question named. Each read is held against it: a device the question did not name ends the
 * write with nothing more signed (`unconfirmed`, with its keys), so the person is asked again.
 */
export async function removeOtherDevices(list: AccountList, scope: WriteScope, confirmed: readonly string[], options: Pick<WriteOptions, "wait"> = {}): Promise<RemoveOutcome> {
  const others = (writer: ListWriter): string[] => listView(writer.state).devices.filter((row) => row.ended === null && row.key !== writer.keys.key).map((row) => row.key);
  let unconfirmed: string[] = [];
  const outcome = await placeParts(list, scope, (writer) => removalRequest(writer, { keys: others(writer), pcs: [] }, { epoch: true, tidy: true }), options, (writer) => {
    unconfirmed = others(writer).filter((key) => !confirmed.includes(key));
    return unconfirmed.length > 0 ? "unconfirmed" : null;
  });
  return !outcome.removed && outcome.why === "unconfirmed" ? { ...outcome, unconfirmed } : outcome;
}

/**
 * This device puts itself out (signing out, leaving the account): one `remove` of its own key, which a device of
 * any power may sign. It opens no epoch: a device that is on its way out leaves that to one that stays, since the
 * next epoch's key would be its own to know.
 */
export function removeSelf(list: AccountList, scope: WriteScope, options: Pick<WriteOptions, "wait"> = {}): Promise<RemoveOutcome> {
  return placeParts(list, scope, (signs) => removalRequest(signs, { keys: [signs.keys.key], pcs: [] }, { epoch: false, tidy: false }),
    { ...options, writer: () => list.writer({ self: true }), trustPlaced: true });
}

/**
 * The tidying a device of power `full` does by itself while it is in front (docs/account-list.md, "What a device
 * writes after entry 0"): it ends each invite past its `exp` and each device past its `until`, by its own clock, then
 * opens the next epoch where nobody could seal under the current one (after another member put itself out, say). What
 * it ends is judged again on the state it signs on. Each key is tried once by this page (`tried`), whatever becomes
 * of it, so a service that refuses is not asked again and again; an epoch is tried once for each place of the list.
 */
export async function tidyList(list: AccountList, tried: Set<string>, options: Pick<WriteOptions, "wait"> = {}): Promise<RemoveOutcome | null> {
  const writer = list.writer();
  if (writer === null) return null;
  const overdue = overdueKeys(writer.state, judgeClock(writer));
  const keys = overdue.filter((key) => !tried.has(key));
  const epochAt = `epoch@${writer.list}:${writer.state.footing.seq}`;
  // an epoch alone only where nothing over its time is left in: the account service opens none while one is
  const opens = overdue.length === 0 && writer.epochs.has(writer.state.epoch) && sealEpoch(writer.state, writer.issued_at) === null && !tried.has(epochAt);
  if (keys.length === 0 && !opens) return null;
  for (const key of keys) tried.add(key);
  if (keys.length === 0) tried.add(epochAt);
  const scope = { account: writer.account, list: writer.list, member: writer.keys.key };
  return placeParts(list, scope, (signs) => {
    // only what is still over its time on the state it is signed on
    const still = new Set(overdueKeys(signs.state, judgeClock(signs)));
    return removalRequest(signs, { keys: keys.filter((key) => still.has(key)), pcs: [] }, { epoch: true, tidy: false });
  }, options);
}
