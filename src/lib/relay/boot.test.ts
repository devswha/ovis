import { describe, expect, it } from "bun:test";

import { reloadAfterFailedLoad, shellLoaded, type TabMemory } from "./boot.ts";

function tab(): TabMemory {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => { items.set(key, value); },
    removeItem: (key) => { items.delete(key); },
  };
}

describe("a shell whose code failed to load", () => {
  it("reloads once, then leaves the page to the notice until a load succeeds", () => {
    const memory = tab();
    expect(reloadAfterFailedLoad(memory)).toBe(true);
    expect(reloadAfterFailedLoad(memory)).toBe(false);
    expect(reloadAfterFailedLoad(memory)).toBe(false);
    shellLoaded(memory);
    expect(reloadAfterFailedLoad(memory)).toBe(true);
  });

  it("does not reload where the tab keeps nothing, so a failing host cannot loop it", () => {
    const refusing: TabMemory = {
      getItem: () => null,
      setItem: () => { throw new DOMException("full", "QuotaExceededError"); },
      removeItem: () => {},
    };
    expect(reloadAfterFailedLoad(refusing)).toBe(false);
    expect(reloadAfterFailedLoad({ ...tab(), setItem: () => {} })).toBe(false);
    expect(reloadAfterFailedLoad(null)).toBe(false);
  });
});
