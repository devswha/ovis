import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { SettingsProvider } from "../lib/settings.ts";
import { mock, spyOn } from "bun:test";
import { StrictModePanel, StrictModeSection, type LockState } from "./StrictModePanel.tsx";

const unlocked: LockState = {
  bound: true, confirm: "available", locked: null, strict: false,
  preview: { rows: [{ id: "r1", label: "Galaxy S30", origin: { from: "remote", how: "list" }, file: "account" }, { id: "r2", label: "Old iPad", origin: null, file: "devices" }], grants: ["token", "tailscale"] },
};
const locked: LockState = { bound: true, confirm: "available", locked: { id: "l1", at: "2026-11-20T04:00:00.000Z", by: "pc" }, strict: false };

describe("the strict-mode screen", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;

  beforeEach(() => {
    for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"] } });
    const events = new EventTarget();
    Object.defineProperty(globalThis, "window", { configurable: true, value: { addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null } });
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  const text = (node: ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : text(child)).join("");
  const mount = async (state: LockState, local = true, asked: string[] = []) => {
    await act(async () => {
      renderer = create(<SettingsProvider><StrictModePanel state={state} local={local} onTurnOn={() => asked.push("on")} onTurnOff={(id) => asked.push(`off ${id}`)} /></SettingsProvider>);
    });
    return { shown: text(renderer!.root), buttons: renderer!.root.findAll((node) => node.type === "button") };
  };

  it("T46: before it is turned on, names each device and access it will end", async () => {
    const { shown } = await mount(unlocked);
    expect(shown).toContain("Galaxy S30");
    expect(shown).toContain("Old iPad");
    expect(shown).toContain("Tailscale");
  });

  it("N7, T49: says what strict mode does not cover and that rolling back Ovis by hand is not stopped", async () => {
    const { shown } = await mount(unlocked);
    expect(shown).toContain("signed in to this computer");
    expect(shown).toContain("older Ovis");
  });

  it("T47: unlocking names the lock that is on", async () => {
    const asked: string[] = [];
    const { buttons } = await mount(locked, true, asked);
    await act(async () => { buttons[0]!.props.onClick(); });
    expect(asked).toEqual(["off l1"]);
  });

  it("R10: only this PC's own window gets the switch", async () => {
    expect((await mount(unlocked, false)).buttons).toEqual([]);
  });

  it("P11: a PC with no way to confirm on its screen offers no switch and says strict mode is Linux only for now", async () => {
    const { shown, buttons } = await mount({ ...unlocked, confirm: "unsupported" });
    expect(buttons).toEqual([]);
    expect(shown).toContain("Linux");
  });

  it("P12: a PC in no account offers no strict mode and says it needs an account", async () => {
    const { shown, buttons } = await mount({ bound: false, confirm: "available", locked: null, strict: false });
    expect(buttons).toEqual([]);
    expect(shown).toContain("account");
  });
});

describe("the strict-mode section in Settings", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let requests: string[];

  beforeEach(() => {
    requests = [];
    for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"] } });
    const events = new EventTarget();
    Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "http://127.0.0.1:7318", href: "http://127.0.0.1:7318/" }, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null } });
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(`${init?.method ?? "GET"} ${new URL(String(input instanceof Request ? input.url : input), "http://127.0.0.1:7318").pathname}`);
      return init?.method === "POST" ? Response.json({ confirm: "c1" }, { status: 202 }) : Response.json(unlocked);
    };
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(fetch, { preconnect: globalThis.fetch.preconnect }));
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    mock.restore();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  it("G5: on a PC that does not offer it, shows nothing and asks the PC nothing", async () => {
    await act(async () => { renderer = create(<SettingsProvider><StrictModeSection offered={false} local /></SettingsProvider>); });
    expect(renderer!.toJSON()).toBeNull();
    expect(requests).toEqual([]);
  });

  it("T46, R10: reads the PC's state, and the switch only asks the PC's screen", async () => {
    await act(async () => { renderer = create(<SettingsProvider><StrictModeSection offered local /></SettingsProvider>); });
    const button = renderer!.root.find((node) => node.type === "button");
    await act(async () => { button.props.onClick(); });
    expect(requests).toEqual(["GET /api/account/lock", "POST /api/account/lock", "GET /api/account/lock"]);
  });
});
