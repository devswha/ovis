import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { foldWorkCard, useWorkCardFolded, WORK_CARD_FOLD_KEY } from "./workCard.ts";

type Seen = { current: boolean | null };
function Probe({ seen }: { seen: Seen }) {
  seen.current = useWorkCardFolded();
  return null;
}

describe("useWorkCardFolded", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let records: Map<string, string>;
  let storageHandlers: Set<(event: { key: string | null }) => void>;

  beforeEach(() => {
    for (const key of ["window", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    records = new Map();
    storageHandlers = new Set();
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      localStorage: { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => { records.set(key, value); } },
      addEventListener: (type: string, handler: (event: { key: string | null }) => void) => { if (type === "storage") storageHandlers.add(handler); },
      removeEventListener: (type: string, handler: (event: { key: string | null }) => void) => { if (type === "storage") storageHandlers.delete(handler); },
    } });
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    foldWorkCard(false);
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  const show = async (seen: Seen): Promise<void> => { await act(async () => { renderer = create(createElement(Probe, { seen })); }); };

  it("reads what this device kept, and every card follows a fold made anywhere on the device", async () => {
    records.set(WORK_CARD_FOLD_KEY, "true");
    const first: Seen = { current: null };
    const second: Seen = { current: null };
    await show(first);
    expect(first.current).toBe(true);
    await act(async () => { renderer?.unmount(); });
    await act(async () => { renderer = create(createElement("div", null, createElement(Probe, { seen: first }), createElement(Probe, { seen: second }))); });
    expect(second.current).toBe(true);
    await act(async () => { foldWorkCard(false); });
    expect([first.current, second.current]).toEqual([false, false]);
    await act(async () => { foldWorkCard(true); });
    expect([first.current, second.current]).toEqual([true, true]);
    expect(records.get(WORK_CARD_FOLD_KEY)).toBe("true");
  });

  it("follows another tab's fold, and a storage that was cleared", async () => {
    const seen: Seen = { current: null };
    await show(seen);
    expect(seen.current).toBe(false);
    records.set(WORK_CARD_FOLD_KEY, "true");
    await act(async () => { for (const handler of [...storageHandlers]) handler({ key: WORK_CARD_FOLD_KEY }); });
    expect(seen.current).toBe(true);
    records.delete(WORK_CARD_FOLD_KEY);
    await act(async () => { for (const handler of [...storageHandlers]) handler({ key: null }); });
    expect(seen.current).toBe(false);
  });

  it("ignores another key's change, and lets go of the page's events when the card goes", async () => {
    const seen: Seen = { current: null };
    await show(seen);
    records.set(WORK_CARD_FOLD_KEY, "true");
    await act(async () => { for (const handler of [...storageHandlers]) handler({ key: "ovis:something-else" }); });
    expect(seen.current).toBe(false);
    expect(storageHandlers.size).toBe(1);
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    expect(storageHandlers.size).toBe(0);
  });
});
