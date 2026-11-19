/**
 * The account's order as this PC's whole reads saw it (Step 2, S2-24, P21): each key's number in the account, and whether
 * it was late, that is first seen in a whole read with a number not above the highest number seen before. A late key
 * was inserted into the account's order behind keys this PC already knew, so it is not trusted as older than them: it
 * lifts no block (T52) and ends no hold (T53). Written in the commit turn of a whole read. A file that cannot be read
 * leaves every key late and is never overwritten here, so a damaged table grants nothing.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writePrivateState } from "../private-state.ts";
import { accountDeviceId } from "../../shared/account-records.ts";

export const ACCOUNT_ORDER_FILE = "account-order.json";

interface OrderEntry { readonly no: number; readonly late: boolean }
interface OrderDoc {
  readonly v: 1;
  readonly account: string | null;
  readonly bind_id?: string;
  readonly server_id?: string;
  readonly last_version?: number;
  readonly methods_version?: number;
  readonly max_no: number;
  readonly keys: Readonly<Record<string, OrderEntry>>;
}

/** What a whole read lists, as the order needs it. */
export interface OrderedRead {
  readonly server_id: string;
  readonly version: number;
  readonly account: string;
  readonly devices: readonly { readonly key: string; readonly no: number }[];
  readonly removed: readonly { readonly key: string; readonly no: number }[];
}

const EMPTY: OrderDoc = { v: 1, account: null, max_no: 0, keys: {} };

export class OrderConflict extends Error {
  constructor(readonly key: string) { super("Snapshot changes a pinned account number"); }
}

function parse(value: unknown): OrderDoc | null {
  if (typeof value !== "object" || value === null) return null;
  const doc = value as Partial<OrderDoc>;
  if (doc.v !== 1 || !(doc.account === null || typeof doc.account === "string") || !Number.isSafeInteger(doc.max_no) || typeof doc.keys !== "object" || doc.keys === null) return null;
  if (doc.last_version !== undefined || doc.bind_id !== undefined || doc.server_id !== undefined) {
    if (typeof doc.bind_id !== "string" || typeof doc.server_id !== "string" || typeof doc.last_version !== "number" || !Number.isSafeInteger(doc.last_version) || doc.last_version < 1) return null;
  }
  if (doc.methods_version !== undefined && (!Number.isSafeInteger(doc.methods_version) || doc.methods_version < 0)) return null;
  const valid = Object.values(doc.keys).every((entry) => Number.isSafeInteger(entry?.no) && typeof entry?.late === "boolean");
  return valid ? doc as OrderDoc : null;
}

export class AccountOrder {
  private constructor(private readonly path: string, private doc: OrderDoc, readonly problem: string | null) {}

  static open(stateDir: string): AccountOrder {
    const path = join(stateDir, ACCOUNT_ORDER_FILE);
    if (!existsSync(path)) return new AccountOrder(path, EMPTY, null);
    let doc: OrderDoc | null = null;
    try { doc = parse(JSON.parse(readFileSync(path, "utf8"))); } catch (error) {
      if (!(error instanceof SyntaxError) && !(error instanceof Error && "code" in error)) throw error;
    }
    return doc === null ? new AccountOrder(path, EMPTY, `${path} cannot be read: every key counts as late until it is restored`) : new AccountOrder(path, doc, null);
  }

  /** Whether \`key\` was first seen late in the account's order; every key while the table is damaged. */
  late(key: string): boolean {
    return this.problem !== null || (this.doc.keys[key]?.late ?? false);
  }

  /** The key's number in the account's order as this PC saw it, null for a key no whole read listed. */
  no(key: string): number | null {
    return this.doc.keys[key]?.no ?? null;
  }

  /** A rowless AUTH names the deterministic account device id, not a public key supplied by its caller. */
  relayKey(serverId: string, deviceId: string): string | undefined {
    return Object.keys(this.doc.keys).find((key) => accountDeviceId(serverId, key) === deviceId);
  }

  lastVersion(bindId: string | undefined, serverId: string | null): number | null {
    return this.doc.bind_id === bindId && this.doc.server_id === serverId ? this.doc.last_version ?? null : null;
  }

  methodsVersion(): number | null { return this.doc.methods_version ?? null; }

  /** Remember only a version whose notice the journal successfully appended. */
  recordMethod(version: number): void {
    const next = { ...this.doc, methods_version: version };
    writePrivateState(this.path, next);
    this.doc = next;
  }

  /** The commit turn of a whole read: new keys enter, marked late when their number is not above the highest seen. */
  record(read: OrderedRead, bindId: string): void {
    this.prepare(read, bindId)();
  }

  /** Validate before any widening; persist the watermark only after the other commit writes succeed. */
  prepare(read: OrderedRead, bindId: string): () => void {
    if (this.problem !== null) throw new Error(this.problem);
    const base = this.doc.account === read.account ? this.doc : { ...EMPTY, account: read.account };
    const known = Object.keys(base.keys).length > 0;
    const keys: Record<string, OrderEntry> = { ...base.keys };
    let max = base.max_no;
    const listed = [...read.devices, ...read.removed].sort((a, b) => a.no - b.no);
    for (const { key, no } of listed) {
      const pinned = keys[key];
      if (pinned === undefined) keys[key] = { no, late: known && no <= base.max_no };
      else if (pinned.no !== no) throw new OrderConflict(key);
    }
    for (const { no } of listed) max = Math.max(max, no);
    const next: OrderDoc = { ...base, bind_id: bindId, server_id: read.server_id, last_version: read.version, max_no: max, keys };
    return () => {
      writePrivateState(this.path, next);
      this.doc = next;
    };
  }
}
