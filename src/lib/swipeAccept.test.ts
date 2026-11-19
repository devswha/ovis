import { describe, expect, test } from "bun:test";
import { ACCEPT_SWIPE_PX, isAcceptSwipe, SCREEN_EDGE_PX, type SwipeStroke } from "./swipeAccept.ts";

const stroke = (over: Partial<SwipeStroke>): SwipeStroke =>
  ({ startX: 100, startY: 300, x: 100, y: 300, viewportWidth: 400, rtl: false, touches: 1, ...over });

describe("isAcceptSwipe", () => {
  test("a forward stroke past the threshold accepts", () => {
    expect(isAcceptSwipe(stroke({ x: 100 + ACCEPT_SWIPE_PX }))).toBe(true);
    expect(isAcceptSwipe(stroke({ x: 220, y: 310 }))).toBe(true);
  });

  test("a short stroke or a tap does not", () => {
    expect(isAcceptSwipe(stroke({}))).toBe(false);
    expect(isAcceptSwipe(stroke({ x: 100 + ACCEPT_SWIPE_PX - 1 }))).toBe(false);
  });

  test("a backward stroke does not", () => {
    expect(isAcceptSwipe(stroke({ x: 100 - 120 }))).toBe(false);
  });

  test("a right-to-left box takes the mirrored direction", () => {
    expect(isAcceptSwipe(stroke({ rtl: true, x: 100 - 80 }))).toBe(true);
    expect(isAcceptSwipe(stroke({ rtl: true, x: 100 + 80 }))).toBe(false);
  });

  test("a vertical or diagonal drag is left to scrolling", () => {
    expect(isAcceptSwipe(stroke({ x: 160, y: 400 }))).toBe(false);
    expect(isAcceptSwipe(stroke({ x: 160, y: 340 }))).toBe(false);
    expect(isAcceptSwipe(stroke({ x: 160, y: 320 }))).toBe(true);
  });

  test("a stroke starting at a screen edge is the system's", () => {
    expect(isAcceptSwipe(stroke({ startX: SCREEN_EDGE_PX - 1, x: 150 }))).toBe(false);
    expect(isAcceptSwipe(stroke({ startX: SCREEN_EDGE_PX, x: 150 }))).toBe(true);
    expect(isAcceptSwipe(stroke({ startX: 400 - SCREEN_EDGE_PX + 1, x: 500 }))).toBe(false);
    expect(isAcceptSwipe(stroke({ rtl: true, startX: 400 - SCREEN_EDGE_PX + 1, x: 250 }))).toBe(false);
  });

  test("more than one finger is a pinch or a scroll, not a swipe", () => {
    expect(isAcceptSwipe(stroke({ x: 220, touches: 2 }))).toBe(false);
  });
});
