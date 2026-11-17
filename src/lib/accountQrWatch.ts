import type { PairedDevice } from "../../shared/protocol.ts";
import { pcAccountStatus } from "./account/join.ts";
import { fetchDevices } from "./api.ts";
import { apiFetch } from "./api-request-id.ts";

export const ACCOUNT_QR_POLL_MS = 3000;
export const ACCOUNT_QR_ALONE_MS = 10_000;
export const ACCOUNT_QR_LATE_MS = 10 * 60_000;

export interface AccountQrBaseline { readonly ids: ReadonlySet<string>; readonly seen: Map<string, number> }

export interface AccountQrStray { readonly id: string; readonly label: string; readonly relay: boolean }

export type AccountQrNotice =
  | { readonly kind: "alone"; readonly strays: readonly AccountQrStray[]; readonly checking: readonly AccountQrStray[]; readonly known: AccountQrBaseline }
  | { readonly kind: "joined"; readonly account: string; readonly device: string | null; readonly strays: readonly AccountQrStray[]; readonly checking: readonly AccountQrStray[]; readonly known: AccountQrBaseline };

export const ACCOUNT_QR_WATCH_EVENT = "ovis:account-qr-watch";

const newest = (devices: readonly PairedDevice[]): PairedDevice | null => devices.reduce<PairedDevice | null>((latest, device) => latest === null || device.created_at > latest.created_at ? device : latest, null);

/**
 * Who put the PC in `account`: a member of that account (its row carries the account, whose key signed its link), never
 * a device that only holds the code. The newest member that came since `known` was read; without one, the account's
 * newest member on the PC (a device paired before that linked itself meanwhile). Null when no row is a member: then
 * nobody is named. The same rule as `ovis add` (scripts/plugin-link.ts `addedBy`).
 */
export function addedBy(devices: readonly PairedDevice[], known: ReadonlySet<string>, account: string): PairedDevice | null {
  const members = devices.filter((device) => device.account === account);
  return newest(members.filter((device) => !known.has(device.id))) ?? newest(members);
}

export function unvouched(devices: readonly PairedDevice[], known: ReadonlySet<string>, account: string | null): PairedDevice[] {
  return devices.filter((device) => !known.has(device.id) && (account === null || device.account !== account));
}

export const strayOf = (device: PairedDevice): AccountQrStray => ({ id: device.id, label: device.label, relay: device.via_relay === true });

export function dueStrays(strays: readonly PairedDevice[], seen: Map<string, number>, now: number): AccountQrStray[] {
  return strays.filter((device) => {
    if (!seen.has(device.id)) seen.set(device.id, now);
    return device.via_relay !== true || now - seen.get(device.id)! >= ACCOUNT_QR_ALONE_MS;
  }).map(strayOf);
}

export function accountQrFindings(devices: readonly PairedDevice[], account: string | null, known: AccountQrBaseline, now: number): { due: AccountQrStray[]; checking: AccountQrStray[] } {
  const strays = unvouched(devices, known.ids, account);
  const due = dueStrays(strays, known.seen, now);
  const asked = new Set(due.map((stray) => stray.id));
  return { due, checking: strays.filter((device) => !asked.has(device.id)).map(strayOf) };
}

let watch: { readonly known: AccountQrBaseline; readonly lingering: boolean; stop: () => void } | null = null;
let notice: AccountQrNotice | null = null;

const changed = (noticed: boolean): void => { window.dispatchEvent(new CustomEvent(ACCOUNT_QR_WATCH_EVENT, { detail: { notice: noticed } })); };

export const accountQrPending = (): boolean => watch !== null && !watch.lingering;
export const accountQrNoticeWaiting = (): boolean => notice !== null;

export function takeAccountQrNotice(): AccountQrNotice | null {
  const taken = notice;
  notice = null;
  return taken;
}

export function holdAccountQrNotice(held: AccountQrNotice): void {
  notice = held;
}

export function stopAccountQrWatch(): AccountQrBaseline | null {
  const known = watch?.known ?? null;
  watch?.stop();
  return known;
}

function publish(next: AccountQrNotice): void {
  notice = next;
  changed(true);
}

export function resetAccountQrWatch(): void {
  stopAccountQrWatch();
  notice = null;
}

/**
 * Watches a PC that was in no account (`known`) after its QR code came down, and ends with the first thing to tell:
 * the PC joined an account, or a device nobody vouched for is due to be asked about.
 * `ended` settles once the code's end was asked of the PC: true when the PC answered, so a read begun after it that
 * finds no new device proves nobody got in, and the watch ends there. Otherwise (the request failed, or the code
 * was never known) it lasts as long as the code can (ACCOUNT_QR_LATE_MS).
 * `linger`: the devices that got in were kept (and count in `known`), so only the PC joining an account, or a device
 * that came through the relay, is left to tell, and no read ends the watch early.
 */
export function watchEndedAccountQr(known: AccountQrBaseline, ended: Promise<boolean>, linger = false): void {
  stopAccountQrWatch();
  let live = true;
  let asking = false;
  let confirmed = false;
  const started = Date.now();
  const stop = () => {
    if (!live) return;
    live = false;
    window.clearInterval(poll);
    window.clearTimeout(limit);
    if (watch !== mine) return;
    watch = null;
    changed(false);
  };
  const mine = { known, lingering: linger, stop };
  const ask = async () => {
    if (!live || asking) return;
    if (Date.now() - started >= ACCOUNT_QR_LATE_MS) { stop(); return; }
    asking = true;
    const conclusive = confirmed;
    try {
      const [status, devices] = await Promise.all([pcAccountStatus(apiFetch), fetchDevices()]);
      if (!live) return;
      const found = accountQrFindings(devices, status.account, known, Date.now());
      const { checking } = found;
      const due = linger ? found.due.filter((stray) => stray.relay) : found.due;
      if (status.account !== null) {
        stop();
        publish({ kind: "joined", account: status.account, device: addedBy(devices, known.ids, status.account)?.label ?? null, strays: due, checking, known });
        return;
      }
      if (due.length > 0) {
        stop();
        publish({ kind: "alone", strays: due, checking, known });
        return;
      }
      if (checking.length === 0 && conclusive && !linger) stop();
    } catch {} finally { asking = false; }
  };
  const poll = window.setInterval(() => void ask(), ACCOUNT_QR_POLL_MS);
  // by the timer, and in each round by the clock: a device that slept ran no timer
  const limit = window.setTimeout(stop, ACCOUNT_QR_LATE_MS);
  watch = mine;
  changed(false);
  void ended.then((answered) => { confirmed = answered; }, () => undefined).then(ask);
}
