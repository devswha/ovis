import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act, createElement, type ReactNode } from "react";
import * as ReactDom from "react-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { dashboardModel, type DashboardPc } from "../lib/relay/dashboard.ts";
import type { PcStatus } from "../lib/relay/pcStatus.ts";
import { SettingsProvider } from "../lib/settings.ts";

await mock.module("react-dom", () => ({ ...ReactDom, createPortal: (node: ReactNode) => node }));
const { RelayPcDetails } = await import("./RelayPcDetails.tsx");
import type { RelayPcDetailsProps } from "./RelayPcDetails.tsx";

const NOW = Date.parse("2026-11-08T12:00:00Z");
const GLOBAL = "wss://relay.ovis.sh";
const SERVER_ID = "0123456789abcdef0123456789abcdef";

function makeRow(
  over: Partial<DashboardPc> = {},
  status?: PcStatus,
) {
  const pc: DashboardPc = {
    server_id: SERVER_ID,
    name: "Home server",
    state: "offline",
    relay: GLOBAL,
    last_seen_at: "2026-11-08T10:00:00.000Z",
    added_at: "2026-11-01T12:00:00.000Z",
    listed: true,
    paired: true,
    linked: true,
    ...over,
  };
  const m = dashboardModel([pc], { label: "Me", now: NOW, ...(status ? { status: new Map([[pc.server_id, status]]) } : {}) }, GLOBAL);
  const first = m.rows[0];
  if (!first) throw new Error("no row");
  return first;
}

const none = () => {};

function renderHtml(props: RelayPcDetailsProps): string {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(RelayPcDetails, props) }));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
}

const textOf = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");

describe("RelayPcDetails", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let wideMatches = true;

  beforeEach(() => {
    wideMatches = true;
    for (const key of ["window", "document", "navigator", "localStorage", "getComputedStyle", "matchMedia", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"]) {
      descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    }
    const events = new EventTarget();
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
      key: () => null,
      length: 0,
      clear: () => store.clear(),
    };
    const matchMedia = (query: string) => ({
      matches: query === "(max-width: 1099px)" ? !wideMatches : false,
      addEventListener() {},
      removeEventListener() {},
    });
    class HTMLElement { isConnected = true; focus(): void {} }
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: HTMLElement });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Test", maxTouchPoints: 0 } });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: matchMedia });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { href: "https://app.ovis.sh/", search: "", origin: "https://app.ovis.sh", pathname: "/" },
        history: { state: null, replaceState() {} },
        localStorage: storage,
        matchMedia,
        innerWidth: 1440,
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
        dispatchEvent: events.dispatchEvent.bind(events),
        setTimeout: globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout,
      },
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
        activeElement: new HTMLElement(),
        body: { nodeType: 1, children: [], createNodeMock: () => ({ isConnected: true, focus() {}, contains: () => false, querySelectorAll: () => [], getClientRects: () => [], closest: () => null, addEventListener() {}, removeEventListener() {} }) },
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
      },
    });
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

  const rootOf = (r: ReactTestRenderer | undefined): ReactTestInstance => { if (!r) throw new Error("not mounted"); return r.root; };
  const mount = async (props: RelayPcDetailsProps) => {
    await act(async () => {
      renderer = create(createElement(SettingsProvider, { children: createElement(RelayPcDetails, props) }), {
        createNodeMock: () => ({ isConnected: true, focus() {}, contains: () => false, querySelectorAll: () => [], getClientRects: () => [], closest: () => null, addEventListener() {}, removeEventListener() {} }),
      });
    });
  };

  it("renders a 44px location bar with StatusDot glyph, PC name and Close/Back, plus state, source, relay, absolute last seen, check result, grouped key ID and observed version without opening a socket", () => {
    const row = makeRow({}, { kind: "answered", route: "relay", relay: GLOBAL, rttMs: 42 });
    const html = renderHtml({
      pc: row,
      observedVersion: { version: "0.5.0", outdated: false, observedAt: "2026-11-08T11:30:00.000Z" },
      onClose: none,
      onForget: async () => {},
    });
    expect(html).toContain('data-pc-details="0123456789abcdef0123456789abcdef"');
    expect(html).toContain("Home server");
    expect(html).toContain("Offline");
    expect(html).toContain("Account directory");
    expect(html).toContain("relay.ovis.sh");
    expect(html).toContain('dateTime="2026-11-08T10:00:00.000Z"');
    expect(html).toContain("This device: answered · 42 ms");
    // Grouped KeyId in mono
    expect(html).toContain("0123");
    expect(html).toContain("cdef");
    // Observed version and observation time
    expect(html).toContain("0.5.0");
    expect(html).toContain('dateTime="2026-11-08T11:30:00.000Z"');
    // Paired PC offers Open and Forget
    expect(html).toContain(`href="/s/${SERVER_ID}/"`);
    expect(html).toContain("Forget this PC");
  });

  it("renders explicit Not checked / — for unknown relay, last seen, check result and version, and omits Open/Forget for unpaired PCs", () => {
    const unknownRow = makeRow({
      name: "Spare desktop",
      state: "needs-approval",
      relay: null,
      last_seen_at: null,
      paired: false,
      linked: false,
      join: { server_public_key: "k", relay: GLOBAL },
    });
    const html = renderHtml({
      pc: unknownRow,
      observedVersion: null,
      onClose: none,
      onOpenSheet: none,
    });
    expect(html).toContain("Spare desktop");
    expect(html).toContain("Not checked");
    expect(html).toContain("—");
    // Unpaired PC has no Open link and no Forget button
    expect(html).not.toContain(`href="/s/${SERVER_ID}/"`);
    expect(html).not.toContain("Forget this PC");
    // Instead offers Join
    expect(html).toContain("Join");
  });

  it("uses ConfirmDialog for Forget this PC and invokes onForget only after confirmation", async () => {
    const forgotten: string[] = [];
    let closed = 0;
    const row = makeRow({ state: "paired" });
    await mount({
      pc: row,
      onClose: () => { closed += 1; },
      onForget: async (id) => { forgotten.push(id); },
    });

    const forgetBtn = rootOf(renderer).find((n) => n.type === "button" && textOf(n) === "Forget this PC");
    await act(async () => { forgetBtn.props.onClick(); });

    const dialog = rootOf(renderer).find((n) => n.props.role === "alertdialog");
    expect(textOf(dialog)).toContain("Forget this PC?");

    // Cancel closes the confirmation without forgetting
    const cancelBtn = dialog.find((n) => n.type === "button" && textOf(n) === "Cancel");
    await act(async () => { cancelBtn.props.onClick(); });
    expect(forgotten).toEqual([]);
    expect(rootOf(renderer).findAll((n) => n.props.role === "alertdialog")).toHaveLength(0);

    // Re-open and confirm Forget
    await act(async () => { forgetBtn.props.onClick(); });
    const dialog2 = rootOf(renderer).find((n) => n.props.role === "alertdialog");
    const confirmBtn = dialog2.find((n) => n.type === "button" && textOf(n) === "Forget");
    await act(async () => { await confirmBtn.props.onClick(); });
    expect(forgotten).toEqual([SERVER_ID]);
  });

  it("shows Back in the location bar below 1100px and closes on Escape", async () => {
    wideMatches = false;
    let closed = 0;
    await mount({
      pc: makeRow(),
      onClose: () => { closed += 1; },
    });
    const backBtn = rootOf(renderer).find((n) => n.type === "button" && textOf(n).includes("Back"));
    await act(async () => { backBtn.props.onClick(); });
    expect(closed).toBe(1);

    const escapeEvent = Object.assign(new Event("keydown", { cancelable: true }), { key: "Escape" });
    await act(async () => { window.dispatchEvent(escapeEvent); });
    expect(closed).toBe(2);
  });
});
