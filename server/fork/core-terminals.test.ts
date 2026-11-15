import { expect, it } from "bun:test";
import { buildSnapshot, type HcTerminal } from "../herdr-core/snapshot.ts";

it("keeps upstream pi terminal names and titles, excluding only work-labelled runners", () => {
  const terminal = (address: string, extra: Partial<HcTerminal> = {}): HcTerminal => ({ address, cols: 80, rows: 24, cwd: "/missing", state: "live", name: "general", title: "π - project", status: { app: "pi", state: "idle" }, ...extra });
  const snapshot = buildSnapshot([
    terminal("pi"),
    terminal("work", { labels: { "ovis.view": "work" } }),
    terminal("other", { labels: { "ovis.view": "coding" } }),
  ], null, "0.1.19");
  expect(snapshot.panes.map((pane) => [pane.pane_id, pane.label, pane.title])).toEqual([
    ["pi", "general", "π - project"],
    ["other", "general", "π - project"],
  ]);
  expect(snapshot.tabs.map((tab) => tab.label)).toEqual(["general", "general"]);
  expect(snapshot.agents).toHaveLength(2);
});
