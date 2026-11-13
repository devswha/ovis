import { useLayoutEffect, useRef, type RefObject } from "react";

const SLOTS = ":scope > .pane-slot";
const KEPT = "data-kept-box";
const SIDES = ["left", "top", "width", "height"] as const;

/**
 * A pane the inbox mode's list stands over keeps the box it was shown in (App.tsx; InboxList.css draws it there). The
 * list takes the shell's bars away, from 769px it draws its column whether or not the classic sidebar was open, and a
 * classic split becomes one pane, so laid out again under the list the pane would have another box than the one its
 * pty was sized to. It sizes nothing while covered (PaneCoveredContext); held in its box, its terminal does not even
 * see a change.
 *
 * Each pane's box is read as the list is about to cover it: the render that says so runs before React writes any of
 * it to the page, which still lies as the pane was shown, in the classic app or in a thread. Nothing is read at any
 * other time and nothing is watched, so the classic app, where no list covers a pane, does none of this. A pane
 * that was not on the page then (one a page opened under its list) is left to the layout.
 */
export function useKeptPaneBoxes(area: RefObject<HTMLElement | null>, covered: boolean): void {
  const boxes = useRef(new WeakMap<Element, { left: number; top: number; width: number; height: number }>());
  /** whether the list covered the panes as the page was last written */
  const wasCovered = useRef(false);
  if (covered && !wasCovered.current) {
    for (const slot of area.current?.querySelectorAll(SLOTS) ?? []) boxes.current.set(slot, slot.getBoundingClientRect());
  }
  useLayoutEffect(() => {
    wasCovered.current = covered;
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
