import { AccountDeviceStore } from "./account-devices.ts";
import type { AccountRowPorts, AccountRowSource } from "./account-device-state.ts";

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
    missing: () => store()?.missing() ?? true,
    rows: () => store()?.rows() ?? [],
    row: (id) => store()?.row(id) ?? null,
    promoted: (id) => store()?.promoted(id),
    rowsByKey: (key) => store()?.rowsByKey(key) ?? [],
    access: (id) => store()?.access(id) ?? { refused: "not_listed" },
    pruneDenied: (evidence, legacyRevoke) => { store()?.pruneDenied(evidence, legacyRevoke); },
    removeRows: (ids, reason, close) => { store()?.removeRows(ids, reason, close); },
    itsMe: (id, sayer) => store()?.itsMe(id, sayer) ?? false,
    seen: (id) => { store()?.seen(id); },
    readmission: (id) => store()?.readmission(id),
  };
}
