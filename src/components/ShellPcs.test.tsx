import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";

import { SettingsProvider } from "../lib/settings.ts";
import type { PcStatus } from "../lib/relay/pcStatus.ts";
import { ShellPcs } from "./ShellPcs.tsx";

const textOf = (node: ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : textOf(child)).join("");

describe("the hosted app's other PCs in the sidebar", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  beforeEach(() => {
    for (const key of ["window", "document", "navigator", "localStorage", "getComputedStyle", "matchMedia", "IS_REACT_ACT_ENVIRONMENT"]) {
      descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    }
    const events = new EventTarget();
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); }, key: () => null, length: 0, clear: () => store.clear() };
    const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Mozilla/5.0", maxTouchPoints: 0 } });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: matchMedia });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      localStorage: storage, matchMedia,
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events),
      requestAnimationFrame: () => 1, cancelAnimationFrame() {},
      setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
    } });
  });
  afterEach(() => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  it("opens each on its own page; one that does not answer reads Off with Check again, which checks that PC alone", async () => {
    const checked: string[] = [];
    const pcs = [{ server_id: "b".repeat(32), name: "Work PC" }, { server_id: "c".repeat(32), name: "HostHatch" }, { server_id: "d".repeat(32), name: null }, { server_id: "e".repeat(32), name: "Laptop" }];
    // a re-check of an off PC keeps it off on screen, so Check again stays where the focus is; a relay that turned this device away says nothing of the PC
    const status = new Map<string, PcStatus>([
      ["b".repeat(32), { kind: "answered", route: "relay", rttMs: 40 }],
      ["c".repeat(32), { kind: "checking", previous: { kind: "offline", reason: "pc" } }],
      ["d".repeat(32), { kind: "checking" }],
      ["e".repeat(32), { kind: "offline", reason: "refused" }],
    ]);
    let root: ReturnType<typeof create> | undefined;
    await act(async () => { root = create(createElement(SettingsProvider, { children: createElement(ShellPcs, { pcs, status, recheck: (id: string) => { checked.push(id); } }) })); });
    const rows = root!.root.findAll((node) => node.type === "li");
    expect(rows.map((row) => row.props["data-pc-state"])).toEqual(["on", "off", "checking", "off"]);
    expect(rows.map((row) => row.find((node) => node.type === "a").props.href)).toEqual([`/s/${"b".repeat(32)}/`, `/s/${"c".repeat(32)}/`, `/s/${"d".repeat(32)}/`, `/s/${"e".repeat(32)}/`]);
    expect(textOf(rows[1]!)).toBe("HostHatchOff·Check again");
    expect(rows[1]!.find((node) => node.type === "button").props["aria-busy"]).toBe(true);
    expect(textOf(rows[2]!)).toBe("Unnamed PC");
    expect(textOf(rows[3]!)).toBe("LaptopCheck again");
    expect(rows[0]!.findAll((node) => node.type === "button")).toHaveLength(0);
    await act(async () => { rows[1]!.find((node) => node.type === "button").props.onClick(); });
    expect(checked).toEqual(["c".repeat(32)]);
  });

  it("draws nothing without another PC", async () => {
    let root: ReturnType<typeof create> | undefined;
    await act(async () => { root = create(createElement(SettingsProvider, { children: createElement(ShellPcs, { pcs: [], status: new Map(), recheck: () => {} }) })); });
    expect(root!.toJSON()).toBeNull();
  });
});
