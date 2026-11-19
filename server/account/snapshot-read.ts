/**
 * One whole read of the account's snapshot (Step 2, rows G1, G13, T15, T52, T58, T60). Every page must carry the
 * first page's snapshot id, for this PC's account and relay identity, and the last page says it is the last. Denials
 * (blocks, removes) only narrow, so each applies as it is read and stands whatever happens to the read. Everything
 * that widens (adds, lifts, the list itself) is staged and committed only when the whole read validated, in one turn
 * with no wait inside, and only while `gen` moved by nothing but this read's own denials.
 *
 * The page shape and the ports are local until the S2-00 contract (shared/account-snapshot.ts) lands; the mailbox
 * adapts both.
 */

export interface SnapshotPage {
  readonly snapshot: string;
  readonly account: string;
  readonly server_id: string;
  readonly version: number;
  readonly last: boolean;
  readonly methods_version: number;
  readonly devices: readonly unknown[];
  readonly removed: readonly unknown[];
  readonly records: readonly unknown[];
  readonly freeze_lines: readonly unknown[];
}

export type PageAnswer = SnapshotPage | { readonly snapshot_gone: true };

/** What a read is judged under: noted when it starts and asked again in the commit turn. */
export interface ReadScope {
  readonly account: string;
  readonly serverId: string;
  readonly gen: number;
  readonly lock: string | null;
}

export interface StagedRead {
  readonly snapshot: string;
  readonly version: number;
  readonly methodsVersion: number;
  readonly devices: readonly unknown[];
  readonly removed: readonly unknown[];
  readonly freezeLines: readonly unknown[];
  readonly adds: readonly unknown[];
  readonly lifts: readonly unknown[];
}

export type RecordClass = "denial" | "lift" | "add" | "invalid";

export interface SnapshotPorts {
  /** The binding, relay identity, `gen` and lock now; null for a PC in no account. */
  scope(): ReadScope | null;
  /** The version of the last snapshot this PC applied. */
  lastVersion(): number;
  classify(record: unknown): RecordClass;
  /** Applies a block or a remove now; true when it raised `gen`. */
  deny(record: unknown): Promise<boolean>;
  /** This PC's own age authority for a lift the service took: its signer is older here than the blocked key. */
  liftAuthority(lift: unknown): boolean;
  /** Synchronous: every guard again, then the journal, the files and memory, in one turn. */
  commit(stage: StagedRead): void;
  methodsVersion(): number | null;
  journalMethod(version: number): void;
  requestRead(): void;
}

export type ReadRefusal = "unbound" | "snapshot_gone" | "mixed_snapshot" | "scope_mismatch" | "stale" | "malformed" | "incomplete" | "page_failed" | "scope_changed" | "generation_changed";

export type ReadOutcome =
  | { readonly committed: true; readonly snapshot: string; readonly denials: number; readonly liftsRefused: number }
  | { readonly committed: false; readonly reason: ReadRefusal; readonly denials: number };

export const SNAPSHOT_MAX_PAGES = 20;

const PARTS = ["devices", "removed", "records", "freeze_lines"] as const;

function wellFormed(page: unknown): page is SnapshotPage {
  if (typeof page !== "object" || page === null) return false;
  const value = page as Record<string, unknown>;
  return typeof value["snapshot"] === "string" && value["snapshot"] !== ""
    && typeof value["account"] === "string" && typeof value["server_id"] === "string"
    && Number.isSafeInteger(value["version"]) && Number.isSafeInteger(value["methods_version"])
    && typeof value["last"] === "boolean"
    && PARTS.every((part) => Array.isArray(value[part]));
}

const gone = (answer: unknown): boolean => typeof answer === "object" && answer !== null && (answer as { snapshot_gone?: unknown }).snapshot_gone === true;

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

  let first: SnapshotPage | null = null;
  const devices: unknown[] = [];
  const removed: unknown[] = [];
  const freezeLines: unknown[] = [];
  const adds: unknown[] = [];
  const lifts: unknown[] = [];
  for (let index = 0; ; index++) {
    if (index === maxPages) return refused("incomplete");
    let answer: PageAnswer;
    try { answer = await fetchPage({ snapshot: first?.snapshot ?? null, page: index }); } catch { return refused("page_failed"); }
    if (gone(answer)) return refused("snapshot_gone");
    if (!wellFormed(answer)) return refused("malformed");
    if (answer.account !== noted.account || answer.server_id !== noted.serverId) return refused("scope_mismatch");
    if (first === null) {
      if (answer.version < ports.lastVersion()) return refused("stale");
      first = answer;
    } else if (answer.snapshot !== first.snapshot || answer.version !== first.version || answer.methods_version !== first.methods_version) {
      return refused("mixed_snapshot");
    }
    for (const record of answer.records) {
      const kind = ports.classify(record);
      if (kind === "denial") {
        denials++;
        if (await ports.deny(record)) raised++;
      } else if (kind === "lift") lifts.push(record);
      else if (kind === "add") adds.push(record);
    }
    devices.push(...answer.devices);
    removed.push(...answer.removed);
    freezeLines.push(...answer.freeze_lines);
    if (answer.last) break;
  }

  // the commit turn: nothing below awaits, so no denial can land between these checks and the write
  const now = ports.scope();
  if (now === null || now.account !== noted.account || now.serverId !== noted.serverId || now.lock !== noted.lock) return refused("scope_changed");
  if (now.gen !== noted.gen + raised) return refused("generation_changed");
  const authorized = lifts.filter((lift) => ports.liftAuthority(lift));
  ports.commit({ snapshot: first.snapshot, version: first.version, methodsVersion: first.methods_version, devices, removed, freezeLines, adds, lifts: authorized });
  if (ports.methodsVersion() !== first.methods_version) ports.journalMethod(first.methods_version);
  return { committed: true, snapshot: first.snapshot, denials, liftsRefused: lifts.length - authorized.length };
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

export interface Receipt {
  readonly id: string;
  readonly outcome: "applied" | "already_applied";
  readonly n?: number;
}

/**
 * What a sign-in this PC refused carries back (T60). Every refusal asks for the catch-up read. Receipts go only to a
 * session that proved a key this PC's order table holds, and come from this PC's own log, never from the mailbox.
 */
export function refusalReceipts(key: string, proved: boolean, ports: { requestRead(): void; ordered(key: string): boolean; receipts(key: string): readonly Receipt[] }): readonly Receipt[] {
  ports.requestRead();
  if (!proved || !ports.ordered(key)) return [];
  return ports.receipts(key);
}
