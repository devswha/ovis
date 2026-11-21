import { useEffect } from "react";
import { INBOX_WIDGET_PATH } from "../../shared/fork/inbox-widget.ts";
import { sendJson } from "../lib/api.ts";
import { callNative, hasNativePlugin, PUSH_PLUGIN } from "../lib/nativeApp.ts";

/** The Android app's home-screen widget (app/android/ovis-widget/OvisWidgetPlugin). */
const WIDGET_PLUGIN = "OvisWidget";
/** the PC answers a placed widget with its agents at once: an app brought back often asks no more than this */
const MIN_GAP_MS = 60_000;

let lastTold = 0;

/**
 * Tells this PC whether a widget is placed on the phone, with the app's own push subscription,
 * whose keys prove it is this phone's: the PC then pushes the agents to it quietly. On every start
 * and each time the app comes back, so a widget placed or removed meanwhile is heard.
 */
async function tellPc(): Promise<void> {
  if (!hasNativePlugin(WIDGET_PLUGIN) || !hasNativePlugin(PUSH_PLUGIN) || Date.now() - lastTold < MIN_GAP_MS) return;
  lastTold = Date.now();
  try {
    const { placed } = await callNative<{ placed: boolean }>(WIDGET_PLUGIN, "placed");
    const { subscription } = await callNative<{ subscription: unknown }>(PUSH_PLUGIN, "getSubscription");
    if (subscription) await sendJson(INBOX_WIDGET_PATH, "POST", { subscription, placed });
  } catch {
    // no subscription on this PC yet, or a PC without the widget's route: nothing to tell
  }
}

export function useInboxWidget(): void {
  useEffect(() => {
    void tellPc();
    const shown = () => { if (document.visibilityState === "visible") void tellPc(); };
    document.addEventListener("visibilitychange", shown);
    return () => document.removeEventListener("visibilitychange", shown);
  }, []);
}
