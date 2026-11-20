import type { AccountSnapshot } from "../../shared/account-snapshot.ts";
import type { DeviceStore } from "../devices.ts";
import { STALE_READ_MS, type accountRowsFor } from "./account-devices.ts";
import { CatchUpGate } from "./catch-up-gate.ts";
import type { PcAccountState } from "./pc-binding.ts";
import type { Readmission } from "./readmission.ts";

/** The server's whole-read lifecycle: release judged rows, then bound how long that read keeps them usable. */
export class AccountCatchUp {
  readonly gate: CatchUpGate | null;
  private cancelStaleness: (() => void) | undefined;
  private remaining: (() => number) | undefined;
  private onStale: (() => void) | undefined;

  constructor(
    private readonly devices: DeviceStore,
    private readonly rows: ReturnType<typeof accountRowsFor> | null,
    pc: PcAccountState | null,
  ) {
    this.gate = rows === null ? null : new CatchUpGate(() => pc?.binding()?.bind_id ?? null);
    devices.attachCatchUp(this.gate);
  }

  commitList(snapshot: AccountSnapshot, readmission?: Readmission): void {
    const store = this.rows?.store();
    store?.commitList(snapshot, readmission);
    store?.expire();
    this.gate?.wholeRead(this.devices.list(null).filter(row => !this.devices.admits(this.devices.relayKeyOf(row.id))).map(row => row.id));
    // Only an applied whole read renews the deadline. Failed pulls never postpone it, and a hung service cannot
    // prevent the PC from closing idle sessions at the deadline.
    this.clearDeadline();
    if (!store) return;
    const clock = this.devices.waitClock();
    const deadline = clock.now() + STALE_READ_MS;
    this.remaining = () => deadline - clock.now();
    this.onStale = () => store.waitForRead();
    const fire = () => {
      const left = this.checkFreshness();
      if (left > 0) this.cancelStaleness = clock.setTimeout(fire, Math.ceil(left));
    };
    this.cancelStaleness = clock.setTimeout(fire, STALE_READ_MS);
  }

  /** Also checked synchronously at use; the timeout only guarantees closure of idle sessions. */
  checkFreshness(): number {
    const left = this.remaining?.() ?? 0;
    if (left <= 0 && this.onStale) {
      const expire = this.onStale;
      this.clearDeadline();
      expire();
    }
    return left;
  }

  private clearDeadline(): void {
    this.remaining = this.onStale = undefined;
    this.cancelStaleness?.();
    this.cancelStaleness = undefined;
  }

  stop(): void { this.clearDeadline(); }
}
