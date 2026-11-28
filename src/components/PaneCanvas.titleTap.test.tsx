import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import type { HerdrPane, SessionSnapshot } from "../../shared/protocol.ts";
import { AppLayoutContext, appLayoutOf } from "../lib/machineContext.tsx";
import { SettingsProvider } from "../lib/settings.ts";

import { PaneCanvas } from "./PaneCanvas.tsx";

const TUI = appLayoutOf({ version: "0.9.5", protocol: 22 });
const pane = (id: string): HerdrPane =>
  ({ pane_id: id, workspace_id: "w1", tab_id: "t1", terminal_id: `${id}:term`, revision: 1, focused: id === "p1", agent_status: "idle", label: id }) as HerdrPane;
const snapshot: SessionSnapshot = {
  protocol: 22, version: "test", agents: [],
  workspaces: [{ workspace_id: "w1", label: "w1", active_tab_id: "t1", number: 1, tab_count: 1, pane_count: 2, focused: true, agent_status: "idle", worktree: null }],
  tabs: [{ tab_id: "t1", workspace_id: "w1", label: "", number: 1, pane_count: 2, focused: true, agent_status: "idle" }],
  panes: [pane("p1"), pane("p2")],
  layouts: [{
    tab_id: "t1", workspace_id: "w1", focused_pane_id: "p1", zoomed: false, area: { x: 0, y: 0, width: 100, height: 40 },
    panes: [{ pane_id: "p1", focused: true, rect: { x: 0, y: 0, width: 50, height: 40 } }, { pane_id: "p2", focused: false, rect: { x: 50, y: 0, width: 50, height: 40 } }],
    splits: [{ id: "split_0_root", direction: "right", ratio: 0.5, rect: { x: 0, y: 0, width: 100, height: 40 } }],
  }],
};

describe("a press on a split pane's title (#3466 item 7)", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let page: Page;
  let coarse = false;

  beforeEach(() => {
    page = openPage();
    coarse = false;
    Object.defineProperty(page.window, "matchMedia", { configurable: true, value: (query: string) => ({
      get matches() { return coarse && query.includes("pointer: coarse"); }, addEventListener() {}, removeEventListener() {},
    }) });
    Object.defineProperty(page.window, "requestAnimationFrame", { configurable: true, value: () => 1 });
    Object.defineProperty(page.window, "cancelAnimationFrame", { configurable: true, value: () => {} });
    Object.defineProperty(page.window.navigator, "platform", { configurable: true, value: "Linux" });
    for (const [key, value] of Object.entries({ localStorage: page.window.localStorage, HTMLElement: page.window.HTMLElement })) {
      descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, value });
    }
  });

  afterEach(async () => {
    await page.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  const draw = () => page.render(createElement(SettingsProvider, null, createElement(AppLayoutContext.Provider, { value: TUI },
    createElement(PaneCanvas, { snapshot, pane: snapshot.panes[0] as HerdrPane, selectedPaneId: "p1", onSelect: () => {}, onChanged: () => {},
      renderPane: (item: HerdrPane | null) => createElement("div", { className: "terminal-input" }, createElement("textarea", { "data-pane": item?.pane_id })),
      onNewTab: () => {}, onNewTerminal: async () => {}, onMoveToWorkspace: async () => {} }))));
  const pressTitle = async (id: string) => {
    const frame = [...document.querySelectorAll(".pane-frame")].find((node) => node.querySelector(`textarea[data-pane="${id}"]`) !== null)!;
    await act(async () => { frame.querySelector<HTMLElement>('.pane-frame-title [role="button"]')!.click(); });
  };
  const focused = () => (document.activeElement as HTMLElement | null)?.dataset["pane"] ?? null;

  it("hands the keyboard to the pane with a mouse", async () => {
    await draw();
    await pressTitle("p2");
    expect(focused()).toBe("p2");
  });

  it("raises no on-screen keyboard on a touch screen: a tap on the title leaves the pane's input alone", async () => {
    coarse = true;
    await draw();
    await pressTitle("p2");
    expect(focused()).toBeNull();
  });
});
