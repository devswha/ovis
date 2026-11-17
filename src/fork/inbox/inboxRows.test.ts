import { expect, test } from "bun:test";
import { forkInboxFolded, forkInboxNesting, forkInboxRows } from "./inboxRows.ts";

const row = (id: string, parent?: string, machine = "local") => ({ machine: { id: machine }, entry: { pane: { pane_id: id, parent_pane_id: parent } } });
const ids = (rows: readonly ReturnType<typeof row>[]) => rows.map((row) => `${row.machine.id}:${row.entry.pane.pane_id}`);

test("helpers follow their conductor like the sidebar, moving the family to its first member", () => {
  const rows = [row("child", "root"), row("other"), row("root"), row("grandchild", "child"), row("sibling", "root")];
  const result = forkInboxRows(rows, true);
  expect(ids(result)).toEqual(["local:root", "local:child", "local:grandchild", "local:sibling", "local:other"]);
  expect(result.map((entry) => entry.forkTree["data-depth"] ?? 0)).toEqual([0, 1, 2, 1, 0]);
  expect(rows.map((row) => row.entry.pane.pane_id)).toEqual(["child", "other", "root", "grandchild", "sibling"]);
});

test("a filtered-out conductor leaves a normal row; parents never match across PCs", () => {
  const result = forkInboxRows([row("child", "root"), row("root", undefined, "remote"), row("other")], true);
  expect(ids(result)).toEqual(["local:child", "remote:root", "local:other"]);
  expect(result.every((entry) => entry.forkTree["data-depth"] === undefined)).toBe(true);
});

test("decoration follows the drawn family, without sorting held rows or connecting across an unrelated row", () => {
  for (const rows of [[row("other"), row("child", "root"), row("root")], [row("root"), row("other"), row("child", "root")]]) {
    const result = forkInboxNesting(rows, true);
    expect(ids(result)).toEqual(ids(rows));
    expect(result.every((entry) => entry.forkTree["data-depth"] === undefined)).toBe(true);
  }
  const family = [row("root"), row("child", "root"), row("grandchild", "child"), row("sibling", "root")];
  expect(forkInboxNesting(family, true).map((entry) => entry.forkTree["data-depth"] ?? 0)).toEqual([0, 1, 2, 1]);
  expect(forkInboxNesting(family, false).every((entry) => entry.forkTree["data-depth"] === undefined)).toBe(true);
});

test("off preserves upstream order and styling; empty and malformed parent chains lose no rows", () => {
  const rows = [row("child", "root"), row("root")];
  const result = forkInboxRows(rows, false);
  expect(ids(result)).toEqual(ids(rows));
  expect(result.every((entry) => entry.forkTree["data-depth"] === undefined)).toBe(true);
  expect(forkInboxRows([], true)).toEqual([]);
  const cycle = forkInboxRows([row("self", "self"), row("a", "b"), row("b", "a")], true);
  expect(new Set(ids(cycle)).size).toBe(3);
  expect(cycle[0]!.forkTree).toEqual({});
});

test("the tree lines are the sidebar's: a line runs on to a later sibling and passes by a grandchild between them", () => {
  const family = [row("root"), row("child", "root"), row("grandchild", "child"), row("sibling", "root")];
  expect(forkInboxNesting(family, true).map((entry) => entry.forkTree)).toEqual([
    {}, { "data-depth": 1, "data-more": "" }, { "data-depth": 2, "data-through": "" }, { "data-depth": 1 },
  ]);
});

test("a folded agent hides its helpers in its row, except the one that asks and the open one", () => {
  const family = [row("root"), row("child", "root"), row("grandchild", "child"), row("asking", "root"), row("other")];
  const folds = (open: string[], shown = "") => ({
    on: true, open,
    stateOf: (entry: ReturnType<typeof row>) => entry.entry.pane.pane_id === "asking" ? "blocked" as const : "idle" as const,
    shown: (entry: ReturnType<typeof row>) => entry.entry.pane.pane_id === shown,
  });
  const folded = forkInboxFolded(family, true, folds([]));
  expect(ids(folded)).toEqual(["local:root", "local:asking", "local:other"]);
  expect(folded[0]!.forkFold).toEqual({ key: "local:root", open: false, hidden: 2 });
  expect(folded[1]!.forkTree).toEqual({ "data-depth": 1 });
  const held = forkInboxFolded(family, true, folds([], "grandchild"));
  expect(ids(held)).toEqual(["local:root", "local:grandchild", "local:asking", "local:other"]);
  expect(held.map((entry) => entry.forkTree["data-depth"] ?? 0)).toEqual([0, 2, 1, 0]);
  const open = forkInboxFolded(family, true, folds(["local:root"]));
  expect(ids(open)).toEqual(ids(family));
  expect(open[0]!.forkFold?.open).toBe(true);
  expect(forkInboxFolded(family, true, { ...folds([]), on: false }).every((entry) => !("forkFold" in entry))).toBe(true);
});
