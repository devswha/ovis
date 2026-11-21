import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AppLoadFailed } from "../../components/AppCrash.tsx";
import { reloadAfterFailedLoad, reloadEntry, shellLoaded, takeEntryUrl, type TabMemory } from "./boot.ts";

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

  it("reloads at the address it was entered by, so a pairing offer the boot took off the address is still there", () => {
    const entered = "https://app.ovis.sh/s/0123456789abcdef0123456789abcdef/#offer=abc";
    let address = entered;
    const steps: string[] = [];
    const history = { replaceState: (_data: unknown, _unused: string, url: string) => { address = new URL(url, address).href; steps.push(`at ${address}`); } };
    const location = {
      get href() { return address; }, get pathname() { return new URL(address).pathname; },
      get search() { return new URL(address).search; }, get hash() { return new URL(address).hash; },
      reload: () => { steps.push(`reload ${address}`); },
    };
    const entryUrl = takeEntryUrl({ location, history });
    expect(address).not.toContain("#offer=");
    reloadEntry({ history, location }, entryUrl);
    expect(steps.at(-1)).toBe(`reload ${entered}`);
  });

  it("says it could not load in the device's language, though no settings provider set one yet", () => {
    const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["ko-KR"] });
    try {
      const html = renderToStaticMarkup(createElement(AppLoadFailed));
      expect(html).toContain("Ovis를 불러오지 못했습니다");
      expect(html).toContain("다시 시도");
    } finally {
      if (languages) Object.defineProperty(navigator, "languages", languages);
      else Reflect.deleteProperty(navigator, "languages");
    }
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
