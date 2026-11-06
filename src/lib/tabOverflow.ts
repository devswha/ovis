/** The narrowest a tab in the header's row is drawn (styles.css .header-tabs .tab-strip-item): its name stays readable and its close a small part of it. */
export const TAB_MIN_WIDTH = 120;
/** The More button after the + (TabStrip.css .tab-strip-more), with its gap before it. */
export const TAB_MORE_WIDTH = 56;

/**
 * Which of `count` tabs the header's row draws in `room` pixels, after the + takes `add`: all of
 * them while each fits at its narrowest, else as many as fit beside the More button, the open
 * tab (`open`, its place) always among them, in the last place when it is past the others.
 */
export function tabsInRow(count: number, open: number, room: number, add: number): number[] {
  const all = Array.from({ length: count }, (_, index) => index);
  if (count * TAB_MIN_WIDTH + add <= room) return all;
  const fit = Math.min(count - 1, Math.max(1, Math.floor((room - add - TAB_MORE_WIDTH) / TAB_MIN_WIDTH)));
  if (open < fit) return all.slice(0, fit);
  return [...all.slice(0, fit - 1), open];
}
