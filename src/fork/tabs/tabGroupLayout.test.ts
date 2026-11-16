import { expect, it } from "bun:test";
import { tabsInRow } from "../../lib/tabOverflow.ts";
import { forkTabsInRow } from "./tabGroupLayout.ts";

it("budgets the role chips, keeps the selected group and preserves upstream overflow without groups", () => {
  const tabs = ["a", "b", "c"].map((tab_id) => ({ tab_id }));
  const children = new Map([["a", [1, 2, 3]]]);
  expect(forkTabsInRow(tabs, children, 1, 400, 32, 120)).toEqual([1]);
  expect(forkTabsInRow(tabs, children, 1, 510, 32, 120)).toEqual([0, 1, 2]);
  expect(forkTabsInRow(tabs, children, 1, 400, 32, 120, 0)).toEqual([0, 1]);
  for (const width of [0, 250, 400, 600]) expect(forkTabsInRow(tabs, new Map(), 2, width, 32, 120)).toEqual(tabsInRow(3, 2, width, 32, 120));
});
