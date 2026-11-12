import { describe, expect, it } from "bun:test";
import { advanceStateStamps, parseStateStamps, stampState, stateSince, type LastLook, type PcLook, type StampState, type StateStamps } from "./agentStateSince.ts";

const MIN = 60_000;
const DAY = 86_400_000;
const T = 1_800_000_000_000;

/** one PC's rows at a look: pane -> its state and herdr's counter */
const look = (rows: Record<string, [StampState, number?]> | null, lifetime = "herdr-1", id = "pc"): PcLook =>
  ({ id, lifetime, rows: rows === null ? null : Object.entries(rows).map(([pane, [state, seq]]) => ({ pane, state, seq })) });

/** a page that looks at its PCs over time; `reload` is the same device opening the page again */
function device(stored: StateStamps = {}) {
  let stamps = stored;
  let last: LastLook = new Map();
  return {
    see(now: number, ...looks: PcLook[]): StateStamps {
      ({ stamps, last } = advanceStateStamps({ stamps, last }, looks, now));
      return stamps;
    },
    reload(): void { last = new Map(); },
    since: (pane: string, state: StampState): number | null => stateSince(stamps, "pc", pane, state),
  };
}

describe("state stamps: when this device saw a state begin", () => {
  it("gives a row first seen no time, and stamps it when its state changes in sight", () => {
    const page = device();
    page.see(T, look({ a: ["working", 1] }));
    expect(page.since("a", "working")).toBeNull();

    page.see(T + 5 * MIN, look({ a: ["idle", 2] }));
    expect(page.since("a", "idle")).toBe(T + 5 * MIN);
    expect(page.since("a", "working")).toBeNull();
  });

  it("stamps a pane that appears in a roster the page was already watching", () => {
    const page = device();
    page.see(T, look({ a: ["idle", 1] }));
    page.see(T + MIN, look({ a: ["idle", 1], b: ["working", 2] }));
    expect(page.since("b", "working")).toBe(T + MIN);
    expect(page.since("a", "idle")).toBeNull();
  });

  it("keeps a stamp across a reload while herdr's counter says nothing changed", () => {
    const page = device();
    page.see(T, look({ a: ["working", 1] }));
    page.see(T + MIN, look({ a: ["blocked", 2] }));
    page.reload();
    page.see(T + 9 * MIN, look({ a: ["blocked", 2] }));
    expect(page.since("a", "blocked")).toBe(T + MIN);
  });

  it("drops a stamp on a reload when the state went away and came back out of sight", () => {
    const page = device();
    page.see(T, look({ a: ["working", 1] }));
    page.see(T + MIN, look({ a: ["blocked", 2] }));
    page.reload();
    page.see(T + 9 * MIN, look({ a: ["blocked", 4] }));
    expect(page.since("a", "blocked")).toBeNull();
  });

  it("counts done and idle as one state: a finish that is read keeps its time, in sight and across a reload", () => {
    expect(stampState("done")).toBe("idle");
    expect(stampState("blocked")).toBe("blocked");
    const page = device();
    page.see(T, look({ a: ["working", 1] }));
    page.see(T + MIN, look({ a: [stampState("done"), 2] }));
    // herdr moves its counter as the finish is read; the row is at rest all along
    page.see(T + 3 * MIN, look({ a: [stampState("idle"), 3] }));
    expect(page.since("a", "idle")).toBe(T + MIN);

    page.reload();
    page.see(T + 4 * MIN, look({ a: ["idle", 3] }));
    expect(page.since("a", "idle")).toBe(T + MIN);
  });

  it("keeps the time of a pane that leaves the roster for a look and returns unchanged", () => {
    const page = device();
    page.see(T, look({ a: ["idle", 1], b: ["idle", 2] }));
    page.see(T + MIN, look({ a: ["working", 3], b: ["idle", 2] }));
    page.see(T + 2 * MIN, look({ b: ["idle", 2] }));
    page.see(T + 3 * MIN, look({ a: ["working", 3], b: ["idle", 2] }));
    expect(page.since("a", "working")).toBe(T + MIN);
  });

  it("stamps a pane anew when the one that returns under its id is another agent's", () => {
    const page = device();
    page.see(T, look({ a: ["idle", 1] }));
    page.see(T + MIN, look({ a: ["working", 2] }));
    page.see(T + 2 * MIN, look({}));
    page.see(T + 3 * MIN, look({ a: ["working", 7] }));
    expect(page.since("a", "working")).toBe(T + 3 * MIN);
  });

  it("leaves a PC's stamps alone while it is away, and trusts them on its return only where nothing changed", () => {
    const page = device();
    page.see(T, look({ a: ["idle", 1], b: ["idle", 2] }));
    page.see(T + MIN, look({ a: ["working", 3], b: ["blocked", 4] }));
    page.see(T + 2 * MIN, look(null));
    expect(page.since("a", "working")).toBe(T + MIN);

    page.see(T + 30 * MIN, look({ a: ["working", 3], b: ["idle", 5] }));
    expect(page.since("a", "working")).toBe(T + MIN);
    expect(page.since("b", "idle")).toBeNull();
  });

  it("drops a PC's stamps when its herdr is another one: the pane ids start over", () => {
    const page = device();
    page.see(T, look({ a: ["idle", 1] }));
    page.see(T + MIN, look({ a: ["working", 2] }));
    page.reload();
    page.see(T + 2 * MIN, look({ a: ["working", 2] }, "herdr-2"));
    expect(page.since("a", "working")).toBeNull();
  });

  it("never leaves a stamp ahead of a clock that was set back", () => {
    const page = device();
    page.see(T, look({ a: ["idle", 1] }));
    page.see(T + 10 * MIN, look({ a: ["working", 2] }));
    page.see(T + 4 * MIN, look({ a: ["working", 2] }));
    expect(page.since("a", "working")).toBe(T + 4 * MIN);

    page.see(T + 20 * MIN, look({ a: ["working", 2] }));
    expect(page.since("a", "working")).toBe(T + 4 * MIN);
  });

  it("forgets a pane that has been gone from its PC's roster for thirty days, and no listed one", () => {
    const page = device();
    page.see(T, look({ a: ["idle", 1], b: ["idle", 2] }));
    page.see(T + MIN, look({ a: ["working", 3], b: ["working", 4] }));
    page.see(T + 29 * DAY, look({ b: ["working", 4] }));
    expect(page.since("a", "working")).toBe(T + MIN);

    const kept = page.see(T + 31 * DAY, look({ b: ["working", 4] }));
    expect(kept).toEqual({ pc: { lifetime: "herdr-1", rows: { b: { state: "working", at: T + MIN, seq: 4 } } } });
  });

  it("keeps the stamps of a PC that left the roster until they are thirty days old", () => {
    const page = device();
    page.see(T, look({ a: ["idle", 1] }));
    page.see(T + MIN, look({ a: ["working", 2] }));
    page.see(T + 29 * DAY);
    expect(page.since("a", "working")).toBe(T + MIN);
    expect(page.see(T + 31 * DAY)).toEqual({});
  });

  it("hands back the very stamps it was given when a look changes nothing, so nothing is written", () => {
    const empty: StateStamps = {};
    expect(advanceStateStamps({ stamps: empty, last: new Map() }, [look({ a: ["idle", 1] })], T).stamps).toBe(empty);

    const page = device();
    page.see(T, look({ a: ["idle", 1] }));
    const stamped = page.see(T + MIN, look({ a: ["working", 2] }));
    expect(page.see(T + 2 * MIN, look({ a: ["working", 2] }))).toBe(stamped);
  });
});

describe("stored state stamps", () => {
  it("reads what it wrote and drops every field that is not a stamp", () => {
    const stored = JSON.stringify({ version: 1, pcs: {
      pc: { lifetime: "herdr-1", rows: {
        good: { state: "blocked", at: T, seq: 4 },
        unseq: { state: "idle", at: T + 1 },
        done: { state: "done", at: T },
        undated: { state: "idle", at: "yesterday" },
        endless: { state: "working", at: Infinity },
      } },
      nameless: { rows: { a: { state: "working", at: T, seq: "9" } } },
      broken: "rows",
    } });
    expect(parseStateStamps(stored)).toEqual({
      pc: { lifetime: "herdr-1", rows: { good: { state: "blocked", at: T, seq: 4 }, unseq: { state: "idle", at: T + 1 } } },
      nameless: { lifetime: null, rows: { a: { state: "working", at: T } } },
    });
  });

  it("reads nothing from another version, from text that is not JSON, or from no record", () => {
    expect(parseStateStamps(JSON.stringify({ version: 2, pcs: { pc: { lifetime: "h", rows: { a: { state: "idle", at: T } } } } }))).toEqual({});
    expect(parseStateStamps("{")).toEqual({});
    expect(parseStateStamps(null)).toEqual({});
  });
});
