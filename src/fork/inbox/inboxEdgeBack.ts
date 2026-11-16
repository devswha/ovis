import { useEffect, useRef } from "react";

import { strokeFree, swipeVerdict } from "../../lib/edgeSwipe.ts";

/**
 * In an agent inbox thread on a phone, a swipe in from the left edge goes back to the list, as the drawer's
 * swipe does in the workspaces view (lib/edgeSwipe.ts, with the same edge and distance). The Android app keeps
 * the middle of that edge from the system's Back for the page (MainActivity.claimDrawerEdge), so without this
 * the inbox, which has no drawer, left it doing nothing. Nothing slides: the list is not drawn under a thread,
 * so `back`, the header's Back, runs once the stroke has gone far enough.
 */
export function useInboxEdgeBack(on: boolean, back: () => void): void {
  const backRef = useRef(back); backRef.current = back;
  useEffect(() => {
    if (!on) return;
    const narrow = window.matchMedia("(max-width: 768px)");
    let start: { x: number; y: number } | null = null;
    let claimed = false;
    const onStart = (event: TouchEvent): void => {
      const touch = event.touches[0];
      start = event.touches.length === 1 && touch && narrow.matches && strokeFree(event.target, false) ? { x: touch.clientX, y: touch.clientY } : null;
      claimed = false;
    };
    const onMove = (event: TouchEvent): void => {
      const touch = event.touches[0];
      if (start === null || !touch) return;
      const verdict = swipeVerdict(false, start.x, touch.clientX - start.x, touch.clientY - start.y);
      if (!claimed && verdict === "pending") return;
      if (verdict === "ignore") { start = null; return; }
      claimed = true;
      // the stroke is the thread's now, not the transcript's or the terminal's under the finger
      event.preventDefault();
      event.stopPropagation();
      if (verdict === "open") { start = null; backRef.current(); }
    };
    const onEnd = (): void => { start = null; claimed = false; };
    // on the window, so it hears the stroke before the drawer's watcher on the document
    window.addEventListener("touchstart", onStart, { capture: true, passive: true });
    window.addEventListener("touchmove", onMove, { capture: true, passive: false });
    window.addEventListener("touchend", onEnd, { capture: true, passive: true });
    window.addEventListener("touchcancel", onEnd, { capture: true, passive: true });
    return () => {
      window.removeEventListener("touchstart", onStart, { capture: true });
      window.removeEventListener("touchmove", onMove, { capture: true });
      window.removeEventListener("touchend", onEnd, { capture: true });
      window.removeEventListener("touchcancel", onEnd, { capture: true });
    };
  }, [on]);
}
