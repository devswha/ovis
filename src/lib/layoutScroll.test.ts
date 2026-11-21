import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { layoutScroll, LAYOUT_SCROLL_START, LAYOUT_SCROLL_END } from "./layoutScroll.ts";

test("layout notifications surround the actual write and finish after an exception", () => {
  const node = new EventTarget() as HTMLElement;
  let top = 10;
  const positions: number[] = [];
  node.addEventListener(LAYOUT_SCROLL_START, () => positions.push(top));
  node.addEventListener(LAYOUT_SCROLL_END, () => positions.push(top));
  expect(() => layoutScroll(node, () => { top = 20; throw new Error("write failed"); })).toThrow("write failed");
  expect(positions).toEqual([10, 20]);
});

test("the list patch emits the same layout notification names as the app", () => {
  const patch = readFileSync(join(import.meta.dir, "../../patches/@legendapp%2Flist@3.3.5.patch"), "utf8");
  const names = [...patch.matchAll(/new Event\("([^"\n]+)"/g)].map((match) => match[1]);
  expect(names).toContain(LAYOUT_SCROLL_START);
  expect(names).toContain(LAYOUT_SCROLL_END);
});
