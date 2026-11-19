import type { StoredDevice } from "../devices.ts";
import { JOIN_HOLD_MS, holdSecondsLeft } from "./join-hold.ts";

/** The notice ID survives on the member row. Deadlines deliberately belong to this running process only. */
export class PromotedHolds {
  private readonly deadlines = new Map<string, number>();

  constructor(private readonly admits: (key: string) => boolean, private readonly release: (row: StoredDevice) => void) {}

  carry(notice: string, until: string | null): void {
    if (until !== null) this.deadlines.set(notice, Date.parse(until));
  }

  /** Called only at a whole read's commit, after its denials. Further reads leave running clocks alone. */
  resume(rows: readonly StoredDevice[], now: number): void {
    for (const row of rows) {
      if (row.held && !this.deadlines.has(row.held) && row.relay_public_key && this.admits(row.relay_public_key)) this.deadlines.set(row.held, now + JOIN_HOLD_MS);
    }
  }

  running(notice: string): boolean { return this.deadlines.has(notice); }
  forget(notice: string): void { this.deadlines.delete(notice); }

  refusal(row: StoredDevice, now: number) {
    if (!row.held) return null;
    const until = this.deadlines.get(row.held) ?? null;
    const seconds = holdSecondsLeft(until, now);
    if (seconds !== 0) return { refused: { refused: "join_hold" as const, seconds }, holdUntil: until === null ? null : new Date(until).toISOString() };
    if (!row.relay_public_key || !this.admits(row.relay_public_key)) return { refused: { refused: "admission" as const }, holdUntil: null };
    this.release(row);
    return null;
  }
}
