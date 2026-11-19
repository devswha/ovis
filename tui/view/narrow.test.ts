import { afterEach, describe, expect, it } from "bun:test";
import type { InputEvent } from "../input/decode.ts";
import type { World } from "../model/focus.ts";
import { MENU_ENTRIES } from "../model/menu.ts";

import { initialState, type ModelEvent, type ModelState, reduce } from "../model/reduce.ts";
import { agents } from "../testing/fixtures/agents.ts";
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

describe("the screen at widths 45, 60, 64 and 65: one terminal at 64 columns or fewer, the splits from 65", () => {
  it("at 45 columns: a header and one terminal down to the last row, with no mode line in terminal mode", async () => {
    const run = await shown(45);
    const grid = run.grid();
    expect(grid[0]).toBe("·1:ovis 1/2:main hc:default            [menu]");
    expect(grid[1]).toBe(`┌ shell ${"─".repeat(36)}┐`);
    expect(grid[2]).toBe(`│$ echo 안녕${" ".repeat(32)}│`);
    expect(grid[29]).toBe(`└${"─".repeat(43)}┘`);
    expect(run.loop.screen()!.cols).toBe(45);
    expect(attached(run)).toEqual(["t1"]);
  }, TEST_MS);

  it("at 60 columns: the same one terminal across the whole width", async () => {
    const run = await shown(60);
    const grid = run.grid();
    expect(grid[0]).toBe(`·1:ovis 1/2:main hc:default${" ".repeat(27)}[menu]`);
    expect(grid[1]).toBe(`┌ shell ${"─".repeat(51)}┐`);
    expect(attached(run)).toEqual(["t1"]);
  }, TEST_MS);

  it("at 64 columns: one pane, the other pane of its tab not attached", async () => {
    const run = await shown(64);
    const grid = run.grid();
    expect(grid[0]).toBe(`·1:ovis 1/2:main hc:default${" ".repeat(31)}[menu]`);
    expect(grid[1]).toBe(`┌ shell ${"─".repeat(55)}┐`);
    expect(grid[29]).toBe(`└${"─".repeat(62)}┘`);
    expect(attached(run)).toEqual(["t1"]);
  }, TEST_MS);

  it("at 65 columns: the sidebar and the tab's two panes side by side, both attached", async () => {
    const run = await shown(65);
    const grid = run.grid();
    expect(grid[0]).toBe(" Workspaces              │  main     logs    +");
    expect(grid[1]).toBe("                         │┌ shell ───────────┐┌ files ──────────┐");
    expect(attached(run)).toEqual(["t1", "t2"]);
  }, TEST_MS);

  it("at 45 columns the focused pane is the one shown: the other pane, once focused, replaces it", async () => {
    const run = await shown(45);
    run.loop.dispatch({ type: "select", target: { kind: "pane", id: "t2" }, at: run.clock.current });
    await run.live();
    await run.advance(10);
    expect(run.grid()[1]).toBe(`┌ files ${"─".repeat(36)}┐`);
    expect(attached(run)).toEqual(["t2"]);
  }, TEST_MS);

  it("the narrow header counts the agents that need the user elsewhere, and not the one it shows", async () => {
    const run = await Run.start({ fixture: agents, cols: 45, rows: 30 });
    runs.push(run);
    await run.live();
    await run.advance(10);
    expect(run.grid()[0]).toBe("!1:agents 1/1:agents hc:default     !1 [menu]");
    run.loop.dispatch({ type: "select", target: { kind: "pane", id: "t2" }, at: run.clock.current });
    await run.live();
    await run.advance(10);
    expect(run.grid()[0]).toBe("!1:agents 1/1:agents hc:default        [menu]");
  }, TEST_MS);

  it("at 120 columns the sidebar's Menu button opens the menu, and its « collapses the sidebar", async () => {
    const run = await shown(120, 40);
    // the workspaces' footer, the last row of the sidebar's upper half, holds the menu button at its right
    await run.keys("click@22:19");
    await run.advance(10);
    expect(run.loop.report().mode.overlays).toEqual(["menu"]);
    await run.keys("esc");
    await run.advance(200);
    await run.keys("click@24:39");
    await run.advance(10);
    expect([run.loop.report().mode.overlays, run.loop.model().sidebarCollapsed]).toEqual([[], true]);
  }, TEST_MS);

});

describe("herdr's menu", () => {
  const AT = 1_000;
  const WORLD: World = { workspaces: [{ id: "w1", name: "one", tabs: [{ id: "t1", name: "a", panes: [{ id: "p1", name: "" }] }] }] };
  const named = (name: string): InputEvent => ({ type: "key", key: name, mods: {}, action: "press", at: AT });
  const after = (state: ModelState, ...events: ModelEvent[]) => events.reduce((current, event) => reduce(current, event).state, state);
  const base = reduce(initialState(undefined), { type: "world", world: WORLD, at: 0 }).state;
  const open = after(base, { type: "action", action: "menu", at: AT });

  it("holds herdr's four entries; the arrows then Enter, or a click, do what the action itself does, and the up arrow wraps", () => {
    expect(MENU_ENTRIES).toEqual(["settings", "help", "reload_config", "detach"]);
    MENU_ENTRIES.forEach((action, at) => {
      const direct = reduce(base, { type: "action", action, at: AT });
      const chosen = reduce(after(open, ...Array.from({ length: at }, () => named("ARROW_DOWN"))), named("ENTER"));
      const clicked = reduce(open, { type: "choose", entry: at, at: AT });
      for (const [how, step] of [["keys", chosen], ["click", clicked]] as const) {
        expect({ action, how, state: step.state, effects: step.effects }).toEqual({ action, how, state: direct.state, effects: direct.effects });
      }
    });
    expect((reduce(open, named("ARROW_UP")).state.overlays.at(-1) as { cursor: number }).cursor).toBe(MENU_ENTRIES.length - 1);
  });
});
