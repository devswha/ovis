import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { MyPc } from "../lib/account/myPcs.ts";
import type { RelayShellState } from "../lib/relay/shellState.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { AddPcSheet, addPcSheetMode, addPcSteps, type AddPcSheetProps } from "./AddPcSheet.tsx";

const SERVER_ID = "b".repeat(32);
const pcOf = (over: Partial<MyPc> = {}): MyPc => ({ server_id: SERVER_ID, name: "desk2", state: "needs-approval", last_seen_at: null, added_at: new Date().toISOString(), listed: true, paired: false, linked: false, join: { server_public_key: "k", relay: "wss://relay.example" }, ...over });
const LIST: RelayShellState = { kind: "list", devices: [], account: { kind: "signed-in", provider: "github", error: null, pcs: [] } };

// the test renderer draws no DOM: a node stands in for every element, so the focus trap finds nothing to hold
const node = () => ({ isConnected: true, focus() {}, contains: () => false, querySelectorAll: () => [], getClientRects: () => [], closest: () => null, addEventListener() {}, removeEventListener() {} });

describe("the Add-a-PC sheet", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let events: EventTarget;
  /** what had the focus when the sheet opened, and how often it got it back */
  let opener: { isConnected: boolean; focus: () => void; focused: number };
  let calls: { joins: unknown[][]; matches: unknown[][]; cancels: number; closes: number; pairs: number; qr: number };

  beforeEach(() => {
    calls = { joins: [], matches: [], cancels: 0, closes: 0, pairs: 0, qr: 0 };
    for (const key of ["window", "document", "navigator", "localStorage", "getComputedStyle", "matchMedia", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    events = new EventTarget();
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); }, key: () => null, length: 0, clear: () => store.clear() };
    const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    class HTMLElement { isConnected = true; focused = 0; focus(): void { this.focused += 1; } }
    opener = new HTMLElement();
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: HTMLElement });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Test browser", maxTouchPoints: 0 } });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: matchMedia });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      location: { href: "https://app.ovis.example/", search: "", origin: "https://app.ovis.example", pathname: "/" },
      history: { state: null, replaceState() {} },
      localStorage: storage,
      matchMedia,
      innerWidth: 1280,
      setTimeout, clearTimeout,
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
      activeElement: opener,
      // the sheet portals into the body: the renderer needs a container with a node mock for refs
      body: { nodeType: 1, children: [], createNodeMock: node },
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
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

  const props = (mode: AddPcSheetProps["mode"], pc: MyPc | null, state: RelayShellState): AddPcSheetProps => ({
    mode, pc, state,
    onJoin: (...args) => { calls.joins.push(args); },
    onPair: () => { calls.pairs += 1; },
    onMatch: (...args) => { calls.matches.push(args); },
    onCancel: () => { calls.cancels += 1; },
    onClose: () => { calls.closes += 1; },
    onPairByQr: () => { calls.qr += 1; },
  });
  const view = (shown: AddPcSheetProps) => createElement(SettingsProvider, { children: createElement(AddPcSheet, shown) });
  const mount = async (shown: AddPcSheetProps) => { await act(async () => { renderer = create(view(shown), { createNodeMock: node }); }); };
  const update = async (shown: AddPcSheetProps) => { await act(async () => { renderer!.update(view(shown)); }); };
  const text = (instance: ReactTestInstance): string => instance.children.map((child) => typeof child === "string" ? child : text(child)).join("");
  const all = () => text(renderer!.root);
  const click = async (label: string) => {
    const found = renderer!.root.findAll((instance) => instance.type === "button" && text(instance) === label);
    expect(found.map(text)).toEqual([label]);
    await act(async () => { found[0]!.props.onClick(); });
  };
  const steps = () => renderer!.root.findAll((instance) => instance.type === "li").map((instance) => instance.props["data-step"] as string);
  const digitField = () => renderer!.root.findAll((instance) => instance.type === "input" && instance.props.name === "digits");
  const escape = async () => {
    const event = Object.assign(new Event("keydown", { cancelable: true }), { key: "Escape" });
    await act(async () => { window.dispatchEvent(event); });
    return event.defaultPrevented;
  };

  it("picks the mode as the front page does: a PC's card types the number, any other PC to join asks through the account", () => {
    const now = Date.now();
    expect(addPcSheetMode(pcOf(), now)).toBe("new");
    expect(addPcSheetMode(pcOf({ added_at: new Date(now - 3_600_000).toISOString() }), now)).toBe("join");
    expect(addPcSheetMode(pcOf({ state: "offline", added_at: null }), now)).toBe("join");
    expect(addPcSheetMode(pcOf({ state: "paired", paired: true }), now)).toBe("add");
    expect(addPcSheetMode(pcOf({ join: undefined }), now)).toBe("add");
    expect(addPcSheetMode(null, now)).toBe("add");
  });

  it("marks the steps done in order, and a refusal after the digits on the approval", () => {
    expect(addPcSteps("new", "start", null)).toEqual(["done", "running", "todo", "todo"]);
    expect(addPcSteps("new", "compare", null)).toEqual(["done", "running", "todo", "todo"]);
    expect(addPcSteps("new", "approving", null)).toEqual(["done", "done", "running", "todo"]);
    expect(addPcSteps("new", "ready", null)).toEqual(["done", "done", "done", "done"]);
    expect(addPcSteps("join", "start", null)).toEqual(["running", "todo", "todo", "todo"]);
    expect(addPcSteps("join", "connecting", null)).toEqual(["running", "todo", "todo", "todo"]);
    expect(addPcSteps("join", "compare", null)).toEqual(["done", "running", "todo", "todo"]);
    expect(addPcSteps("join", "failed", "pc-offline")).toEqual(["failed", "todo", "todo", "todo"]);
    expect(addPcSteps("join", "failed", "pair-declined")).toEqual(["done", "done", "failed", "todo"]);
  });

  it("walks a new PC through the typed join: the card's join, the number typed from its screen, then its approval", async () => {
    const pc = pcOf();
    await mount(props("new", pc, LIST));
    expect(renderer!.root.findByProps({ role: "dialog" }).props["aria-modal"]).toBe("true");
    expect(all()).toContain("Add desk2 to your account");
    expect(steps()).toEqual(["done", "running", "todo", "todo"]);
    await click("Add this PC");
    expect(calls.joins).toEqual([[pc, { typed: true }]]);
    // the shell asks for the number the PC shows: the field, never digits of this device's
    await update(props("new", pc, { kind: "compare", name: "desk2", digits: "123456", confirmed: false, typed: true }));
    expect(digitField()).toHaveLength(1);
    expect(all()).not.toContain("123 456");
    expect(steps()).toEqual(["done", "running", "todo", "todo"]);
    const form = renderer!.root.findByType("form");
    await act(async () => { form.props.onSubmit({ preventDefault() {}, currentTarget: { elements: { namedItem: () => ({ value: "123 456" }) } } }); });
    expect(calls.matches).toEqual([["123456"]]);
    await update(props("new", pc, { kind: "compare", name: "desk2", digits: "123456", confirmed: true }));
    expect(steps()).toEqual(["done", "done", "running", "todo"]);
    expect(all()).toContain("Approve this phone on desk2 to finish.");
    await update(props("new", pcOf({ state: "paired", paired: true, linked: true }), LIST));
    expect(steps()).toEqual(["done", "done", "done", "done"]);
    expect(renderer!.root.findByType("a").props.href).toBe(`/s/${SERVER_ID}/`);
  });

  it("walks an account join: the plain join, this device's own digits, then an account member's approval", async () => {
    const pc = pcOf({ added_at: new Date(Date.now() - 3_600_000).toISOString() });
    await mount(props("join", pc, LIST));
    expect(all()).toContain("Add this device to desk2");
    expect(steps()).toEqual(["running", "todo", "todo", "todo"]);
    await click("Ask to join");
    expect(calls.joins).toHaveLength(1);
    expect(calls.joins[0]).toEqual([pc]);
    // the comparison this device shows, as the shell's own screen shows it
    await update(props("join", pc, { kind: "compare", name: "desk2", digits: "123456", confirmed: false }));
    const digits = renderer!.root.findByProps({ className: "relay-shell-digits" });
    expect(text(digits)).toBe("123 456");
    expect(digits.props["aria-label"]).toBe("1 2 3 4 5 6");
    expect(digitField()).toHaveLength(0);
    expect(steps()).toEqual(["done", "running", "todo", "todo"]);
    await click("The numbers match");
    expect(calls.matches).toEqual([[]]);
    await update(props("join", pc, { kind: "compare", name: "desk2", digits: "123456", confirmed: true }));
    expect(steps()).toEqual(["done", "done", "running", "todo"]);
    expect(all()).toContain("Waiting for an account member to approve this device");
    await update(props("join", pc, { kind: "failed", failure: "pair-declined", name: "desk2", detail: null }));
    expect(steps()).toEqual(["done", "done", "failed", "todo"]);
    expect(all()).toContain("desk2 did not approve this phone");
  });

  it("shows the shell's own failure for a wrong typed number, with the typing step still running", async () => {
    await mount(props("new", pcOf(), { kind: "compare", name: "desk2", digits: "", confirmed: false, typed: true, wrong: true }));
    expect(all()).toContain("That is not the number desk2 shows");
    expect(digitField()).toHaveLength(0);
    expect(steps()).toEqual(["done", "running", "todo", "todo"]);
  });

  it("closes on Escape, ending a comparison in progress, and gives the focus back to what opened it", async () => {
    await mount(props("new", pcOf(), LIST));
    expect(await escape()).toBe(true);
    expect(calls).toMatchObject({ closes: 1, cancels: 0 });
    await update(props("new", pcOf(), { kind: "compare", name: "desk2", digits: "123456", confirmed: false, typed: true }));
    await escape();
    expect(calls).toMatchObject({ closes: 2, cancels: 1 });
    expect(opener.focused).toBe(0);
    await act(async () => { renderer!.unmount(); });
    expect(opener.focused).toBe(1);
  });

  it("with no PC, says how one is added and leads to the QR and code screen", async () => {
    await mount(props("add", null, LIST));
    expect(all()).toContain("Add a PC");
    expect(steps()).toEqual([]);
    expect(renderer!.root.findAll((instance) => instance.props.className === "add-pc-bars")).toHaveLength(0);
    await click("Pair with a QR or code");
    expect(calls.qr).toBe(1);
    await click("Close");
    expect(calls).toMatchObject({ closes: 1, cancels: 0 });
  });
});
