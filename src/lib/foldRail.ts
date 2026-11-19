/**
 * The foldable iPhone ("iPhone Duo") draws its status bar and Dynamic Island in a wide safe-area band: a
 * column at the side held upright on the cover display or turned to landscape, a tall band at the top in
 * the open display's portrait. The app puts its header controls into that band instead of laying a header
 * row beside it (styles.css, `:root[data-fold-rail]`), and the room that frees goes to the tabs and the
 * transcript. Nothing else changes on any other device.
 *
 * A page cannot read the device model, so the display is told by its fixed size in device pixels, which
 * holds under iOS's display zoom (that changes the points, not the pixels). The size is the window's, not
 * `screen`'s: the iOS web view reports a screen of 466 x 678 points on either display.
 */

export type FoldDisplay = "inner" | "cover";
export type FoldRail = { side: "left" | "right" | "top"; band: number; cover: boolean };
type Insets = { top: number; right: number; bottom: number; left: number };

/** [short side, long side] in device pixels: the display open (inner), and closed (cover) */
const DISPLAYS: Record<FoldDisplay, readonly [number, number]> = { inner: [2007, 2853], cover: [1398, 2034] };
/** a button (44px) must fit in it */
const MIN_SIDE_BAND = 44;
const MIN_TOP_BAND = 44;

const near = (points: number, pixels: number, dpr: number): boolean => Math.abs(Math.round(points * dpr) - pixels) <= 2;

/**
 * The display a window of this size is, or null. The keyboard shortens the window: a display seen whole
 * (`previous`) stays told while the width is still one of its sides.
 */
export function foldDisplayOf(width: number, height: number, dpr: number, previous: FoldDisplay | null): FoldDisplay | null {
  const [short, long] = width < height ? [width, height] : [height, width];
  for (const name of Object.keys(DISPLAYS) as FoldDisplay[]) {
    if (near(short, DISPLAYS[name][0], dpr) && near(long, DISPLAYS[name][1], dpr)) return name;
  }
  return previous !== null && DISPLAYS[previous].some((side) => near(width, side, dpr)) ? previous : null;
}

/**
 * Where the status bar's band is: the widest inset, a side in landscape and on the cover display (whose
 * island sits at the edge of the phone held upright), the top in the open display's portrait.
 */
export function foldRailOf(display: FoldDisplay | null, insets: Insets): FoldRail | null {
  if (display === null) return null;
  const sideBand = Math.max(insets.left, insets.right);
  if (sideBand >= insets.top && sideBand >= MIN_SIDE_BAND) return { side: insets.left > insets.right ? "left" : "right", band: sideBand, cover: display === "cover" };
  if (insets.top >= MIN_TOP_BAND) return { side: "top", band: insets.top, cover: false };
  return null;
}

function measureInsets(): Insets {
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;visibility:hidden;pointer-events:none;inset:0 auto auto 0;width:0;height:0;"
    + "padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)";
  document.body.appendChild(probe);
  const style = getComputedStyle(probe);
  const insets = { top: parseFloat(style.paddingTop) || 0, right: parseFloat(style.paddingRight) || 0, bottom: parseFloat(style.paddingBottom) || 0, left: parseFloat(style.paddingLeft) || 0 };
  probe.remove();
  return insets;
}

let display: FoldDisplay | null = null;

function apply(): void {
  const root = document.documentElement;
  display = foldDisplayOf(root.clientWidth || window.innerWidth, window.innerHeight, window.devicePixelRatio || 1, display);
  const rail = display === null ? null : foldRailOf(display, measureInsets());
  if (rail === null) {
    delete root.dataset.foldRail;
    delete root.dataset.foldCover;
    root.style.removeProperty("--fold-rail-band");
    return;
  }
  root.dataset.foldRail = rail.side;
  // the cover display is narrow: the whole header goes into the side strip, not just its trailing controls
  if (rail.cover) root.dataset.foldCover = "";
  else delete root.dataset.foldCover;
  root.style.setProperty("--fold-rail-band", `${rail.band}px`);
}

export function startFoldRail(): void {
  // every other screen has no such band, and nothing here would change it
  if (navigator.maxTouchPoints < 1) return;
  let frame = 0;
  let later: ReturnType<typeof setTimeout> | undefined;
  const schedule = (): void => {
    cancelAnimationFrame(frame);
    clearTimeout(later);
    // iOS reports the new safe area a moment after the rotation's resize
    frame = requestAnimationFrame(() => { apply(); later = setTimeout(apply, 300); });
  };
  if (document.body) apply();
  else document.addEventListener("DOMContentLoaded", apply, { once: true });
  // a home-screen app reports its safe area a moment after it starts too: measure again
  window.addEventListener("load", schedule, { once: true });
  for (const delay of [250, 1000, 2500]) setTimeout(schedule, delay);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) schedule(); });
  window.addEventListener("resize", schedule);
  window.addEventListener("orientationchange", schedule);
}
