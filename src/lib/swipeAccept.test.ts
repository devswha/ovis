import { describe, expect, test } from "bun:test";
import { ACCEPT_SWIPE_PX, LONG_PRESS_MS, SCREEN_EDGE_PX, SLOP_PX, trackAcceptSwipe, type SwipeStart, type SwipeVerdict } from "./swipeAccept.ts";

type Move = [x: number, y: number, at?: number, touches?: number];

function verdicts(moves: Move[], over: Partial<SwipeStart> = {}): SwipeVerdict[] {
  const move = trackAcceptSwipe({ x: 100, y: 300, at: 0, viewportWidth: 400, rtl: false, ...over });
  return moves.map(([x, y, at = 0, touches = 1]) => move({ x, y, at, touches }));
}

describe("trackAcceptSwipe", () => {
  test("a forward stroke past the threshold accepts", () => {
    expect(verdicts([[100 + ACCEPT_SWIPE_PX, 300]])).toEqual(["accept"]);
    expect(verdicts([[220, 310]])).toEqual(["accept"]);
  });

  test("a short stroke or a resting finger is not decided yet", () => {
    expect(verdicts([[100 + SLOP_PX - 1, 300], [100 + ACCEPT_SWIPE_PX - 1, 300], [100 + ACCEPT_SWIPE_PX, 300]])).toEqual(["pending", "pending", "accept"]);
  });

  test("a backward stroke does not", () => {
    expect(verdicts([[100 - 120, 300]])).toEqual(["cancel"]);
  });

  test("a right-to-left box takes the mirrored direction", () => {
    expect(verdicts([[100 - 80, 300]], { rtl: true })).toEqual(["accept"]);
    expect(verdicts([[100 + 80, 300]], { rtl: true })).toEqual(["cancel"]);
  });

  test("a vertical or diagonal drag is left to scrolling", () => {
    expect(verdicts([[160, 400]])).toEqual(["cancel"]);
    expect(verdicts([[160, 340]])).toEqual(["cancel"]);
    expect(verdicts([[160, 320]])).toEqual(["accept"]);
  });

  test("a decided stroke stays decided: a scroll that turns sideways is still a scroll", () => {
    expect(verdicts([[103, 330], [250, 332]])).toEqual(["cancel", "cancel"]);
    expect(verdicts([[200, 300], [100, 300]])).toEqual(["accept", "accept"]);
  });

  test("a forward stroke survives a stray point back at the start, but not a turn into a vertical drag", () => {
    expect(verdicts([[130, 300], [100, 300], [150, 301]])).toEqual(["pending", "pending", "accept"]);
    expect(verdicts([[130, 300], [135, 340], [200, 340]])).toEqual(["pending", "cancel", "cancel"]);
    expect(verdicts([[140, 300], [140, 322], [150, 322]])).toEqual(["pending", "cancel", "cancel"]);
  });

  test("a finger that rests before it moves is a long press", () => {
    expect(verdicts([[102, 301, LONG_PRESS_MS], [200, 300, LONG_PRESS_MS + 1]])).toEqual(["pending", "cancel"]);
    expect(verdicts([[120, 301, LONG_PRESS_MS], [200, 300, 5 * LONG_PRESS_MS]])).toEqual(["pending", "accept"]);
  });

  test("a stroke starting at a screen edge is the system's", () => {
    expect(verdicts([[150, 300]], { x: SCREEN_EDGE_PX - 1 })).toEqual(["cancel"]);
    expect(verdicts([[150, 300]], { x: SCREEN_EDGE_PX })).toEqual(["accept"]);
    expect(verdicts([[500, 300]], { x: 400 - SCREEN_EDGE_PX + 1 })).toEqual(["cancel"]);
    expect(verdicts([[250, 300]], { rtl: true, x: 400 - SCREEN_EDGE_PX + 1 })).toEqual(["cancel"]);
  });

  test("more than one finger is a pinch or a scroll, not a swipe", () => {
    expect(verdicts([[220, 300, 0, 2], [240, 300]])).toEqual(["cancel", "cancel"]);
  });
});
