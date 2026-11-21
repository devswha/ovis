import { useEffect, useState, type RefObject } from "react";

/**
 * What floats over the page without being a dialog: menus and lists, the toast, notices, hints, a peeking sidebar.
 * A built-in browser tab is drawn by the app above the page, so any of these over its place would fall under it.
 */
export const FLOATING_SELECTOR = '.menu,[role="menu"],[role="listbox"],[role="tooltip"],.droplet,.work-image-preview,.tab-strip-notice,.relay-pairing-layer,.first-hint,.sidebar.is-peek';

/** whether one of `nodes`, shown, overlaps `place` */
export function floatingOver(place: DOMRect, nodes: Iterable<Element>): boolean {
  for (const node of nodes) {
    if (node.closest("[hidden]") || getComputedStyle(node).visibility !== "visible") continue;
    for (const box of node.getClientRects()) {
      if (box.width > 0 && box.height > 0 && box.left < place.right && box.right > place.left && box.top < place.bottom && box.bottom > place.top) return true;
    }
  }
  return false;
}

/** whether something floats over `place` now, followed as the page changes */
export function useFloatingOver(place: RefObject<HTMLElement | null>, watching: boolean): boolean {
  const [over, setOver] = useState(false);
  useEffect(() => {
    const at = place.current;
    if (!watching || at === null) {
      setOver(false);
      return;
    }
    let frame = 0;
    const check = () => {
      frame = 0;
      setOver(floatingOver(at.getBoundingClientRect(), document.querySelectorAll(FLOATING_SELECTOR)));
    };
    const soon = () => { if (frame === 0) frame = requestAnimationFrame(check); };
    const changes = new MutationObserver(soon);
    changes.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden", "open", "role"] });
    const resized = new ResizeObserver(soon);
    resized.observe(at);
    window.addEventListener("resize", soon);
    check();
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      changes.disconnect();
      resized.disconnect();
      window.removeEventListener("resize", soon);
    };
  }, [place, watching]);
  return over;
}
