import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

const SLOTS = ":scope > .pane-slot";
const KEPT = "data-kept-box";
const SIDES = ["left", "top", "width", "height"] as const;

/**
 * A pane the inbox mode's list stands over keeps the box it was shown in (App.tsx; InboxList.css draws it there). The
 * list takes the shell's bars away, from 769px it draws its column whether or not the classic sidebar was open, and a
 * classic split becomes one pane, so laid out again under the list the pane would have another box than the one its
 * pty was sized to. It sizes nothing while covered (PaneCoveredContext); held in its box, its terminal does not even
 * see a change. Each pane's box is noted as it is shown and never while the list covers it, and a pane whose box was
 * never seen is left to the layout.
 */
export function useKeptPaneBoxes(area: RefObject<HTMLElement | null>, covered: boolean): void {
  const boxes = useRef(new WeakMap<Element, { left: number; top: number; width: number; height: number }>());
  const coveredRef = useRef(covered);
  coveredRef.current = covered;
  const watch = useRef<ResizeObserver | null>(null);
  const watched = useRef(new Set<Element>());
  useEffect(() => {
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver((entries) => {
      if (coveredRef.current) return;
      for (const entry of entries) boxes.current.set(entry.target, entry.target.getBoundingClientRect());
    });
    watch.current = observer;
    return () => {
      observer.disconnect();
      watch.current = null;
      watched.current.clear();
    };
  }, []);
  // a split adds and removes panes: the ones there now are watched, and one that left the page is let go, so the
  // watch never keeps a closed pane's terminal alive
  useEffect(() => {
    const observer = watch.current;
    if (observer === null) return;
    const here = new Set<Element>(area.current?.querySelectorAll(SLOTS) ?? []);
    for (const slot of watched.current) {
      if (here.has(slot)) continue;
      observer.unobserve(slot);
      watched.current.delete(slot);
    }
    for (const slot of here) {
      if (watched.current.has(slot)) continue;
      observer.observe(slot);
      watched.current.add(slot);
    }
  });
  useLayoutEffect(() => {
    const host = area.current;
    if (!covered || host === null) return;
    const origin = host.getBoundingClientRect();
    const held: HTMLElement[] = [];
    for (const slot of host.querySelectorAll<HTMLElement>(SLOTS)) {
      const box = boxes.current.get(slot);
      if (box === undefined) continue;
      const place = { left: box.left - origin.left, top: box.top - origin.top, width: box.width, height: box.height };
      for (const side of SIDES) slot.style.setProperty(`--kept-${side}`, `${place[side]}px`);
      slot.setAttribute(KEPT, "");
      held.push(slot);
    }
    return () => {
      for (const slot of held) {
        slot.removeAttribute(KEPT);
        for (const side of SIDES) slot.style.removeProperty(`--kept-${side}`);
      }
    };
  }, [covered]);
}
