import { logAccess } from "../connection-diagnostics.ts";
import type { DeviceStore } from "../devices.ts";

/** The local commit shared by a ticketed move and a left-behind PC's local add. */
export function switchMovedAccount(devices: DeviceStore, old: { readonly account: string; readonly bind_id: string }, target: {
  readonly account: string; readonly listing_id: string; readonly merge: string | null; readonly at: string; readonly by: string;
}): void {
  devices.settleMovedRows({ from: old.account, merge: target.merge, at: target.at });
  devices.rebindAccount(old.bind_id, target);
  try {
    devices.journalEvent({ kind: "account", how: "moved", key: null, no: null, row: target.by,
      label: `${old.account.slice(0, 12)} to ${target.account.slice(0, 12)}`, by: null, account: target.account });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    console.warn("[account] the move could not be recorded in the device journal");
  }
  logAccess({ event: "account.binding.moved" });
}
