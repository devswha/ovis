/**
 * The wait after a start (Step 2, rows P7, T41, T42, T65, T70) for devices.json rows: a block may have been signed while
 * the PC was off, so on a PC in an account every row whose key was not approved on this PC's screen waits for the first
 * whole read, with no time limit and whatever metadata it carries (legacy rows too). Binding the PC to an account starts
 * the same wait. `ovis recover` may release rows by name until that read judges them again. All of it is in memory: a
 * restart starts the wait again and forgets every release.
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
  /** After a whole read, the admission guard (G3) that read asked: a row it refuses keeps waiting. */
  private guard: ((row: GatedRow) => boolean) | null = null;
  private readonly released = new Set<string>();

  /** `binding`: this PC's binding id now, null in no account, where nobody waits (no block can name it). */
  constructor(private readonly binding: () => string | null) {}

  waits(row: GatedRow): boolean {
    const binding = this.binding();
    if (binding === null || pairedAtPc(row.origin) || this.released.has(row.id)) return false;
    if (this.caughtUpFor !== binding) return true;
    return this.guard !== null && !this.guard(row);
  }

  /** T42: a whole read was applied; it ends the wait of every row `guard` admits, and every release ends with it. */
  wholeRead(guard?: (row: GatedRow) => boolean): void {
    this.caughtUpFor = this.binding();
    this.guard = guard ?? null;
    this.released.clear();
  }

  /** T70: `ovis recover` releases these rows from the wait until the next whole read; only rows that wait now. */
  release(ids: readonly string[], rowOf: (id: string) => GatedRow | undefined): string[] {
    const named = ids.filter((id) => {
      const row = rowOf(id);
      return row !== undefined && this.waits(row);
    });
    for (const id of named) this.released.add(id);
    return named;
  }
}
