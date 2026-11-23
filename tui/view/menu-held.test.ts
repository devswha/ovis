import { afterEach, expect, it } from "bun:test";
import { FRAME_PASS_MS } from "../model/deadlines.ts";
import { demo } from "../testing/fixtures/demo.ts";
import { place } from "../testing/fixtures/fixture.ts";
import { Run } from "../testing/run.ts";

const runs: Run[] = [];
afterEach(async () => {
  for (const run of runs.splice(0)) await run.close();
});

it.each(["unchanged", "refresh before click", "refresh after click"])("a held menu click stays bound to its accepted frame: %s", async (ordering) => {
  const run = await Run.start({ fixture: demo, cols: 120, rows: 80 });
  runs.push(run);
  await run.live();
  await run.advance(1);
  const written = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<void>();
  const call = run.loop.link.call.bind(run.loop.link);
  run.loop.link.call = async (method, params, timeout) => {
    if (method === "terminal.label") {
      run.loop.link.call = call;
      const result = await call(method, params, timeout);
      written.resolve();
      await answer.promise;
      return result;
    }
    return call(method, params, timeout);
  };
  try {
    // The world already reflects the rename, but its reply still holds the user's input.
    run.type("\x02Prenamed\r");
    await written.promise;
    await run.advance(20);
    run.loop.dispatch({ type: "action", action: "menu", at: run.clock.current });
    await run.advance(FRAME_PASS_MS);
    if (ordering === "refresh before click") {
      place(run.core, { space: "w-new", spaceName: "new", tab: "t-new", tabName: "new" }, "$ ");
      await run.advance(FRAME_PASS_MS);
    }
    const grid = run.grid();
    const row = grid.findIndex((line) => line.includes("tab 2:logs"));
    const col = grid[row]?.indexOf("tab 2:logs") ?? -1;
    expect(row).toBeGreaterThan(0);
    expect(col).toBeGreaterThan(0);
    run.type(`\x1b[<0;${col + 1};${row + 1}M\x1b[<0;${col + 1};${row + 1}m`);
    await run.settle();
    expect(run.loop.model().focus.tabs["w-ovis"]).toBe("t-main");
    if (ordering === "refresh after click") {
      place(run.core, { space: "w-new", spaceName: "new", tab: "t-new", tabName: "new" }, "$ ");
      await run.advance(FRAME_PASS_MS);
    }
    answer.resolve();
    await run.advance(200);
    expect(run.loop.model().focus.tabs["w-ovis"]).toBe(ordering === "refresh after click" ? "t-main" : "t-logs");
    expect(run.loop.report().mode.overlays).toEqual(ordering === "refresh after click" ? ["menu"] : []);
  } finally {
    answer.resolve();
  }
}, 60_000);
