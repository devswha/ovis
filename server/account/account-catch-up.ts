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
    this.gate?.wholeRead(row => this.devices.admits(this.devices.relayKeyOf(row.id)));
    // Only an applied whole read renews the deadline. Failed pulls never postpone it, and a hung service cannot
    // prevent the PC from closing idle sessions at the deadline.
    const lastWholeReadAt = Date.now();
    this.cancelStaleness?.();
    this.cancelStaleness = this.devices.waitClock().setTimeout(() => {
      store?.staleness(lastWholeReadAt);
    }, STALE_READ_MS);
  }

  stop(): void {
    this.cancelStaleness?.();
    this.cancelStaleness = undefined;
  }
}
