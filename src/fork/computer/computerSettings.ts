import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { useSettings } from "../../lib/settings.ts";

const KEEP_CHOICES = ["0", "2", "5", "10"];
const KEEP_DEFAULT = 2;

/**
 * Minutes the view stays connected out of sight after Chat or Terminal is picked, so coming back needs no new
 * connection. The choice an older Computer view saved for this PC in this browser (`keep`) still counts; none, or
 * one it doesn't know, is the default.
 */
export function keepMinutes(machineId: string): number {
  try {
    const value = JSON.parse(localStorage.getItem(`ovis:computer:${encodeURIComponent(machineId)}`) ?? "null") as { keep?: unknown } | null;
    const keep = value?.keep;
    return typeof keep === "string" && KEEP_CHOICES.includes(keep) ? Number(keep) : KEEP_DEFAULT;
  } catch {
    return KEEP_DEFAULT;
  }
}

// Logins an older Computer view kept on this device; it no longer reads or writes them, only wipes them.
const LOGIN_PREFIX = "ovis:computer-login:";

/** On sign-out: no PC's login stays on a device that is no longer signed in. */
export function forgetComputerLogins(): void {
  try {
    for (const name of Object.keys(localStorage)) if (name.startsWith(LOGIN_PREFIX)) localStorage.removeItem(name);
  } catch { /* no storage: nothing was kept */ }
}

/**
 * Which PC's desktop is shown over the pane area, opened from that PC's sidebar header (null: none), and
 * which one is kept connected out of sight for a few minutes after it closes.
 */
export function useComputerView(): [shown: string | null, show: Dispatch<SetStateAction<string | null>>, kept: string | null] {
  const { settings } = useSettings();
  const [shown, setShown] = useState<string | null>(null);
  const [kept, setKept] = useState<string | null>(null);
  useEffect(() => {
    if (shown !== null) {
      setKept(shown);
      return;
    }
    if (kept === null) return;
    const timer = setTimeout(() => setKept(null), keepMinutes(kept) * 60_000);
    return () => clearTimeout(timer);
  }, [shown, kept]);
  useEffect(() => { if (!settings.computerView) { setShown(null); setKept(null); } }, [settings.computerView]);
  return [settings.computerView ? shown : null, setShown, settings.computerView ? kept : null];
}
