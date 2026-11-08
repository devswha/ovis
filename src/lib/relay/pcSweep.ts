/** Bounded, rotating liveness checks. Probe results never imply account or version state. */
import { checkPc, sweepOf } from "./pcStatus.ts";
import type { PcStatus } from "./pcStatus.ts";
import type { RelayDeviceStore } from "./device.ts";
import type { RelaySocket } from "./channel.ts";

const CHECK_PCS = 8;
const CHECK_AT_ONCE = 2;
/** a minute: one sweep's CHECK_PCS connections (up to two each, with the global relay's fallback) stay well under the relay's 30 a minute */
const CHECK_GAP_MS = 60_000;
const CHECK_KEY = "ovis-pc-check-at";
const CHECK_CURSOR_KEY = "ovis-pc-check-cursor";

function localStorageGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function localStorageSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* no storage: lastCheck keeps the gap for this page */ }
}


export function createPcSweep(store: RelayDeviceStore, view: { readonly active: () => boolean; readonly redraw: () => void }, options: { readonly probe?: typeof checkPc; readonly directSocket?: (url: string) => RelaySocket } = {}) {
  const pcStatus = new Map<string, PcStatus>();
  const probe = options.probe ?? checkPc;
  const directSocket = options.directSocket;
  let lastCheck = -Infinity;
  let deferred: ReturnType<typeof setTimeout> | undefined;
  /** the sweep under way: another waits for it, so CHECK_AT_ONCE holds across sweeps */
  let sweeping: Promise<void> | undefined;
  const redraw = (): void => { if (view.active()) view.redraw(); };
  const cursorNow = (): number => Number(localStorageGet(CHECK_CURSOR_KEY) ?? "0");
  const checkPcs = async (): Promise<void> => {
    if (sweeping) return;
    const stored = Number(localStorageGet(CHECK_KEY) ?? "");
    const wait = CHECK_GAP_MS - (Date.now() - Math.max(lastCheck, Number.isFinite(stored) ? stored : -Infinity));
    // too soon after the last sweep (a reload, or Check now again): this one runs once the gap is over,
    // and the rows say a check is on its way meanwhile
    if (wait > 0) {
      deferred ??= setTimeout(() => { deferred = undefined; if (view.active()) void checkPcs(); }, wait);
      redraw();
      return;
    }
    lastCheck = Date.now();
    localStorageSet(CHECK_KEY, String(lastCheck));
    sweeping = sweepPcs().finally(() => { sweeping = undefined; });
    await sweeping;
  };
  const sweepPcs = async (): Promise<void> => {
    // past CHECK_PCS, each sweep starts where the last one stopped (kept across reloads), so every saved PC gets its turn
    const cursor = cursorNow();
    const saved = sweepOf(await store.list(), cursor, CHECK_PCS);
    localStorageSet(CHECK_CURSOR_KEY, String(cursor + CHECK_PCS));
    for (const device of saved) pcStatus.set(device.server_id, { kind: "checking" });
    redraw();
    const sockets = { relay: (url: string) => new WebSocket(url), ...(directSocket ? { direct: directSocket } : {}) };
    const queue = [...saved];
    await Promise.all(Array.from({ length: CHECK_AT_ONCE }, async () => {
      for (let device = queue.shift(); device; device = queue.shift()) {
        // a check that throws knows nothing more of the PC than that no relay answered
        const found = await probe(device, sockets).catch((): PcStatus => ({ kind: "offline", reason: "relay" }));
        pcStatus.set(device.server_id, found);
        redraw();
      }
    }));
  };

  return { status: pcStatus, check: checkPcs };
}
