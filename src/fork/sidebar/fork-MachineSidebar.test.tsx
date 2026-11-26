import { afterEach, beforeEach, expect, it } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";

import type { Machine } from "../../../shared/machines.ts";
import { AgentSidebar } from "../../components/AgentSidebar.tsx";
import { MachineSidebar } from "../../components/MachineSidebar.tsx";
import { SidebarSplit } from "../../components/SidebarSplit.tsx";
import type { AppActions } from "../../lib/actions.ts";
import { AGENT_GROUPS_STORAGE_KEY, FOLD_HELPERS_STORAGE_KEY, SettingsProvider, SIDEBAR_AGENT_TREE_STORAGE_KEY } from "../../lib/settings.ts";

const actions = new Proxy({}, { get: () => () => {} }) as AppActions;
const activity = { seqs: () => new Map<string, number>(), status: () => undefined };
const node = (): HTMLElement => ({
  isConnected: true, offsetWidth: 200, offsetHeight: 100, dataset: {}, style: { setProperty() {}, removeProperty() {} }, classList: { add() {}, remove() {}, contains: () => false },
  getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  querySelector: () => null, querySelectorAll: () => [], contains: () => false, closest: () => null,
  focus() {}, addEventListener() {}, removeEventListener() {},
}) as unknown as HTMLElement;
const laptop = { id: "local", kind: "local", name: "Laptop", state: "connected", snapshot: null, error: null, action_required: null, remote_ovis: null } as unknown as Machine;

const descriptors = new Map<string, PropertyDescriptor | undefined>();
const stored = new Map<string, string>();
let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  for (const key of ["window", "document", "navigator", "getComputedStyle", "localStorage", "HTMLElement", "ResizeObserver", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  stored.clear();
  const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); }, removeItem: (key: string) => { stored.delete(key); } };
  const events = new EventTarget();
  const media = { matches: false, addEventListener() {}, removeEventListener() {} };
  const define = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  define("IS_REACT_ACT_ENVIRONMENT", true);
  define("HTMLElement", class HTMLElement {});
  define("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  define("localStorage", storage);
  define("navigator", { languages: ["en-US"], platform: "Linux", userAgent: "test" });
  define("window", { localStorage: storage, sessionStorage: storage, location: { pathname: "/", search: "", hash: "" }, matchMedia: () => media, innerWidth: 1280, innerHeight: 800, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), requestAnimationFrame: (run: FrameRequestCallback) => { run(0); return 1; }, cancelAnimationFrame() {}, setTimeout, clearTimeout, setInterval, clearInterval });
  define("document", { visibilityState: "visible", activeElement: null, querySelectorAll: () => [], body: { nodeType: 1, children: [] }, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null, getElementById: () => null, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) });
  define("getComputedStyle", () => ({ getPropertyValue: () => "" }));
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

async function draw(settings: { foldHelpers: boolean; agentTree: boolean; agentGroups: boolean }) {
  stored.set(FOLD_HELPERS_STORAGE_KEY, String(settings.foldHelpers));
  stored.set(SIDEBAR_AGENT_TREE_STORAGE_KEY, String(settings.agentTree));
  stored.set(AGENT_GROUPS_STORAGE_KEY, String(settings.agentGroups));
  await act(async () => {
    renderer = create(createElement(SettingsProvider, null, createElement(MachineSidebar, {
      machines: [laptop], selectedMachineId: "local", selectedPaneId: null, activity, actions,
      onSelect: () => {}, onNew: () => {}, onSetup: () => {}, onUsageLogin: () => {}, inbox: { waiting: 0, open: () => {} },
    })), { createNodeMock: node });
  });
  const has = (className: string) => renderer!.root.findAll((found) => typeof found.type === "string" && String(found.props.className).split(" ").includes(className)).length > 0;
  const drawn = { agents: renderer!.root.findAllByType(AgentSidebar).length, splits: renderer!.root.findAllByType(SidebarSplit).length, pcs: has("pcs-sidebar"), inbox: has("sidebar-footer-inbox"), settings: has("sidebar-footer-settings") };
  await act(async () => renderer!.unmount());
  renderer = undefined;
  return drawn;
}

it("draws no Agents list nor its divider while both settings are on, above or below the PCs, and keeps the rest", async () => {
  for (const agentGroups of [false, true]) {
    expect(await draw({ foldHelpers: true, agentTree: true, agentGroups })).toEqual({ agents: 0, splits: 0, pcs: true, inbox: true, settings: true });
  }
});

it("keeps the Agents list and its divider while either setting is off", async () => {
  for (const [foldHelpers, agentTree] of [[true, false], [false, true], [false, false]] as const) {
    for (const agentGroups of [false, true]) {
      expect(await draw({ foldHelpers, agentTree, agentGroups })).toEqual({ agents: 1, splits: 1, pcs: true, inbox: true, settings: true });
    }
  }
});
