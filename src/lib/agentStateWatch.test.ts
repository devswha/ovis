import { afterEach, beforeEach, describe, expect, it, jest, setSystemTime } from "bun:test";
import { stateWatch, type UnseenLook } from "./agentStateWatch.ts";

const T = 1_800_000_000_000;
const SEC = 1_000;
const MIN = 60 * SEC;

describe("the watch the state stamps go by", () => {
  let end: () => void;
  let unseen: UnseenLook[];

  /** the page runs for a while: its timers fire as the clock moves */
  const runs = (ms: number): void => { jest.advanceTimersByTime(ms); };
  /** the page does not run for a while: the clock moves and no timer of it fires */
  const sleeps = (ms: number): void => { jest.setSystemTime(new Date(Date.now() + ms)); };
  /** a read of the roster, asked and answered now */
  const reads = (): void => { stateWatch.read(stateWatch.asked()); };
  /** a stream that opened and sent its own first roster */
  const streams = (): void => { stateWatch.subscription("opened"); stateWatch.pushed(); };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(T));
    unseen = [];
    end = stateWatch.keep((look) => { unseen.push(look); });
  });

  afterEach(() => {
    end();
    jest.useRealTimers();
    setSystemTime();
  });

  it("has lost nothing while no roster was told to it", () => {
    sleeps(60 * MIN);
    expect(stateWatch.blind()).toBe(false);
    reads();
    expect(unseen).toEqual([]);
  });

  it("holds through a quiet hour of an open stream while the page runs", () => {
    streams();
    runs(60 * MIN);
    expect(stateWatch.blind()).toBe(false);

    stateWatch.pushed();
    expect(unseen).toEqual([]);
  });

  it("holds in a hidden tab, whose timers run about once a minute", () => {
    streams();
    for (let minute = 0; minute < 30; minute++) {
      sleeps(MIN - 5 * SEC);
      runs(5 * SEC);
    }
    expect(stateWatch.blind()).toBe(false);
  });

  it("reads the roster after a sleep as a first look, and trusts nothing held back or asked before it", () => {
    streams();
    const askedBefore = stateWatch.asked();
    sleeps(60 * MIN);
    expect(stateWatch.blind()).toBe(true);

    // what the stream held back while the page slept, and the answer to a read from before it, say what was
    stateWatch.heard();
    stateWatch.pushed();
    stateWatch.read(askedBefore);
    expect(unseen).toEqual([]);
    expect(stateWatch.blind()).toBe(true);

    reads();
    expect(unseen).toEqual(["first"]);
    expect(stateWatch.blind()).toBe(false);
    // the stream, still open, tells of what changes from here on
    runs(10 * MIN);
    expect(stateWatch.blind()).toBe(false);
  });

  it("dates what a stream brings when it reconnects soon, and reads a long loss as a first look", () => {
    streams();
    runs(MIN);
    stateWatch.subscription("lost");
    runs(30 * SEC);
    streams();
    expect(unseen).toEqual([]);

    stateWatch.subscription("lost");
    runs(5 * MIN);
    expect(stateWatch.blind()).toBe(true);
    streams();
    expect(unseen).toEqual(["first"]);
    expect(stateWatch.blind()).toBe(false);
  });

  it("holds on reads alone while no stream is open", () => {
    reads();
    for (let read = 0; read < 120; read++) {
      runs(5 * SEC);
      expect(stateWatch.blind()).toBe(false);
      reads();
    }
    expect(unseen).toEqual([]);
  });

  it("reads the roster after the server was out of reach for long as a first look", () => {
    streams();
    stateWatch.subscription("lost");
    runs(5 * MIN);
    reads();
    expect(unseen).toEqual(["first"]);
  });

  it("dates no change a read finds after the stream said nothing for long: silent, or dead", () => {
    streams();
    runs(10 * MIN);
    reads();
    expect(unseen).toEqual(["undated"]);

    // heard from a moment ago, the stream is alive: a read then finds what just changed
    runs(10 * MIN);
    stateWatch.heard();
    reads();
    expect(unseen).toEqual(["undated"]);
  });

  it("starts with nothing known and no stream for the page that comes after one that ended", () => {
    streams();
    sleeps(60 * MIN);
    expect(stateWatch.blind()).toBe(true);
    end();
    end = stateWatch.keep((look) => { unseen.push(look); });
    expect(stateWatch.blind()).toBe(false);

    // the stream the page before it had does not vouch for this one: a read, then two quiet minutes, and the page is blind
    reads();
    runs(2 * MIN);
    expect(stateWatch.blind()).toBe(true);
  });
});
