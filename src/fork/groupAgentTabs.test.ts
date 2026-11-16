import { expect, it } from "bun:test";
import { groupAgentTabs } from "./groupAgentTabs.ts";

const tab = (id: string, workspace = "w") => ({ tab_id: id, workspace_id: workspace });
const pane = (id: string, parent?: string, workspace = "w") => ({ pane_id: id, tab_id: id, workspace_id: workspace, parent_pane_id: parent });
const ids = (tabs: ReturnType<typeof tab>[]) => tabs.map((tab) => tab.tab_id);

it("folds children beside their parent in stable sibling order without changing tabs", () => {
  const tabs = [tab("review"), tab("other"), tab("parent"), tab("implement")];
  const panes = [pane("parent"), pane("review", "parent"), pane("implement", "parent")];
  const grouped = groupAgentTabs(tabs, panes, true);
  expect(ids(grouped.tabs)).toEqual(["other", "parent"]);
  expect(ids(grouped.children.get("parent") ?? [])).toEqual(["review", "implement"]);
  expect(grouped.parentOf.get("review")).toBe("parent");
  expect(ids(tabs)).toEqual(["review", "other", "parent", "implement"]);
  expect(groupAgentTabs(tabs, panes, false).tabs).toEqual(tabs);
});

it("keeps orphans, same-tab children, other workspaces and cycles as normal tabs", () => {
  const tabs = [tab("orphan"), tab("parent", "elsewhere"), tab("child"), tab("self"), tab("a"), tab("b")];
  const panes = [pane("orphan", "gone"), pane("parent", undefined, "elsewhere"), pane("child", "parent"), pane("self", "self"), pane("a", "b"), pane("b", "a")];
  expect(groupAgentTabs(tabs, panes, true).tabs).toEqual(tabs);
  expect(groupAgentTabs([], [], true).tabs).toEqual([]);
});

it("folds descendants into the visible root and temporarily exposes a rename field", () => {
  const tabs = [tab("grandchild"), tab("parent"), tab("child")];
  const panes = [pane("parent"), pane("child", "parent"), pane("grandchild", "child")];
  const grouped = groupAgentTabs(tabs, panes, true);
  expect(ids(grouped.tabs)).toEqual(["parent"]);
  expect(ids(grouped.children.get("parent") ?? [])).toEqual(["child", "grandchild"]);
  expect(grouped.parentOf.get("grandchild")).toBe("parent");
  expect(ids(groupAgentTabs(tabs, panes, true, "child").tabs)).toEqual(["parent", "child"]);
});
