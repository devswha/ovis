/**
 * A removal this device signed, carried to every PC it knows until each reports it (docs/account.md,
 * "Removing a device"). Only removals this device signed itself are carried: one signed by any other
 * key may come from a stolen former key, so it is shown, never spread.
 */
import { AccountRecordError, readAccountRecord, type RemoveRecord } from "../../../shared/account-records.ts";
import { pcAccountStatus, post, withDevice, type PcAccountStatus, type PcFetch } from "./join.ts";
import type { AccountStore } from "./store.ts";

/** At most this many removals are tracked; past it no new one is signed until settled ones are cleared. */
export const TRACKED_MAX = 4096;

/**
 * What a PC said about a removal when this device last read it, by the PC's own word:
 * `reported` it lists the key in `tombstones`; `repaired` it kept a pairing made there after the
 * removal; `waiting` it keeps the removal waiting (its signer is no member there); `unconfirmed` it
 * is from before `tombstones`; `unknown` the send or the read failed; `not-reached` not read since.
 */
export type PcRemovalState = "reported" | "repaired" | "waiting" | "unconfirmed" | "unknown" | "not-reached";

export interface PcRemovalReport {
  readonly state: PcRemovalState;
  readonly at: string | null;
  readonly reason?: string;
}

export interface TrackedRemoval {
  readonly account: string;
  readonly record: RemoveRecord;
  readonly label?: string;
  /** the account's directory could not be read when it was signed: never called done until a read adds its PCs */
  readonly directoryUnread?: boolean;
  /** PCs the person forgot on this device: never added back from the directory */
  readonly forgotten?: readonly string[];
  /** by server_id: every PC the removal must reach; one leaves only by forgetPc */
  readonly pcs: Readonly<Record<string, PcRemovalReport>>;
}

export class RemovalTrackingFull extends Error {
  constructor() {
    super(`This device already tracks ${TRACKED_MAX} removals. Clear the settled ones first.`);
    this.name = "RemovalTrackingFull";
  }
}

const SETTLED: readonly PcRemovalState[] = ["reported", "repaired"];

export function unsettledPcs(tracked: TrackedRemoval): string[] {
  return Object.entries(tracked.pcs).filter(([, report]) => !SETTLED.includes(report.state)).map(([id]) => id);
}

/** Settled on every PC this device knows, and the directory was read. */
export function settledEverywhere(tracked: TrackedRemoval): boolean {
  return tracked.directoryUnread !== true && unsettledPcs(tracked).length === 0;
}

/** What Clear settled removals drops: every PC of the list reports it removed, and the directory was read. */
export function clearable(tracked: TrackedRemoval): boolean {
  return tracked.directoryUnread !== true && Object.values(tracked.pcs).every((report) => report.state === "reported");
}

/**
 * Keeps a removal this device just signed, with the PCs it must reach, before it is sent anywhere.
 * Refuses (RemovalTrackingFull) when TRACKED_MAX are kept, so no removal goes out untracked.
 */
export async function trackRemoval(store: AccountStore, record: RemoveRecord, pcs: readonly string[], label?: string, directoryUnread = false): Promise<void> {
  let full = false;
  // one transaction with the record enrollPc hands a PC brought in later, so neither is kept without the other
  await store.updateMany(["tracked", "devices"], (current) => {
    if (Object.keys(current.tracked ?? {}).length >= TRACKED_MAX) { full = true; return current; }
    const reports: Record<string, PcRemovalReport> = {};
    for (const id of pcs) reports[id] = { state: "not-reached", at: null };
    return {
      tracked: { ...current.tracked, [record.id]: { account: record.account, record, pcs: reports, ...(label === undefined ? {} : { label }), ...(directoryUnread ? { directoryUnread } : {}) } },
      devices: withDevice(current.devices, record),
    };
  });
  if (full) throw new RemovalTrackingFull();
}

/** Whether this device carries a removal of `key` for `account`: it then approves, adds and introduces nothing for it. */
export async function carriesRemovalOf(store: AccountStore, account: string, key: string): Promise<boolean> {
  return Object.values(await store.get("tracked") ?? {}).some((entry) => entry.account === account && entry.record.key === key);
}

export async function clearSettled(store: AccountStore, account: string): Promise<number> {
  let dropped = 0;
  await store.update("tracked", (current) => {
    const next: Record<string, TrackedRemoval> = {};
    for (const [id, tracked] of Object.entries(current ?? {})) {
      // only a removal every PC reports: `repaired` is a PC's word about a pairing, kept on show
      if (tracked.account === account && clearable(tracked)) dropped++;
      else next[id] = tracked;
    }
    return Object.keys(next).length === 0 ? undefined : next;
  });
  return dropped;
}

/** Adds PCs this device sees in the account's directory to the list of every removal of `account` it signed. */
export async function notePcs(store: AccountStore, account: string, serverIds: readonly string[]): Promise<number> {
  let unsettled = 0;
  await store.update("tracked", (current) => {
    if (current === undefined) return current;
    const next: Record<string, TrackedRemoval> = {};
    for (const [id, tracked] of Object.entries(current)) {
      if (tracked.account !== account) { next[id] = tracked; continue; }
      const pcs = { ...tracked.pcs };
      for (const serverId of serverIds) if (!(tracked.forgotten ?? []).includes(serverId)) pcs[serverId] ??= { state: "not-reached", at: null };
      // the directory read now: a removal signed while it could not be is no longer held back by that
      const { directoryUnread: _read, ...rest } = tracked;
      next[id] = { ...rest, pcs };
      if (!settledEverywhere(next[id])) unsettled++;
    }
    return next;
  });
  return unsettled;
}

export async function forgetPc(store: AccountStore, serverId: string): Promise<void> {
  await store.update("tracked", (current) => {
    if (current === undefined) return current;
    const next: Record<string, TrackedRemoval> = {};
    for (const [id, tracked] of Object.entries(current)) {
      const { [serverId]: _gone, ...pcs } = tracked.pcs;
      next[id] = { ...tracked, pcs, forgotten: [...new Set([...tracked.forgotten ?? [], serverId])] };
    }
    return next;
  });
}

type Outcome = { outcome?: unknown; code?: unknown };

function report(record: RemoveRecord, status: PcAccountStatus | null, outcome: Outcome | undefined, failure: string | null, at: string): PcRemovalReport {
  if (status === null) return { state: "unknown", at, reason: failure ?? "no answer" };
  if (status.tombstones === undefined) return { state: "unconfirmed", at };
  if (status.tombstones.includes(record.key)) return { state: "reported", at };
  if (status.blocked.includes(record.key)) return { state: "waiting", at };
  // paired again only where the PC shows a row it paired itself for the key (not one a link moved onto it)
  if (outcome?.outcome === "unchanged" && (status.pairedHere?.includes(record.key) ?? false)) return { state: "repaired", at };
  if (outcome?.outcome === "unchanged") return { state: "unknown", at, reason: "no pairing shown" };
  const reason = failure ?? (outcome?.outcome === "refused" ? String(outcome.code) : status.blockedAll === true ? "blocked_all" : "no answer");
  return { state: "unknown", at, reason };
}

/**
 * On a connection to PC `serverId` of `account` (`fetch` signed in with the account key there):
 * adds that PC to the list of every removal this device signed, sends it each one it does not report
 * removed, and keeps what it then reports. The PC decides each removal itself.
 */
export async function carryRemovals(options: { fetch: PcFetch; store: AccountStore; account: string; serverId: string; now?: () => number }): Promise<void> {
  const own = (await options.store.key()).public_spki;
  const tracked = Object.values(await options.store.get("tracked") ?? {})
    .filter((entry) => entry.account === options.account && entry.record.signer === own);
  if (tracked.length === 0) return;
  const outcomes = new Map<string, Outcome>();
  let status: PcAccountStatus | null = null;
  let failure: string | null = null;
  try {
    const before = await pcAccountStatus(options.fetch);
    if (before.account !== options.account) return;
    // a PC that already kept a pairing made after it, or that cannot report (older), is not sent it again on every connection
    const answered = (entry: TrackedRemoval) => ["repaired", "unconfirmed"].includes(entry.pcs[options.serverId]?.state ?? "");
    const send = tracked.filter((entry) => !answered(entry)).map((entry) => entry.record).filter((record) => !(before.tombstones?.includes(record.key) ?? false));
    for (let start = 0; start < send.length; start += 32) {
      const batch = send.slice(start, start + 32);
      const answer = await (await post(options.fetch, "/api/account/records", { records: batch })).json() as { results?: unknown };
      const results = Array.isArray(answer.results) ? answer.results as (Outcome & { id?: unknown })[] : [];
      for (const result of results) if (typeof result.id === "string") outcomes.set(result.id, result);
    }
    // read again: the report is what the PC says after it decided
    status = send.length === 0 ? before : await pcAccountStatus(options.fetch);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  const at = new Date((options.now ?? Date.now)()).toISOString();
  await options.store.update("tracked", (current) => {
    if (current === undefined) return current;
    const next = { ...current };
    for (const entry of tracked) {
      const kept = next[entry.record.id];
      // not sent again here: its report stays, unless the PC now reports it removed
      const skipped = status !== null && ["repaired", "unconfirmed"].includes(entry.pcs[options.serverId]?.state ?? "") && !(status?.tombstones?.includes(entry.record.key) ?? false);
      if (skipped) continue;
      // cleared meanwhile (another tab), or this PC forgotten meanwhile: not brought back
      if (kept === undefined || (kept.forgotten ?? []).includes(options.serverId)) continue;
      next[entry.record.id] = { ...kept, pcs: { ...kept.pcs, [options.serverId]: report(entry.record, status, outcomes.get(entry.record.id), failure, at) } };
    }
    return next;
  });
}

/** A device a removed one let in, as the PC in view shows it. */
export interface LostCandidate { readonly key: string; readonly label: string }

/**
 * The devices a lost or stolen device let in (docs/account.md, "Lost or stolen"), from what the PC in
 * view lists: `signed`, keys whose signed add (signature checked) the removed key signed, then the same
 * for those, transitively; `pcSays`, account rows the PC says it added (`added_by`) with no such add.
 * Only candidates: the person picks which to remove.
 */
export async function lostCandidates(options: {
  removed: string; account: string; adds: readonly unknown[];
  devices: readonly { readonly id: string; readonly label: string; readonly account?: string; readonly account_key?: string; readonly added_by?: string }[];
}): Promise<{ signed: LostCandidate[]; pcSays: LostCandidate[] }> {
  const adds: { key: string; signer: string; label: string }[] = [];
  for (const value of options.adds) {
    let record;
    try { record = await readAccountRecord(value); } catch (error) {
      if (error instanceof AccountRecordError) continue;
      throw error;
    }
    if (record?.kind === "add" && record.account === options.account) adds.push({ key: record.key, signer: record.signer, label: record.label });
  }
  const reached = new Set([options.removed]);
  const signed: LostCandidate[] = [];
  for (let grew = true; grew;) {
    grew = false;
    for (const add of adds) {
      if (reached.has(add.signer) && !reached.has(add.key)) {
        reached.add(add.key);
        signed.push({ key: add.key, label: options.devices.find((row) => row.account_key === add.key)?.label ?? add.label });
        grew = true;
      }
    }
  }
  const rowsOf = new Set(options.devices.filter((row) => row.account_key !== undefined && reached.has(row.account_key)).map((row) => row.id));
  const pcSays = options.devices
    .filter((row) => row.account === options.account && row.account_key !== undefined && !reached.has(row.account_key) && row.added_by !== undefined && rowsOf.has(row.added_by))
    .map((row) => ({ key: row.account_key!, label: row.label }));
  return { signed, pcSays };
}

/** A removal another device signed that the PC in view holds (`signer`) or keeps waiting (no signer known). */
export interface ForeignRemoval { readonly key: string; readonly signer: string | null; readonly waiting: boolean }

/**
 * What the PC in view says other devices removed (docs/account.md, "What a client carries"): verified
 * `removals` not signed by this device, and `blocked` keys it keeps waiting, minus the ones this device
 * already carries. Shown with Remove everywhere, never carried as they are.
 */
export async function foreignRemovals(options: { status: PcAccountStatus; account: string; own: string; store: AccountStore }): Promise<ForeignRemoval[]> {
  const carried = new Set(Object.values(await options.store.get("tracked") ?? {}).filter((entry) => entry.account === options.account).map((entry) => entry.record.key));
  const found = new Map<string, ForeignRemoval>();
  for (const value of options.status.removals) {
    let record;
    try { record = await readAccountRecord(value); } catch (error) {
      if (error instanceof AccountRecordError) continue;
      throw error;
    }
    if (record?.kind !== "remove" || record.account !== options.account || record.signer === options.own || carried.has(record.key)) continue;
    found.set(record.key, { key: record.key, signer: record.signer, waiting: false });
  }
  // a key the PC only lists in `blocked` is not offered: an enrollment hold is the PC's word, and nothing signed backs it
  return [...found.values()];
}
