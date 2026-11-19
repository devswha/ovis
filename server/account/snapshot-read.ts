/**
 * One whole read of the account's snapshot (Step 2, rows G1, G13, T15, T52, T58, T60). Every page must carry the
 * first page's snapshot id, version and methods version, for this PC's account and relay identity, in order, and the
 * last page says it is the last. Denials (blocks in the snapshot, removes in the mailbox) only narrow, so each applies
 * as it is read and stands whatever happens to the read. Everything that widens (adds, lifts, the list itself) is
 * staged and committed only when the whole read validated, in one turn with no wait inside, and only while `gen`
 * moved by nothing but this read's own denials.
 */
import type { BlockReceipt } from "../../shared/account-devices-api.ts";
import type { BlockRecord, DeviceLiftRecord } from "../../shared/account-records.ts";
import { AccountSnapshotError, assembleSnapshot, parseSnapshotPage, SNAPSHOT_GONE, type AccountSnapshot, type AccountSnapshotPage } from "../../shared/account-snapshot.ts";

/** One page of the snapshot as the service sent it, with the mailbox records read beside it. */
export type PageAnswer = { readonly page: unknown; readonly records?: readonly unknown[] } | { readonly snapshot_gone: true };

/** What a read is judged under: noted when it starts and asked again in the commit turn. */
export interface ReadScope {
  readonly account: string;
  readonly serverId: string;
  readonly gen: number;
  readonly lock: string | null;
}

export interface StagedRead {
  readonly snapshot: AccountSnapshot;
  readonly adds: readonly unknown[];
  readonly lifts: readonly DeviceLiftRecord[];
}

/** How a mailbox or handed record bears on the read: a denial narrows at once, an add or lift waits for a whole read. */
export type RecordClass = "denial" | "lift" | "add" | "invalid";

export interface SnapshotPorts {
  /** The binding, relay identity, `gen` and lock now; null for a PC in no account. */
  scope(): ReadScope | null;
  /** The version of the last snapshot this PC applied, null for none. */
  lastVersion(): number | null;
  /** The ids of the blocks this PC's safety log holds: a freeze line may name one the snapshot no longer carries. */
  knownBlocks(): ReadonlySet<string>;
  classify(record: unknown): RecordClass;
  /** Applies a block or a remove now; true when it raised `gen`. */
  deny(record: BlockRecord | unknown): Promise<boolean>;
  /**
   * This PC's own authority for a lift the service took (DeviceStore.liftAuthority): its signature holds and its signer
   * is older here than the blocked key and not removed. Asked before the commit turn; a change it relied on raises gen.
   */
  liftAuthority(lift: DeviceLiftRecord): Promise<boolean>;
  /** Synchronous: every guard again, then the journal, the files and memory, in one turn. */
  commit(stage: StagedRead): void;
  methodsVersion(): number | null;
  journalMethod(version: number): void;
  requestRead(): void;
}

export type ReadRefusal = "unbound" | typeof SNAPSHOT_GONE | "mixed_snapshot" | "scope_mismatch" | "stale" | "malformed" | "incomplete" | "page_failed" | "scope_changed" | "generation_changed";

export type ReadOutcome =
  | { readonly committed: true; readonly snapshot: string; readonly denials: number; readonly liftsRefused: number }
  | { readonly committed: false; readonly reason: ReadRefusal; readonly denials: number };

export const SNAPSHOT_MAX_PAGES = 20;

export async function readSnapshot(
  fetchPage: (cursor: { snapshot: string | null; page: number }) => Promise<PageAnswer>,
  ports: SnapshotPorts,
  maxPages = SNAPSHOT_MAX_PAGES,
): Promise<ReadOutcome> {
  const noted = ports.scope();
  let denials = 0;
  let raised = 0;
  const refused = (reason: ReadRefusal): ReadOutcome => ({ committed: false, reason, denials });
  if (noted === null) return refused("unbound");
  const deny = async (record: unknown) => {
    denials++;
    if (await ports.deny(record)) raised++;
  };

  const pages: AccountSnapshotPage[] = [];
  const adds: unknown[] = [];
  for (let index = 0; ; index++) {
    if (index === maxPages) return refused("incomplete");
    let answer: PageAnswer;
    try { answer = await fetchPage({ snapshot: pages[0]?.snapshot ?? null, page: index }); } catch { return refused("page_failed"); }
    if ("snapshot_gone" in answer) return refused(SNAPSHOT_GONE);
    let page: AccountSnapshotPage;
    try { page = parseSnapshotPage(answer.page); } catch (error) {
      if (error instanceof AccountSnapshotError) return refused("malformed");
      throw error;
    }
    if (page.account !== noted.account || page.server_id !== noted.serverId) return refused("scope_mismatch");
    const first = pages[0];
    if (first === undefined) {
      const last = ports.lastVersion();
      if (last !== null && page.version < last) return refused("stale");
    } else if (page.snapshot !== first.snapshot || page.version !== first.version || page.methods_version !== first.methods_version) {
      return refused("mixed_snapshot");
    }
    if (page.page !== index) return refused("malformed");
    pages.push(page);
    for (const block of page.blocks) await deny(block);
    for (const record of answer.records ?? []) {
      const kind = ports.classify(record);
      if (kind === "denial") await deny(record);
      else if (kind === "add") adds.push(record);
    }
    if (page.last) break;
  }

  let snapshot: AccountSnapshot;
  try { snapshot = assembleSnapshot(pages, { account: noted.account, server_id: noted.serverId, lastApplied: ports.lastVersion(), knownBlocks: ports.knownBlocks() }); } catch (error) {
    if (error instanceof AccountSnapshotError) return refused("malformed");
    throw error;
  }

  const authorized: DeviceLiftRecord[] = [];
  for (const lift of snapshot.lifts) if (await ports.liftAuthority(lift)) authorized.push(lift);

  // the commit turn: nothing below awaits, so no denial can land between these checks and the write
  const now = ports.scope();
  if (now === null || now.account !== noted.account || now.serverId !== noted.serverId || now.lock !== noted.lock) return refused("scope_changed");
  if (now.gen !== noted.gen + raised) return refused("generation_changed");
  ports.commit({ snapshot, adds, lifts: authorized });
  if (ports.methodsVersion() !== snapshot.methods_version) ports.journalMethod(snapshot.methods_version);
  return { committed: true, snapshot: snapshot.snapshot, denials, liftsRefused: snapshot.lifts.length - authorized.length };
}

export type HandedOutcome =
  | { readonly id: string | null; readonly outcome: "applied" | "unchanged" | "staged" }
  | { readonly id: string | null; readonly outcome: "refused"; readonly code: "record_invalid" };

const idOf = (record: unknown): string | null => {
  const id = typeof record === "object" && record !== null ? (record as { id?: unknown }).id : undefined;
  return typeof id === "string" ? id : null;
};

/**
 * Records handed to the PC directly (POST /api/account/records, a device's own session). A denial applies at once;
 * an add or a lift is never applied as handed: it asks for a whole read, which commits it only if that snapshot
 * carries it (T15, T52).
 */
export async function handRecords(records: readonly unknown[], ports: Pick<SnapshotPorts, "classify" | "deny" | "requestRead">): Promise<HandedOutcome[]> {
  const outcomes: HandedOutcome[] = [];
  let staged = false;
  for (const record of records) {
    const kind = ports.classify(record);
    const id = idOf(record);
    if (kind === "denial") outcomes.push({ id, outcome: await ports.deny(record) ? "applied" : "unchanged" });
    else if (kind === "invalid") outcomes.push({ id, outcome: "refused", code: "record_invalid" });
    else { staged = true; outcomes.push({ id, outcome: "staged" }); }
  }
  if (staged) ports.requestRead();
  return outcomes;
}

/**
 * What a sign-in this PC refused carries back (T60). Every refusal asks for the catch-up read. Receipts go only to a
 * session that proved a key this PC's order table holds, and come from this PC's own log, never from the mailbox.
 */
export function refusalReceipts(key: string, proved: boolean, ports: { requestRead(): void; ordered(key: string): boolean; receipts(key: string): readonly BlockReceipt[] }): readonly BlockReceipt[] {
  ports.requestRead();
  if (!proved || !ports.ordered(key)) return [];
  return ports.receipts(key);
}
