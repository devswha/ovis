import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";

import type { AgentCatalogRow } from "../../shared/agent-catalog.ts";
import type { HarnessToolSetting } from "../../shared/harness-tool.ts";
import { SettingsProvider, useSettings } from "../lib/settings.ts";
import { AgentCallsRows } from "./AgentCallsRows.tsx";

const agent = (id: string, name: string, installed: boolean) => ({ id, name, state: { installed } }) as unknown as AgentCatalogRow;
const agents = [agent("opencode", "OpenCode", true), agent("claude", "Claude Code", true), agent("gjc", "GJC", false)];

describe("Settings > Agents > Let agents call other agents", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const stored = new Map<string, string>();
  let renderer: ReactTestRenderer | undefined;
  let seen: HarnessToolSetting | undefined;

  function Probe() {
    seen = useSettings().settings.agentHarnessTool;
    return null;
  }

  beforeEach(() => {
    for (const key of ["window", "document", "navigator", "localStorage", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    stored.clear();
    const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); }, removeItem: (key: string) => { stored.delete(key); } };
    const events = new EventTarget();
    const define = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    define("IS_REACT_ACT_ENVIRONMENT", true);
    define("localStorage", storage);
    define("navigator", { languages: ["en-US"], platform: "Linux" });
    define("window", { localStorage: storage, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) });
    define("getComputedStyle", () => ({ getPropertyValue: () => "" }));
    define("document", { documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null });
  });

  afterEach(() => {
    act(() => { renderer?.unmount(); });
    renderer = undefined;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  const mount = (watching = false) => act(() => {
    renderer = create(createElement(SettingsProvider, null, createElement(Probe), createElement(AgentCallsRows, { agents, watching })));
  });
  const toggle = () => renderer!.root.findByProps({ role: "switch" });
  const chips = () => renderer!.root.findAll((node) => node.type === "button" && node.props.className === "settings-chip");

  it("is off by default: agents may only look, and no agent to call is offered", () => {
    mount();
    expect(seen?.level).toBe("view");
    expect(toggle().props["aria-checked"]).toBe(false);
    expect(chips()).toHaveLength(0);
  });

  it("turned on, lets agents start the installed agents they may start, and turned off, takes it back to looking", () => {
    mount();
    act(() => { toggle().props.onClick(); });
    expect(seen).toEqual({ level: "start", depth: 1, harnesses: ["opencode"] });
    expect(chips().map((chip) => [chip.children.join(""), chip.props["aria-pressed"]])).toEqual([["OpenCode", true]]);
    act(() => { chips()[0]!.props.onClick(); });
    expect(seen?.harnesses).toEqual([]);
    act(() => { toggle().props.onClick(); });
    expect(seen).toEqual({ level: "view", depth: 1, harnesses: [] });
    expect(chips()).toHaveLength(0);
  });

  it("cannot be turned on from a watching device", () => {
    mount(true);
    expect(toggle().props.disabled).toBe(true);
  });
});
