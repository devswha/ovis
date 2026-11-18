import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import "./FilePanelResizer.css";

import { clampFilePanelWidth, filePanelMaxWidth, filePanelMinWidth, keyedFilePanelWidth, storeFilePanelWidth, type FilePanelKind } from "../lib/filePanelWidth.ts";
import { useT } from "../lib/i18n.ts";

export interface FilePanelResizerProps {
  width: number | null;
  kind?: FilePanelKind;
  onResize(width: number | null): void;
}

export function FilePanelResizer({ width, kind = "file", onResize }: FilePanelResizerProps) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ right: number; grip: number; width: number; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [shown, setShown] = useState(width ?? filePanelMinWidth(kind));
  const [limit, setLimit] = useState(() => filePanelMaxWidth(window.innerWidth, 0, kind));
  const occupiedWidth = (): number => {
    const body = ref.current?.closest(".app-body");
    const sidebar = body?.querySelector(".sidebar")?.getBoundingClientRect().width ?? 0;
    if (kind === "file") return sidebar + (body?.querySelector(".files-panel")?.getBoundingClientRect().width ?? 0);
    // A browser drag can shrink the preview, but reserves its preferred minimum (or half the room left).
    return sidebar + (body?.querySelector(".file-panel") ? Math.min(220, Math.max(0, (window.innerWidth - sidebar - 320) / 2)) : 0);
  };
  const measure = (): number => {
    const measured = Math.floor(ref.current?.parentElement?.getBoundingClientRect().width ?? shown);
    if (measured > 0) setShown(measured);
    setLimit(filePanelMaxWidth(window.innerWidth, occupiedWidth(), kind));
    return measured > 0 ? measured : shown;
  };
  useLayoutEffect(() => { measure(); }, [width]);
  useEffect(() => {
    const panel = ref.current?.parentElement;
    if (!panel || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => { measure(); });
    observer.observe(panel);
    const sidebar = panel.parentElement?.querySelector(".sidebar");
    if (sidebar) observer.observe(sidebar);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const onWindowResize = (): void => { measure(); };
    window.addEventListener("resize", onWindowResize);
    return () => window.removeEventListener("resize", onWindowResize);
  }, []);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    const panel = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!panel) return;
    // no text selection in the file while the edge moves
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { right: panel.right, grip: event.clientX - panel.left, width: Math.round(panel.width), moved: false };
    setDragging(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const state = drag.current;
    if (!state) return;
    const next = clampFilePanelWidth(state.right - (event.clientX - state.grip), window.innerWidth, occupiedWidth(), kind);
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
    if (state.moved) storeFilePanelWidth(state.width, kind);
  };
  const reset = (): void => {
    storeFilePanelWidth(null, kind);
    onResize(null);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const next = keyedFilePanelWidth(measure(), event.key, window.innerWidth, occupiedWidth(), kind);
    if (next === null) return;
    event.preventDefault();
    storeFilePanelWidth(next, kind);
    onResize(next);
  };

  return (
    <div
      ref={ref}
      className={`file-panel-resizer${dragging ? " is-dragging" : ""}`}
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={t("Resize file panel")}
      aria-valuemin={Math.min(filePanelMinWidth(kind), limit)}
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
