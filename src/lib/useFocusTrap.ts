import { useEffect, useLayoutEffect, useRef, type MutableRefObject, type RefObject } from "react";
import { typeAheadFocused } from "./typeAhead.ts";

const FOCUSABLE = [
  "a[href]",
  "area[href]",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "iframe",
  "audio[controls]",
  "video[controls]",
  "[tabindex]",
  "[contenteditable]",
].join(",");

export interface FocusTrapOptions {
  initialFocus?: RefObject<HTMLElement | null>;
  shouldRestore?: () => boolean;
  paused?: boolean;
  leadingStops?: () => readonly HTMLElement[];
  startOnSurface?: boolean;
}

const heldSurfaces = new Set<HTMLElement>();

export function inFocusTrap(node: Element): boolean {
  for (const surface of heldSurfaces) if (surface.contains(node)) return true;
  return false;
}

function reachable(node: HTMLElement): boolean {
  if (node.hasAttribute("disabled") || node.getAttribute("aria-hidden") === "true") return false;
  if (node.tabIndex < 0) return false;
  if (node.closest("[inert]") !== null) return false;
  // hidden ancestors and collapsed sections report no box at all
  return node.getClientRects().length > 0;
}

function tabStops(surface: HTMLElement, options: FocusTrapOptions): HTMLElement[] {
  return [...(options.leadingStops?.() ?? []), ...surface.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(reachable);
}

export function overlayStops(): HTMLElement[] {
  const stops: HTMLElement[] = [];
  for (const prompt of document.querySelectorAll<HTMLElement>(".relay-pairing-prompt")) {
    if (prompt.closest("[inert]") !== null || prompt.getClientRects().length === 0) continue;
    stops.push(prompt, ...[...prompt.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(reachable));
  }
  return stops;
}

function overlayOf(stop: HTMLElement): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>(".relay-pairing-prompt")].find((prompt) => prompt.contains(stop));
}

export function overlayEntry(next: HTMLElement, active: Element | null): HTMLElement {
  const overlay = overlayOf(next);
  return overlay === undefined || overlay === next || (active !== null && overlay.contains(active)) ? next : overlay;
}

export function tabTarget(stops: readonly HTMLElement[], active: Element | null, back: boolean): HTMLElement | undefined {
  const at = active === null ? -1 : stops.indexOf(active as HTMLElement);
  return back
    ? (at <= 0 ? stops[stops.length - 1] : stops[at - 1])
    : (at === stops.length - 1 ? stops[0] : stops[at + 1]);
}

const openTraps: object[] = [];

/**
 * A native modal (`showModal()`, as Add PC opens) the surface is not part of. It never joins
 * `openTraps`, but the browser puts it in the top layer and makes the rest of the page inert, so
 * while it is open it owns Tab, Escape and the focus, and every trap and overlay beneath stands down.
 */
export function nativeModalOver(surface: HTMLElement | null): boolean {
  for (const dialog of document.querySelectorAll("dialog")) {
    if (!dialog.matches(":modal")) continue;
    if (surface && (dialog.contains(surface) || surface.contains(dialog))) continue;
    return true;
  }
  return false;
}

/**
 * The keyboard is in another `aria-modal` surface than this one. Window and document listeners run in the order
 * they were added, not the order the dialogs are drawn in, so a dialog beneath leaves this Escape to the one in
 * front, the one with the focus (#3037).
 */
export function focusInOtherModal(surface: HTMLElement | null): boolean {
  const focused = document.activeElement?.closest("[aria-modal='true']");
  return focused != null && focused !== surface;
}

export function useFocusTrap<T extends HTMLElement>(open: boolean, options: FocusTrapOptions = {}): MutableRefObject<T | null> {
  const surface = useRef<T | null>(null);
  const latest = useRef(options);
  latest.current = options;
  useLayoutEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      if (latest.current.paused || latest.current.shouldRestore?.() === false || !opener?.isConnected || nativeModalOver(surface.current)) return;
      opener.focus({ preventScroll: true });
      if (document.activeElement !== opener) queueMicrotask(() => {
        const active = document.activeElement;
        if (opener.isConnected && (active === null || active === document.body)) opener.focus({ preventScroll: true });
      });
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || options.paused) return;
    const node = surface.current;
    if (node && !nativeModalOver(node) && !node.contains(document.activeElement)) {
      // AutoFocus or a child's layout effect may already have placed focus inside the surface.
      // Otherwise try the preferred control, then a tab stop, then the surface: a connected
      // control can still refuse focus (disabled, hidden or inside a disabled fieldset).
      const wanted = latest.current.startOnSurface ? node : latest.current.initialFocus?.current;
      wanted?.focus({ preventScroll: true });
      const own = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(reachable);
      if (!node.contains(document.activeElement)) own[0]?.focus({ preventScroll: true });
      if (!node.contains(document.activeElement)) node.focus({ preventScroll: true });
    }
  }, [open, options.paused]);

  useLayoutEffect(() => {
    if (!open || options.paused) return;
    const node = surface.current;
    if (!node) return;
    heldSurfaces.add(node);
    return () => { heldSurfaces.delete(node); };
  }, [open, options.paused]);

  useEffect(() => {
    if (!open || options.paused) return;
    const trap = {};
    openTraps.push(trap);
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Tab" || openTraps.at(-1) !== trap || typeAheadFocused()) return;
      const node = surface.current;
      if (!node || nativeModalOver(node)) return;
      const holder = document.activeElement;
      if (holder instanceof Element && !node.contains(holder) && holder.closest('[role="dialog"], [role="alertdialog"], [role="menu"]') !== null) return;
      const stops = [...tabStops(node, latest.current), ...overlayStops()];
      const stop = tabTarget(stops, document.activeElement, event.shiftKey);
      const next = stop && overlayEntry(stop, document.activeElement);
      event.preventDefault();
      next?.focus({ preventScroll: true });
      const overlay = next && overlayOf(next);
      if (!overlay) return;
      overlay.scrollIntoView({ block: "nearest" });
      if (next !== overlay) next.scrollIntoView({ block: "nearest" });
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      openTraps.splice(openTraps.indexOf(trap), 1);
    };
  }, [open, options.paused]);

  return surface;
}

export function useFocusReturn(shown: boolean): void {
  useLayoutEffect(() => {
    if (!shown) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      // after the surface left the DOM: a focus it held is the body's now
      const active = document.activeElement;
      if (active !== null && active !== document.body) return;
      if (opener?.isConnected && !nativeModalOver(null)) opener.focus({ preventScroll: true });
    };
  }, [shown]);
}
