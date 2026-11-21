/** Which saved PCs the hosted shell opens by itself (shell.tsx): a launch, and a move off a PC that went away. */
import type { RelayDevice } from "./device.ts";

/**
 * The saved PCs this device opens without a press: a finished pairing (a row with no device id would ask to pair again)
 * made on this device by hand. Never one an account introduction alone saved (introduced_at): security-triage
 * condition 3, nothing this device did not choose opens by itself.
 */
export function openablePcs(devices: readonly RelayDevice[]): RelayDevice[] {
  return devices.filter((device) => device.device_id !== null && device.introduced_at === undefined);
}

export function lastFirst(devices: readonly RelayDevice[], last: string | null): RelayDevice[] {
  return [...devices.filter((device) => device.server_id === last), ...devices.filter((device) => device.server_id !== last)];
}

/**
 * The PCs a launch opened in this tab that turned out off on their own page: the launch goes on with the others, and
 * never back to one of these, so it ends once every saved PC was tried.
 */
const LAUNCH_TRIED = "ovis-launch-tried";

export function launchTried(): string[] {
  try {
    const kept: unknown = JSON.parse(sessionStorage.getItem(LAUNCH_TRIED) ?? "[]");
    return Array.isArray(kept) ? kept.filter((id): id is string => typeof id === "string") : [];
  } catch { return []; }
}

export function keepLaunchTried(serverIds: readonly string[]): void {
  try {
    if (serverIds.length === 0) sessionStorage.removeItem(LAUNCH_TRIED);
    else sessionStorage.setItem(LAUNCH_TRIED, JSON.stringify([...new Set(serverIds)]));
  } catch { /* no storage: a launch that goes on may try a PC found off again, once per page */ }
}
