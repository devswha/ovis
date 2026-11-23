import { afterEach, expect, it } from "bun:test";
import { FRAME_PASS_MS } from "../model/deadlines.ts";
import { demo } from "../testing/fixtures/demo.ts";
import { place } from "../testing/fixtures/fixture.ts";
import { Run } from "../testing/run.ts";

const runs: Run[] = [];
afterEach(async () => {
  for (const run of runs.splice(0)) await run.close();
});

it.each([
  ["click", "unchanged"], ["click", "refresh before"], ["click", "refresh after"],
  ["digit", "refresh after"], ["digit", "removed after"],
  ["Enter", "refresh after"], ["Enter", "removed after"],
  ["digit", "refresh before"], ["split digit", "refresh after"], ["split digit", "removed after"],
  ["Enter after refresh", "refresh after"],
  ["digit", "closed after"],
  ["digit with release", "closed after"],
  ["unassigned", "refresh after"], ["unassigned then valid", "refresh after"],
  ["unassigned then refreshed valid", "refresh after"],
] as const)("a held menu choice stays bound to its presented target: %s, %s", async (input, ordering) => {
  const run = await Run.start({ fixture: demo, cols: 120, rows: 80 });
  runs.push(run);
  await run.live();
  await run.advance(1);
  if (input === "digit with release") {
    run.core.program("t1").output("\x1b[?1002h\x1b[?1006h");
    await run.advance(20);
    run.type("\x1b[<0;31;6M");
    await run.settle();
  }
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
    if (ordering === "refresh before") {
      place(run.core, { space: "w-new", spaceName: "new", tab: "t-new", tabName: "new" }, "$ ");
      await run.advance(FRAME_PASS_MS);
    }
    if (input === "click") {
      const grid = run.grid();
      const row = grid.findIndex((line) => line.includes("tab 2:logs"));
      const col = grid[row]?.indexOf("tab 2:logs") ?? -1;
      expect(row).toBeGreaterThan(0);
      expect(col).toBeGreaterThan(0);
      run.type(`\x1b[<0;${col + 1};${row + 1}M\x1b[<0;${col + 1};${row + 1}m`);
    } else {
      expect(run.grid().some((line) => line.includes("6 · pane") && line.includes(ordering === "refresh before" ? "renamed" : "files"))).toBe(true);
      if (input === "Enter" || input === "Enter after refresh") run.type("\x1b[B".repeat(5));
      if (input.startsWith("unassigned")) {
        expect(run.grid().some((line) => line.includes("7 · pane"))).toBe(false);
        run.type(input === "unassigned then valid" ? "76z" : "7");
      } else if (input !== "Enter after refresh") run.type(input === "Enter" ? "\rz" : input === "split digit" ? "6" : "6z");
    }
    await run.settle();
    expect(run.loop.model().focus.tabs["w-ovis"]).toBe("t-main");
    if (ordering === "refresh after") {
      place(run.core, { space: "w-new", spaceName: "new", tab: "t-new", tabName: "new" }, "$ ");
      await run.advance(FRAME_PASS_MS);
    }
    if (ordering === "removed after") {
      run.core.remove("t2");
      await run.advance(FRAME_PASS_MS);
    }
    if (ordering === "closed after") {
      run.loop.dispatch({ type: "close_overlay", at: run.clock.current });
      await run.advance(FRAME_PASS_MS);
    }
    if (input === "split digit") run.type("z");
    if (input === "Enter after refresh") run.type("\rz");
    if (input === "digit with release") run.type("\x1b[<0;32;6m");
    if (input === "unassigned then refreshed valid") run.type("7z");
    answer.resolve();
    await run.advance(200);
    const refused = ordering === "removed after" || ordering === "closed after" || (input === "click" && ordering === "refresh after");
    expect(run.loop.model().focus.tabs["w-ovis"]).toBe(input === "click" && !refused ? "t-logs" : "t-main");
    expect(run.loop.report().mode.overlays).toEqual(input === "unassigned" || (refused && ordering !== "closed after") ? ["menu"] : []);
    expect(run.core.program("t1").receivedHex()).toBe(input === "digit with release"
      ? Buffer.from("\x1b[<0;6;4M\x1b[<0;7;4m").toString("hex")
      : input !== "click" && ordering === "refresh before" ? "7a" : "");
    if (ordering !== "removed after") expect(run.core.program("t2").receivedHex()).toBe(input !== "click" && input !== "unassigned" && ordering !== "refresh before" && !refused ? "7a" : "");
    if (input === "unassigned") {
      expect(run.loop.model().focus.panes["t-main"]).toBe("t1");
      run.type("7z");
      await run.advance(20);
      expect(run.loop.report().mode.overlays).toEqual([]);
      expect(["t1", "t2"].map((id) => run.core.program(id).receivedHex())).toEqual(["", "7a"]);
    }
  } finally {
    answer.resolve();
  }
}, 60_000);
