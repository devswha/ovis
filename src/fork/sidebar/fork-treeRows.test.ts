import { expect, test } from "bun:test";
import { forkTreeOn, forkTreeRows, forkTreeTab } from "./treeRows.ts";

const entry = (id: string, parent?: string) => ({ pane: { pane_id: id, parent_pane_id: parent } });
type Entry = ReturnType<typeof entry>;
const ids = (rows: readonly Entry[]) => rows.map((row) => row.pane.pane_id);
const folds = (open: string[] = [], selectedPaneId: string | null = null, fold = true) => ({
  fold, open, selectedPaneId, blocked: (row: Entry) => row.pane.pane_id === "asking",
});
// a workspace's agents in snapshot order: helpers before or after their agent, and one from another workspace's agent
const workspace = [entry("child", "root"), entry("other"), entry("root"), entry("grandchild", "child"), entry("asking", "root"), entry("stray", "elsewhere")];

test("only both settings together turn the tree's folds on", () => {
  expect(forkTreeOn({ foldHelpers: true, sidebarAgentTree: true })).toBe(true);
  expect(forkTreeOn({ foldHelpers: true, sidebarAgentTree: false })).toBe(false);
  expect(forkTreeOn({ foldHelpers: false, sidebarAgentTree: true })).toBe(false);
});

test("a helper sits under its agent, a helper's helper under that helper, and one whose agent is elsewhere stays a row", () => {
  const rows = forkTreeRows("local", workspace, folds(["local:root"]));
  expect(ids(rows)).toEqual(["root", "child", "grandchild", "asking", "other", "stray"]);
  expect(rows.map((row) => row.forkTree?.["data-depth"] ?? 0)).toEqual([0, 1, 2, 1, 0, 0]);
  expect(rows[0]!.forkFold).toEqual({ key: "local:root", open: true, hidden: 0 });
  expect(rows.find((row) => row.pane.pane_id === "stray")!.forkFold).toBeUndefined();
});

test("a folded agent hides its helpers, except the one that needs the person and the selected one", () => {
  const folded = forkTreeRows("local", workspace, folds());
  expect(ids(folded)).toEqual(["root", "asking", "other", "stray"]);
  expect(folded[0]!.forkFold).toEqual({ key: "local:root", open: false, hidden: 2 });
  expect(folded[1]!.forkTree).toEqual({ "data-depth": 1 });
  const selected = forkTreeRows("local", workspace, folds([], "grandchild"));
  expect(ids(selected)).toEqual(["root", "grandchild", "asking", "other", "stray"]);
  expect(selected.map((row) => row.forkTree?.["data-depth"] ?? 0)).toEqual([0, 2, 1, 0, 0]);
  expect(selected[0]!.forkFold?.hidden).toBe(1);
});

test("the open state is per PC: another PC's open agent does not open this one", () => {
  expect(ids(forkTreeRows("local", workspace, folds(["remote:root"])))).toEqual(["root", "asking", "other", "stray"]);
});

test("under a filter the family order stays and nothing folds", () => {
  const rows = forkTreeRows("local", workspace, folds([], null, false));
  expect(ids(rows)).toEqual(["root", "child", "grandchild", "asking", "other", "stray"]);
  expect(rows.every((row) => row.forkFold === undefined)).toBe(true);
});

test("the tree's agent rows drop the tab name only while its folds are on", () => {
  expect(forkTreeTab(true, "Tab 1")).toBeNull();
  expect(forkTreeTab(false, "Tab 1")).toBe("Tab 1");
});
