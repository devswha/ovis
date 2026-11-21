/** Paired synchronous notifications around an instant layout scroll, also used by the list patch. */
export const LAYOUT_SCROLL_START = "ovis:layout-scroll-start";
export const LAYOUT_SCROLL_END = "ovis:layout-scroll-end";

/** A layout write must not disguise a reader's scroll whose event has not arrived yet. */
export function layoutScroll(node: HTMLElement, write: () => void): void {
  node.dispatchEvent(new Event(LAYOUT_SCROLL_START, { bubbles: true }));
  try { write(); }
  finally { node.dispatchEvent(new Event(LAYOUT_SCROLL_END, { bubbles: true })); }
}
