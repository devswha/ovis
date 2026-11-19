import { afterEach, describe, expect, it } from "bun:test";
import { demo } from "../testing/fixtures/demo.ts";
import { Run } from "../testing/run.ts";
import type { World } from "./focus.ts";
import { pickerMatches, pickerPlaces } from "./picker.ts";
import { initialState, type ModelEvent, type ModelState, reduce } from "./reduce.ts";

const TEST_MS = 120_000;
const AT = 1;

const key = (name: string, mods: Record<string, boolean> = {}): ModelEvent => ({ type: "key", key: name, mods, action: "press", at: AT });
const text = (typed: string): ModelEvent => ({ type: "text", text: typed, at: AT });
const after = (state: ModelState, ...events: ModelEvent[]): ModelState => events.reduce((s, event) => reduce(s, event).state, state);

const world: World = {
  workspaces: [
    { id: "w1", name: "ovis", tabs: [{ id: "t1", name: "main", panes: [{ id: "p1", name: "lead", agent: "claude" }, { id: "p2", name: "shell" }] }, { id: "t2", name: "logs", panes: [{ id: "p3", name: "tail" }] }] },
    { id: "w2", name: "docs", tabs: [{ id: "t3", name: "notes", panes: [{ id: "p4", name: "문서" }] }] },
  ],
};

describe("the picker's terminals", () => {
  it("are every terminal in the world's order, grouped by workspace; a search keeps those whose words hold its characters in order", () => {
    const places = pickerPlaces(world);
    expect(places.map((place) => [place.id, place.workspace])).toEqual([["p1", "w1"], ["p2", "w1"], ["p3", "w1"], ["p4", "w2"]]);
    const found = (query: string) => pickerMatches(places, query).map((place) => place.id);
    expect(found("")).toEqual(["p1", "p2", "p3", "p4"]);
    expect(found("logs")).toEqual(["p3"]);
    expect(found("CLAUDE")).toEqual(["p1"]);
    expect(found("o s")).toEqual(["p1", "p2", "p3", "p4"]);
    expect(found("\u1106\u116e\u11ab")).toEqual(["p4"]);
    expect(found("zz")).toEqual([]);
  });
});

describe("the picker overlay", () => {
  const open = after(reduce(initialState(undefined), { type: "world", world, at: AT }).state, key("B", { ctrl: true }), text("g"));
  const chosen = (state: ModelState) => (state.overlays.at(-1) as { chosen: string | null }).chosen;

  it("opens on the terminal in front; j, k and the arrows move a row and wrap; left and right go to the next workspace's first terminal", () => {
    expect([open.overlays.map((overlay) => overlay.kind), chosen(open)]).toEqual([["goto"], "p1"]);
    expect(chosen(after(open, text("j"), key("ARROW_DOWN")))).toBe("p3");
    expect(chosen(after(open, text("k")))).toBe("p4");
    expect(chosen(after(open, key("ARROW_RIGHT")))).toBe("p4");
    expect(chosen(after(open, key("ARROW_RIGHT"), key("ARROW_RIGHT")))).toBe("p1");
    const step = reduce(after(open, key("ARROW_DOWN")), key("ENTER"));
    expect([step.state.overlays, step.state.focus.tabs["w1"], step.state.focus.panes["t1"]]).toEqual([[], "t1", "p2"]);
  });

  it("/ starts a search that takes every key until Enter keeps it or Escape drops it; Escape then closes the picker", () => {
    const searched = after(open, text("/logs"));
    expect(searched.overlays.at(-1)).toMatchObject({ searching: true, field: { graphemes: [..."logs"] } });
    // j is a letter of the search, not a row
    expect(after(searched, text("j")).overlays.at(-1)).toMatchObject({ field: { graphemes: [..."logsj"] } });
    const kept = after(searched, key("ENTER"));
    expect(kept.overlays.at(-1)).toMatchObject({ searching: false });
    const jumped = reduce(kept, key("ENTER")).state;
    expect([jumped.overlays, jumped.focus.tabs["w1"]]).toEqual([[], "t2"]);
    const dropped = after(searched, key("ESCAPE"));
    expect(dropped.overlays.at(-1)).toMatchObject({ searching: false, field: { graphemes: [] } });
    expect(after(dropped, key("ESCAPE")).overlays).toEqual([]);
  });

  it("an open picker follows the world and keeps a surviving choice", () => {
    const onTail = after(open, key("ARROW_DOWN"), key("ARROW_DOWN"));
    const grown: World = { workspaces: [{ id: "w0", name: "new", tabs: [{ id: "t0", name: "a", panes: [{ id: "p0", name: "x" }] }] }, ...world.workspaces] };
    expect(chosen(after(onTail, { type: "world", world: grown, at: AT }))).toBe("p3");
  });
});

describe("the picker on screen", () => {
  const runs: Run[] = [];
  afterEach(async () => {
    for (const run of runs.splice(0)) await run.close();
  });

  it("a click on a terminal's row jumps to it", async () => {
    const run = await Run.start({ fixture: demo, cols: 80, rows: 24 });
    runs.push(run);
    await run.live();
    await run.keys("ctrl+b,g");
    await run.advance(10);
    const row = run.grid().findIndex((line) => line.includes("└─ · logs"));
    expect(row).toBeGreaterThan(3);
    await run.keys(`click@10:${row}`);
    await run.advance(10);
    expect([run.loop.model().overlays, run.loop.model().focus.tabs["w-ovis"]]).toEqual([[], "t-logs"]);
  }, TEST_MS);
});
