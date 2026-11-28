import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import type { PaneInfo, SessionSnapshot, WorkspaceInfo } from "../../shared/protocol.ts";
import { AppLayoutContext, appLayoutOf } from "../lib/machineContext.tsx";
import { SettingsProvider } from "../lib/settings.ts";
import { TabStrip } from "./TabStrip.tsx";
import { paneDrag } from "../lib/paneDrag.ts";

const TUI = appLayoutOf({ version: "0.9.5", protocol: 22 });

const workspace = (id: string, tabs: number): WorkspaceInfo =>
  ({ workspace_id: id, label: id, active_tab_id: `${id}:t1`, number: 1, tab_count: tabs, pane_count: tabs, focused: false, agent_status: "idle", worktree: null });
const pane = (workspaceId: string, tabId: string): PaneInfo =>
  ({ pane_id: `${tabId}:p`, workspace_id: workspaceId, tab_id: tabId, terminal_id: `${tabId}:term`, revision: 1, focused: false, agent_status: "idle" });
const snapshot: SessionSnapshot = {
  protocol: 22, version: "test", workspaces: [workspace("w1", 2), workspace("w2", 1)], layouts: [], agents: [],
  tabs: [
    { tab_id: "w1:t1", workspace_id: "w1", label: "", number: 1, pane_count: 1, focused: true, agent_status: "idle" },
    { tab_id: "w1:t2", workspace_id: "w1", label: "", number: 2, pane_count: 1, focused: false, agent_status: "idle" },
    { tab_id: "w2:t1", workspace_id: "w2", label: "", number: 1, pane_count: 1, focused: false, agent_status: "idle" },
  ],
  panes: [pane("w1", "w1:t1"), pane("w1", "w1:t2"), pane("w2", "w2:t1")],
};
describe("a closed tab's rename draft (#3447 item 5)", () => {
  let page: Page;
  const browserGlobals = ["HTMLElement", "Element", "Node", "Event", "CustomEvent", "CSS", "localStorage", "requestAnimationFrame", "cancelAnimationFrame"] as const;
  const savedBrowserGlobals = new Map(browserGlobals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let media: { matches: boolean; addEventListener(): void; removeEventListener(): void };

  beforeEach(() => {
    page = openPage();
    media = { matches: false, addEventListener() {}, removeEventListener() {} };
    Object.defineProperties(page.window, {
      matchMedia: { configurable: true, writable: true, value: () => media },
      innerWidth: { configurable: true, value: 1280 },
      innerHeight: { configurable: true, value: 800 },
      requestAnimationFrame: { configurable: true, value: () => 1 },
      cancelAnimationFrame: { configurable: true, value: () => {} },
    });
    Object.defineProperty(page.window.navigator, "platform", { configurable: true, value: "Linux" });
    Object.defineProperty(page.window.document, "visibilityState", { configurable: true, value: "visible" });
    for (const key of browserGlobals) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: page.window[key] });
  });

  afterEach(async () => {
    paneDrag.cancel();
    await page.close();
    for (const [key, descriptor] of savedBrowserGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  const draw = (shown: SessionSnapshot) => page.render(createElement(SettingsProvider, null, createElement(AppLayoutContext.Provider, { value: TUI },
    createElement(TabStrip, { snapshot: shown, workspace: shown.workspaces[0]!, selectedPane: shown.panes[0]!, onSelectPane: () => {}, onNewTab: () => {}, onNewTerminal: async () => {}, onMoveToWorkspace: async () => {} }))));

  it("a closed tab's unfinished rename is not offered to the next tab with its id", async () => {
    await draw(snapshot);
    await act(async () => { page.one<HTMLButtonElement>('[data-tab-id="w1:t2"]').dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true, cancelable: true })); });
    const field = () => page.one<HTMLInputElement>('[class="input tab-strip-rename"]');
    await page.type(field(), "half typed");
    await act(async () => { field().dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true, cancelable: true })); });
    const closed: SessionSnapshot = { ...snapshot, workspaces: [workspace("w1", 1), workspace("w2", 1)], tabs: snapshot.tabs.filter((t) => t.tab_id !== "w1:t2"), panes: snapshot.panes.filter((p) => p.tab_id !== "w1:t2") };
    await draw(closed);
    await draw(snapshot);
    await act(async () => { page.one<HTMLButtonElement>('[data-tab-id="w1:t2"]').dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true, cancelable: true })); });
    expect(field().value).toBe("");
  });
});
