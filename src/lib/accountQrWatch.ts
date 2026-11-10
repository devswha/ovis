import type { PairedDevice } from "../../shared/protocol.ts";
import { pcAccountStatus } from "./account/join.ts";
import { fetchDevices } from "./api.ts";
import { apiFetch } from "./api-request-id.ts";

/**
 * What the relay tab's QR code (ConnectPhoneDialog `AccountQr`) let in after it was taken down. A device that
 * redeemed the code just before it was ended links itself seconds later (lib/relay/accountController.ts), when the
 * tab, the dialog or all of Settings may be gone. So the watch lives here, outside any component: it reads the PC's
 * account and devices until it knows nobody got in, and what it finds waits as a notice for the relay tab, which
 * Devices and PCs opens again for it.
 */

/** how often the PC is asked which account it is in and which devices it has */
export const ACCOUNT_QR_POLL_MS = 3000;
/** how long a device that just paired gets to put the PC in its account before it is named as paired with the PC alone */
export const ACCOUNT_QR_ALONE_MS = 10_000;
/** how long the PC is watched after its QR code came down: as long as a pairing code lives (server/devices.ts) */
export const ACCOUNT_QR_LATE_MS = 10 * 60_000;

/** the PC's account and device ids as the press on Show the QR code found them */
export interface AccountQrBaseline { readonly account: string | null; readonly ids: ReadonlySet<string> }

export type AccountQrNotice =
  /** a device paired and the PC is still in no account; `known` then counts that device in */
  | { readonly kind: "alone"; readonly device: string; readonly id: string; readonly known: AccountQrBaseline }
  | { readonly kind: "joined"; readonly account: string; readonly device: string | null };

/**
 * Fired on `window` when the watch starts or ends, and with `detail.notice` true when a notice waits
 * (takeAccountQrNotice).
 */
export const ACCOUNT_QR_WATCH_EVENT = "ovis:account-qr-watch";

/** The newest device paired through the relay that is not in `known`: the one a QR code shown after `known` was read let in. */
export function newestRelayDevice(devices: readonly PairedDevice[], known: ReadonlySet<string>): PairedDevice | null {
  return devices.filter((device) => device.via_relay === true && !known.has(device.id))
    .reduce<PairedDevice | null>((newest, device) => newest === null || device.created_at > newest.created_at ? device : newest, null);
}

/** Who put the PC in `account`: the device the QR code let in; without one, the account's newest member on the PC. */
export function joinedBy(devices: readonly PairedDevice[], known: ReadonlySet<string>, account: string): PairedDevice | null {
  return newestRelayDevice(devices, known) ?? devices.filter((device) => device.account === account)
    .reduce<PairedDevice | null>((newest, device) => newest === null || device.created_at > newest.created_at ? device : newest, null);
}

let watch: { readonly known: AccountQrBaseline; readonly lingering: boolean; stop: () => void } | null = null;
let notice: AccountQrNotice | null = null;

const changed = (noticed: boolean): void => { window.dispatchEvent(new CustomEvent(ACCOUNT_QR_WATCH_EVENT, { detail: { notice: noticed } })); };

/** a QR code that came down is still being checked for a device it may have let in a moment before */
export const accountQrPending = (): boolean => watch !== null && !watch.lingering;
export const accountQrNoticeWaiting = (): boolean => notice !== null;

/** The waiting notice, once: whoever takes it shows it. */
export function takeAccountQrNotice(): AccountQrNotice | null {
  const taken = notice;
  notice = null;
  return taken;
}

/** Ends the watch; the baseline it compared with, for a QR code shown again to go on from. */
export function stopAccountQrWatch(): AccountQrBaseline | null {
  const known = watch?.known ?? null;
  watch?.stop();
  return known;
}

function publish(next: AccountQrNotice): void {
  notice = next;
  changed(true);
}

/** Forgets the watch and any waiting notice: every device was revoked, or a test starts over. */
export function resetAccountQrWatch(): void {
  stopAccountQrWatch();
  notice = null;
}

/**
 * Watches a PC that was in no account (`known`) after its QR code came down.
 * `ended` settles once the code's end was asked of the PC: true when the PC answered, so a read begun after it that
 * finds no new relay device proves nobody got in, and the watch ends there. Otherwise (the request failed, or the code
 * was never known) it lasts as long as the code can (ACCOUNT_QR_LATE_MS).
 * `linger`: a device is already in (named as paired alone, and counted in `known`), so only the PC joining an account is
 * left to tell, and no read ends the watch early.
 */
export function watchEndedAccountQr(known: AccountQrBaseline, ended: Promise<boolean>, linger = false): void {
  stopAccountQrWatch();
  let baseline = known;
  let live = true;
  let asking = false;
  let confirmed = false;
  let lingering = linger;
  let pairedAt: number | null = null;
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
  const mine = { get known() { return baseline; }, get lingering() { return lingering; }, stop };
  const ask = async () => {
    if (!live || asking) return;
    if (Date.now() - started >= ACCOUNT_QR_LATE_MS) { stop(); return; }
    asking = true;
    const conclusive = confirmed;
    try {
      const [status, devices] = await Promise.all([pcAccountStatus(apiFetch), fetchDevices()]);
      if (!live) return;
      if (status.account !== null) {
        stop();
        publish({ kind: "joined", account: status.account, device: joinedBy(devices, baseline.ids, status.account)?.label ?? null });
        return;
      }
      const paired = newestRelayDevice(devices, baseline.ids);
      if (paired === null) {
        if (conclusive && !lingering) stop();
        return;
      }
      pairedAt ??= Date.now();
      if (Date.now() - pairedAt < ACCOUNT_QR_ALONE_MS) return;
      baseline = { account: null, ids: new Set([...baseline.ids, paired.id]) };
      lingering = true;
      pairedAt = null;
      publish({ kind: "alone", device: paired.label, id: paired.id, known: baseline });
    } catch { /* the next round asks again */ } finally { asking = false; }
  };
  const poll = window.setInterval(() => void ask(), ACCOUNT_QR_POLL_MS);
  // by the timer, and in each round by the clock: a device that slept ran no timer
  const limit = window.setTimeout(stop, ACCOUNT_QR_LATE_MS);
  watch = mine;
  changed(false);
  void ended.then((answered) => { confirmed = answered; }, () => undefined).then(ask);
}
