/*
 * A swipe forward across the empty chat box takes the agent's suggested prompt, as Tab does on a
 * keyboard (a phone has no Tab). "Forward" is the way the line reads: left to right in a
 * left-to-right box, right to left in a right-to-left one. Only a single finger and a mostly
 * horizontal stroke count, so a tap (caret), a long press and a vertical drag (scrolling a
 * tall box) stay the browser's.
 */

/** How far a finger travels forward before it counts as a swipe. */
export const ACCEPT_SWIPE_PX = 48;
/** A stroke is horizontal when its sideways travel is this many times its vertical travel. */
export const HORIZONTAL_RATIO = 1.5;
/** A stroke that starts this close to a screen edge is the system's (Android's back gesture). */
export const SCREEN_EDGE_PX = 24;

export interface SwipeStroke {
  startX: number;
  startY: number;
  x: number;
  y: number;
  /** The width of the screen the stroke is on, for the right edge. */
  viewportWidth: number;
  /** The box reads right to left. */
  rtl: boolean;
  /** How many fingers are down. */
  touches: number;
}

/** Whether a stroke, as far as it has gone, is a forward swipe that takes the suggestion. */
export function isAcceptSwipe(stroke: SwipeStroke): boolean {
  if (stroke.touches !== 1) return false;
  if (stroke.startX < SCREEN_EDGE_PX || stroke.startX > stroke.viewportWidth - SCREEN_EDGE_PX) return false;
  const dx = (stroke.x - stroke.startX) * (stroke.rtl ? -1 : 1);
  const dy = stroke.y - stroke.startY;
  return dx >= ACCEPT_SWIPE_PX && Math.abs(dx) > HORIZONTAL_RATIO * Math.abs(dy);
}
