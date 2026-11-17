import type { PairedDevice } from "../../shared/protocol.ts";
import { fetchDevices, pairDevice, startPairing } from "./api.ts";
import { deviceLabel } from "./phone.ts";

export function singleFlight<T>(run: () => Promise<T>): () => Promise<T> {
  let out: Promise<T> | null = null;
  return () => out ??= run().finally(() => { out = null; });
}

export class UnconfirmedPairing extends Error {}

export const pairThisBrowser: () => Promise<PairedDevice[]> = singleFlight(async () => {
  const known = await fetchDevices();
  if (known.some((device) => device.current)) return known;
  const fresh = await startPairing();
  await pairDevice(fresh.code, deviceLabel(navigator.userAgent, navigator.maxTouchPoints ?? 0));
  const list = await fetchDevices();
  if (!list.some((device) => device.current)) throw new UnconfirmedPairing();
  return list;
});
