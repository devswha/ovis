/**
 * The PC's safety log (rule R2, row P24 of the account-opens-all design): blocks, freezes, lifts, locks, unlocks and
 * forgettings in one append-only, numbered file of this PC's own state, `account-log.json`. Entries are only ever
 * appended: none is edited or deleted, and an ending is a record of the same log that names what it ends. What is in
 * force (locked, the blocks, the freezes, the markers of blocks) is worked out from the log alone, at every open, and
 * is never kept anywhere as a second truth.
 *
 * Fails closed (S19 in its strict form): a log that cannot be read, that is missing from a state folder that keeps a
 * device journal, or that holds one id with two records, makes `strict` say why; a strict log appends nothing, so the
 * file it could not read is never written over. Read only while OVIS_ACCOUNT_OPENS_ALL is on.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AccountRecordError, parseSafetyRecord, type PcLiftRecord, type SafetyRecord, type SafetyRecordKind } from "../../shared/account-records.ts";
import { writePrivateState } from "../private-state.ts";

export const SAFETY_LOG_FILE = "account-log.json";
/** The device journal (P15). A state folder that has one has had a log since, so a missing log there is damage. */
export const ACCOUNT_JOURNAL_FILE = "account-journal.json";

/** How the record reached this PC; noted once and never compared (P24). */
export type SafetyGot = "handed" | "mailbox" | "snapshot" | "pc" | "session" | "merge";

/** What this PC's own table said when a block arrived (P21), kept with the entry and never changed. */
export interface BlockAsOf {
  readonly signer_no: number | null;
  readonly target_no: number | null;
  readonly after: number | null;
  readonly joined: number | null;
  readonly signer_removed: boolean;
}

/**
 * An entry: the record whole as shared/account-records.ts parses it (a device-signed one with its signature, so its
 * signed bytes are those of the record and its id is their hash), and what this PC added once and never changes.
 */
export interface SafetyEntry {
  readonly n: number;
  readonly got: SafetyGot;
  readonly record: SafetyRecord;
  readonly asof?: BlockAsOf;
}

export type SafetyReceipt =
  | { outcome: "applied"; id: string; n: number }
  | { outcome: "already_applied"; id: string }
  | { outcome: "refused"; id: string; code: "record_invalid" | "conflict" | "log_unavailable" };

export interface SafetyState {
  readonly locked: boolean;
  readonly locks: readonly SafetyEntry[];
  readonly blocks: readonly SafetyEntry[];
  /** service freezes and blocks in force: each closes this PC to the keys newer than its target (P23) */
  readonly freezes: readonly SafetyEntry[];
  /** blocks whose marker stands: no lift that says `forget` names them, whether or not they are in force */
  readonly markers: readonly SafetyEntry[];
}

interface LogFile {
  v: 1;
  next: number;
  /** folded records, one line each with no number: an id in it is known and ended (P24) */
  base: { id: string }[];
  entries: SafetyEntry[];
  /** P19's waiting blocks (S2-10) */
  waiting: unknown[];
}

const GOTS: ReadonlySet<string> = new Set(["handed", "mailbox", "snapshot", "pc", "session", "merge"]);

/** The id of a record this PC writes: random, made then, in the form shared/account-records.ts accepts. */
export function pcRecordId(): string {
  return randomBytes(16).toString("hex");
}

const isNo = (value: unknown): boolean => value === null || (Number.isSafeInteger(value) && (value as number) >= 0);

/** Why `record` is no record of the log, or null: the shared parser decides, and a block keeps what this PC knew. */
function recordProblem(record: unknown, asof: BlockAsOf | undefined): string | null {
  let parsed: SafetyRecord;
  try { parsed = parseSafetyRecord(record); } catch (error) {
    if (error instanceof AccountRecordError) return error.message;
    throw error;
  }
  if (parsed.kind === "block") {
    if (asof === undefined) return "a block keeps what this PC knew when it arrived";
    const a = asof as unknown as Record<string, unknown>;
    if (typeof a !== "object" || a === null || Object.keys(a).length !== 5 || !isNo(a.signer_no) || !isNo(a.target_no) || !isNo(a.after) || !isNo(a.joined) || typeof a.signer_removed !== "boolean") return "invalid asof";
  } else if (asof !== undefined) return "only a block keeps asof";
  return null;
}

/** Two copies of one record: the same fields with the same values, whatever order JSON kept them in. */
function sameRecord(a: SafetyRecord, b: SafetyRecord): boolean {
  const canonical = (record: SafetyRecord) => JSON.stringify(Object.entries(record).sort(([x], [y]) => x < y ? -1 : x > y ? 1 : 0));
  return canonical(a) === canonical(b);
}

function parseLog(value: unknown): LogFile | string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "it is not a log";
  const file = value as Partial<LogFile>;
  if (file.v !== 1) return "unknown version";
  if (!Number.isSafeInteger(file.next) || file.next! < 1) return "invalid next";
  if (!Array.isArray(file.base) || !file.base.every((line) => typeof line === "object" && line !== null && typeof line.id === "string")) return "invalid base";
  if (!Array.isArray(file.entries) || !Array.isArray(file.waiting)) return "invalid entries";
  const seen = new Map<string, SafetyRecord>();
  const numbers = new Set<number>();
  for (const id of file.base.map((line) => line.id)) seen.set(id, { id } as SafetyRecord);
  for (const entry of file.entries as SafetyEntry[]) {
    if (typeof entry !== "object" || entry === null) return "an entry is an object";
    if (!Number.isSafeInteger(entry.n) || entry.n < 1 || entry.n >= file.next! || numbers.has(entry.n)) return `entry number ${String(entry.n)} is taken twice or past next`;
    numbers.add(entry.n);
    if (!GOTS.has(entry.got)) return "invalid got";
    const problem = recordProblem(entry.record, entry.asof);
    if (problem !== null) return `entry ${entry.n}: ${problem}`;
    const known = seen.get(entry.record.id);
    // one id with two records is a damaged log; the same record twice is one record that was written twice
    if (known !== undefined) return `the id ${entry.record.id} is held ${sameRecord(known, entry.record) ? "twice" : "by two different records"}`;
    seen.set(entry.record.id, entry.record);
  }
  return file as LogFile;
}

export class SafetyLog {
  private file: LogFile = { v: 1, next: 1, base: [], entries: [], waiting: [] };
  private readError: string | null = null;
  private writeError: string | null = null;

  private constructor(private readonly path: string) {}

  /** Reads and replays the log of `stateDir`. Never throws: a log that cannot be trusted makes `strict` say why. */
  static open(stateDir: string): SafetyLog {
    const log = new SafetyLog(join(stateDir, SAFETY_LOG_FILE));
    let text: string;
    try { text = readFileSync(log.path, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") log.readError = `Cannot read ${log.path} (${(error as NodeJS.ErrnoException).code ?? String(error)})`;
      else if (existsSync(join(stateDir, ACCOUNT_JOURNAL_FILE))) log.readError = `${log.path} is missing beside the device journal`;
      return log;
    }
    let value: unknown;
    try { value = JSON.parse(text); } catch { log.readError = `${log.path} is not JSON`; return log; }
    const parsed = parseLog(value);
    if (typeof parsed === "string") log.readError = `${log.path} cannot be trusted: ${parsed}`;
    else log.file = parsed;
    return log;
  }

  /**
   * Why this PC fails closed, or null: nothing but this PC itself signs in until the log is put right. A failed append
   * counts until an append is written.
   */
  get strict(): string | null {
    const why = this.readError ?? this.writeError;
    return why === null ? null : `${why}: only this PC itself gets in until the account safety log is restored.`;
  }

  entries(): readonly SafetyEntry[] { return this.file.entries; }

  /** The receipt of a record this log holds (T51): the same `applied` as often as it is asked, until it is folded. */
  receipt(id: string): SafetyReceipt | null {
    const entry = this.file.entries.find((candidate) => candidate.record.id === id);
    if (entry !== undefined) return { outcome: "applied", id, n: entry.n };
    return this.file.base.some((line) => line.id === id) ? { outcome: "already_applied", id } : null;
  }

  /**
   * Appends one record with the next number, on disk before it counts. A record this log already holds answers its
   * receipt and appends nothing; another record under a known id is refused, and the log keeps what it holds.
   */
  append(input: { record: SafetyRecord; got: SafetyGot; asof?: BlockAsOf }): SafetyReceipt {
    const { record, got, asof } = input;
    const id = typeof record?.id === "string" ? record.id : "";
    if (this.readError !== null) return { outcome: "refused", id, code: "log_unavailable" };
    if (!GOTS.has(got) || recordProblem(record, asof) !== null) return { outcome: "refused", id, code: "record_invalid" };
    const held = this.file.entries.find((entry) => entry.record.id === id);
    if (held !== undefined) return sameRecord(held.record, record) ? { outcome: "applied", id, n: held.n } : { outcome: "refused", id, code: "conflict" };
    if (this.file.base.some((line) => line.id === id)) return { outcome: "already_applied", id };
    const entry: SafetyEntry = { n: this.file.next, got, record: { ...record }, ...(asof === undefined ? {} : { asof: { ...asof } }) };
    const next: LogFile = { ...this.file, next: this.file.next + 1, entries: [...this.file.entries, entry] };
    try { writePrivateState(this.path, next); } catch (error) {
      this.writeError = `Cannot write ${this.path} (${error instanceof Error ? error.message : String(error)})`;
      return { outcome: "refused", id, code: "log_unavailable" };
    }
    this.file = next;
    this.writeError = null;
    return { outcome: "applied", id, n: entry.n };
  }

  /** What is in force, worked out from the log alone. Each ending ends only the record it names, and only of its kind. */
  state(): SafetyState {
    const lifted = new Set<string>();
    const forgotten = new Set<string>();
    const unlocked = new Set<string>();
    for (const { record } of this.file.entries) {
      if (record.kind === "lift") {
        lifted.add(record.target);
        if (record.signer === "pc" && (record as PcLiftRecord).forget) forgotten.add(record.target);
      } else if (record.kind === "unlock") unlocked.add(record.target);
    }
    const byN = [...this.file.entries].sort((a, b) => a.n - b.n);
    const of = (kind: SafetyRecordKind) => byN.filter((entry) => entry.record.kind === kind);
    const locks = of("lock").filter((entry) => !unlocked.has(entry.record.id));
    const blocks = of("block").filter((entry) => !lifted.has(entry.record.id));
    const serviceFreezes = of("freeze").filter((entry) => !lifted.has(entry.record.id.slice(2)));
    return {
      locked: locks.length > 0,
      locks,
      blocks,
      freezes: [...blocks, ...serviceFreezes].sort((a, b) => a.n - b.n),
      markers: of("block").filter((entry) => !forgotten.has(entry.record.id)),
    };
  }
}
