import { useInsertionEffect, useLayoutEffect, useRef, type RefObject } from "react";

const SLOTS = ":scope > .pane-slot";
const KEPT = "data-kept-box";
const SIDES = ["left", "top", "width", "height"] as const;
const HELD = ["position", ...SIDES, "--header-over"] as const;
interface Box { left: number; top: number; width: number; height: number; over: string }

function place(slot: HTMLElement, box: Box, origin: { left: number; top: number }): void {
  const at = { position: "absolute", left: `${box.left - origin.left}px`, top: `${box.top - origin.top}px`, width: `${box.width}px`, height: `${box.height}px`, "--header-over": box.over };
  for (const name of HELD) if (at[name] !== "") slot.style.setProperty(name, at[name]);
}

export function useKeptPaneBoxes(area: RefObject<HTMLElement | null>, covered: boolean): void {
  const boxes = useRef(new WeakMap<Element, Box>());
  const bySlot = useRef(new Map<string, Box>());
  const origin = useRef<{ left: number; top: number } | null>(null);
  const wasCovered = useRef(false);
  const held = useRef<{ slot: HTMLElement; box: Box; own: string[]; wrote: string[] }[]>([]);
  if (covered && !wasCovered.current) {
    const host = area.current;
    if (host !== null) {
      const at = host.getBoundingClientRect();
      origin.current = { left: at.left, top: at.top };
      for (const slot of host.querySelectorAll(SLOTS)) {
        const read = slot.getBoundingClientRect();
        const box = { left: read.left, top: read.top, width: read.width, height: read.height, over: getComputedStyle(slot).getPropertyValue("--header-over").trim() };
        boxes.current.set(slot, box);
        const id = slot.getAttribute("data-slot");
        if (id !== null) bySlot.current.set(id, box);
      }
    }
  }
  useInsertionEffect(() => {
    wasCovered.current = covered;
    const host = area.current;
    const from = origin.current;
    if (!covered || host === null || from === null) return;
    const entries: typeof held.current = [];
    for (const slot of host.querySelectorAll<HTMLElement>(SLOTS)) {
      const id = slot.getAttribute("data-slot");
      const box = boxes.current.get(slot) ?? (id === null ? undefined : bySlot.current.get(id));
      if (box === undefined) continue;
      const own = HELD.map((name) => slot.style.getPropertyValue(name));
      place(slot, box, from);
      // as the style reads the values back: a length may be written with fewer digits than it was given
      entries.push({ slot, box, own, wrote: HELD.map((name) => slot.style.getPropertyValue(name)) });
      slot.setAttribute(KEPT, "");
    }
    held.current = entries;
    return () => {
      for (const { slot, own, wrote } of entries) {
        slot.removeAttribute(KEPT);
        HELD.forEach((name, at) => {
          if (slot.style.getPropertyValue(name) !== wrote[at]) return;
          if (own[at]) slot.style.setProperty(name, own[at]); else slot.style.removeProperty(name);
        });
      }
      held.current = [];
    };
  }, [covered]);
  useLayoutEffect(() => {
    const host = area.current;
    if (!covered || host === null || held.current.length === 0) return;
    const now = host.getBoundingClientRect();
    for (const entry of held.current) {
      place(entry.slot, entry.box, now);
      entry.wrote = HELD.map((name) => entry.slot.style.getPropertyValue(name));
    }
  }, [covered]);
}
