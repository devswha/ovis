import { afterEach, describe, expect, it } from "bun:test";
import type { InputEvent } from "../input/decode.ts";
import { CATALOGUE } from "../model/catalogue.ts";
import type { World } from "../model/focus.ts";
import type { MenuEntry } from "../model/menu.ts";
import { initialState, type ModelEvent, type ModelState, reduce } from "../model/reduce.ts";
import { demo } from "../testing/fixtures/demo.ts";
import { Run } from "../testing/run.ts";

const TEST_MS = 120_000;
const runs: Run[] = [];
afterEach(async () => {
  for (const run of runs.splice(0)) await run.close();
});

async function shown(cols: number, rows = 30): Promise<Run> {
  const run = await Run.start({ fixture: demo, cols, rows });
  runs.push(run);
  await run.live();
  await run.advance(1);
  return run;
}

const attached = (run: Run) => run.loop.panes.views().map((view) => view.terminal).sort();
const docSets = (run: Run) => run.core.calls().filter((call) => call.method === "doc.set").length;

describe("the screen at widths 45, 60, 64 and 65: one terminal at 64 columns or fewer, the splits from 65", () => {
  it("at 45 columns: a header, one terminal, and a hint line of at most 45 cells that names the menu key", async () => {
    const run = await shown(45);
    const grid = run.grid();
    expect(grid[0]).toBe("·1:ovis 1/2:main hc:default            [menu]");
    expect(grid[1]).toBe(`+- shell / ${"-".repeat(33)}+`);
    expect(grid[2]).toBe(`|$ echo 안녕${" ".repeat(32)}|`);
    expect(grid[28]).toBe(`+${"-".repeat(43)}+`);
    expect(grid[29]).toBe(" TERMINAL  ctrl+b prefix prefix+enter menu");
    expect(run.loop.screen()!.cols).toBe(45);
    expect(attached(run)).toEqual(["t1"]);
  }, TEST_MS);

  it("at 60 columns: the same one terminal across the whole width", async () => {
    const run = await shown(60);
    const grid = run.grid();
    expect(grid[0]).toBe(`·1:ovis 1/2:main hc:default${" ".repeat(27)}[menu]`);
    expect(grid[1]).toBe(`+- shell / ${"-".repeat(48)}+`);
    expect(attached(run)).toEqual(["t1"]);
  }, TEST_MS);

  it("at 64 columns: one pane, the other pane of its tab not attached", async () => {
    const run = await shown(64);
    const grid = run.grid();
    expect(grid[0]).toBe(`·1:ovis 1/2:main hc:default${" ".repeat(31)}[menu]`);
    expect(grid[1]).toBe(`+- shell / ${"-".repeat(52)}+`);
    expect(grid[29]).toBe(" TERMINAL  ctrl+b prefix prefix+enter menu prefix+? help");
    expect(attached(run)).toEqual(["t1"]);
  }, TEST_MS);

  it("at 65 columns: the sidebar and the tab's two panes side by side, both attached", async () => {
    const run = await shown(65);
    const grid = run.grid();
    expect(grid[0]).toBe("hc:default           <<| 1:main  2:logs");
    expect(grid[1]).toBe("Workspaces             |+- shell / ---------++- files / --------+");
    expect(attached(run)).toEqual(["t1", "t2"]);
  }, TEST_MS);

  it("at 45 columns the focused pane is the one shown: the other pane, once focused, replaces it", async () => {
    const run = await shown(45);
    run.loop.dispatch({ type: "select", target: { kind: "pane", id: "t2" }, at: run.clock.current });
    await run.live();
    await run.advance(10);
    expect(run.grid()[1]).toBe(`+- files / ${"-".repeat(33)}+`);
    expect(attached(run)).toEqual(["t2"]);
  }, TEST_MS);

  it("the narrow view sends zero doc.set: switching panes, tabs and workspaces at 45 columns writes no layout", async () => {
    const run = await shown(45);
    const steps: [keys: string, shown: string][] = [["ctrl+b,enter,6", "t2"], ["ctrl+b,enter,4", "t3"], ["ctrl+b,enter,2", "t4"], ["ctrl+b,enter,1", "t3"], ["click@3:0", "t3"], ["esc", "t3"]];
    for (const [keys, pane] of steps) {
      await run.keys(keys);
      await run.live();
      await run.advance(200);
      expect({ keys, attached: attached(run) }).toEqual({ keys, attached: [pane] });
    }
    expect(run.loop.report().mode.overlays).toEqual([]);
    expect(docSets(run)).toBe(0);
    expect(run.core.herdrAppWrites).toEqual([]);
  }, TEST_MS);

  it("a click on the header opens the menu; a click on an entry chooses it", async () => {
    const run = await shown(45);
    await run.keys("click@20:0");
    await run.advance(10);
    expect(run.loop.report().mode.overlays).toEqual(["menu"]);
    expect(run.grid()[0]).toBe("+ Menu ----------------------- [close: esc] +");
    expect(run.grid()[4]).toBe("| 4 · tab 2:logs                            |");
    await run.keys("click@10:4");
    await run.live();
    await run.advance(10);
    expect(run.loop.report().mode.overlays).toEqual([]);
    expect(run.grid()[0]).toBe("·1:ovis 2/2:logs hc:default            [menu]");
    expect(attached(run)).toEqual(["t3"]);
  }, TEST_MS);
});

describe("plain route: every built action of the catalogue is an entry of the menu", () => {
  const AT = 1_000;
  const WORLD: World = {
    workspaces: [
      { id: "w1", name: "one", tabs: [{ id: "t1", name: "a", panes: [{ id: "p1", name: "" }, { id: "p2", name: "" }] }, { id: "t2", name: "b", panes: [{ id: "p3", name: "" }] }] },
      { id: "w2", name: "two", tabs: [{ id: "t3", name: "c", panes: [{ id: "p4", name: "" }] }] },
    ],
    agents: ["p3"],
  };
  const named = (name: string): InputEvent => ({ type: "key", key: name, mods: {}, action: "press", at: AT });
  const text = (value: string): InputEvent => ({ type: "text", text: value, at: AT });
  const after = (state: ModelState, ...events: ModelEvent[]) => events.reduce((current, event) => reduce(current, event).state, state);
  const base = reduce(initialState(undefined), { type: "world", world: WORLD, at: 0 }).state;
  const open = after(base, { type: "action", action: "menu", at: AT });
  const entries = (open.overlays.at(-1) as { entries: readonly MenuEntry[] }).entries;
  const built = CATALOGUE.filter((entry) => entry.status === "built").map((entry) => entry.id);

  it("each built id is an entry, in the catalogue's order, with a digit or letter of its own", () => {
    const actions = entries.flatMap((entry) => (entry.kind === "action" ? [entry] : []));
    expect(actions.map((entry) => entry.action)).toEqual(built);
    expect(built.length).toBe(46);
    for (const entry of actions) expect({ action: entry.action, label: /^[0-9A-Za-z]$/.test(entry.label) }).toEqual({ action: entry.action, label: true });
    const labels = entries.flatMap((entry) => (entry.label === null ? [] : [entry.label]));
    expect(new Set(labels).size).toBe(labels.length);
    expect(entries.slice(0, 7).map((entry) => [entry.kind, entry.kind === "action" ? entry.action : entry.id, entry.label])).toEqual([
      ["workspace", "w1", "1"], ["workspace", "w2", "2"], ["tab", "t1", "3"], ["tab", "t2", "4"], ["pane", "p1", "5"], ["pane", "p2", "6"], ["agent", "p3", "7"],
    ]);
  });

  it("each entry's letter, and the arrows then Enter, do what the action itself does: no Escape, no Ctrl, no composed key", () => {
    const numbered: Record<string, string> = { switch_workspace: "workspace", switch_tab: "tab", focus_agent: "agent" };
    entries.forEach((entry, at) => {
      if (entry.kind !== "action") return;
      const byLabel = reduce(open, text(entry.label));
      const byArrows = after(open, ...Array.from({ length: at }, () => named("ARROW_DOWN")));
      const chosen = reduce(byArrows, named("ENTER"));
      if (numbered[entry.action]) {
        const first = entries.findIndex((candidate) => candidate.kind === numbered[entry.action]);
        expect({ action: entry.action, cursor: (byLabel.state.overlays.at(-1) as { cursor: number }).cursor }).toEqual({ action: entry.action, cursor: first });
        expect({ action: entry.action, cursor: (chosen.state.overlays.at(-1) as { cursor: number }).cursor }).toEqual({ action: entry.action, cursor: first });
        return;
      }
      const direct = reduce(base, { type: "action", action: entry.action, at: AT });
      expect({ action: entry.action, state: byLabel.state, effects: byLabel.effects }).toEqual({ action: entry.action, state: direct.state, effects: direct.effects });
      expect({ action: entry.action, state: chosen.state, effects: chosen.effects }).toEqual({ action: entry.action, state: direct.state, effects: direct.effects });
    });
  });

  it("a digit goes to its place; Hangul typed under a Korean input method chooses nothing; the up arrow wraps to the last entry", () => {
    const tab = reduce(open, text("4")).state;
    expect([tab.overlays, tab.focus.workspace, tab.focus.tabs["w1"]]).toEqual([[], "w1", "t2"]);
    const agent = reduce(open, text("7")).state;
    expect(agent.focus.panes["t2"]).toBe("p3");
    for (const typed of ["\u3141", "\ud55c", "\u3131\u314f"]) expect(reduce(open, text(typed)).state).toEqual(open);
    expect((reduce(open, named("ARROW_UP")).state.overlays.at(-1) as { cursor: number }).cursor).toBe(entries.length - 1);
  });
});
