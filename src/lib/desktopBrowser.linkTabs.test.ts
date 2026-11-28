import { afterAll, afterEach, describe, expect, it } from "bun:test";

import { onBrowserTabOpened, setBrowserTabsShowable } from "./desktopBrowser.ts";

type Holder = { ovisBrowser?: unknown };

// the bridge is read off `window`; this file runs without a DOM, so the global object stands in for it
const scope = globalThis as unknown as { window?: unknown };
const hadWindow = "window" in scope;
if (!hadWindow) scope.window = globalThis;

afterEach(() => { delete (window as Holder).ovisBrowser; });
afterAll(() => { if (!hadWindow) delete scope.window; });

function fakeBridge() {
  const told: boolean[] = [];
  let opened: ((id: unknown) => void) | null = null;
  (window as Holder).ovisBrowser = {
    current: async () => null,
    onChange: () => () => undefined,
    close: () => undefined,
    showable: (showable: boolean) => { told.push(showable); },
    onOpened: (listener: (id: unknown) => void) => { opened = listener; return () => { opened = null; }; },
  };
  return { told, open: (id: unknown) => opened?.(id), listening: () => opened !== null };
}

describe("a web link main opened in the built-in browser", () => {
  it("reaches the page only as a tab id, and stops once unsubscribed", () => {
    const bridge = fakeBridge();
    const heard: number[] = [];
    const stop = onBrowserTabOpened((id) => heard.push(id));
    for (const id of [3, "4", 1.5, null, Number.MAX_SAFE_INTEGER + 1, 7]) bridge.open(id);
    expect(heard).toEqual([3, 7]);
    stop();
    expect(bridge.listening()).toBe(false);
  });

  it("is offered only while the page says it can show a tab", () => {
    const bridge = fakeBridge();
    setBrowserTabsShowable(true);
    setBrowserTabsShowable(false);
    expect(bridge.told).toEqual([true, false]);
  });

  it("is a no-op without the desktop app's bridge", () => {
    expect(() => { onBrowserTabOpened(() => undefined)(); setBrowserTabsShowable(true); }).not.toThrow();
  });
});
