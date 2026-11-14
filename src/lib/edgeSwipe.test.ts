import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { drawerSettles, EDGE_PX, FLING_SPEED, SWIPE_PX, swipeVerdict, watchDrawerSwipe } from "./edgeSwipe.ts";

describe("swipeVerdict", () => {
  test("a swipe in from the left edge opens the closed drawer", () => {
    expect(swipeVerdict(false, 4, 20, 2)).toBe("claim");
    expect(swipeVerdict(false, 4, SWIPE_PX, 5)).toBe("open");
  });

  test("a flat rightward stroke opens from mid-screen, including the angle boundary", () => {
    expect(swipeVerdict(false, 200, 20, 10)).toBe("pending");
    expect(swipeVerdict(false, 200, SWIPE_PX, SWIPE_PX / 2)).toBe("open");
    expect(swipeVerdict(false, 200, SWIPE_PX, -SWIPE_PX / 2)).toBe("open");
    expect(swipeVerdict(false, 200, -SWIPE_PX, 0)).toBe("ignore");
    expect(swipeVerdict(false, 200, 3, 2)).toBe("pending");
  });

  test("diagonal strokes scroll away from the edge, which keeps its looser angle", () => {
    expect(swipeVerdict(false, EDGE_PX + 1, 56, 29)).toBe("ignore");
    expect(swipeVerdict(false, 200, 56, -29)).toBe("ignore");
    expect(swipeVerdict(false, EDGE_PX, 56, 40)).toBe("open");
    expect(swipeVerdict(true, 200, -56, 40)).toBe("close");
  });

  test("a vertical stroke from the edge still scrolls", () => {
    expect(swipeVerdict(false, 4, 12, 40)).toBe("ignore");
  });

  test("a tiny movement is not a direction yet", () => {
    expect(swipeVerdict(false, 4, 3, 2)).toBe("pending");
  });

  test("a swipe to the left anywhere closes the open drawer", () => {
    expect(swipeVerdict(true, 200, -20, 3)).toBe("claim");
    expect(swipeVerdict(true, 200, -SWIPE_PX, 3)).toBe("close");
    expect(swipeVerdict(true, 200, SWIPE_PX, 3)).toBe("ignore");
  });
});

describe("drawerSettles", () => {
  test("let go slowly, the drawer stays open when more than half of it shows", () => {
    expect(drawerSettles(170, 300, 0)).toBe(true);
    expect(drawerSettles(130, 300, 0)).toBe(false);
  });

  test("a flick settles it the way it went, wherever it is let go", () => {
    expect(drawerSettles(40, 300, FLING_SPEED)).toBe(true);
    expect(drawerSettles(260, 300, -FLING_SPEED)).toBe(false);
  });
});

/**
 * The listener itself, on a stand-in document: a claimed stroke must keep every later move
 * from the page (the terminal's one-finger scroll listens below it) until the finger lifts.
 */
describe("watchDrawerSwipe", () => {
  type Handler = (event: unknown) => void;
  let listeners: Map<string, Handler>;
  let saved: { window: unknown; document: unknown };
  let narrow: { matches: boolean };
  let modal: unknown;
  let selection: { isCollapsed: boolean };

  beforeEach(() => {
    listeners = new Map();
    narrow = { matches: true };
    modal = null;
    selection = { isCollapsed: true };
    saved = { window: (globalThis as Record<string, unknown>)["window"], document: (globalThis as Record<string, unknown>)["document"] };
    (globalThis as Record<string, unknown>)["window"] = { matchMedia: () => narrow };
    (globalThis as Record<string, unknown>)["document"] = {
      addEventListener: (type: string, handler: Handler) => listeners.set(type, handler),
      removeEventListener: (type: string) => listeners.delete(type),
      querySelector: () => modal,
      getSelection: () => selection,
    };
  });
  afterEach(() => {
    (globalThis as Record<string, unknown>)["window"] = saved.window;
    (globalThis as Record<string, unknown>)["document"] = saved.document;
  });

  /** One stroke through the listener; how many moves reached the page, and what the drawer did. */
  const stroke = (points: [number, number][], open = false, target: unknown = null, midway?: () => void) => {
    const calls: boolean[] = [];
    const stop = watchDrawerSwipe(() => open, (next) => calls.push(next));
    let reached = 0;
    const event = (x: number, y: number) => {
      let blocked = false;
      return { touches: [{ clientX: x, clientY: y }], preventDefault: () => { blocked = true; }, stopPropagation: () => { blocked = true; }, get blocked() { return blocked; } };
    };
    const [first, ...rest] = points;
    listeners.get("touchstart")!({ ...event(first![0], first![1]), target });
    for (const [index, [x, y]] of rest.entries()) {
      if (index === 1) midway?.();
      const move = event(x, y);
      listeners.get("touchmove")!(move);
      if (!move.blocked) reached++;
    }
    listeners.get("touchend")!({ touches: [] });
    stop();
    return { reached, calls };
  };

  test("a claimed stroke that comes back within the slop keeps every move from the page", () => {
    expect(stroke([[4, 400], [24, 400], [6, 400], [5, 400]])).toEqual({ reached: 0, calls: [] });
  });

  test("a claimed stroke that comes back and goes on opens the drawer once, and keeps its moves", () => {
    expect(stroke([[4, 400], [24, 400], [6, 400], [70, 400], [90, 460], [120, 520]])).toEqual({ reached: 0, calls: [true] });
  });

  test("a flat mid-screen stroke opens and retains the stroke after opening", () => {
    expect(stroke([[200, 300], [220, 305], [260, 320], [280, 370]])).toEqual({ reached: 1, calls: [true] });
  });

  test("an initially flat interior stroke turns into scrolling without cancelling either move", () => {
    expect(stroke([[200, 300], [220, 302], [220, 370]])).toEqual({ reached: 2, calls: [] });
  });

  test("a diagonal mid-screen stroke stays with the page even if it later flattens", () => {
    expect(stroke([[200, 300], [220, 311], [280, 311]])).toEqual({ reached: 2, calls: [] });
  });

  test("a divider excludes opening, but still permits closing the open drawer", () => {
    const divider = { getAttribute: (name: string) => name === "role" ? "separator" : null, parentElement: null };
    const child = { parentElement: divider };
    for (const target of [divider, child]) {
      expect(stroke([[200, 300], [230, 300], [280, 300]], false, target)).toEqual({ reached: 2, calls: [] });
      expect(stroke([[200, 300], [170, 300], [120, 300]], true, target)).toEqual({ reached: 0, calls: [false] });
    }
  });

  test("a vertical stroke from mid-screen belongs to the page", () => {
    expect(stroke([[200, 300], [200, 330], [200, 360], [200, 400]])).toEqual({ reached: 3, calls: [] });
  });

  test("a swipe to the left closes the open drawer", () => {
    expect(stroke([[300, 400], [270, 400], [200, 400]], true)).toEqual({ reached: 0, calls: [false] });
  });

  test("a stroke that turns to scrolling before the drawer moved goes back to the page", () => {
    expect(stroke([[4, 300], [15, 302], [15, 360], [15, 430]])).toEqual({ reached: 2, calls: [] });
  });

  test("a swipe over a dialog, the palette or a sheet leaves the drawer under it alone", () => {
    modal = {};
    expect(stroke([[4, 400], [24, 400], [90, 400]])).toEqual({ reached: 2, calls: [] });
  });

  test("a swipe on a code block scrolled sideways scrolls it back instead", () => {
    const code = { scrollLeft: 40, scrollWidth: 900, clientWidth: 350, parentElement: null };
    const text = { scrollLeft: 0, scrollWidth: 0, clientWidth: 0, parentElement: code };
    expect(stroke([[4, 400], [24, 400], [90, 400]], false, text)).toEqual({ reached: 2, calls: [] });
  });

  test("a stroke that goes on after the screen turned wide leaves the drawer alone", () => {
    expect(stroke([[4, 400], [24, 400], [90, 400]], false, null, () => { narrow.matches = false; })).toEqual({ reached: 1, calls: [] });
  });

  test("a stroke on a text field edits it, the drawer open or closed", () => {
    const input = { tagName: "TEXTAREA", scrollLeft: 0, scrollWidth: 0, clientWidth: 0, parentElement: null };
    expect(stroke([[4, 400], [24, 400], [90, 400]], false, input)).toEqual({ reached: 2, calls: [] });
    expect(stroke([[300, 400], [270, 400], [200, 400]], true, input)).toEqual({ reached: 2, calls: [] });
    const block = { isContentEditable: true, tagName: "DIV", scrollLeft: 0, scrollWidth: 0, clientWidth: 0, parentElement: null };
    const inner = { tagName: "SPAN", scrollLeft: 0, scrollWidth: 0, clientWidth: 0, parentElement: block };
    expect(stroke([[4, 400], [24, 400], [90, 400]], false, inner)).toEqual({ reached: 2, calls: [] });
  });

  test("a stroke while text is selected drags the selection, not the drawer", () => {
    selection = { isCollapsed: false };
    expect(stroke([[4, 400], [24, 400], [90, 400]])).toEqual({ reached: 2, calls: [] });
    expect(stroke([[300, 400], [270, 400], [200, 400]], true)).toEqual({ reached: 2, calls: [] });
  });

  test("a selection begun mid-stroke, before the drawer moved, hands the stroke back", () => {
    expect(stroke([[4, 400], [24, 400], [40, 400], [90, 400]], false, null, () => { selection = { isCollapsed: false }; })).toEqual({ reached: 2, calls: [] });
  });

  test("the drawer is under the finger while it moves, and settles where it is let go", () => {
    const style: Record<string, string> = {};
    const drawer = { style, getBoundingClientRect: () => ({ width: 300 }) };
    const doc = (globalThis as Record<string, unknown>)["document"] as Record<string, unknown>;
    doc["getElementById"] = (id: string) => (id === "workspace-drawer" ? drawer : null);
    const seen: string[] = [];
    const watch = new Proxy(style, { set: (target, key: string, value: string) => { target[key] = value; if (key === "transform") seen.push(value); return true; } });
    drawer.style = watch;
    // past the swipe it opens, the finger comes back to a third of the drawer, and is let go slowly: it closes
    const timed = stroke([[4, 400], [24, 400], [100, 400], [100, 400], [100, 400]]);
    expect(seen).toContain("translateX(-204px)");
    expect(timed.calls).toEqual([true, false]);
    expect(style["transform"]).toBe("");
    expect(style["visibility"]).toBe("");
    delete doc["getElementById"];
  });

  test("a stroke whose end never came lets the drawer go at the next touch", () => {
    const drawer = { style: {} as Record<string, string>, getBoundingClientRect: () => ({ width: 300 }) };
    const scrim = { style: {} as Record<string, string> };
    const doc = (globalThis as Record<string, unknown>)["document"] as Record<string, unknown>;
    doc["getElementById"] = (id: string) => (id === "workspace-drawer" ? drawer : null);
    doc["querySelector"] = (selector: string) => (selector === ".scrim" ? scrim : null);
    const calls: boolean[] = [];
    const stop = watchDrawerSwipe(() => true, (next) => calls.push(next));
    const event = (x: number, timeStamp: number) => ({ touches: [{ clientX: x, clientY: 400 }], target: null, timeStamp, preventDefault: () => {}, stopPropagation: () => {} });
    // a swipe from the scrim closes the drawer, and its touchend never reaches the document
    listeners.get("touchstart")!(event(360, 0));
    listeners.get("touchmove")!(event(330, 16));
    listeners.get("touchmove")!(event(290, 32));
    expect(calls).toEqual([false]);
    expect(drawer.style["transform"]).toBe("translateX(-70px)");
    expect(scrim.style["transition"]).toBe("none");
    // the next touch finds it held, and lets it go where it was: most of it showed, so it stays open
    listeners.get("touchstart")!(event(100, 5000));
    expect(calls).toEqual([false, true]);
    expect(drawer.style["transform"]).toBe("");
    expect(drawer.style["transition"]).toBe("");
    expect(drawer.style["visibility"]).toBe("");
    expect(scrim.style["transition"]).toBe("");
    expect(scrim.style["opacity"]).toBe("");
    stop();
    delete doc["getElementById"];
  });

  test("a flick that lifts after one move settles by its speed from the touch down", () => {
    const drawer = { style: {} as Record<string, string>, getBoundingClientRect: () => ({ width: 300 }) };
    const doc = (globalThis as Record<string, unknown>)["document"] as Record<string, unknown>;
    doc["getElementById"] = (id: string) => (id === "workspace-drawer" ? drawer : null);
    const calls: boolean[] = [];
    const stop = watchDrawerSwipe(() => false, (next) => calls.push(next));
    const event = (x: number, timeStamp: number) => ({ touches: [{ clientX: x, clientY: 400 }], target: null, timeStamp, preventDefault: () => {}, stopPropagation: () => {} });
    // 36 px of 300 in 20 ms: far short of half, but fast enough to open
    listeners.get("touchstart")!(event(4, 0));
    listeners.get("touchmove")!(event(40, 20));
    listeners.get("touchend")!({ touches: [], timeStamp: 30 });
    expect(calls).toEqual([true]);
    stop();
    delete doc["getElementById"];
  });

  test("a decided flat interior move can open even when the browser no longer allows cancellation", () => {
    const calls: boolean[] = [];
    const stop = watchDrawerSwipe(() => false, (open) => calls.push(open));
    listeners.get("touchstart")!({ touches: [{ clientX: 200, clientY: 300 }], target: null });
    listeners.get("touchmove")!({ touches: [{ clientX: 270, clientY: 300 }], cancelable: false,
      preventDefault: () => { throw new Error("must not call preventDefault on a non-cancelable event"); }, stopPropagation: () => {} });
    expect(calls).toEqual([true]);
    stop();
  });

  /** Timed moves with a real drawer stand-in, including a rested lift that cannot count as a flick. */
  const timedStroke = (points: [number, number][], liftAt: number) => {
    const drawer = { style: {} as Record<string, string>, getBoundingClientRect: () => ({ width: 300 }) };
    const doc = (globalThis as Record<string, unknown>)["document"] as Record<string, unknown>;
    doc["getElementById"] = () => drawer;
    const calls: boolean[] = [];
    const stop = watchDrawerSwipe(() => false, (open) => calls.push(open));
    const event = ([x, at]: [number, number]) => ({ touches: [{ clientX: x, clientY: 400 }], timeStamp: at,
      target: null, cancelable: true, preventDefault: () => {}, stopPropagation: () => {} });
    listeners.get("touchstart")!(event(points[0]!));
    for (const point of points.slice(1)) listeners.get("touchmove")!(event(point));
    listeners.get("touchend")!({ touches: [], timeStamp: liftAt });
    expect(drawer.style["transform"]).toBe("");
    stop();
    return calls;
  };

  test("a slow short opening from the right half stays open after a rested lift", () => {
    expect(timedStroke([[320, 0], [340, 200], [360, 400], [380, 600]], 1600)).toEqual([true]);
  });

  test("an interior opening can still be reversed or flicked closed", () => {
    expect(timedStroke([[320, 0], [380, 600], [330, 900]], 1600)).toEqual([true, false]);
    expect(timedStroke([[200, 0], [360, 400], [300, 416]], 420)).toEqual([true, false]);
  });

  test("the edge keeps its existing half-width settling for a slow short stroke", () => {
    expect(timedStroke([[4, 0], [64, 600]], 1600)).toEqual([true, false]);
  });

  test("a selection after the drawer moved leaves the stroke with it", () => {
    expect(stroke([[4, 400], [70, 400], [90, 400], [100, 400]], false, null, () => { selection = { isCollapsed: false }; })).toEqual({ reached: 0, calls: [true] });
  });
});
