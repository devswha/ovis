import { describe, expect, it } from "bun:test";

import { paneAfterClose } from "./paneAfterClose.ts";

/** a roster from workspace → tab → panes in layout order; each tab's first pane is its focus unless `focus` names another */
function roster(tree: Record<string, Record<string, string[]>>, focus: Record<string, string> = {}) {
  const workspaces = Object.entries(tree).map(([workspace_id, tabs], index) => ({ workspace_id, number: index + 1, active_tab_id: Object.keys(tabs)[0] }));
  const tabs = Object.entries(tree).flatMap(([workspace_id, entries]) => Object.keys(entries).map((tab_id, index) => ({ tab_id, workspace_id, number: index + 1 })));
  const panes = Object.entries(tree).flatMap(([workspace_id, entries]) => Object.entries(entries).flatMap(([tab_id, ids]) => ids.map((pane_id) => ({ pane_id, tab_id, workspace_id }))));
  const layouts = Object.values(tree).flatMap((entries) => Object.entries(entries).map(([tab_id, ids]) => ({ tab_id, focused_pane_id: focus[tab_id] ?? ids[0], panes: ids.map((pane_id) => ({ pane_id })) })));
  return { workspaces, tabs, panes, layouts } as never;
}

describe("paneAfterClose", () => {
  it("stays in the tab: the pane selected before, else the next in layout order, else the one before", () => {
    const before = roster({ w1: { t1: ["a", "b", "c"] }, w2: { t2: ["x"] } });
    const after = roster({ w1: { t1: ["a", "c"] }, w2: { t2: ["x"] } });
    expect(paneAfterClose(before, after, "b", "a")).toBe("a");
    expect(paneAfterClose(before, after, "b", null)).toBe("c");
    // a previous selection in another tab is not this tab's previous focus
    expect(paneAfterClose(before, after, "b", "x")).toBe("c");
    expect(paneAfterClose(before, roster({ w1: { t1: ["a", "b"] }, w2: { t2: ["x"] } }), "c", null)).toBe("b");
    // a pane made in the tab after `before` was read keeps the selection in the tab
    expect(paneAfterClose(roster({ w1: { t1: ["a"], t2: ["y"] } }), roster({ w1: { t1: ["n"], t2: ["y"] } }), "a", null)).toBe("n");
  });

  it("with its tab gone, opens the tab before it, else the one after, at that tab's focused pane", () => {
    const before = roster({ w1: { t1: ["a", "b"], t2: ["c"], t3: ["d", "e"] } }, { t1: "b", t3: "e" });
    expect(paneAfterClose(before, roster({ w1: { t1: ["a", "b"], t3: ["d", "e"] } }, { t1: "b", t3: "e" }), "c", null)).toBe("b");
    const first = roster({ w1: { t2: ["c"], t3: ["d", "e"] } }, { t3: "e" });
    expect(paneAfterClose(roster({ w1: { t1: ["a"], t2: ["c"], t3: ["d", "e"] } }, { t3: "e" }), first, "a", null)).toBe("c");
  });

  it("with its workspace gone, opens the workspace after it, else the one before", () => {
    const before = roster({ w1: { t1: ["a"] }, w2: { t2: ["b"] }, w3: { t3: ["c"] } });
    expect(paneAfterClose(before, roster({ w1: { t1: ["a"] }, w3: { t3: ["c"] } }), "b", null)).toBe("c");
    expect(paneAfterClose(before, roster({ w1: { t1: ["a"] }, w2: { t2: ["b"] } }), "c", null)).toBe("b");
  });

  it("names nothing for a pane it never saw, or when nothing is left", () => {
    const before = roster({ w1: { t1: ["a"] } });
    expect(paneAfterClose(before, before, "gone", null)).toBeNull();
    expect(paneAfterClose(before, roster({}), "a", null)).toBeNull();
  });
});
