import { shouldSyncViewportOnResume } from "./viewportResume.ts";
import { keyboardTypingField, keyboardViewportReference } from "./keyboard.ts";
import { keyboardControl } from "./keyboardControl.ts";

/*
 * Sizes the shell to the VISUAL viewport. When the soft keyboard opens, iOS
 * Safari shrinks window.visualViewport but leaves the layout viewport (and so
 * 100dvh) at full height and scrolls the page to reveal the focused textarea,
 * which drags the header off-screen and puts the key bar under the keyboard.
 * Publishing the visual height as --app-height (read by .app in styles.css)
 * and pinning the page at (0, 0) keeps header, terminal and key bar in view.
 * Chrome resizes the layout viewport itself (interactive-widget=resizes-content
 * in index.html), so there the same value changes nothing.
 *
 * Only the shell (.app) is pinned. The token gate sizes itself to the same height
 * and is otherwise a plain page: pinning it fought iOS scrolling the focused field
 * into view, and a second tap on the field (to paste) landed after the page jumped,
 * off the field, which dismissed the keyboard.
 *
 * The visual height is published only while the soft keyboard is up. An iPhone home
 * screen app (standalone, black-translucent status bar) reports a visual viewport
 * shorter than the screen with no keyboard at all, which left a band as tall as the
 * status bar under the composer. Without a keyboard the shell is 100dvh unless
 * the missing height matches the measured standalone top safe area.
 */

const viewport = window.visualViewport;
const root = document.documentElement;

/**
 * Focus starts it, and is not sufficient: dismissal and hardware keyboards leave the
 * field focused. Accept keyboard geometry where available, or detect a
 * substantial viewport occlusion relative to the large CSS viewport or a remembered
 * unobstructed height. Comparing visualViewport with innerHeight alone misses browsers
 * that resize both. The relative cutoff excludes ordinary browser/status-bar insets;
 * Safari has no exact keyboard-visibility API, so small floating keyboards cannot be
 * inferred this way. xterm's automatically focused helper only counts in direct typing.
 * Once up, the keyboard counts as up until its occlusion ends, whatever holds the focus: a
 * field unmounted under it (the chat's composer as the lens switches) or a tap that moves the
 * focus to a button leaves the keyboard on screen for its own hide animation, and the shell,
 * the sheets and the terminal's grid (#1045) follow the keyboard, not the focus.
 */
const touch = window.matchMedia("(pointer: coarse)");
const keyboard = (navigator as Navigator & {
  virtualKeyboard?: EventTarget & { boundingRect: DOMRectReadOnly };
}).virtualKeyboard;
const largeViewport = document.createElement("div");
largeViewport.style.cssText = "position:fixed;top:0;left:0;width:0;height:100lvh;visibility:hidden;pointer-events:none;contain:strict";
largeViewport.setAttribute("aria-hidden", "true");
root.append(largeViewport);
const topInset = document.createElement("div");
topInset.style.cssText = "position:fixed;top:0;left:0;width:0;height:env(safe-area-inset-top, 0px);visibility:hidden;pointer-events:none;contain:strict";
topInset.setAttribute("aria-hidden", "true");
root.append(topInset);
// Width separates portrait and landscape. Retain the baseline when a keyboard
// shrinks all three viewports, but not when a split view shrinks the large
// viewport while leaving only its ordinary visual inset.
const unobstructedHeights = new Map<number, { large: number; height: number }>();
const typing = keyboardTypingField;
// An iPad home-screen app with a hardware keyboard (iPadOS 26, Magic Keyboard) reports a visual viewport
// shrunk for a single frame on every keystroke and whole again on the next. Applied at once, that frame
// collapsed the shell to a keyboard-sized height and the page flashed on each key. A shrink is read again
// a moment later and applied only where it lasted; a viewport growing back is applied at once, so a
// keyboard going away never waits.
// Shrinking is measured against the height applied last. A viewport that only stays short of the large
// one is not shrinking (a Safari tab with its toolbars showing, an iPad home-screen app under its status
// bar), so nothing waits there, the first sync of a page included. Without a keyboard it must also be
// short of the large viewport: where the keyboard resizes the layout itself (Chrome), all three shrink
// together and that is applied at once, as before.
// The wait starts at the first shrinking event and the ones after it leave it running: a keyboard that
// opens under a stream of viewport events is applied 40 ms after its first event, then every 40 ms while
// it still opens, not 40 ms after its last event.
const SHRINK_SETTLE_MS = 40;
let shrinkTimer: number | undefined;
let appliedHeight: number | undefined;
const syncKeyboard = (): void => {
  if (document.querySelector(".app") !== null) window.scrollTo(0, 0);
  const height = viewport?.height ?? window.innerHeight;
  const shrinking = !!viewport && appliedHeight !== undefined && height < appliedHeight - 1
    && (root.hasAttribute("data-keyboard") || height < largeViewport.getBoundingClientRect().height - 1);
  if (!shrinking) {
    window.clearTimeout(shrinkTimer);
    shrinkTimer = undefined;
    applyKeyboard();
    return;
  }
  shrinkTimer ??= window.setTimeout(() => {
    shrinkTimer = undefined;
    applyKeyboard();
  }, SHRINK_SETTLE_MS);
};
const applyKeyboard = (): void => {
  const width = window.innerWidth;
  const height = viewport?.height ?? window.innerHeight;
  appliedHeight = height;
  const large = largeViewport.getBoundingClientRect().height;
  const remembered = unobstructedHeights.get(width);
  const focused = touch.matches && typing(document.activeElement);
  const keyboardActive = focused || root.hasAttribute("data-keyboard");
  const reference = keyboardViewportReference(height, large, window.innerHeight, remembered, keyboardActive);
  const visible = keyboardActive && ((keyboard?.boundingRect.height ?? 0) > 0
    // A pinch zoom narrows the visual viewport and is not a keyboard. Safari's per-site page zoom
    // (Settings → Apps → Safari → Page Zoom, kept by the home-screen app) also reports as a scale
    // below 1 while the visual viewport stays as wide as the layout, so the width tells them apart.
    || !!viewport && Math.abs(viewport.width - document.documentElement.clientWidth) < 2 && reference - height > reference * 0.2);
  if (!visible) unobstructedHeights.set(width, { large, height: Math.max(reference, height) });
  root.toggleAttribute("data-keyboard", visible);
  // the key bar's keyboard control reads this value with its tap word (lib/keyboardControl.ts):
  // label and tap hold the user's word while the value is mid-animation
  keyboardControl.measure(visible);
  if (visible && viewport) root.style.setProperty("--app-height", `${Math.round(height)}px`);
  else {
    // Only correct the standalone status region when the screen-to-CSS gap
    // agrees with the measured top safe area.
    const inset = topInset.getBoundingClientRect().height;
    const missing = window.screen.height - largeViewport.getBoundingClientRect().height;
    const standalone = window.matchMedia("(display-mode: standalone)").matches;
    if (standalone && inset > 0
      && Math.abs(missing - inset) < 2 && window.screen.height > window.innerWidth)
      root.style.setProperty("--app-height", `${Math.round(window.screen.height)}px`);
    // An iPad home-screen app in landscape draws the shell 100dvh tall while the visual viewport stops
    // above the status bar. The page can then scroll by that band, and iOS does so to reveal a field that
    // gets the focus: the whole shell slid up and back on every tap into the composer. With no keyboard and
    // no browser chrome, the visual viewport is the whole usable screen, so the shell fits it. Only a small
    // band counts; a larger gap is a keyboard or a split view, which the rules above own. iPads only (the
    // smallest is 744px on its short side); a phone keeps the rule above. Safari's page zoom reports as a
    // scale below 1 with the visual viewport as wide as the layout, a pinch zoom narrows it: the width test
    // keeps this on at a page zoom and off while pinched.
    else if (standalone && Math.min(window.innerWidth, window.innerHeight) >= 744 && viewport
      && Math.abs(viewport.width - document.documentElement.clientWidth) < 2 && large - height > 0 && large - height < reference * 0.2)
      root.style.setProperty("--app-height", `${Math.round(height)}px`);
    else root.style.removeProperty("--app-height");
  }
};
// iOS Safari zooms the page into a field whose text is under 16px when it gets the focus. Fields draw at
// the interface size (styles.css .input/.select), like the labels beside them; on iOS the press that
// precedes the focus arms the field to --fs-input, and the field keeps it while it has the focus. A press
// on a field's label arms the field the label focuses. A field focused by a handler (a press on Find in
// diff or Rename tab focuses a field it did not touch) is armed as it takes the focus. A press the browser
// cancels (a scroll) disarms a field that did not take the focus.
const ios = /iP(hone|ad|od)/.test(navigator.platform) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
if (ios) {
  const field = (target: EventTarget | null): HTMLElement | null => {
    if (!(target instanceof Element)) return null;
    const own = target.closest<HTMLElement>(".input, .select");
    if (own) return own;
    const control = target.closest("label")?.control;
    return control instanceof HTMLElement && control.matches(".input, .select") ? control : null;
  };
  let pressed: HTMLElement | null = null;
  document.addEventListener("pointerdown", (event) => {
    pressed = field(event.target);
    pressed?.setAttribute("data-armed", "");
  }, true);
  document.addEventListener("pointercancel", () => {
    if (pressed && document.activeElement !== pressed) pressed.removeAttribute("data-armed");
    pressed = null;
  }, true);
  document.addEventListener("focusin", (event) => field(event.target)?.setAttribute("data-armed", ""), true);
  document.addEventListener("focusout", (event) => field(event.target)?.removeAttribute("data-armed"), true);
}
// iPadOS 26 draws a windowed app's controls (close, minimize, full screen) over the page's top-left
// corner, where the header's first button sits, and no safe area or titlebar-area value reports them.
// A full-screen app has none there (they wait in the menu bar). A home-screen app narrower than the
// screen is in a window: mark it, and the header leaves the corner free (styles.css). The visual
// viewport's width × scale is the window's width in points whatever Safari's page zoom. The controls
// are drawn in points and the page in CSS pixels, so their room is converted through the page zoom
// (viewport.scale while the visual viewport is as wide as the layout, i.e. not pinched).
const WINDOW_CONTROLS_PT = 68; // the controls' right edge plus a gap, in points, measured on iPadOS 26
const standaloneApp = window.matchMedia("(display-mode: standalone)");
const syncWindowControls = (): void => {
  if (viewport && Math.abs(viewport.width - window.innerWidth) < 2)
    root.style.setProperty("--window-controls-w", `${Math.ceil(WINDOW_CONTROLS_PT / viewport.scale)}px`);
  const width = viewport ? viewport.width * viewport.scale : window.innerWidth;
  const landscape = screen.orientation ? screen.orientation.type.startsWith("landscape") : window.innerWidth > window.innerHeight;
  const screenWidth = landscape ? Math.max(screen.width, screen.height) : Math.min(screen.width, screen.height);
  root.toggleAttribute("data-window-controls", ios && standaloneApp.matches && width < screenWidth - 1);
};
viewport?.addEventListener("resize", syncWindowControls);
window.addEventListener("resize", syncWindowControls);
syncWindowControls();
viewport?.addEventListener("resize", syncKeyboard);
viewport?.addEventListener("scroll", syncKeyboard);
window.addEventListener("resize", syncKeyboard);
window.addEventListener("orientationchange", syncKeyboard);
touch.addEventListener("change", syncKeyboard);
keyboard?.addEventListener("geometrychange", syncKeyboard);
document.addEventListener("focusin", syncKeyboard);
document.addEventListener("visibilitychange", () => {
  if (shouldSyncViewportOnResume("visibilitychange", document.visibilityState)) syncKeyboard();
});
window.addEventListener("pageshow", () => {
  if (shouldSyncViewportOnResume("pageshow", document.visibilityState)) syncKeyboard();
});
// focus moving from one field to the next blurs first: read where it landed
document.addEventListener("focusout", () => window.setTimeout(syncKeyboard, 0));
// Switching xterm direct typing leaves its helper focused; observe the mode change.
new MutationObserver(syncKeyboard).observe(root, { attributes: true, subtree: true, attributeFilter: ["data-direct-typing"] });
syncKeyboard();
