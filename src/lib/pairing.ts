/**
 * This browser pairing itself, from the setup guide's Connect your phone or Settings → Phone's Pair
 * this device now: a code, used at once by this browser, so the gate closes to everyone else and the
 * phone paired next does not shut it out. One at a time across both views: two at once could leave
 * the later, already void, cookie in place of the good one (server/devices.ts confirms one per gate).
 */
import type { PairedDevice } from "../../shared/protocol.ts";
import { fetchDevices, pairDevice, startPairing } from "./api.ts";
import { t } from "./i18n.ts";
import { deviceLabel } from "./phone.ts";

export function singleFlight<T>(run: () => Promise<T>): () => Promise<T> {
  let out: Promise<T> | null = null;
  return () => out ??= run().finally(() => { out = null; });
}

/** the pairing went through but no listed device is this browser (its cookie did not stick) */
export class UnconfirmedPairing extends Error {}

/** how long this browser's pairing may take: the setup guide's other ways wait for it (a relay start follows it) */
export const PAIRING_MS = 20_000;

export const pairThisBrowser: () => Promise<PairedDevice[]> = singleFlight(() => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let over = false;
  // a step that answers after the bound takes no next step: no code is asked for, nor used, once the pairing gave up
  const still = <T>(value: T): T => { if (over) throw new DOMException(t("No answer"), "TimeoutError"); return value; };
  const pairing = (async () => {
    // the server's word, not the app's access facts (they can be behind, or it paired in Settings):
    // a browser already paired gets no second device and keeps its cookie
    const known = still(await fetchDevices());
    if (known.some((device) => device.current)) return known;
    const fresh = still(await startPairing());
    still(await pairDevice(fresh.code, deviceLabel(navigator.userAgent, navigator.maxTouchPoints ?? 0)));
    const list = still(await fetchDevices());
    if (!list.some((device) => device.current)) throw new UnconfirmedPairing();
    return list;
  })();
  const bound = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { over = true; reject(new DOMException(t("No answer"), "TimeoutError")); }, PAIRING_MS);
  });
  // the losing side's own failure is not this pairing's answer
  pairing.catch(() => undefined);
  return Promise.race([pairing, bound]).finally(() => clearTimeout(timer));
});
