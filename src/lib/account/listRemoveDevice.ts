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
import { listView, pcRemoval, sealEpoch, signListEntry, wrapKeys, type ListKind, type ListState } from "../../../shared/account-list.ts";
import { nextEpoch, wrapEpochKeyFor, wrapToText } from "../../../shared/account-list-seal.ts";
import type { AccountList, ListWriter } from "./accountList.ts";
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
 * in through those in turn. This device (`self`) is never among them, and neither is what came in through it: the
 * person removing a key trusts the device they remove it from. Devices and PCs that were in the account before the
 * list (`carried`) came in through nobody.
 */
export function cameInThrough(state: ListState, key: string, self: string | null): Arrival[] {
  const view = listView(state);
  const placer = (signer: string | null): string | null => (signer === null ? null : state.signers[signer]?.by ?? null);
  const found: Arrival[] = [];
  const seen = new Set<string>([key]);
  const from = [key];
  for (let via = from.shift(); via !== undefined; via = from.shift()) {
    const take = (arrival: Arrival, signs: string | null): void => {
      const id = arrival.kind === "pc" ? `pc:${arrival.endpoint}` : arrival.key;
      if (seen.has(id) || (arrival.kind !== "pc" && arrival.key === self)) return;
      seen.add(id);
      found.push(arrival);
      if (signs !== null && signs !== self) from.push(signs);
    };
    for (const row of view.devices) if (row.ended === null && !row.carried && row.by === via) take({ kind: "device", key: row.key, seq: row.seq, via }, row.key);
    for (const row of view.signers) if (row.by === via) take({ kind: "signer", key: row.key, seq: row.seq, via }, row.key);
    for (const row of view.pcs) {
      if (row.removed !== null || row.how === "carried") continue;
      // a PC a person added came in through the key that signed its `pc`; one that joined, through whoever placed its invite
      const by = row.how === "added" ? placer(row.key) : placer(row.invite);
      if (by === via) take({ kind: "pc", endpoint: row.endpoint, seq: row.seq, via }, row.how === "added" ? row.key : null);
    }
  }
  return found.sort((a, b) => a.seq - b.seq);
}

/**
 * The keys whose time is over by `clock` and that still hold their place: an invite past its `exp` (one that a PC
 * joins with by itself only while it has a use left), and a device that is in past its `until`. Each still holds the
 * current epoch's key or may still sign, so a member that is awake ends it.
 */
export function overdueKeys(state: ListState, clock: number): string[] {
  const view = listView(state);
  return [
    ...view.invites.filter((row) => state.signers[row.key]?.ended === null && clock > row.exp && (!row.auto || row.joins < row.uses)).map((row) => row.key),
    ...view.devices.filter((row) => row.ended === null && row.until !== null && !(clock < row.until)).map((row) => row.key),
  ];
}

/** Who a removal puts out: keys (a device, a key with no name) and PCs by their relay key. */
export interface Removal {
  readonly keys: readonly string[];
  readonly pcs: readonly string[];
}

/** Why nothing, or not everything, was put out: the write loop's reasons (listWrite.ts, WriteRefusal). */
export type RemoveOutcome =
  | { readonly removed: true }
  | { readonly removed: false; readonly why: WriteRefusal; readonly retryAfterMs: number | null };

/** The most entries one request carries (the account service's bound). */
export const BATCH_ENTRIES_MAX = 16;
/** The most requests one removal places, each the next part of it. */
const PARTS_MAX = 64;

/** A request signed on a writer's state, and whether it holds all that was asked. */
export interface Signed extends Written {
  readonly whole: boolean;
}

/**
 * The request that puts out what `removal` names and is still in, then what is over its time, then opens the next
 * epoch where the kinds call for one and this device holds the current epoch's key (`epoch`: false for a device that
 * puts itself out, which leaves the next epoch to one that stays). Null when nothing is left to put out or open. A
 * removal too long for one request is placed in parts, the epoch with the last.
 */
export async function removalRequest(writer: ListWriter, removal: Removal, options: { readonly epoch: boolean; readonly tidy: boolean }): Promise<Signed | null> {
  const { list, clock, issued_at } = writer;
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
  for (const step of steps) {
    const kinds = step();
    if (entries.length + kinds.length > room) { whole = false; break; }
    for (const kind of kinds) await sign(kind);
  }
  if (whole && options.tidy) {
    for (const key of overdueKeys(after, clock)) {
      if (entries.length >= room) { whole = false; break; }
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
  return { entries, wraps, place: placeOf(after), whole };
}

/**
 * Places what `build` signs on the list as this device holds it, through the one write loop (listWrite.ts), part
 * after part until `build` has nothing left to sign. Only a sign-in that ended throws.
 */
async function placeParts(list: AccountList, build: (writer: ListWriter) => Promise<Signed | null>, options: WriteOptions): Promise<RemoveOutcome> {
  for (let parts = 0; parts < PARTS_MAX; parts += 1) {
    let whole = true;
    const outcome = await writeToList(list, async (writer) => {
      const request = await build(writer);
      if (request === null) return { done: placeOf(writer.state) };
      ({ whole } = request);
      return { request };
    }, options);
    if (!outcome.written) return { removed: false, why: outcome.why, retryAfterMs: outcome.retryAfterMs };
    if (whole) return { removed: true };
  }
  return { removed: false, why: "busy", retryAfterMs: null };
}

/**
 * Puts out the keys and PCs that `removal` names, in one request with the epoch after it, and what is over its time
 * with them. A key that is out already is passed by; with nothing left the outcome is `removed`.
 */
export function removeFromList(list: AccountList, removal: Removal, options: Pick<WriteOptions, "wait"> = {}): Promise<RemoveOutcome> {
  return placeParts(list, (writer) => removalRequest(writer, removal, { epoch: true, tidy: true }), options);
}

/**
 * This device puts itself out (signing out, leaving the account): one `remove` of its own key, which a device of
 * any power may sign. It opens no epoch: a device that is on its way out leaves that to one that stays, since the
 * next epoch's key would be its own to know.
 */
export function removeSelf(list: AccountList, options: Pick<WriteOptions, "wait"> = {}): Promise<RemoveOutcome> {
  return placeParts(list, (signs) => removalRequest(signs, { keys: [signs.keys.key], pcs: [] }, { epoch: false, tidy: false }),
    { ...options, writer: () => list.writer({ self: true }), trustPlaced: true });
}

/**
 * The tidying a device of power `full` does by itself while it is in front (docs/account-list.md, "What a device
 * writes after entry 0"): it ends each invite past its `exp` and each device past its `until`, then opens the next
 * epoch where nobody could seal under the current one (after another member put itself out, say). Each key is tried
 * once by this page (`tried`), whatever becomes of it, so a service that refuses is not asked again and again; an
 * epoch is tried once for each place of the list.
 */
export async function tidyList(list: AccountList, tried: Set<string>, options: Pick<WriteOptions, "wait"> = {}): Promise<RemoveOutcome | null> {
  const writer = list.writer();
  if (writer === null) return null;
  const overdue = overdueKeys(writer.state, writer.clock);
  const keys = overdue.filter((key) => !tried.has(key));
  const epochAt = `epoch@${writer.list}:${writer.state.footing.seq}`;
  // an epoch alone only where nothing over its time is left in: the account service opens none while one is
  const opens = overdue.length === 0 && writer.epochs.has(writer.state.epoch) && sealEpoch(writer.state, writer.issued_at) === null && !tried.has(epochAt);
  if (keys.length === 0 && !opens) return null;
  for (const key of keys) tried.add(key);
  if (keys.length === 0) tried.add(epochAt);
  return placeParts(list, (signs) => removalRequest(signs, { keys, pcs: [] }, { epoch: true, tidy: false }), options);
}
