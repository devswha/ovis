/*
 * A swipe forward across the empty chat box takes the agent's suggested prompt, as Tab does on a
 * keyboard (a phone has no Tab). "Forward" is the way the line reads: left to right in a
 * left-to-right box, right to left in a right-to-left one. Only a single finger and a stroke that
 * is horizontal from its first move count, so a tap (caret), a long press (selection, the caret
 * loupe, the paste menu) and a vertical drag (scrolling a tall box) stay the browser's, also when
 * they drift sideways later.
 */

/** How far a finger travels forward before it counts as a swipe. */
export const ACCEPT_SWIPE_PX = 48;
/** A stroke is horizontal when its sideways travel is this many times its vertical travel. */
export const HORIZONTAL_RATIO = 1.5;
/** A stroke that starts this close to a screen edge is the system's (Android's back gesture). */
export const SCREEN_EDGE_PX = 24;
/** Movement within this distance of the start is a finger resting, not yet a stroke. */
export const SLOP_PX = 10;
/** A finger that rests this long before it moves is a long press. */
export const LONG_PRESS_MS = 400;

export interface SwipeStart {
  x: number;
  y: number;
  at: number;
  /** The width of the screen the stroke is on, for the right edge. */
  viewportWidth: number;
  /** The box reads right to left. */
  rtl: boolean;
}

export interface SwipeMove {
  x: number;
  y: number;
  at: number;
  /** How many fingers are down. */
  touches: number;
}

export type SwipeVerdict = "accept" | "pending" | "cancel";

/** Follows one stroke from where the finger came down; call the result with each move. */
export function trackAcceptSwipe(start: SwipeStart): (move: SwipeMove) => SwipeVerdict {
  const atEdge = start.x < SCREEN_EDGE_PX || start.x > start.viewportWidth - SCREEN_EDGE_PX;
  let verdict: SwipeVerdict = atEdge ? "cancel" : "pending";
  let moved = false;
  return ({ x, y, at, touches }) => {
    if (verdict !== "pending") return verdict;
    const dx = (x - start.x) * (start.rtl ? -1 : 1);
    const dy = Math.abs(y - start.y);
    if (touches !== 1) verdict = "cancel";
    else if (!moved && Math.abs(dx) < SLOP_PX && dy < SLOP_PX) return verdict;
    else if (!moved && at - start.at > LONG_PRESS_MS) verdict = "cancel";
    else if (dx <= 0 || dx <= HORIZONTAL_RATIO * dy) verdict = "cancel";
    else if (dx >= ACCEPT_SWIPE_PX) verdict = "accept";
    moved = true;
    return verdict;
  };
}
