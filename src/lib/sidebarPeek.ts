import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

/**
 * Settings → Appearance → Show the sidebar on hover (#2588, `sidebarPeek`): on a desktop with the
 * sidebar collapsed, a mouse resting on the sidebar's toggle shows the sidebar over the pane for a
 * moment, as the Claude desktop app's collapsed sidebar does. The pane keeps its width, nothing is
 * focused, and a click on the toggle keeps the sidebar open as it always did.
 */

/** how long the pointer rests on the toggle before the sidebar comes out: a pass over it shows nothing */
export const PEEK_OPEN_MS = 150;
/** how long the sidebar waits after the pointer left the toggle and the sidebar: the trip between them, or a wobble, keeps it */
export const PEEK_CLOSE_MS = 300;

export type PeekZone = "toggle" | "sidebar";

export interface SidebarPeek {
  enter(zone: PeekZone): void;
  leave(zone: PeekZone): void;
  /** puts it away at once (Escape); the pointer has to come back to the toggle to show it again */
  hide(): void;
  dispose(): void;
}

/** `held`: something opened from the sidebar is up (a row menu, a dialog), so the sidebar stays until it goes */
export function createSidebarPeek(onChange: (shown: boolean) => void, held: () => boolean): SidebarPeek {
  const inside = new Set<PeekZone>();
  let shown = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const show = (value: boolean): void => {
    if (shown === value) return;
    shown = value;
    onChange(value);
  };
  const closeLater = (): void => {
    timer = setTimeout(() => {
      timer = null;
      if (held()) closeLater();
      else show(false);
    }, PEEK_CLOSE_MS);
  };
  return {
    enter(zone) {
      // a hidden sidebar has no box to enter: only the toggle brings it out
      if (zone === "sidebar" && !shown) return;
      inside.add(zone);
      clear();
      if (!shown) timer = setTimeout(() => { timer = null; show(true); }, PEEK_OPEN_MS);
    },
    leave(zone) {
      if (!inside.delete(zone) || inside.size > 0) return;
      clear();
      if (shown) closeLater();
    },
    hide() {
      clear();
      inside.clear();
      show(false);
    },
    dispose: clear,
  };
}

/** a row menu or a dialog takes its own Escape and keeps the sidebar it was opened from */
const HOLDING = '[role="dialog"], [role="alertdialog"], [role="menu"]';

/**
 * `enabled`: the setting is on, the window is wide and the sidebar is collapsed. Turning it off (a click on
 * the toggle keeps the sidebar open) puts a peek away. Only a mouse peeks: a touch keeps the toggle's tap.
 */
export function useSidebarPeek(enabled: boolean) {
  const [peeking, setPeeking] = useState(false);
  const controller = useRef<SidebarPeek | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const peek = createSidebarPeek(setPeeking, () => document.querySelector(HOLDING) !== null);
    controller.current = peek;
    return () => {
      controller.current = null;
      peek.dispose();
      setPeeking(false);
    };
  }, [enabled]);
  // Escape puts the peek away and still reaches the pane: the focus never left it. A row menu, a dialog, an IME
  // composition, the sidebar's filter with words in it or a field with its own Escape takes it first
  useEffect(() => {
    if (!peeking) return;
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229) return;
      if (document.querySelector(HOLDING)) return;
      if (event.target instanceof HTMLInputElement && event.target.type === "search" && event.target.value !== "") return;
      if (event.target instanceof Element && event.target.closest("[data-own-escape]") !== null) return;
      controller.current?.hide();
    };
    window.addEventListener("keydown", onEscape, true);
    return () => window.removeEventListener("keydown", onEscape, true);
  }, [peeking]);
  const handlers = useMemo(() => {
    const zone = (name: PeekZone) => ({
      onPointerEnter: (event: ReactPointerEvent) => { if (event.pointerType === "mouse") controller.current?.enter(name); },
      onPointerLeave: (event: ReactPointerEvent) => { if (event.pointerType === "mouse") controller.current?.leave(name); },
    });
    return { toggle: zone("toggle"), sidebar: zone("sidebar") };
  }, []);
  return { peeking: enabled && peeking, toggleHandlers: handlers.toggle, sidebarHandlers: handlers.sidebar };
}
