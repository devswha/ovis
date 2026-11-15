import { useEffect, type RefObject } from "react";

import { HOLD_SLOP_PX } from "../lib/touchReorder.ts";

/**
 * Where the live call's orb rests: the side of the screen it snapped to, and how far down the
 * band it can travel (0: the top, under the header; 1: the foot). Per device, like the sidebar's
 * width, so it is no setting.
 */
export type OrbPlace = { side: "left" | "right"; y: number };

const KEY = "ovis:voice-orb";

export const DEFAULT_ORB_PLACE: OrbPlace = { side: "right", y: 0.3 };

const clamp = (value: number) => Math.min(1, Math.max(0, value));

/** The stored value as a place, the default for anything else. */
export function parseOrbPlace(raw: string | null): OrbPlace {
  try {
    const value: unknown = raw === null ? null : JSON.parse(raw);
    if (typeof value !== "object" || value === null) return DEFAULT_ORB_PLACE;
    const { side, y } = value as { side?: unknown; y?: unknown };
    if ((side !== "left" && side !== "right") || typeof y !== "number" || !Number.isFinite(y)) return DEFAULT_ORB_PLACE;
    return { side, y: clamp(y) };
  } catch {
    return DEFAULT_ORB_PLACE;
  }
}

type Box = { left: number; top: number; width: number; height: number };
type Area = { top: number; bottom: number; width: number };

/** Where an orb dropped at `box` snaps to: the nearer side, at its height within the band `area`. */
export function snapOrbPlace(box: Box, area: Area): OrbPlace {
  const side = box.left + box.width / 2 < area.width / 2 ? "left" : "right";
  const travel = area.bottom - area.top - box.height;
  return { side, y: travel > 0 ? clamp((box.top - area.top) / travel) : 0 };
}

export function storedOrbPlace(): OrbPlace {
  try {
    return parseOrbPlace(window.localStorage.getItem(KEY));
  } catch {
    return DEFAULT_ORB_PLACE;
  }
}

export function storeOrbPlace(place: OrbPlace): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(place));
  } catch {
    /* private mode: the place simply is not remembered */
  }
}

/** The room the orb has, between the header and the screen's foot. */
function orbArea(): Area {
  const margin = 8;
  const header = document.querySelector(".app-header")?.getBoundingClientRect().bottom ?? 0;
  return { top: header + margin, bottom: window.innerHeight - margin, width: window.innerWidth };
}

/**
 * A drag on `handle` carries `surface` with the finger, from where it was grabbed; let go, it
 * snaps to the nearer side and `onPlace` keeps it there. A press that moves less than a tap's
 * slop is the handle's own click, which a drag swallows.
 */
export function useOrbPlacement(handle: RefObject<HTMLElement | null>, surface: RefObject<HTMLElement | null>, onPlace: (place: OrbPlace) => void): void {
  useEffect(() => {
    const node = handle.current;
    if (!node) return;
    let stroke: { id: number; x: number; y: number; dx: number; dy: number; dragging: boolean } | null = null;
    let dragged = false;
    const release = () => {
      const target = surface.current;
      target?.classList.remove("is-dragging");
      target?.style.removeProperty("left");
      target?.style.removeProperty("top");
    };
    const down = (event: PointerEvent) => {
      const box = surface.current?.getBoundingClientRect();
      if (!event.isPrimary || event.button !== 0 || !box) return;
      dragged = false;
      stroke = { id: event.pointerId, x: event.clientX, y: event.clientY, dx: event.clientX - box.left, dy: event.clientY - box.top, dragging: false };
    };
    const move = (event: PointerEvent) => {
      const target = surface.current;
      if (!stroke || event.pointerId !== stroke.id || !target) return;
      if (!stroke.dragging) {
        if (Math.abs(event.clientX - stroke.x) <= HOLD_SLOP_PX && Math.abs(event.clientY - stroke.y) <= HOLD_SLOP_PX) return;
        stroke.dragging = true;
        node.setPointerCapture(event.pointerId);
        target.classList.add("is-dragging");
      }
      target.style.left = `${event.clientX - stroke.dx}px`;
      target.style.top = `${event.clientY - stroke.dy}px`;
    };
    const up = (event: PointerEvent) => {
      const was = stroke;
      if (!was || event.pointerId !== was.id) return;
      stroke = null;
      if (!was.dragging) return;
      dragged = true;
      const box = surface.current?.getBoundingClientRect();
      release();
      if (!box) return;
      const place = snapOrbPlace(box, orbArea());
      storeOrbPlace(place);
      onPlace(place);
    };
    const cancel = (event: PointerEvent) => {
      if (stroke?.id !== event.pointerId) return;
      stroke = null;
      release();
    };
    // a drag ends in a click on the handle: it is not a tap
    const click = (event: MouseEvent) => {
      if (!dragged) return;
      dragged = false;
      event.stopPropagation();
      event.preventDefault();
    };
    node.addEventListener("pointerdown", down);
    node.addEventListener("pointermove", move);
    node.addEventListener("pointerup", up);
    node.addEventListener("pointercancel", cancel);
    node.addEventListener("click", click);
    return () => {
      node.removeEventListener("pointerdown", down);
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerup", up);
      node.removeEventListener("pointercancel", cancel);
      node.removeEventListener("click", click);
      release();
    };
  }, [handle, surface, onPlace]);
}
