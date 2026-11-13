import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement, type RefObject } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useKeptPaneBoxes } from "./coveredPane.ts";

interface Box { left: number; top: number; width: number; height: number }

/** a pane slot as the hook reads and writes it: its box, its kept-box attribute and the custom properties that carry the box */
class FakeSlot {
  box: Box;
  /** how often its box was read */
  reads = 0;
  readonly attributes = new Map<string, string>();
  readonly properties = new Map<string, string>();
  readonly style = {
    setProperty: (name: string, value: string): void => { this.properties.set(name, value); },
    removeProperty: (name: string): void => { this.properties.delete(name); },
  };
  constructor(box: Box) { this.box = box; }
  getBoundingClientRect(): Box { this.reads += 1; return { ...this.box }; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  kept(): Record<string, string> | null {
    return this.attributes.has("data-kept-box") ? Object.fromEntries(this.properties) : null;
  }
}

describe("useKeptPaneBoxes", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let slots: FakeSlot[];
  let areaBox: Box;
  /** how often the pane area was asked for its panes or its own box, and how many observers of any kind were made */
  let asked: { panes: number; box: number; observers: number };
  const area = { current: null } as unknown as RefObject<HTMLElement | null>;

  beforeEach(() => {
    for (const key of ["ResizeObserver", "MutationObserver", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    asked = { panes: 0, box: 0, observers: 0 };
    const Observer = class {
      constructor() { asked.observers += 1; }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
    for (const key of ["ResizeObserver", "MutationObserver"]) Object.defineProperty(globalThis, key, { configurable: true, value: Observer });
    slots = [];
    areaBox = { left: 0, top: 52, width: 390, height: 792 };
    (area as { current: unknown }).current = {
      querySelectorAll: () => { asked.panes += 1; return slots; },
      getBoundingClientRect: () => { asked.box += 1; return { ...areaBox }; },
    };
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  function Probe({ covered }: { covered: boolean }) {
    useKeptPaneBoxes(area, covered);
    return null;
  }
  const draw = async (covered: boolean): Promise<void> => {
    await act(async () => {
      if (renderer) renderer.update(createElement(Probe, { covered }));
      else renderer = create(createElement(Probe, { covered }));
    });
  };

  it("holds a covered pane in the box it was shown in, whatever the shell around it has become, and lets it go when it is shown again", async () => {
    // Given a pane shown under a phone's header.
    const slot = new FakeSlot({ left: 0, top: 52, width: 390, height: 792 });
    slots = [slot];
    await draw(false);
    expect(slot.kept()).toBeNull();

    // When the list covers it and the header is gone: the pane area starts at the screen's top.
    areaBox = { left: 0, top: 0, width: 390, height: 844 };
    await draw(true);

    // Then the pane keeps its box, placed inside the area as it now lies.
    expect(slot.kept()).toEqual({ "--kept-left": "0px", "--kept-top": "52px", "--kept-width": "390px", "--kept-height": "792px" });

    // When it is shown again.
    await draw(false);

    // Then nothing holds it.
    expect(slot.kept()).toBeNull();
    expect(slot.properties.size).toBe(0);
  });

  it("reads a pane's box as the list is about to cover it and not while it is covered: the box it keeps is the last it was shown in", async () => {
    const slot = new FakeSlot({ left: 0, top: 42, width: 1440, height: 830 });
    slots = [slot];
    await draw(false);
    // a wide window whose classic sidebar is collapsed: the mode draws its column, and the area moves and narrows
    areaBox = { left: 320, top: 0, width: 1120, height: 900 };
    await draw(true);
    expect(slot.kept()).toEqual({ "--kept-left": "-320px", "--kept-top": "42px", "--kept-width": "1440px", "--kept-height": "830px" });

    // the window is resized under the list: what the pane's element measures now is not a box it was shown in
    slot.box = { left: 0, top: 42, width: 1000, height: 600 };
    await draw(true);
    expect(slot.kept()).toEqual({ "--kept-left": "-320px", "--kept-top": "42px", "--kept-width": "1440px", "--kept-height": "830px" });

    // a row opens it as a thread beside the column, and Back covers it again: the thread's box is the one it keeps now
    await draw(false);
    slot.box = { left: 320, top: 0, width: 1120, height: 900 };
    await draw(true);
    expect(slot.kept()).toEqual({ "--kept-left": "0px", "--kept-top": "0px", "--kept-width": "1120px", "--kept-height": "900px" });
  });

  it("leaves alone a pane that came to the page under the list, until it has been shown", async () => {
    // Given a page that opened on the mode's list: its pane is drawn under the list and was never shown.
    areaBox = { left: 0, top: 0, width: 390, height: 844 };
    await draw(true);
    const slot = new FakeSlot({ left: 0, top: 0, width: 390, height: 844 });
    slots = [slot];
    await draw(true);
    expect(slot.kept()).toBeNull();

    // When a row shows it as a thread, and Back covers it.
    await draw(false);
    await draw(true);

    // Then it keeps the thread's box.
    expect(slot.kept()).toEqual({ "--kept-left": "0px", "--kept-top": "0px", "--kept-width": "390px", "--kept-height": "844px" });
  });

  it("reads nothing of the page and watches nothing while no list covers a pane, as in the classic app", async () => {
    const slot = new FakeSlot({ left: 0, top: 52, width: 390, height: 792 });
    slots = [slot];

    // When the classic app draws, and draws again.
    await draw(false);
    await draw(false);
    await draw(false);

    // Then no pane was looked for, no box was read and no observer was made.
    expect(asked).toEqual({ panes: 0, box: 0, observers: 0 });
    expect(slot.reads).toBe(0);
  });
});
