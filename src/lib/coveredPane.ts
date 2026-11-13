import { useLayoutEffect, useRef, type RefObject } from "react";

const SLOTS = ":scope > .pane-slot";
const KEPT = "data-kept-box";
const SIDES = ["left", "top", "width", "height"] as const;
/** what the hold writes on a slot's own style: a split's slot carries its rectangle there (App.tsx), as percentages */
const HELD = ["position", ...SIDES] as const;

/**
 * A pane the inbox mode's list stands over keeps the box it was shown in (App.tsx; InboxList.css draws it there). The
 * list takes the shell's bars away, from 769px it draws its column whether or not the classic sidebar was open, and a
 * classic split becomes one pane, so laid out again under the list the pane would have another box than the one its
 * pty was sized to. It sizes nothing while covered (PaneCoveredContext); held in its box, its terminal does not even
 * see a change. The box is written on the slot's own style, which outranks the rectangle a split's slot carries there.
 * Shown again, the slot gets back what its style held only where that still is the hold's value: the commit that
 * shows a thread clears a split slot's rectangle before the hold lets go, and what React wrote then stands.
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
    const held: { slot: HTMLElement; own: string[]; wrote: string[] }[] = [];
    for (const slot of host.querySelectorAll<HTMLElement>(SLOTS)) {
      const box = boxes.current.get(slot);
      if (box === undefined) continue;
      const place = { position: "absolute", left: `${box.left - origin.left}px`, top: `${box.top - origin.top}px`, width: `${box.width}px`, height: `${box.height}px` };
      const own = HELD.map((name) => slot.style.getPropertyValue(name));
      for (const name of HELD) slot.style.setProperty(name, place[name]);
      // as the style reads the values back: a length may be written with fewer digits than it was given
      held.push({ slot, own, wrote: HELD.map((name) => slot.style.getPropertyValue(name)) });
      slot.setAttribute(KEPT, "");
    }
    return () => {
      for (const { slot, own, wrote } of held) {
        slot.removeAttribute(KEPT);
        HELD.forEach((name, at) => {
          if (slot.style.getPropertyValue(name) !== wrote[at]) return;
          if (own[at]) slot.style.setProperty(name, own[at]); else slot.style.removeProperty(name);
        });
      }
    };
  }, [covered]);
}
