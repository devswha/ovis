import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { LanExposureNotice } from "../components/LanExposureNotice.tsx";
import { useDirectNotice } from "./directNotice.ts";
import { SettingsProvider } from "./settings.ts";

interface ProbeProps { scope: string; host: string | null | undefined; seen: { dismissed: boolean; dismiss: () => void }[] }

function Probe({ scope, host, seen }: ProbeProps) {
  seen.push(useDirectNotice(scope, host));
  return null;
}

describe("the same-Wi-Fi direct notice", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let records: Map<string, string>;
  let renderer: ReactTestRenderer | undefined;

  beforeEach(() => {
    for (const key of ["window", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    records = new Map();
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      localStorage: { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => void records.set(key, value), removeItem: (key: string) => void records.delete(key) },
    } });
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

  /** a page load: a fresh mount that reads only what storage kept */
  async function load(scope: string, host: string | null | undefined) {
    const seen: ProbeProps["seen"] = [];
    await act(async () => { renderer?.unmount(); renderer = create(createElement(Probe, { scope, host, seen })); });
    return { latest: () => seen.at(-1)!, answer: async (next: string | null | undefined) => { await act(async () => { renderer!.update(createElement(Probe, { scope, host: next, seen })); }); } };
  }

  it("stays dismissed on the next load for the same PC and address", async () => {
    const page = await load("", "192.168.0.10");
    expect(page.latest().dismissed).toBe(false);
    await act(async () => { page.latest().dismiss(); });
    expect(page.latest().dismissed).toBe(true);
    expect((await load("", "192.168.0.10")).latest().dismissed).toBe(true);
    // another PC opened in the hosted shell shares this origin's storage, not the dismissal
    expect((await load("pc-two", "192.168.0.10")).latest().dismissed).toBe(false);
  });

  it("comes back when the address changes", async () => {
    const page = await load("", "192.168.0.10");
    await act(async () => { page.latest().dismiss(); });
    await page.answer("192.168.0.22");
    expect(page.latest().dismissed).toBe(false);
  });

  it("comes back once direct is turned off and on again, but not after an unanswered read", async () => {
    const page = await load("", "192.168.0.10");
    await act(async () => { page.latest().dismiss(); });
    // no health answer yet on a fresh load says nothing about direct
    expect((await load("", undefined)).latest().dismissed).toBe(false);
    const again = await load("", "192.168.0.10");
    expect(again.latest().dismissed).toBe(true);
    await again.answer(null);
    await again.answer("192.168.0.10");
    expect(again.latest().dismissed).toBe(false);
  });
});

describe("the exposure line", () => {
  const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
  beforeEach(() => { Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] }); });
  afterEach(() => {
    if (languages) Object.defineProperty(navigator, "languages", languages);
    else Reflect.deleteProperty(navigator, "languages");
  });

  it("offers a dismiss on the direct notice only, never on the open-server warning", () => {
    const render = (direct: boolean) => renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(LanExposureNotice, { host: "192.168.0.10", direct, onOpen: () => undefined, onDismiss: () => undefined }) }));
    expect(render(true)).toContain("aria-label=\"Dismiss\"");
    expect(render(false)).not.toContain("aria-label=\"Dismiss\"");
  });
});
