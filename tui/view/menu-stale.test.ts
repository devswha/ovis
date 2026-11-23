import { afterEach, expect, it } from "bun:test";
import { FRAME_PASS_MS } from "../model/deadlines.ts";
import type { World } from "../model/focus.ts";
import { initialState, type ModelEvent, type ModelState, reduce } from "../model/reduce.ts";
import { demo } from "../testing/fixtures/demo.ts";
import { Run } from "../testing/run.ts";

const runs: Run[] = [];
afterEach(async () => {
  for (const run of runs.splice(0)) await run.close();
});

const hex = (text: string) => Buffer.from(text).toString("hex");
const click = (col: number, row: number) => `\x1b[<0;${col + 1};${row + 1}M\x1b[<0;${col + 1};${row + 1}m`;

it.each(["before Escape", "after Escape", "after repaint"])("a click on a picker row the world moved since its frame chooses nothing, and a program's held button keeps its own release: %s", async (ordering) => {
  const run = await Run.start({ fixture: demo, cols: 120, rows: 80 });
  runs.push(run);
  await run.live();
  const program = run.core.program("t1");
  program.output("\x1b[?1002h\x1b[?1006h");
  await run.advance(200);
  // the middle button, held in the program (a right press would open the pane's menu)
  const press = "\x1b[<1;6;4M";
  run.type("\x1b[<1;33;6M");
  await run.settle();
  expect(program.receivedHex()).toBe(hex(press));
  run.type("\x02g");
  await run.advance(FRAME_PASS_MS);
  const painted = run.grid();
  const row = painted.findIndex((line) => line.includes("└─ · logs"));
  expect(row).toBeGreaterThan(0);
  const col = painted[row]!.indexOf("logs");
  // the logs terminal ends: the row the frame still shows it on is the next workspace's terminal in the list now
  run.core.remove("t3");
  await run.settle();
  expect(run.grid()).toEqual(painted);
  run.type(click(col, row));
  await run.settle();
  expect(program.receivedHex()).toBe(hex(press));
  expect(run.loop.report().mode.overlays).toEqual(["goto"]);
  expect([run.loop.model().focus.workspace, run.loop.model().focus.panes["t-main"]]).toEqual(["w-ovis", "t1"]);
  if (ordering !== "before Escape") run.type("\x1b[27u");
  if (ordering === "after repaint") await run.advance(FRAME_PASS_MS);
  run.type("\x1b[<1;34;6m");
  await run.settle();
  const balanced = hex(`${press}\x1b[<1;7;4m`);
  expect(["t1", "t2"].map((id) => run.core.program(id).receivedHex())).toEqual([balanced, ""]);
  run.type("\x1b[<1;35;6m");
  await run.settle();
  expect(program.receivedHex()).toBe(balanced);
}, 60_000);

it("a character the menu does not know does not block the next choice", async () => {
  const run = await Run.start({ fixture: demo, cols: 120, rows: 80 });
  runs.push(run);
  await run.live();
  await run.advance(1);
  // one read before the menu's first paint: the letter is ignored, Enter chooses its first entry, the text goes on to the pane
  run.type("\x02\r한\rz");
  await run.advance(200);
  expect(["t1", "t2"].map((id) => run.core.program(id).receivedHex())).toEqual(["7a", ""]);
  expect(run.loop.report().mode.overlays).toEqual([]);
}, 60_000);

it("a long run of characters the menu ignores stays iterative, and the choice after it runs once", async () => {
  const run = await Run.start({ fixture: demo, cols: 120, rows: 80 });
  runs.push(run);
  await run.live();
  await run.advance(1);
  run.type("\x02\r" + "7".repeat(100_000) + "\rz");
  await run.advance(200);
  expect(run.loop.report().mode.overlays).toEqual([]);
  expect(["t1", "t2"].map((id) => run.core.program(id).receivedHex())).toEqual(["7a", ""]);
  run.type("y");
  await run.settle();
  expect(["t1", "t2"].map((id) => run.core.program(id).receivedHex())).toEqual(["7a79", ""]);
  expect(run.loop.report().actions).not.toContain("close_all");
}, 60_000);

it.each(["reused address", "new connection"])("a right-click menu opened on a terminal acts on no other terminal at its address: %s", (change) => {
  const AT = 1_000;
  const after = (state: ModelState, ...events: ModelEvent[]) => events.reduce((now, event) => reduce(now, event).state, state);
  const born = (created: number): World => ({
    workspaces: [{ id: "w", name: "", tabs: [{ id: "tab", name: "", panes: [
      { id: "p", name: "shell", created }, { id: "other", name: "", created: 2 },
    ] }] }],
  });
  const menu = after(initialState(undefined), { type: "resize", cols: 120, rows: 40, at: AT }, { type: "world", epoch: 1, world: born(1), at: AT },
    { type: "context", target: { kind: "pane", id: "p" }, cell: { x: 3, y: 3 }, at: AT });
  expect(menu.overlays.map((overlay) => overlay.kind)).toEqual(["context"]);
  const changed = after(menu, { type: "world", epoch: change === "new connection" ? 2 : 1, world: born(change === "new connection" ? 1 : 3), at: AT });
  expect([changed.overlays, changed.notices.map((notice) => notice.code)]).toEqual([[], ["target_gone"]]);
  // Enter was Rename on the terminal the menu showed: here it opens no field and writes nothing
  const enter = reduce(changed, { type: "key", key: "ENTER", mods: {}, action: "press", at: AT });
  expect([enter.state.overlays, enter.effects.filter((effect) => effect.type === "run")]).toEqual([[], []]);
});
