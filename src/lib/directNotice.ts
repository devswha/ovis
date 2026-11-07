import { useCallback, useEffect, useState } from "react";

/**
 * Whether the line that says the relay's same-Wi-Fi direct connection listens on this PC's network
 * (components/LanExposureNotice.tsx, `direct_exposure`) was dismissed in this browser. It is news
 * once, not a warning: direct is on by default with the relay, and only relay-paired devices sign in
 * there. Settings, Devices and PCs keeps saying it. One dismissal covers one PC at one address: the
 * line comes back when the address changes, or once a health answer says direct is off and it is
 * turned on again. The open-server warning (`lan_exposure`) is never dismissed.
 *
 * `scope` names the PC whose storage this is: its server id in the hosted shell, whose origin all
 * PCs share; "" on a PC's own page, whose origin is that PC.
 */
const KEY = "ovis:direct-notice-dismissed";

const entry = (scope: string, host: string) => `${scope} ${host}`;

function readDismissed(): string[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch { return []; }
}

function writeDismissed(dismissed: readonly string[]): void {
  try {
    if (dismissed.length) window.localStorage.setItem(KEY, JSON.stringify(dismissed));
    else window.localStorage.removeItem(KEY);
  } catch { /* storage blocked: the dismissal lasts until the page reloads */ }
}

/**
 * `host`: the direct carrier's address from the last health answer, null when that answer named no
 * direct listener, undefined before any answer (which says nothing, so forgets nothing).
 */
export function useDirectNotice(scope: string, host: string | null | undefined): { dismissed: boolean; dismiss: () => void } {
  const [dismissed, setDismissed] = useState(readDismissed);
  useEffect(() => {
    if (host === undefined) return;
    // this PC's dismissals of any other address, or of every address once direct is off, end here
    const kept = dismissed.filter((item) => !item.startsWith(`${scope} `) || (host !== null && item === entry(scope, host)));
    if (kept.length === dismissed.length) return;
    setDismissed(kept);
    writeDismissed(kept);
  }, [scope, host, dismissed]);
  const dismiss = useCallback(() => {
    if (host == null) return;
    const next = [...readDismissed().filter((item) => item !== entry(scope, host)), entry(scope, host)];
    setDismissed(next);
    writeDismissed(next);
  }, [scope, host]);
  return { dismissed: host != null && dismissed.includes(entry(scope, host)), dismiss };
}
