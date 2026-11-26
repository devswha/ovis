import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { HerdrPane, SessionSnapshot, WorkspaceInfo } from "../../../shared/protocol.ts";
import { HELPERS_OPEN_KEY } from "../../components/AgentSidebar.tsx";
import { Sidebar } from "../../components/Sidebar.tsx";
import type { AppActions } from "../../lib/actions.ts";
import { FOLD_HELPERS_STORAGE_KEY, SettingsProvider, SIDEBAR_AGENT_TREE_STORAGE_KEY, useSettings, type Settings } from "../../lib/settings.ts";
import { inactiveSidebarFilter } from "../../lib/sidebarFilter.ts";
import { SidebarFilterProvider } from "../../lib/sidebarFilterContext.ts";
import { currentSidebarPins, setSidebarPins } from "../../lib/sidebarPins.ts";

const workspace = (id: string, tabs: number): WorkspaceInfo =>
  ({ workspace_id: id, label: id, active_tab_id: `${id}:t1`, number: 1, tab_count: tabs, pane_count: 1, focused: false, agent_status: "idle", worktree: null });
const pane = (id: string, workspaceId: string, tab: string, extra: Partial<HerdrPane> = {}): HerdrPane =>
  ({ pane_id: id, workspace_id: workspaceId, tab_id: `${workspaceId}:${tab}`, terminal_id: `${id}:term`, revision: 1, focused: false, agent_status: "idle", ...extra });
// an agent with two helpers, one idle and one that needs the person, and a helper of it that runs in another workspace
const snapshot: SessionSnapshot = {
  protocol: 22, version: "test", layouts: [], agents: [],
  workspaces: [workspace("api", 2), workspace("web", 1)],
  tabs: [
    { tab_id: "api:t1", workspace_id: "api", label: "1", number: 1, pane_count: 2, focused: false, agent_status: "idle" },
    { tab_id: "api:t2", workspace_id: "api", label: "2", number: 2, pane_count: 1, focused: false, agent_status: "idle" },
    { tab_id: "web:t1", workspace_id: "web", label: "1", number: 1, pane_count: 2, focused: false, agent_status: "idle" },
  ],
  panes: [
    pane("api:helper", "api", "t1", { agent: "claude", title: "write tests", parent_pane_id: "api:lead" }),
    pane("api:lead", "api", "t1", { agent: "claude", title: "fix login", agent_status: "working" }),
    pane("api:asking", "api", "t2", { agent: "codex", title: "review", agent_status: "blocked", parent_pane_id: "api:lead" }),
    pane("web:pi", "web", "t1", { agent: "pi", title: "styles" }),
    pane("web:stray", "web", "t1", { agent: "pi", title: "lint", parent_pane_id: "api:lead" }),
  ],
};

const descriptors = new Map<string, PropertyDescriptor | undefined>();
const stored = new Map<string, string>();
let renderer: ReactTestRenderer | undefined;
let pinsBefore: string[];
let fetchSpy: { mockRestore(): void } | undefined;
const actions = new Proxy({}, { get: () => () => {} }) as AppActions;

beforeEach(() => {
  for (const key of ["window", "document", "navigator", "getComputedStyle", "localStorage", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  stored.clear();
  const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); }, removeItem: (key: string) => { stored.delete(key); } };
  const events = new EventTarget();
  const media = { matches: false, addEventListener() {}, removeEventListener() {} };
  const define = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  define("IS_REACT_ACT_ENVIRONMENT", true);
  define("localStorage", storage);
  define("navigator", { languages: ["en-US"], platform: "Linux" });
  define("window", { localStorage: storage, matchMedia: () => media, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), requestAnimationFrame: () => 1, cancelAnimationFrame() {}, setTimeout, clearTimeout });
  define("document", { visibilityState: "visible", activeElement: null, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) });
  define("getComputedStyle", () => ({ getPropertyValue: () => "" }));
  pinsBefore = currentSidebarPins();
  setSidebarPins([]);
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({ error: "not a repository" }, { status: 404 }), { preconnect: globalThis.fetch.preconnect }));
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  fetchSpy?.mockRestore();
  setSidebarPins(pinsBefore);
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

async function draw(settings: { foldHelpers: boolean; agentTree: boolean }, selectedPaneId = "web:pi"): Promise<void> {
  stored.set(SIDEBAR_AGENT_TREE_STORAGE_KEY, String(settings.agentTree));
  stored.set(FOLD_HELPERS_STORAGE_KEY, String(settings.foldHelpers));
  await act(async () => {
    renderer = create(createElement(SettingsProvider, null, createElement(SidebarFilterProvider, { value: { filter: inactiveSidebarFilter(), reportBranches: () => {} } },
      createElement(SettingsHandle), createElement(Sidebar, { snapshot, online: true, selectedPaneId, actions }))));
  });
}
let updateSettings: (patch: Partial<Settings>) => void = () => {};
function SettingsHandle() {
  updateSettings = useSettings().update;
  return null;
}
const tree = () => renderer!.root.findAll((node) => node.type === "li" && typeof node.props["data-workspace"] === "string").map((row) =>
  [row.props["data-workspace"] as string, ...row.findAll((node) => node.type === "li" && typeof node.props["data-agent-pane"] === "string").map((agent) => agent.props["data-agent-pane"] as string)]);
const agentRow = (paneId: string): ReactTestInstance => renderer!.root.find((node) => node.type === "li" && node.props["data-agent-pane"] === paneId);
const text = (node: ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : text(child)).join("");
const places = (paneId: string) => agentRow(paneId).findAll((node) => node.props.className === "workspace-agent-place").map(text);

it("keeps upstream's flat rows, tab names and no fold while either setting is off", async () => {
  await draw({ foldHelpers: false, agentTree: true });
  expect(tree()).toEqual([["api", "api:helper", "api:lead", "api:asking"], ["web", "web:pi", "web:stray"]]);
  expect(renderer!.root.findAll((node) => node.props.className === "fork-helpers-face")).toEqual([]);
  expect(agentRow("api:helper").props["data-depth"]).toBeUndefined();
  expect(places("api:lead")).toEqual(["Tab 1"]);
});

it("folds an agent's helpers under it, keeping the one that needs the person in sight", async () => {
  await draw({ foldHelpers: true, agentTree: true });
  expect(tree()).toEqual([["api", "api:lead", "api:asking"], ["web", "web:pi", "web:stray"]]);
  expect(agentRow("api:asking").props["data-depth"]).toBe(1);
  expect(agentRow("web:stray").props["data-depth"]).toBeUndefined();
  expect(agentRow("api:lead").findAll((node) => node.props.className === "workspace-fold-count").map(text)).toEqual(["+1"]);
  const face = agentRow("api:lead").find((node) => node.props.className === "fork-helpers-face");
  expect(face.props["aria-expanded"]).toBe(false);
  await act(async () => face.props.onClick());
  expect(JSON.parse(stored.get(HELPERS_OPEN_KEY)!)).toEqual(["local:api:lead"]);
  expect(tree()[0]).toEqual(["api", "api:lead", "api:helper", "api:asking"]);
  expect(agentRow("api:helper").props["data-more"]).toBe("");
});

it("opens the agents the Agents list and the inbox keep open, and shows the selected helper while folded", async () => {
  stored.set(HELPERS_OPEN_KEY, JSON.stringify(["local:api:lead"]));
  await draw({ foldHelpers: true, agentTree: true });
  expect(tree()[0]).toEqual(["api", "api:lead", "api:helper", "api:asking"]);
  await act(async () => renderer!.unmount());
  stored.delete(HELPERS_OPEN_KEY);
  await draw({ foldHelpers: true, agentTree: true }, "api:helper");
  expect(tree()[0]).toEqual(["api", "api:lead", "api:helper", "api:asking"]);
});

it("takes the agents the Agents list opened while the tree was off, and its first click folds them", async () => {
  await draw({ foldHelpers: true, agentTree: false });
  // the Agents list, drawn while the tree is off, opens the agent
  stored.set(HELPERS_OPEN_KEY, JSON.stringify(["local:api:lead"]));
  await act(async () => updateSettings({ sidebarAgentTree: true }));
  expect(tree()[0]).toEqual(["api", "api:lead", "api:helper", "api:asking"]);
  const face = agentRow("api:lead").find((node) => node.props.className === "fork-helpers-face");
  expect(face.props["aria-expanded"]).toBe(true);
  await act(async () => face.props.onClick());
  expect(JSON.parse(stored.get(HELPERS_OPEN_KEY)!)).toEqual([]);
  expect(tree()[0]).toEqual(["api", "api:lead", "api:asking"]);
});

it("drops the tab name from an agent row while both are on, keeping it in the row's hover title", async () => {
  await draw({ foldHelpers: true, agentTree: true });
  expect(places("api:lead")).toEqual([]);
  expect(agentRow("api:lead").find((node) => node.props.className === "workspace-agent-select").props.title).toContain("Tab 1");
});
