import { describe, expect, it } from "bun:test";
import type { Machine } from "../shared/machines.ts";
import { hiddenEvents, rosterShape } from "./hidden-events.ts";

const machine = (over: Partial<Machine>, ...panes: string[]): Machine =>
  ({ id: "local", name: "Local", kind: "local", enabled: true, state: "connected", error: null, snapshot: { panes: panes.map((pane_id) => ({ pane_id })) }, ...over }) as unknown as Machine;

describe("hiddenEvents", () => {
  it("sends the first roster, then a roster only when the shape an alert reads moved", () => {
    const hidden = hiddenEvents();
    expect(hidden.sendsRoster([machine({}, "p1")])).toBe(true);
    expect(hidden.sendsRoster([machine({ name: "Renamed" }, "p1")])).toBe(false);
    expect(hidden.sendsRoster([machine({}, "p1", "p2")])).toBe(true);
    expect(hidden.sendsRoster([machine({ state: "reconnecting" }, "p1", "p2")])).toBe(true);
    expect(hidden.sendsRoster([machine({ state: "reconnecting" }, "p1", "p2")])).toBe(false);
  });

  it("sends a roster that is forced, and counts it as told", () => {
    const hidden = hiddenEvents();
    hidden.sendsRoster([machine({}, "p1")]);
    expect(hidden.sendsRoster([machine({}, "p1")], true)).toBe(true);
    expect(hidden.sendsRoster([machine({}, "p1")])).toBe(false);
  });

  it("sends a pane's status and exit, not its focus or layout", () => {
    const hidden = hiddenEvents();
    const of = (type: string) => hidden.sendsMessage({ type: "machine-message", machine_id: "local", message: { type } as never });
    expect(of("pane-status")).toBe(true);
    expect(of("pane-exited")).toBe(true);
    expect(of("pane-focused")).toBe(false);
    expect(of("session-changed")).toBe(false);
    expect(of("snapshot")).toBe(false);
  });
});

describe("rosterShape", () => {
  it("is the same for two rosters that differ in what an alert never reads", () => {
    expect(rosterShape([machine({}, "p1")])).toBe(rosterShape([machine({ name: "Other", tailnet_offline: undefined }, "p1")]));
    expect(rosterShape([machine({}, "p1")])).not.toBe(rosterShape([machine({ snapshot: null }, "p1")]));
  });
});
