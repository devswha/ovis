import { describe, expect, it } from "bun:test";
import { advanceStateStamps, parseStateStamps, stampState, stateSince, type LastLook, type PcLook, type StampState, type StateStamps } from "./agentStateSince.ts";

const MIN = 60_000;
const DAY = 86_400_000;
const T = 1_800_000_000_000;

/** one PC's rows at a look: pane -> its state and herdr's counter */
const look = (rows: Record<string, [StampState, number?]> | null, lifetime = "herdr-1", id = "pc"): PcLook =>
  ({ id, lifetime, rows: rows === null ? null : Object.entries(rows).map(([pane, [state, seq]]) => ({ pane, state, seq })) });

/**
 * A page that looks at its PCs over time, reading the device's stamps anew at each look and writing them back, as the
 * app does. `reload` is the same device opening the page again; a second page over the same `kept` is another tab of it.
 */
function device(kept: { stamps: StateStamps } = { stamps: {} }) {
  let last: LastLook = new Map();
  return {
    see(now: number, ...looks: PcLook[]): StateStamps {
      ({ stamps: kept.stamps, last } = advanceStateStamps({ stamps: kept.stamps, last }, looks, now));
      return kept.stamps;
    },
    /** a look that cannot say when what it finds began (lib/agentStateWatch.ts) */
    seeUndated(now: number, ...looks: PcLook[]): StateStamps {
      ({ stamps: kept.stamps, last } = advanceStateStamps({ stamps: kept.stamps, last }, looks, now, false));
      return kept.stamps;
    },
    reload(): void { last = new Map(); },
    since: (pane: string, state: StampState): number | null => stateSince(kept.stamps, "pc", pane, state),
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

  it("drops a stamp on a reload when herdr gives no counter: nothing proves the state did not go and come back", () => {
    const page = device();
    page.see(T, look({ a: ["working"] }));
    page.see(T + MIN, look({ a: ["blocked"] }));
    // in sight the page saw every look, so the stamp holds with no counter
    page.see(T + 2 * MIN, look({ a: ["blocked"] }));
    expect(page.since("a", "blocked")).toBe(T + MIN);

    page.reload();
    page.see(T + 9 * MIN, look({ a: ["blocked"] }));
    expect(page.since("a", "blocked")).toBeNull();

    page.see(T + 10 * MIN, look({ a: ["working"] }));
    expect(page.since("a", "working")).toBe(T + 10 * MIN);
  });

  it("drops a stamp on a reload when only the stamp, or only the row, carries herdr's counter", () => {
    const counted = device();
    counted.see(T, look({ a: ["working", 1] }));
    counted.see(T + MIN, look({ a: ["blocked", 2] }));
    counted.reload();
    counted.see(T + 5 * MIN, look({ a: ["blocked"] }));
    expect(counted.since("a", "blocked")).toBeNull();

    const uncounted = device();
    uncounted.see(T, look({ a: ["working"] }));
    uncounted.see(T + MIN, look({ a: ["blocked"] }));
    uncounted.reload();
    uncounted.see(T + 5 * MIN, look({ a: ["blocked", 2] }));
    expect(uncounted.since("a", "blocked")).toBeNull();
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

  it("stamps no change at a look that cannot date it, and keeps the times the page had", () => {
    const page = device();
    page.see(T, look({ a: ["idle", 1], b: ["idle", 2], c: ["idle", 3] }));
    page.see(T + MIN, look({ a: ["working", 4], b: ["working", 5], c: ["idle", 3] }));
    // a read after the stream said nothing for an hour: `b` waits and `d` is new, since some time in that hour
    page.seeUndated(T + 60 * MIN, look({ a: ["working", 4], b: ["blocked", 6], c: ["idle", 3], d: ["working", 7] }));
    expect(page.since("a", "working")).toBe(T + MIN);
    expect(page.since("b", "blocked")).toBeNull();
    expect(page.since("d", "working")).toBeNull();

    // the page watches again from that look on
    page.see(T + 61 * MIN, look({ a: ["working", 4], b: ["working", 8], c: ["idle", 3], d: ["working", 7] }));
    expect(page.since("b", "working")).toBe(T + 61 * MIN);
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

  it("gives the panes of another herdr no time when it replaces the one this page was watching", () => {
    const page = device();
    page.see(T, look({ a: ["working", 1], b: ["idle", 2] }));
    // between two looks the PC's herdr was replaced: `a` and `b` name other panes now, and this page saw none of their states begin
    page.see(T + MIN, look({ a: ["idle", 1], b: ["idle", 2], c: ["working", 3] }, "herdr-2"));
    expect(page.since("a", "idle")).toBeNull();
    expect(page.since("b", "idle")).toBeNull();
    expect(page.since("c", "working")).toBeNull();

    // from then on it watches the new one
    page.see(T + 2 * MIN, look({ a: ["working", 4], b: ["idle", 2], c: ["working", 3] }, "herdr-2"));
    expect(page.since("a", "working")).toBe(T + 2 * MIN);
  });

  it("keeps the time another tab of this device stamped for a change both see", () => {
    const kept = { stamps: {} };
    const first = device(kept), second = device(kept);
    first.see(T, look({ a: ["idle", 1] }));
    second.see(T, look({ a: ["idle", 1] }));
    // the first tab sees the change as it happens; the second, held back in the background, learns of it later
    first.see(T + MIN, look({ a: ["working", 2] }));
    second.see(T + 20 * MIN, look({ a: ["working", 2] }));
    expect(second.since("a", "working")).toBe(T + MIN);

    // a change the kept stamp does not tell of is stamped by the tab that sees it, and the other keeps that
    second.see(T + 30 * MIN, look({ a: ["idle", 3] }));
    first.see(T + 31 * MIN, look({ a: ["idle", 3] }));
    expect(first.since("a", "idle")).toBe(T + 30 * MIN);
  });

  it("never leaves a stamp ahead of a clock that was set back", () => {
    const page = device();
    page.see(T, look({ a: ["idle", 1] }));
    page.see(T + 10 * MIN, look({ a: ["working", 2] }));
    page.see(T + 4 * MIN, look({ a: ["working", 2] }));
    expect(page.since("a", "working")).toBe(T + 4 * MIN);

    page.see(T + 20 * MIN, look({ a: ["working", 2] }));
    expect(page.since("a", "working")).toBe(T + 4 * MIN);

    // nor the mark of when a pane left the roster
    page.see(T + 30 * MIN, look({}));
    expect(page.see(T + 25 * MIN, look({}))).toEqual({ pc: { lifetime: "herdr-1", rows: { a: { state: "working", at: T + 4 * MIN, seq: 2, gone: T + 25 * MIN } } } });
  });

  it("forgets a pane thirty days after it left its PC's roster, however long it had been in its state, and no listed one", () => {
    const page = device();
    page.see(T, look({ a: ["idle", 1], b: ["idle", 2] }));
    page.see(T + MIN, look({ a: ["working", 3], b: ["working", 4] }));
    // listed for forty days, then gone: the thirty days are counted from the look that first missed it
    page.see(T + 40 * DAY, look({ a: ["working", 3], b: ["working", 4] }));
    page.see(T + 40 * DAY + MIN, look({ b: ["working", 4] }));
    page.see(T + 69 * DAY, look({ b: ["working", 4] }));
    expect(page.since("a", "working")).toBe(T + MIN);

    const kept = page.see(T + 71 * DAY, look({ b: ["working", 4] }));
    expect(kept).toEqual({ pc: { lifetime: "herdr-1", rows: { b: { state: "working", at: T + MIN, seq: 4 } } } });
  });

  it("keeps the time of a pane more than thirty days in its state that leaves the roster for a look", () => {
    const page = device();
    page.see(T, look({ a: ["idle", 1] }));
    page.see(T + MIN, look({ a: ["working", 2] }));
    page.see(T + 40 * DAY, look({}));
    // back, and listed again: the mark of its leaving goes
    expect(page.see(T + 40 * DAY + MIN, look({ a: ["working", 2] }))).toEqual({ pc: { lifetime: "herdr-1", rows: { a: { state: "working", at: T + MIN, seq: 2 } } } });
  });

  it("keeps the stamps of a PC that left the roster for thirty days from the look that first missed it", () => {
    const page = device();
    page.see(T, look({ a: ["idle", 1] }));
    page.see(T + MIN, look({ a: ["working", 2] }));
    page.see(T + 40 * DAY);
    page.see(T + 69 * DAY);
    expect(page.since("a", "working")).toBe(T + MIN);
    expect(page.see(T + 71 * DAY)).toEqual({});
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
        left: { state: "idle", at: T + 2, seq: 5, gone: T + 9 },
        leaving: { state: "idle", at: T + 3, gone: "soon" },
        done: { state: "done", at: T },
        undated: { state: "idle", at: "yesterday" },
        endless: { state: "working", at: Infinity },
      } },
      nameless: { rows: { a: { state: "working", at: T, seq: "9" } } },
      broken: "rows",
    } });
    expect(parseStateStamps(stored)).toEqual({
      pc: { lifetime: "herdr-1", rows: { good: { state: "blocked", at: T, seq: 4 }, unseq: { state: "idle", at: T + 1 }, left: { state: "idle", at: T + 2, seq: 5, gone: T + 9 }, leaving: { state: "idle", at: T + 3 } } },
      nameless: { lifetime: null, rows: { a: { state: "working", at: T } } },
    });
  });

  it("reads nothing from another version, from text that is not JSON, or from no record", () => {
    expect(parseStateStamps(JSON.stringify({ version: 2, pcs: { pc: { lifetime: "h", rows: { a: { state: "idle", at: T } } } } }))).toEqual({});
    expect(parseStateStamps("{")).toEqual({});
    expect(parseStateStamps(null)).toEqual({});
  });
});
