import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { BrowserPanel, type BrowserPanelProps } from "./BrowserPanel.tsx";
import type { DesktopBrowserTab, PickedBrowserElement } from "../lib/desktopBrowser.ts";

const TAB: DesktopBrowserTab = {
  id: 7,
  profile: "mine",
  address: "http://localhost:5173/",
  title: "Checkout",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  held: false,
  owner: null,
};

const PICKED: PickedBrowserElement = {
  address: "http://localhost:5173/",
  title: "Checkout",
  tag: "button",
  role: "button",
  id: "pay-btn",
  classes: ["primary"],
  name: "Pay now",
  text: "Pay now",
  rect: { x: 10, y: 20, width: 120, height: 36 },
  imageDataUrl: null,
};

let page: Page;
const savedResizeObserver = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");

function installBridge(bridge: Record<string, unknown> | undefined): void {
  Object.defineProperty(page.window, "ovisBrowser", { configurable: true, value: bridge });
}

function renderPanel(props: BrowserPanelProps): Promise<void> {
  return page.render(createElement(SettingsProvider, null, createElement(BrowserPanel, props)));
}

beforeEach(() => {
  page = openPage();
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: class {
      observe() {}
      disconnect() {}
    },
  });
});

afterEach(async () => {
  installBridge(undefined);
  await page.close();
  if (savedResizeObserver) Object.defineProperty(globalThis, "ResizeObserver", savedResizeObserver);
  else Reflect.deleteProperty(globalThis, "ResizeObserver");
});

describe("BrowserPanel element picker", () => {
  it("shows the Pick element button only when the bridge supports picking and attaches the chosen element", async () => {
    let resolvePick: ((value: PickedBrowserElement | null) => void) | null = null;
    const cancelled: (number | undefined)[] = [];
    installBridge({
      current: () => Promise.resolve(null),
      onChange: () => () => undefined,
      close: () => undefined,
      show: () => undefined,
      hide: () => undefined,
      pick: () => new Promise<PickedBrowserElement | null>((resolve) => { resolvePick = resolve; }),
      cancelPick: (id?: number) => { cancelled.push(id); },
    });

    const attached: PickedBrowserElement[] = [];
    await renderPanel({
      tab: TAB,
      canPick: true,
      onOpened: () => undefined,
      onClose: () => undefined,
      onPicked: (el) => { attached.push(el); return true; },
    });

    const pickButton = page.one<HTMLButtonElement>('button[aria-label="Pick element"]');
    expect(pickButton.disabled).toBe(false);

    await act(async () => { pickButton.click(); });
    expect(pickButton.getAttribute("aria-pressed")).toBe("true");
    expect(page.container.textContent).toContain("Click an element on the page to attach it to the chat.");

    await act(async () => {
      resolvePick?.(PICKED);
      await Promise.resolve();
    });

    expect(attached).toEqual([PICKED]);
    expect(pickButton.getAttribute("aria-pressed")).toBe("false");
    expect(cancelled).toEqual([]);
  });

  it("cancels an active pick when Cancel is clicked or the panel is covered", async () => {
    const cancelled: (number | undefined)[] = [];
    installBridge({
      current: () => Promise.resolve(null),
      onChange: () => () => undefined,
      close: () => undefined,
      show: () => undefined,
      hide: () => undefined,
      pick: () => new Promise<PickedBrowserElement | null>(() => undefined),
      cancelPick: (id?: number) => { cancelled.push(id); },
    });

    await renderPanel({ tab: TAB, canPick: true, onOpened: () => undefined, onClose: () => undefined, onPicked: () => true });

    const pickButton = page.one<HTMLButtonElement>('button[aria-label="Pick element"]');
    await act(async () => { pickButton.click(); });
    expect(pickButton.getAttribute("aria-pressed")).toBe("true");

    await renderPanel({ tab: TAB, canPick: true, covered: true, onOpened: () => undefined, onClose: () => undefined, onPicked: () => true });
    expect(pickButton.getAttribute("aria-pressed")).toBe("false");
    expect(cancelled).toContain(TAB.id);
  });

  it("shows an alert when the message box is full", async () => {
    installBridge({
      current: () => Promise.resolve(null),
      onChange: () => () => undefined,
      close: () => undefined,
      show: () => undefined,
      hide: () => undefined,
      pick: () => Promise.resolve(PICKED),
      cancelPick: () => undefined,
    });

    await renderPanel({ tab: TAB, canPick: true, onOpened: () => undefined, onClose: () => undefined, onPicked: () => false });

    await act(async () => {
      page.one<HTMLButtonElement>('button[aria-label="Pick element"]').click();
      await Promise.resolve();
    });

    expect(page.one('[role="alert"]').textContent).toBe("The message box is full.");
  });
});
