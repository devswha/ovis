/**
 * What holds account `add`s back on this PC (docs/account.md, "Enrolling a PC"): the barrier a PC
 * keeps from its first link until the member that linked it hands over the account's devices, and
 * the keys that member could not let in (removed somewhere it checked). Both are on disk, so a stop
 * lifts neither, and a file that will not parse holds every add back until it is restored.
 */
import { readFileSync, rmSync } from "node:fs";
import { isAccountKey } from "../../shared/account-records.ts";
import { writePrivateState } from "../private-state.ts";

/** Keys held at most; past them every add is held back, as a full list could be missing the one that matters. */
export const ACCOUNT_HELD_MAX = 4096;

function readJson(path: string | undefined): { value: unknown } | null | "missing" {
  if (!path) return "missing";
  try { return { value: JSON.parse(readFileSync(path, "utf8")) as unknown }; } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : null;
  }
}

export class AccountHolds {
  /** Why the holds could not be read: every add waits until it is fixed. */
  readonly error: string | null = null;
  private enrollingBy: string | null = null;
  private keys = new Set<string>();
  private full = false;

  constructor(private readonly options: { enrollingPath?: string; heldPath?: string } = {}) {
    const enrolling = readJson(options.enrollingPath);
    const held = readJson(options.heldPath);
    if (enrolling === null || held === null) {
      this.error = "The account's held keys cannot be read: account adds wait until the file is restored or removed.";
      return;
    }
    if (enrolling !== "missing") {
      const by = (enrolling.value as { by?: unknown } | null)?.by;
      if (typeof by !== "string") { this.error = `${options.enrollingPath} is not an enrollment barrier.`; return; }
      this.enrollingBy = by;
    }
    if (held !== "missing") {
      const value = held.value as { keys?: unknown; full?: unknown } | null;
      if (!Array.isArray(value?.keys) || !value.keys.every(isAccountKey) || typeof value.full !== "boolean") { this.error = `${options.heldPath} is not a list of held keys.`; return; }
      this.keys = new Set(value.keys);
      this.full = value.full;
    }
  }

  /** The PC waits for the member `by` that linked it first to enroll it: account adds wait meanwhile. */
  startEnrolling(by: string): void {
    if (this.options.enrollingPath) writePrivateState(this.options.enrollingPath, { by });
    this.enrollingBy = by;
  }

  endEnrolling(): void {
    if (this.options.enrollingPath) rmSync(this.options.enrollingPath, { force: true });
    this.enrollingBy = null;
  }

  enrolling(): boolean { return this.enrollingBy !== null; }

  /** The member whose enrollment ends the wait: the one whose link brought the PC into the account. */
  enrollingMember(): string | null { return this.enrollingBy; }

  /** Keys an enrolling member found removed (or suspected) elsewhere: an add for one never applies here. */
  hold(keys: readonly string[]): void {
    const next = new Set(this.keys);
    for (const key of keys) next.add(key);
    const full = this.full || next.size > ACCOUNT_HELD_MAX;
    const kept = full ? [...next].slice(0, ACCOUNT_HELD_MAX) : [...next];
    if (this.options.heldPath) writePrivateState(this.options.heldPath, { keys: kept, full });
    this.keys = new Set(kept);
    this.full = full;
  }

  /** Waiting removes had to be dropped: every add is held back from now on, until the file is removed. */
  overflow(): void {
    if (this.options.heldPath) writePrivateState(this.options.heldPath, { keys: [...this.keys], full: true });
    this.full = true;
  }

  /** Whether an add for `key` is held back: a held key, a list that overflowed, or holds that cannot be read. */
  holds(key: string): boolean { return this.error !== null || this.full || this.keys.has(key); }

  list(): string[] { return [...this.keys]; }
}
