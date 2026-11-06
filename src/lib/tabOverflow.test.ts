import { describe, expect, test } from "bun:test";
import { TAB_MIN_WIDTH, TAB_MORE_WIDTH, tabsInRow } from "./tabOverflow.ts";

describe("which tabs the header's row draws", () => {
  const add = 32;

  test("every tab while each fits at its narrowest", () => {
    expect(tabsInRow(5, 4, 5 * TAB_MIN_WIDTH + add, add)).toEqual([0, 1, 2, 3, 4]);
  });

  test("as many as fit beside More, from the first", () => {
    const room = 4 * TAB_MIN_WIDTH + add + TAB_MORE_WIDTH;
    expect(tabsInRow(20, 2, room, add)).toEqual([0, 1, 2, 3]);
    expect(tabsInRow(20, 2, room - 1, add)).toEqual([0, 1, 2]);
  });

  test("the open tab past the others takes the last place", () => {
    expect(tabsInRow(20, 15, 4 * TAB_MIN_WIDTH + add + TAB_MORE_WIDTH, add)).toEqual([0, 1, 2, 15]);
  });

  test("a row too narrow for one tab still draws the open one", () => {
    expect(tabsInRow(8, 6, 50, add)).toEqual([6]);
    expect(tabsInRow(8, 0, 50, add)).toEqual([0]);
  });
});
