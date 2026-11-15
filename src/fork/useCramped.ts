import { useSyncExternalStore } from "react";
import { keyboardTypingField, keyboardUp } from "../lib/keyboard.ts";
import { CRAMPED_QUERY } from "../lib/paneCanvas.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { useSettings } from "../lib/settings.ts";

/*
 * Whether the screen is short (CRAMPED_QUERY) as it stands without the soft keyboard. Android's
 * resizes-content shrinks the layout viewport under the keyboard, so the query alone would read a
 * phone held upright, typing, as a landscape one, and take a lone tab's row away mid-message.
 * While a field has the keyboard the value from before it holds, until the width changes (a turn).
 */
let held: { width: number; cramped: boolean } | null = null;

function cramped(): boolean {
  const width = window.innerWidth;
  const short = window.matchMedia?.(CRAMPED_QUERY).matches === true;
  // a keyboard only takes height away: a screen tall enough with it is tall enough without
  const typing = short && (keyboardUp() || (window.matchMedia("(pointer: coarse)").matches && document.activeElement !== null && keyboardTypingField(document.activeElement)));
  if (!typing || held === null || held.width !== width) held = { width, cramped: short };
  return held.cramped;
}

function subscribe(onChange: () => void): () => void {
  const media = window.matchMedia?.(CRAMPED_QUERY);
  media?.addEventListener("change", onChange);
  window.addEventListener("resize", onChange);
  document.addEventListener("focusin", onChange);
  document.addEventListener("focusout", onChange);
  // lib/viewport.ts settles data-keyboard after the resize, and its going is the keyboard's
  const keyboard = typeof MutationObserver === "undefined" ? null : new MutationObserver(onChange);
  keyboard?.observe(document.documentElement, { attributes: true, attributeFilter: ["data-keyboard"] });
  return () => {
    media?.removeEventListener("change", onChange);
    window.removeEventListener("resize", onChange);
    document.removeEventListener("focusin", onChange);
    document.removeEventListener("focusout", onChange);
    keyboard?.disconnect();
  };
}

const noSubscribe = () => () => {};
const notCramped = () => false;

/** The upstream query by default; opted-in devices retain their row during a soft-keyboard resize. */
export function useCramped(): boolean {
  const { settings } = useSettings();
  const normal = useMediaQuery(CRAMPED_QUERY);
  const steady = useSyncExternalStore(settings.steadyKeyboardTabs ? subscribe : noSubscribe, settings.steadyKeyboardTabs ? cramped : notCramped, notCramped);
  return settings.steadyKeyboardTabs ? steady : normal;
}
