import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement, type RefObject } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useKeptPaneBoxes } from "./coveredPane.ts";

interface Box { left: number; top: number; width: number; height: number }

/** a pane slot as the hook reads and writes it: its box, its kept-box attribute and the custom properties that carry the box */
class FakeSlot {
  box: Box;
  readonly attributes = new Map<string, string>();
  readonly properties = new Map<string, string>();
  readonly style = {
    setProperty: (name: string, value: string): void => { this.properties.set(name, value); },
    removeProperty: (name: string): void => { this.properties.delete(name); },
  };
  constructor(box: Box) { this.box = box; }
  getBoundingClientRect(): Box { return { ...this.box }; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  kept(): Record<string, string> | null {
    return this.attributes.has("data-kept-box") ? Object.fromEntries(this.properties) : null;
  }
}

describe("useKeptPaneBoxes", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let observed: Set<FakeSlot>;
  let notify: (slots: FakeSlot[]) => void;
  let slots: FakeSlot[];
  let areaBox: Box;
  const area = { current: null } as unknown as RefObject<HTMLElement | null>;

  beforeEach(() => {
    for (const key of ["ResizeObserver", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    observed = new Set();
    notify = () => {};
    Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: class {
      constructor(callback: (entries: { target: FakeSlot }[]) => void) { notify = (changed) => callback(changed.map((target) => ({ target }))); }
      observe(target: FakeSlot): void { observed.add(target); }
      unobserve(target: FakeSlot): void { observed.delete(target); }
      disconnect(): void { observed.clear(); }
    } });
    slots = [];
    areaBox = { left: 0, top: 52, width: 390, height: 792 };
    (area as { current: unknown }).current = {
      querySelectorAll: () => slots,
      getBoundingClientRect: () => ({ ...areaBox }),
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
    expect(observed.has(slot)).toBe(true);
    notify([slot]);
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

  it("notes no box while the list covers the pane: the one it keeps is the last it was shown in", async () => {
    const slot = new FakeSlot({ left: 0, top: 42, width: 1440, height: 830 });
    slots = [slot];
    await draw(false);
    notify([slot]);
    // a wide window whose classic sidebar is collapsed: the mode draws its column, and the area moves and narrows
    areaBox = { left: 320, top: 0, width: 1120, height: 900 };
    await draw(true);
    expect(slot.kept()).toEqual({ "--kept-left": "-320px", "--kept-top": "42px", "--kept-width": "1440px", "--kept-height": "830px" });
    // the window is resized under the list: what the pane's element measures now is not a box it was shown in
    slot.box = { left: 0, top: 42, width: 1000, height: 600 };
    notify([slot]);
    await draw(false);
    await draw(true);
    expect(slot.kept()).toEqual({ "--kept-left": "-320px", "--kept-top": "42px", "--kept-width": "1440px", "--kept-height": "830px" });
  });

  it("lets go of a pane that left the page", async () => {
    const first = new FakeSlot({ left: 0, top: 42, width: 720, height: 830 });
    const second = new FakeSlot({ left: 720, top: 42, width: 720, height: 830 });
    slots = [first, second];
    await draw(false);
    expect([...observed]).toEqual([first, second]);
    // the split ends: its second pane's element is gone
    slots = [first];
    await draw(false);
    expect([...observed]).toEqual([first]);
  });

  it("leaves alone a pane whose box it never saw, and watches the panes a split adds", async () => {
    const first = new FakeSlot({ left: 0, top: 42, width: 720, height: 830 });
    slots = [first];
    await draw(false);
    notify([first]);
    const second = new FakeSlot({ left: 720, top: 42, width: 720, height: 830 });
    slots = [first, second];
    await draw(false);
    expect(observed.has(second)).toBe(true);
    areaBox = { left: 0, top: 0, width: 1440, height: 900 };
    await draw(true);
    expect(first.kept()).toEqual({ "--kept-left": "0px", "--kept-top": "42px", "--kept-width": "720px", "--kept-height": "830px" });
    expect(second.kept()).toBeNull();
  });
});
