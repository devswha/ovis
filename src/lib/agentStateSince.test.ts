import { describe, expect, it } from "bun:test";
import { advanceStateStamps, loadStateStamps, parseStateStamps, saveStateStamps, stampState, stateSince, type LastLook, type PcLook, type StampState, type StateStamps } from "./agentStateSince.ts";

const MIN = 60_000;
const DAY = 86_400_000;
const T = 1_800_000_000_000;

/** a row at a look: its state, herdr's counter, the server's count of its finishes (none yet unless said), and what else the look says of it */
type Row = [state: StampState, seq?: number, finish?: number, more?: { done?: boolean; wait?: boolean; own?: boolean }];
/** one PC's rows at a look, by pane, of one herdr and one server (its finishes' epoch) */
const look = (rows: Record<string, Row> | null, lifetime = "herdr-1", id = "pc", epoch: string | null = "server-1"): PcLook =>
  ({ id, lifetime, epoch, rows: rows === null ? null : Object.entries(rows).map(([pane, [state, seq, finish = 0, more]]) => ({ pane, state, seq, finish, done: more?.done ?? false, wait: more?.wait ?? false, own: more?.own ?? false })) });
/** the roster says done: a finish herdr has not seen read */
const DONE = { done: true };
/** at rest while its turn's background work still runs: the roster says done, and the row shows working */
const WAITING = { done: true, wait: true };
/** an agent whose state Ovis reads from its own session files */
const OWN = { own: true };

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
    page.see(T + MIN, look({ a: [stampState("done"), 2, 1, DONE] }));
    // herdr moves its counter as the finish is read; the row is at rest all along
    page.see(T + 3 * MIN, look({ a: [stampState("idle"), 3, 1] }));
    expect(page.since("a", "idle")).toBe(T + MIN);

    page.reload();
    page.see(T + 4 * MIN, look({ a: ["idle", 3, 1] }));
    expect(page.since("a", "idle")).toBe(T + MIN);
  });

  it("drops a stamp on a reload when a turn ended meanwhile, though herdr's counter stands: the state Ovis shows is not always herdr's", () => {
    const page = device();
    page.see(T, look({ a: ["idle", 1] }));
    page.see(T + MIN, look({ a: ["working", 2] }));
    page.reload();
    // a Claude whose turn ended while a subagent kept herdr at working, and that works again: one finish counted, herdr's counter where it was
    page.see(T + 600 * MIN, look({ a: ["working", 2, 1] }));
    expect(page.since("a", "working")).toBeNull();
  });

  it("trusts no kept stamp of an agent whose state Ovis reads itself: herdr's counter stands whatever it does", () => {
    const page = device();
    // here herdr's counter even moved with the change, as it may for what herdr takes the pane for
    page.see(T, look({ a: ["idle", 5, 0, OWN] }));
    page.see(T + MIN, look({ a: ["working", 6, 0, OWN] }));
    // in sight its change is stamped as any other's
    expect(page.since("a", "working")).toBe(T + MIN);

    page.reload();
    // it may have waited for an answer and worked on, with both counters where they were
    page.see(T + 600 * MIN, look({ a: ["working", 6, 0, OWN] }));
    expect(page.since("a", "working")).toBeNull();
  });

  it("drops a PC's kept stamps on a reload after its server started anew, and keeps them in a page that watched through it", () => {
    const reloaded = device();
    reloaded.see(T, look({ a: ["idle", 1] }));
    reloaded.see(T + MIN, look({ a: ["working", 2, 4] }));
    reloaded.reload();
    // the new server counts its finishes from nothing: the same number is no proof
    reloaded.see(T + 2 * MIN, look({ a: ["working", 2, 4] }, "herdr-1", "pc", "server-2"));
    expect(reloaded.since("a", "working")).toBeNull();

    const watching = device();
    watching.see(T, look({ a: ["idle", 1] }));
    watching.see(T + MIN, look({ a: ["working", 2, 4] }));
    watching.see(T + 2 * MIN, look({ a: ["working", 2, 0] }, "herdr-1", "pc", "server-2"));
    expect(watching.since("a", "working")).toBe(T + MIN);
    // and from then on the new server's count proves it
    watching.reload();
    watching.see(T + 3 * MIN, look({ a: ["working", 2, 0] }, "herdr-1", "pc", "server-2"));
    expect(watching.since("a", "working")).toBe(T + MIN);
  });

  it("drops the time of a state that was left and come back to between two looks", () => {
    const waited = device();
    waited.see(T, look({ a: ["working", 1] }));
    waited.see(T + MIN, look({ a: ["blocked", 2] }));
    // it worked and waits again before the page looked: the state reads the same, herdr's counter does not
    waited.see(T + 5 * MIN, look({ a: ["blocked", 4] }));
    expect(waited.since("a", "blocked")).toBeNull();

    const rested = device();
    rested.see(T, look({ a: ["working", 1] }));
    rested.see(T + MIN, look({ a: ["idle", 2, 1] }));
    // another turn began and ended: one more finish
    rested.see(T + 5 * MIN, look({ a: ["idle", 2, 2] }));
    expect(rested.since("a", "idle")).toBeNull();
  });

  it("drops no time for a roster that names no counter for a moment: only two numbers that differ are a move", () => {
    const page = device();
    page.see(T, look({ a: ["working", 1] }));
    page.see(T + MIN, look({ a: ["blocked", 2] }));
    page.see(T + 2 * MIN, { ...look({ a: ["blocked"] }), rows: [{ pane: "a", state: "blocked", seq: undefined, finish: undefined, done: false, wait: false, own: false }] });
    page.see(T + 3 * MIN, look({ a: ["blocked", 2] }));
    expect(page.since("a", "blocked")).toBe(T + MIN);
  });

  it("keeps a time through the roster that brings the counter of a change a pushed status told of first", () => {
    const page = device();
    page.see(T, look({ a: ["working", 1] }));
    // a pushed status: the roster's counter is still the last change's
    page.see(T + MIN, look({ a: ["blocked", 1] }));
    page.see(T + MIN + 1000, look({ a: ["blocked", 2] }));
    expect(page.since("a", "blocked")).toBe(T + MIN);

    page.reload();
    page.see(T + 9 * MIN, look({ a: ["blocked", 2] }));
    expect(page.since("a", "blocked")).toBe(T + MIN);
  });

  it("keeps a rest's time when a pushed status says its finish was read, and the roster then brings herdr's counter", () => {
    const page = device();
    page.see(T, look({ a: ["working", 1] }));
    page.see(T + MIN, look({ a: ["idle", 2, 1, DONE] }));
    page.see(T + 2 * MIN, look({ a: ["idle", 2, 1] }));
    page.see(T + 2 * MIN + 1000, look({ a: ["idle", 3, 1] }));
    expect(page.since("a", "idle")).toBe(T + MIN);
    // the debt is paid: a counter that moves again is a state left and come back to
    page.see(T + 5 * MIN, look({ a: ["idle", 5, 1] }));
    expect(page.since("a", "idle")).toBeNull();
  });

  it("keeps a working time through the end of a turn whose background work holds the row at working", () => {
    const page = device();
    page.see(T, look({ a: ["idle", 1] }));
    page.see(T + MIN, look({ a: ["working", 2] }));
    // the turn ends and its subagent runs on: herdr's counter moves, the server counts the finish, the row shows working
    page.see(T + 10 * MIN, look({ a: ["working", 3, 1, WAITING] }));
    expect(page.since("a", "working")).toBe(T + MIN);
    // the subagent's notice starts the next turn: herdr turns from done to working
    page.see(T + 12 * MIN, look({ a: ["working", 4, 1] }));
    expect(page.since("a", "working")).toBe(T + MIN);

    // with no such wait, a finish counted under a row that goes on working is a turn that ended and another that began
    const missed = device();
    missed.see(T, look({ a: ["idle", 1] }));
    missed.see(T + MIN, look({ a: ["working", 2] }));
    missed.see(T + 10 * MIN, look({ a: ["working", 4, 1] }));
    expect(missed.since("a", "working")).toBeNull();

    // and a wait found with two finishes counted holds a later turn than the one the page saw begin
    const later = device();
    later.see(T, look({ a: ["idle", 1] }));
    later.see(T + MIN, look({ a: ["working", 2] }));
    later.see(T + 10 * MIN, look({ a: ["working", 5, 2, WAITING] }));
    expect(later.since("a", "working")).toBeNull();
  });

  it("drops a stamp on a reload that only a pushed status told of: its change's counter never came", () => {
    const page = device();
    page.see(T, look({ a: ["working", 1] }));
    page.see(T + MIN, look({ a: ["blocked", 1] }));
    page.reload();
    page.see(T + 9 * MIN, look({ a: ["blocked", 2] }));
    expect(page.since("a", "blocked")).toBeNull();
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

  it("keeps another tab's time for a change that tab heard of by a pushed status, and takes the counter the roster brings", () => {
    const kept = { stamps: {} };
    const first = device(kept), second = device(kept);
    first.see(T, look({ a: ["working", 1] }));
    second.see(T, look({ a: ["working", 1] }));
    // the first tab stamps on the pushed status, with no counter of the change yet; the second sees it with its roster
    first.see(T + MIN, look({ a: ["blocked", 1] }));
    second.see(T + MIN + 2000, look({ a: ["blocked", 2] }));
    expect(second.since("a", "blocked")).toBe(T + MIN);
    first.see(T + MIN + 3000, look({ a: ["blocked", 2] }));
    expect(first.since("a", "blocked")).toBe(T + MIN);

    first.reload();
    first.see(T + 9 * MIN, look({ a: ["blocked", 2] }));
    expect(first.since("a", "blocked")).toBe(T + MIN);
  });

  it("keeps another tab's time for a change both see where herdr counts nothing: the stamp was made while this tab had the last state", () => {
    const kept = { stamps: {} };
    const first = device(kept), second = device(kept);
    first.see(T, look({ a: ["idle"] }));
    second.see(T, look({ a: ["idle"] }));
    first.see(T + MIN, look({ a: ["working"] }));
    second.see(T + 2 * MIN, look({ a: ["working"] }));
    expect(second.since("a", "working")).toBe(T + MIN);
  });

  it("leaves another tab's stamp of a state this tab has not seen yet, and keeps its time when it sees it", () => {
    for (const counts of [true, false]) {
      const seq = (n: number): number | undefined => counts ? n : undefined;
      const kept = { stamps: {} };
      const ahead = device(kept), behind = device(kept);
      ahead.see(T, look({ a: ["working", seq(1)], b: ["idle", seq(2)] }));
      behind.see(T, look({ a: ["working", seq(1)], b: ["idle", seq(2)] }));
      ahead.see(T + MIN, look({ a: ["blocked", seq(3)], b: ["idle", seq(2)] }));
      // the tab behind hears of another agent first: in its roster `a` still works
      behind.see(T + 2 * MIN, look({ a: ["working", seq(1)], b: ["working", seq(4)] }));
      expect(ahead.since("a", "blocked")).toBe(T + MIN);
      behind.see(T + 3 * MIN, look({ a: ["blocked", seq(3)], b: ["working", seq(4)] }));
      expect(behind.since("a", "blocked")).toBe(T + MIN);
      expect(behind.since("b", "working")).toBe(T + 2 * MIN);
    }
  });

  it("leaves another tab's stamp alone when this tab's own counters move under a state it has been seeing", () => {
    const kept = { stamps: {} };
    const ahead = device(kept), behind = device(kept);
    ahead.see(T, look({ a: ["working", 5, 0, OWN] }));
    behind.see(T, look({ a: ["working", 5, 0, OWN] }));
    // it ended a turn, worked again and waits: the tab ahead sees the wait begin
    ahead.see(T + MIN, look({ a: ["blocked", 5, 1, OWN] }));
    // the tab behind hears of the finish and of the work after it, not yet of the wait
    behind.see(T + 2 * MIN, look({ a: ["working", 5, 1, OWN] }));
    expect(ahead.since("a", "blocked")).toBe(T + MIN);
  });

  it("goes by what this tab saw: a stamp from before it saw the pane's last state is not the time of a change it is then told of", () => {
    const kept = { stamps: {} };
    const ahead = device(kept), late = device(kept);
    ahead.see(T, look({ a: ["working", 5] }));
    ahead.see(T + MIN, look({ a: ["blocked", 7] }));
    // a tab opens on a roster in which the pane works, under a counter older than the stamp's: the stamp is left alone
    late.see(T + 2 * MIN, look({ a: ["working", 5] }));
    expect(ahead.since("a", "blocked")).toBe(T + MIN);
    // a pushed status then says it waits, with no counter of that change yet: the tab saw it work after the stamp was made
    late.see(T + 3 * MIN, look({ a: ["blocked", 5] }));
    expect(late.since("a", "blocked")).toBe(T + 3 * MIN);
  });

  it("does not let a tab behind stamp its old news over a newer stamp", () => {
    const kept = { stamps: {} };
    const ahead = device(kept), behind = device(kept);
    ahead.see(T, look({ a: ["idle", 1] }));
    behind.see(T, look({ a: ["idle", 1] }));
    ahead.see(T + MIN, look({ a: ["working", 2] }));
    ahead.see(T + 2 * MIN, look({ a: ["blocked", 3] }));
    // only now the tab behind hears that it worked, and only on a reload that it waits
    behind.see(T + 3 * MIN, look({ a: ["working", 2] }));
    expect(ahead.since("a", "blocked")).toBe(T + 2 * MIN);
    behind.reload();
    behind.see(T + 4 * MIN, look({ a: ["working", 2] }));
    expect(ahead.since("a", "blocked")).toBe(T + 2 * MIN);
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
    expect(page.see(T + 25 * MIN, look({}))).toEqual({ pc: { lifetime: "herdr-1", epoch: "server-1", rows: { a: { state: "working", at: T + 4 * MIN, seq: 2, finish: 0, gone: T + 25 * MIN } } } });
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
    expect(kept).toEqual({ pc: { lifetime: "herdr-1", epoch: "server-1", rows: { b: { state: "working", at: T + MIN, seq: 4, finish: 0 } } } });
  });

  it("keeps the time of a pane more than thirty days in its state that leaves the roster for a look", () => {
    const page = device();
    page.see(T, look({ a: ["idle", 1] }));
    page.see(T + MIN, look({ a: ["working", 2] }));
    page.see(T + 40 * DAY, look({}));
    // back, and listed again: the mark of its leaving goes
    expect(page.see(T + 40 * DAY + MIN, look({ a: ["working", 2] }))).toEqual({ pc: { lifetime: "herdr-1", epoch: "server-1", rows: { a: { state: "working", at: T + MIN, seq: 2, finish: 0 } } } });
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
      pc: { lifetime: "herdr-1", epoch: "server-1", rows: {
        good: { state: "blocked", at: T, seq: 4, finish: 2 },
        unseq: { state: "idle", at: T + 1, finish: "two" },
        left: { state: "idle", at: T + 2, seq: 5, gone: T + 9 },
        leaving: { state: "idle", at: T + 3, gone: "soon" },
        done: { state: "done", at: T },
        undated: { state: "idle", at: "yesterday" },
        endless: { state: "working", at: Infinity },
      } },
      nameless: { epoch: 7, rows: { a: { state: "working", at: T, seq: "9" } } },
      broken: "rows",
    } });
    expect(parseStateStamps(stored)).toEqual({
      pc: { lifetime: "herdr-1", epoch: "server-1", rows: { good: { state: "blocked", at: T, seq: 4, finish: 2 }, unseq: { state: "idle", at: T + 1 }, left: { state: "idle", at: T + 2, seq: 5, gone: T + 9 }, leaving: { state: "idle", at: T + 3 } } },
      nameless: { lifetime: null, epoch: null, rows: { a: { state: "working", at: T } } },
    });
  });

  it("reads what this page wrote without parsing it again, and what another tab then wrote", () => {
    const page = Object.getOwnPropertyDescriptor(globalThis, "window");
    let text: string | null = null;
    Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: {
      getItem: () => text,
      setItem: (_key: string, value: string) => { text = value; },
    } } });
    try {
      const mine: StateStamps = { pc: { lifetime: "herdr-1", epoch: "server-1", rows: { a: { state: "idle", at: T, seq: 1, finish: 0 } } } };
      expect(saveStateStamps(mine)).toBe(true);
      expect(loadStateStamps()).toBe(mine);

      const theirs: StateStamps = { pc: { lifetime: "herdr-1", epoch: "server-1", rows: { a: { state: "working", at: T + MIN, seq: 2, finish: 0 } } } };
      text = JSON.stringify({ version: 1, pcs: theirs });
      const read = loadStateStamps();
      expect(read).toEqual(theirs);
      expect(loadStateStamps()).toBe(read);
    } finally {
      if (page) Object.defineProperty(globalThis, "window", page);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });

  it("reads nothing from another version, from text that is not JSON, or from no record", () => {
    expect(parseStateStamps(JSON.stringify({ version: 2, pcs: { pc: { lifetime: "h", rows: { a: { state: "idle", at: T } } } } }))).toEqual({});
    expect(parseStateStamps("{")).toEqual({});
    expect(parseStateStamps(null)).toEqual({});
  });
});
