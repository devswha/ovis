/**
 * Account-joined rows (Step 2, rows P1, S21, S23, T34, T35, T44, T49): devices the account's list admits, kept in
 * `account-devices.json` and never in devices.json, so an older Ovis that reads only devices.json never lets one in.
 * The list only admits what the guards admit and only drops what it no longer names; it writes no tombstone and no
 * marker. Order: an admission is journalled before its row is written and the row waits in `hold` until the join
 * hold is satisfied; a drop closes sessions first, then journals, then writes.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { accountDeviceId } from "../../shared/account-records.ts";
import { AccountSnapshotError, parseAccountDevicesFile, type AccountJoinedRow, type AccountSnapshot, type AdmissionOrigin, type SnapshotDevice } from "../../shared/account-snapshot.ts";
import { writePrivateState } from "../private-state.ts";
import type { RemovalEvidence } from "./removal-evidence.ts";
import { rowDrop, type RowDrop } from "./row-drop-evidence.ts";

export const ACCOUNT_DEVICES_FILE = "account-devices.json";
export const ACCOUNT_DEVICES_MAX = 100;

const iso = (at: number): string => new Date(at).toISOString();

export type DropReason = "list" | "left_on_pc" | "revoke_all" | "identity_reset" | "remove" | "block" | "revoke";

/**
 * What Track A's deny path (DeviceStore.attachAccountRows, set only with OVIS_ACCOUNT_OPENS_ALL=1) asks of the
 * account-joined rows: they are target and signer candidates of blocks, removes and Revokes like devices.json rows.
 * Removal detaches the whole batch before notifying session owners or writing the journal (P8 step 3).
 */
export interface AccountRowSource {
  /** Why `account-devices.json` cannot be used. A file that will not read is never empty (S19, T41). */
  blocked(): string | null;
  /** No `account-devices.json` on disk: no listed row is known here, which is not proof that none was. */
  missing(): boolean;
  rows(): readonly AccountRow[];
  row(id: string): AccountRow | null;
  rowsByKey(key: string): readonly AccountRow[];
  access(id: string): AccessAnswer;
  pruneDenied(evidence: RemovalEvidence, legacyRevoke?: "revoke_all"): void;
  removeRows(ids: readonly string[], reason: Exclude<DropReason, "list">, close?: (id: string) => void): void;
}

export type AccountRow = AccountJoinedRow;

/** A whole read's list, as S2-24's commit hands it over. */
export type ListCommit = Pick<AccountSnapshot, "account" | "snapshot" | "version" | "devices" | "removed">;

export interface JournalEntry extends Pick<SnapshotDevice, "provider" | "two_step"> {
  readonly kind: "admit" | "drop";
  readonly key: string;
  readonly row: string;
  readonly account: string | null;
  readonly drop?: RowDrop | undefined;
  readonly no?: number;
  readonly label?: string;
  readonly reason?: DropReason;
}

export type AccessAnswer = { readonly ok: true } | { readonly refused: "join_hold"; readonly seconds: number | null } | { readonly refused: "not_listed" };

export interface AccountRowPorts {
  readonly evidence?: RemovalEvidence;
  /** On disk when it returns; a drop already recorded for this admission is not repeated. */
  journal(entry: JournalEntry): void;
  closeSessions(rowId: string, reason: DropReason): void;
  /** P2: a key a devices.json row holds stays there. */
  heldByDevicesJson(key: string): boolean;
  /** Every admission guard of the commit turn (G2 to G15) for this key, now. */
  admits(key: string, account: string): boolean;
  now(): number;
  /**
   * Numbers one admission on this PC and returns its origin (PcAccountState.admit in pc-binding.ts, P12, P22): its
   * `admit_no` is the age every PC decision compares.
   */
  admitOrigin(at: number): AdmissionOrigin;
}

/** The file in memory: `account` and `snapshot` are null only in the cleared state, which holds no rows. */
interface DevicesFile {
  account: string | null;
  snapshot: string | null;
  version: number;
  devices: AccountRow[];
}

const CLEARED: DevicesFile = { account: null, snapshot: null, version: 1, devices: [] };

function load(path: string, serverId: string): { file: DevicesFile; error: string | null; foreign?: true } {
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { file: CLEARED, error: null };
    return { file: CLEARED, error: `Cannot read ${path}: account-joined devices are refused until it is restored or fixed.` };
  }
  try {
    const file = parseAccountDevicesFile(value);
    // rows admitted under another relay identity name another PC: none of them is a row here
    return { file: { account: file.account, snapshot: file.snapshot, version: file.version, devices: [...file.devices] }, error: null,
      ...(file.server_id !== serverId ? { foreign: true } : {}) };
  } catch (error) {
    if (!(error instanceof AccountSnapshotError)) throw error;
    return { file: CLEARED, error: `${path} is not an account devices file (${error.message}): account-joined devices are refused until it is fixed.` };
  }
}

export class AccountDeviceStore implements AccountRowSource {
  readonly error: string | null;
  private readonly path: string;
  private file: DevicesFile;
  private readonly pendingDrops: JournalEntry[] = [];

  constructor(stateDir: string, private readonly serverId: string, private readonly ports: AccountRowPorts) {
    this.path = join(stateDir, ACCOUNT_DEVICES_FILE);
    const { file, error, foreign } = load(this.path, serverId);
    this.file = foreign ? CLEARED : file;
    this.error = error ?? (foreign ? ports.evidence?.strict ?? null : null);
    // Never serve a foreign row. Finish its old admission before replacing the only copy on disk.
    if (foreign && this.error === null) {
      for (const row of file.devices) {
        const reason = this.recoveryReason(row, file.account, ports.evidence);
        if (reason !== null) ports.journal(this.dropEntry(row, file.account, reason));
      }
      this.write(CLEARED);
    }
  }

  blocked(): string | null { return this.error; }

  missing(): boolean { return !existsSync(this.path); }

  rows(): readonly AccountRow[] { return this.error === null ? this.file.devices : []; }

  row(id: string): AccountRow | null {
    return this.rows().find((row) => row.id === id) ?? null;
  }

  rowsByKey(key: string): readonly AccountRow[] {
    return this.rows().filter((row) => row.key === key);
  }

  /** Startup replay: finish the journal before the registry. There are no sessions to close yet. */
  pruneDenied(evidence: RemovalEvidence, legacyRevoke?: "revoke_all"): void {
    const { account, devices } = this.file;
    if (account === null) return;
    const kept = devices.filter(row => {
      const reason = this.recoveryReason(row, account, evidence, legacyRevoke);
      if (reason === null) return true;
      this.ports.journal(this.dropEntry(row, account, reason));
      return false;
    });
    if (kept.length !== devices.length) this.write({ ...this.file, devices: kept });
  }

  private recoveryReason(row: AccountRow, account: string | null, evidence?: RemovalEvidence, legacyRevoke?: "revoke_all") {
    const own = evidence?.dropFor(row.id, row.origin.admit_no);
    if (own) return own.how;
    const reason = account === null ? null : evidence?.accountRowDrop(row.key, account) ?? null;
    return reason === "revoke" ? legacyRevoke ?? reason : reason;
  }

  private dropEntry(row: AccountRow, account: string | null, reason: DropReason): JournalEntry {
    const drop = reason === "remove" || reason === "block" || reason === "revoke" || reason === "revoke_all" ? rowDrop(row, reason) : undefined;
    return { kind: "drop", row: row.id, key: row.key, account, reason, drop };
  }

  removeRows(ids: readonly string[], reason: Exclude<DropReason, "list">, close?: (id: string) => void): void {
    this.usable();
    this.drop(this.file.devices.filter(row => ids.includes(row.id)), reason, close);
  }

  live(id: string): boolean {
    return this.rows().some((row) => row.id === id && row.state === "live");
  }

  /** Whether row `id` may sign in now: a held row waits for its join hold, which S2-29 ends. */
  access(id: string): AccessAnswer {
    const row = this.rows().find((candidate) => candidate.id === id);
    if (!row) return { refused: "not_listed" };
    return row.state === "live" ? { ok: true } : { refused: "join_hold", seconds: null };
  }

  /** Applies a whole read's list: drops what it no longer names, then admits what it newly names and the guards let in. */
  commitList(list: ListCommit): { admitted: string[]; dropped: string[] } {
    this.usable();
    const removed = new Set(list.removed.map((gone) => gone.key));
    const eligible = new Map(list.devices.filter((entry) => entry.eligible && !removed.has(entry.key)).map((entry) => [entry.key, entry]));
    const sameAccount = this.file.account === null || this.file.account === list.account;
    const leaving = this.file.devices.filter((row) => !sameAccount || !eligible.has(row.key));
    const dropped = this.drop(leaving, "list", this.ports.closeSessions);

    // rows admitted from here on belong to this read's account and snapshot
    this.write({ ...this.file, account: list.account, snapshot: list.snapshot, version: list.version });

    const admitted: string[] = [];
    for (const entry of eligible.values()) {
      if (this.file.devices.length >= ACCOUNT_DEVICES_MAX) break;
      if (this.file.devices.some((row) => row.key === entry.key)) continue;
      if (this.ports.heldByDevicesJson(entry.key) || !this.ports.admits(entry.key, list.account)) continue;
      this.admit(entry);
      admitted.push(entry.key);
    }
    return { admitted, dropped };
  }

  /** The PC's account was cleared or its relay identity reset (T44): every account-joined row goes. */
  clear(reason: Exclude<DropReason, "list">): void {
    this.usable();
    this.drop(this.file.devices, reason, this.ports.closeSessions);
    this.write({ ...this.file, account: null, snapshot: null });
  }

  private admit(entry: SnapshotDevice): void {
    const now = this.ports.now();
    const row: AccountRow = {
      id: accountDeviceId(this.serverId, entry.key), key: entry.key, no: entry.no, label: entry.label,
      origin: this.ports.admitOrigin(now),
      confirmed_at: iso(now), last_signin_day: null, state: "hold", hold_until: null,
    };
    this.ports.journal({ kind: "admit", key: row.key, row: row.id, account: this.file.account, no: row.no, label: row.label,
      two_step: entry.two_step ?? "unknown", ...(entry.provider === undefined ? {} : { provider: entry.provider }) });
    this.write({ ...this.file, devices: [...this.file.devices, row] });
  }

  private drop(rows: readonly AccountRow[], reason: DropReason, close?: AccountRowPorts["closeSessions"]): string[] {
    if (rows.length === 0) return [];
    const ids = new Set(rows.map((row) => row.id));
    this.file = { ...this.file, devices: this.file.devices.filter(row => !ids.has(row.id)) };
    // A durable deny can finish these drops at startup. Until journalled, not even
    // a later registry write in this process may erase the rows needed for replay.
    const replayable = reason === "revoke" || reason === "remove" || reason === "block" || reason === "revoke_all";
    const entries = rows.map(row => this.dropEntry(row, this.file.account, reason));
    if (replayable) this.pendingDrops.push(...entries);
    for (const row of rows) close?.(row.id, reason);
    let failure: Error | undefined;
    for (const entry of replayable ? [] : entries) {
      try { this.ports.journal(entry); }
      catch (error) { failure ??= error instanceof Error ? error : new Error(String(error)); }
    }
    this.write(this.file);
    if (failure) throw failure;
    return rows.map((row) => row.key);
  }

  private usable(): void {
    if (this.error !== null) throw new Error(this.error);
  }

  private write(next: DevicesFile): void {
    for (let entry = this.pendingDrops[0]; entry; entry = this.pendingDrops[0]) {
      this.ports.journal(entry);
      this.pendingDrops.shift();
    }
    writePrivateState(this.path, { v: 1, server_id: this.serverId, ...next });
    this.file = next;
  }
}

/**
 * The account rows of whichever relay identity this PC has now: the store is opened for that identity's server id on
 * first use and opened again when the identity changes, so rows written for another identity are never rows here.
 */
export function accountRowsFor(stateDir: string, serverId: () => string | null, ports: AccountRowPorts): AccountRowSource & { store(): AccountDeviceStore | null } {
  let open: { serverId: string; store: AccountDeviceStore } | null = null;
  const store = (): AccountDeviceStore | null => {
    const id = serverId();
    if (id === null) return null;
    if (open?.serverId !== id) {
      // the rows of the identity this PC had end here: their sessions close, and the file is the new identity's (T44)
      if (open !== null) {
        open.store.clear("identity_reset");
      }
      open = { serverId: id, store: new AccountDeviceStore(stateDir, id, ports) };
    }
    return open.store;
  };
  return {
    store,
    blocked: () => store()?.blocked() ?? null,
    missing: () => store()?.missing() ?? false,
    rows: () => store()?.rows() ?? [],
    row: (id) => store()?.row(id) ?? null,
    rowsByKey: (key) => store()?.rowsByKey(key) ?? [],
    access: (id) => store()?.access(id) ?? { refused: "not_listed" },
    pruneDenied: (evidence, legacyRevoke) => { store()?.pruneDenied(evidence, legacyRevoke); },
    removeRows: (ids, reason, close) => { store()?.removeRows(ids, reason, close); },
  };
}
