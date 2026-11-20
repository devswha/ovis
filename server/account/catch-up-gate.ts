/**
 * The wait after a start (Step 2, rows P7, T41, T42, T65, T70) for devices.json rows: a block may have been signed while
 * the PC was off, so on a PC in an account every row whose key was not approved on this PC's screen waits for the first
 * whole read. Binding the PC to an account starts the same wait. Credential access from pre-Step-2 rows can
 * continue during the one durable migration window or after an explicit service opt-out. Neither is a whole read.
 * Otherwise a restart starts the wait again. `ovis recover` can release named rows (S2-15).
 */
import type { AdmissionOrigin } from "../../shared/account-snapshot.ts";

export interface GatedRow {
  readonly id: string;
  readonly origin: AdmissionOrigin | undefined;
}

/** A key approved on this PC's own screen by code, digits or QR (P7 (b)); a confirm (T68) or a link moves no row out. */
const SCREEN_PAIRED: readonly string[] = ["code", "digits", "qr"];
const pairedAtPc = (origin: AdmissionOrigin | undefined): boolean => origin?.from === "pc" && SCREEN_PAIRED.includes(origin.how);

export class CatchUpGate {
  /** The binding the last whole read was for: a new binding waits for a read of its own (T59). */
  private caughtUpFor: string | null = null;
  private step2OffFor: string | null = null;
  /** A lift changes the next read's decision, never the result of the previous one. */
  private waiting: ReadonlySet<string> = new Set();
  private readonly frozenByTarget = new Map<string, Set<string>>();
  private readonly lifted = new Set<string>();

  /** `binding`: this PC's binding id now, null in no account, where nobody waits (no block can name it). */
  constructor(private readonly binding: () => string | null, private readonly released: (id: string) => boolean = () => false,
    private readonly firstActivation: () => boolean = () => false) {}

  waits(row: GatedRow, credential = true): boolean {
    const binding = this.binding();
    if (binding === null || this.released(row.id)) return false;
    if (this.lifted.has(row.id)) return true;
    if (pairedAtPc(row.origin)) return false;
    if (this.caughtUpFor === binding) return this.waiting.has(row.id);
    return !credential || row.origin?.from !== "legacy" || !(this.step2OffFor === binding || this.firstActivation());
  }

  /** Only T50's pre-Step-2 rows are excused, never a row judged unsafe by a read or waiting after a lift. */
  step2Off(): void { this.step2OffFor = this.binding(); }

  /** T42: record the rows that the whole read's admission check refused. */
  wholeRead(refused: readonly string[] = []): void {
    this.caughtUpFor = this.binding();
    this.step2OffFor = null;
    this.waiting = new Set(refused);
    this.lifted.clear();
  }

  /** The lift identifies its target key, not the newer rows this block froze between reads. */
  noteFreeze(target: string, ids: readonly string[]): void {
    const affected = this.frozenByTarget.get(target) ?? new Set<string>();
    for (const id of ids) affected.add(id);
    this.frozenByTarget.set(target, affected);
  }

  waitAfterLift(target: string, rows: readonly string[]): ReadonlySet<string> {
    const affected = new Set([...this.endFreeze(target), ...rows]);
    for (const id of affected) this.lifted.add(id);
    return affected;
  }

  endFreeze(target: string): ReadonlySet<string> {
    const affected = this.frozenByTarget.get(target) ?? new Set<string>();
    this.frozenByTarget.delete(target);
    return affected;
  }
}
