import { useSyncExternalStore } from "react";
import { accountServiceOf } from "./account/service.ts";

/**
 * Whether this device has no network at all: the browser (or the phone app's WebView) says `navigator.onLine === false`,
 * and the page's account service did not answer since. A Galaxy Z Flip6's WebView said false all along on working Wi-Fi
 * (app 1.0.7) while the account's list read fine, so a false is put to the account service (checkNetwork) before the
 * screen believes it; a page with no account service believes the flag. `true` can still be a network with no way to the
 * internet, which the request that fails then says itself.
 */
export function deviceOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false && !answered;
}

/** the account service answered since the device last said it went offline */
let answered = false;
let asking: Promise<void> | null = null;
const listeners = new Set<() => void>();

/**
 * Asks the page's account service whether the network answers while the device says it is offline (one ask at a time;
 * Try again and each `offline` event ask again). Any answer, an error status too, is a network; `no-cors` keeps a page
 * of another origin from being refused by CORS rather than by the network.
 */
export function checkNetwork(): Promise<void> {
  if (asking !== null) return asking;
  const service = typeof document === "undefined" ? null : accountServiceOf(document);
  if (typeof navigator === "undefined" || navigator.onLine !== false || service === null) {
    answered = false;
    return Promise.resolve();
  }
  asking = fetch(`${service}/v1/providers`, { mode: "no-cors", cache: "no-store" }).then(
    () => { answered = true; },
    // no answer: the device is offline, as it says
    () => { answered = false; },
  ).finally(() => {
    asking = null;
    for (const changed of listeners) changed();
  });
  return asking;
}

function watch(changed: () => void): () => void {
  const wentOffline = (): void => { void checkNetwork(); changed(); };
  listeners.add(changed);
  window.addEventListener("online", changed);
  window.addEventListener("offline", wentOffline);
  void checkNetwork();
  return () => {
    listeners.delete(changed);
    window.removeEventListener("online", changed);
    window.removeEventListener("offline", wentOffline);
  };
}

/** deviceOffline, drawn again as the browser's online and offline events, and checkNetwork's answers, say it changed. */
export function useOffline(): boolean {
  return useSyncExternalStore(watch, deviceOffline, () => false);
}
