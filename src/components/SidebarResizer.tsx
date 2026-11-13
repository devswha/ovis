import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import "./SidebarResizer.css";

import { useT } from "../lib/i18n.ts";
import { clampSidebarWidth, keyedSidebarWidth, sidebarMaxWidth, SIDEBAR_MIN_WIDTH, storeSidebarWidth } from "../lib/sidebarWidth.ts";

/**
 * Whether (x, y) lies on the drawn scrollbar of a scrolling list inside `sidebar`. Read through the
 * grip, which lies over the sidebar's right edge where such a scrollbar stands. An overlay scrollbar
 * takes no width and is not found.
 */
function onListScrollbar(sidebar: Element | null | undefined, x: number, y: number): boolean {
  if (!sidebar) return false;
  return document.elementsFromPoint(x, y).some((element) => {
    if (!(element instanceof HTMLElement) || element === sidebar || !sidebar.contains(element) || element.scrollHeight <= element.clientHeight) return false;
    const border = parseFloat(getComputedStyle(element).borderRightWidth) || 0;
    const bar = element.offsetWidth - element.clientWidth - element.clientLeft - border;
    const right = element.getBoundingClientRect().right - border;
    return bar > 0 && x >= right - bar && x < right;
  });
}

export interface SidebarResizerProps {
  /** the chosen width in px; null is the density's own */
  width: number | null;
  onResize(width: number | null): void;
}

/**
 * The sidebar's right edge, as herdr's: drag it to resize, double-click to go back to the
 * default width. Drawn inside the sidebar it sizes; a phone's drawer has none.
 */
export function SidebarResizer({ width, onResize }: SidebarResizerProps) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ left: number; grip: number; width: number; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  // the pointer rests on a list's scrollbar under the grip: the grip lets it through to that scrollbar,
  // and the strip beside it still resizes. Held while a button is down, so no press changes hands
  const [yielding, setYielding] = useState(false);
  // what the sidebar measures now: the default width is a token, and a narrow window caps a chosen one
  const [shown, setShown] = useState(width ?? SIDEBAR_MIN_WIDTH);
  // the widest the keys allow in this window; a resize can move it while the sidebar's own width holds
  const [limit, setLimit] = useState(() => sidebarMaxWidth(window.innerWidth));
  const measure = (): number => {
    const measured = Math.round(ref.current?.parentElement?.getBoundingClientRect().width ?? shown);
    // a closed sidebar measures nothing; the last width it showed stays the value
    if (measured > 0) setShown(measured);
    setLimit(sidebarMaxWidth(window.innerWidth));
    return measured;
  };
  useLayoutEffect(() => { measure(); }, [width]);
  // the default width follows the density setting, with no width prop and no window resize to say so
  useEffect(() => {
    const sidebar = ref.current?.parentElement;
    if (!sidebar || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => { measure(); });
    observer.observe(sidebar);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const onPointerMove = (event: globalThis.PointerEvent): void => {
      if (event.buttons !== 0 || event.pointerType === "touch") return;
      const grip = ref.current;
      if (!grip) return;
      const box = grip.getBoundingClientRect();
      const over = event.clientX >= box.left && event.clientX < box.right && event.clientY >= box.top && event.clientY < box.bottom;
      setYielding(over && onListScrollbar(grip.parentElement, event.clientX, event.clientY));
    };
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    return () => window.removeEventListener("pointermove", onPointerMove);
  }, []);
  useEffect(() => {
    const onWindowResize = (): void => { measure(); };
    window.addEventListener("resize", onWindowResize);
    return () => window.removeEventListener("resize", onWindowResize);
  }, []);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    const sidebar = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!sidebar) return;
    // no text selection in the pane while the edge moves
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { left: sidebar.left, grip: event.clientX - sidebar.right, width: Math.round(sidebar.width), moved: false };
    setDragging(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const state = drag.current;
    if (!state) return;
    const next = clampSidebarWidth(event.clientX - state.grip - state.left, window.innerWidth);
    if (next === state.width) return;
    state.width = next;
    state.moved = true;
    onResize(next);
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>): void => {
    const state = drag.current;
    if (!state) return;
    drag.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    // a press that moved nothing chooses no width; the drag's own record says so, since the
    // width prop of a first drag may not have come back yet
    if (state.moved) storeSidebarWidth(state.width);
  };
  const reset = (): void => {
    storeSidebarWidth(null);
    onResize(null);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const next = keyedSidebarWidth(measure(), event.key, window.innerWidth);
    if (next === null) return;
    event.preventDefault();
    storeSidebarWidth(next);
    onResize(next);
  };

  return (
    <div
      ref={ref}
      className={`sidebar-resizer${dragging ? " is-dragging" : ""}${yielding ? " is-yielding" : ""}`}
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={t("Resize sidebar")}
      aria-valuemin={SIDEBAR_MIN_WIDTH}
      aria-valuemax={limit}
      aria-valuenow={shown}
      title={t("Drag to resize · double-click to reset")}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={reset}
      onFocus={measure}
      onKeyDown={onKeyDown}
    />
  );
}
