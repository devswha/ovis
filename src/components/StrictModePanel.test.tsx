import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { SettingsProvider } from "../lib/settings.ts";
import { mock, spyOn } from "bun:test";
import { StrictModePanel, StrictModeSection, StrictUnlockAsk, type LockState } from "./StrictModePanel.tsx";
import { AccessGate } from "./AccessGate.tsx";

const unlocked: LockState = {
  bound: true, confirm: "available", locked: null, strict: false,
  preview: { rows: [{ id: "r1", label: "Galaxy S30", origin: { from: "remote", how: "list" }, file: "account" }, { id: "r2", label: "Old iPad", origin: null, file: "devices" }], grants: ["token", "tailscale"] },
};
const locked: LockState = { bound: true, confirm: "available", locked: "l1", strict: false };

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

  it("N4: while locked, says this PC is used through its desktop app or a terminal on it", async () => {
    const { shown } = await mount(locked);
    expect(shown).toContain("desktop app");
    expect(shown).toContain("terminal");
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
  let answer: LockState;
  let refuse: { status: number; code: string } | null;
  let refuseRead: boolean;
  const text = (node: ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : text(child)).join("");

  beforeEach(() => {
    requests = [];
    answer = unlocked;
    refuse = null;
    refuseRead = false;
    for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"] } });
    const events = new EventTarget();
    Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "http://127.0.0.1:7318", href: "http://127.0.0.1:7318/" }, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null } });
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(`${init?.method ?? "GET"} ${new URL(String(input instanceof Request ? input.url : input), "http://127.0.0.1:7318").pathname}`);
      if (init?.method !== "POST" && refuseRead) return Response.json({ error: { code: "locked", message: "locked" } }, { status: 403 });
      if (init?.method === "POST" && refuse !== null) return Response.json({ error: { code: refuse.code, message: "refused" } }, { status: refuse.status });
      return init?.method === "POST" ? Response.json({ confirm: "c1" }, { status: 202 }) : Response.json(answer);
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
    await act(async () => { renderer = create(<SettingsProvider><StrictModeSection offered={false} auth={{ required: false, authenticated: true, via: "local", role: "drive" }} /></SettingsProvider>); });
    expect(renderer!.toJSON()).toBeNull();
    expect(requests).toEqual([]);
  });

  it("T46, R10, Q20: after asking, says strict mode is not on until approved on this PC's screen, by when, and how to open that page", async () => {
    await act(async () => { renderer = create(<SettingsProvider><StrictModeSection offered auth={{ required: false, authenticated: true, via: "local", role: "drive" }} /></SettingsProvider>); });
    const before = text(renderer!.root);
    expect(before).not.toContain("ovis confirm");
    const button = renderer!.root.find((node) => node.type === "button");
    await act(async () => { button.props.onClick(); });
    const shown = text(renderer!.root);
    expect(shown).toContain("Strict mode is not on yet");
    expect(shown).toContain("ovis confirm");
    expect(shown).toMatch(/\d{1,2}:\d{2}/);
  });

  it("T47: asking to turn it off says it stays on until approved on this PC's screen", async () => {
    answer = locked;
    await act(async () => { renderer = create(<SettingsProvider><StrictModeSection offered auth={{ required: false, authenticated: true, via: "local", role: "drive" }} /></SettingsProvider>); });
    const button = renderer!.root.find((node) => node.type === "button");
    await act(async () => { button.props.onClick(); });
    expect(requests).toContain("POST /api/account/unlock");
    const shown = text(renderer!.root);
    expect(shown).toContain("Strict mode stays on");
    expect(shown).toContain("ovis confirm");
  });

  it("R10: a phone or laptop on this PC's address (Tailscale, a token, the open network) gets no switch: only a window the server says is on this PC", async () => {
    for (const via of ["tailscale", "token", "open", "device", "portal", "relay"] as const) {
      await act(async () => { renderer = create(<SettingsProvider><StrictModeSection offered auth={{ required: false, authenticated: true, via, role: "drive" }} /></SettingsProvider>); });
      expect({ via, buttons: renderer!.root.findAll((node) => node.type === "button").length }).toEqual({ via, buttons: 0 });
      await act(async () => { renderer?.unmount(); });
    }
  });

  it("R10: a request the PC refuses says why, here local_required", async () => {
    refuse = { status: 403, code: "local_required" };
    await act(async () => { renderer = create(<SettingsProvider><StrictModeSection offered auth={{ required: false, authenticated: true, via: "local", role: "drive" }} /></SettingsProvider>); });
    const button = renderer!.root.find((node) => node.type === "button");
    await act(async () => { button.props.onClick(); });
    const shown = text(renderer!.root);
    expect(shown).toContain("Turn strict mode on or off in a browser on this PC itself.");
    expect(shown).not.toContain("ovis confirm");
  });

  it("Q20: the approve-by time is taken before the request goes out, so a slow answer never shows a later time than the PC's", async () => {
    let now = Date.parse("2026-11-21T03:00:00.000Z");
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const reply = Promise.withResolvers<Response>();
    const slow = async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(`${init?.method ?? "GET"} ${new URL(String(input instanceof Request ? input.url : input), "http://127.0.0.1:7318").pathname}`);
      return init?.method === "POST" ? reply.promise : Response.json(answer);
    };
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(slow, { preconnect: globalThis.fetch.preconnect }));
    try {
      const sent = now;
      await act(async () => { renderer = create(<SettingsProvider><StrictModeSection offered auth={{ required: false, authenticated: true, via: "local", role: "drive" }} /></SettingsProvider>); });
      await act(async () => { renderer!.root.find((node) => node.type === "button").props.onClick(); });
      now += 90_000;
      await act(async () => { reply.resolve(Response.json({ confirm: "c1" }, { status: 202 })); });
      const by = (at: number) => new Date(at).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" });
      const shown = text(renderer!.root);
      expect(shown).toContain(by(sent + 120_000));
      expect(shown).not.toContain(by(sent + 210_000));
    } finally { clock.mockRestore(); }
  });

  it("T47, N4: a locked PC's own window, which the server lets read the lock, may only ask to turn strict mode off", async () => {
    answer = locked;
    await act(async () => { renderer = create(<SettingsProvider><StrictUnlockAsk /></SettingsProvider>); });
    const buttons = renderer!.root.findAll((node) => node.type === "button");
    expect(buttons.map((button) => text(button))).toEqual(["Ask to turn strict mode off"]);
    await act(async () => { buttons[0]!.props.onClick(); });
    expect(requests).toContain("POST /api/account/unlock");
    expect(text(renderer!.root)).toContain("Strict mode stays on until you approve turning it off");
  });

  it("T47, R10: a window the server does not let read the lock (relay, LAN, a forwarded page) sees no unlock request", async () => {
    refuseRead = true;
    await act(async () => { renderer = create(<SettingsProvider><StrictUnlockAsk /></SettingsProvider>); });
    expect(renderer!.toJSON()).toBeNull();
  });

  it("T47: the access gate of a locked PC carries the unlock request", async () => {
    answer = locked;
    await act(async () => {
      renderer = create(<SettingsProvider><AccessGate reason="locked" initialCode="" consumePairCode={() => ""} pairingUnconfirmed={false} onUnlocked={() => {}} /></SettingsProvider>);
    });
    expect(renderer!.root.findAll((node) => node.type === "button" && text(node) === "Ask to turn strict mode off")).toHaveLength(1);
  });

  it("T46, R10: reads the PC's state, and the switch only asks the PC's screen", async () => {
    await act(async () => { renderer = create(<SettingsProvider><StrictModeSection offered auth={{ required: false, authenticated: true, via: "local", role: "drive" }} /></SettingsProvider>); });
    const button = renderer!.root.find((node) => node.type === "button");
    await act(async () => { button.props.onClick(); });
    expect(requests).toEqual(["GET /api/account/lock", "POST /api/account/lock", "GET /api/account/lock"]);
  });
});
