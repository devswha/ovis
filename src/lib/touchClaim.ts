/** A UI gesture has taken this stroke: consumers below it must discard pending touch work. */
export const TOUCH_STROKE_CLAIMED = "ovis:touch-stroke-claimed";

/** A terminal's pending selection hold can be cancelled; a started selection owns the stroke. */
export const terminalTouchSelections = new WeakMap<EventTarget, (() => void) | "selecting">();

export function claimTouchStroke(path: readonly EventTarget[]): void {
  // A renderer can replace the original row mid-stroke. Its connected ancestor still owns
  // the same pending work; dispatch there rather than into the detached row.
  const target = path.find((node) => (node as Node).isConnected !== false);
  target?.dispatchEvent?.(new Event(TOUCH_STROKE_CLAIMED, { bubbles: true }));
}
