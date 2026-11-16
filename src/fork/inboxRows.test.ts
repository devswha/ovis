import { expect, test } from "bun:test";
import { forkInboxNesting, forkInboxRows } from "./inboxRows.ts";

const row = (id: string, parent?: string, machine = "local") => ({ machine: { id: machine }, entry: { pane: { pane_id: id, parent_pane_id: parent } } });
const ids = (rows: readonly ReturnType<typeof row>[]) => rows.map((row) => `${row.machine.id}:${row.entry.pane.pane_id}`);

test("helpers follow their conductor like the sidebar, moving the family to its first member", () => {
  const rows = [row("child", "root"), row("other"), row("root"), row("grandchild", "child"), row("sibling", "root")];
  const result = forkInboxRows(rows, true);
  expect(ids(result)).toEqual(["local:root", "local:child", "local:grandchild", "local:sibling", "local:other"]);
  expect(result.map((entry) => entry.forkNested)).toEqual([false, true, true, true, false]);
  expect(rows.map((row) => row.entry.pane.pane_id)).toEqual(["child", "other", "root", "grandchild", "sibling"]);
});

test("a filtered-out conductor leaves a normal row; parents never match across PCs", () => {
  const result = forkInboxRows([row("child", "root"), row("root", undefined, "remote"), row("other")], true);
  expect(ids(result)).toEqual(["local:child", "remote:root", "local:other"]);
  expect(result.every((entry) => !entry.forkNested)).toBe(true);
});

test("decoration follows the drawn family, without sorting held rows or connecting across an unrelated row", () => {
  for (const rows of [[row("other"), row("child", "root"), row("root")], [row("root"), row("other"), row("child", "root")]]) {
    const result = forkInboxNesting(rows, true);
    expect(ids(result)).toEqual(ids(rows));
    expect(result.every((entry) => !entry.forkNested)).toBe(true);
  }
  const family = [row("root"), row("child", "root"), row("grandchild", "child"), row("sibling", "root")];
  expect(forkInboxNesting(family, true).map((entry) => entry.forkNested)).toEqual([false, true, true, true]);
  expect(forkInboxNesting(family, false).every((entry) => !entry.forkNested)).toBe(true);
});

test("off preserves upstream order and styling; empty and malformed parent chains lose no rows", () => {
  const rows = [row("child", "root"), row("root")];
  const result = forkInboxRows(rows, false);
  expect(ids(result)).toEqual(ids(rows));
  expect(result.every((entry) => !entry.forkNested)).toBe(true);
  expect(forkInboxRows([], true)).toEqual([]);
  const cycle = forkInboxRows([row("self", "self"), row("a", "b"), row("b", "a")], true);
  expect(new Set(ids(cycle)).size).toBe(3);
  expect(cycle[0]!.forkNested).toBe(false);
});
