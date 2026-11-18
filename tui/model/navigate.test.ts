import { afterEach, describe, expect, it } from "bun:test";
import { FRAME_FACTS, FRAME_FOCUS, FRAME_RESIZE } from "../../server/herdr-core/connection.ts";
import { FakeHcCore } from "../../server/herdr-core/core.fake.ts";
import { OVIS_LAYOUT_DOC } from "../../server/herdr-core/layout-doc.ts";
import { place } from "../testing/fixtures/fixture.ts";
import { Run } from "../testing/run.ts";
import type { Effect, TextInput } from "./effects.ts";
import type { World } from "./focus.ts";
import { chordId } from "./keymap.ts";
import { initialState, type ModelEvent, type ModelState, reduce } from "./reduce.ts";

const TEST_MS = 120_000;
const AT = 1;

const key = (name: string, mods: Record<string, boolean> = {}): ModelEvent => ({ type: "key", key: name, mods, action: "press", at: AT });
const text = (typed: string): TextInput => ({ type: "text", text: typed, at: AT });
const PREFIX = key("B", { ctrl: true });
const after = (state: ModelState, ...events: ModelEvent[]): ModelState => events.reduce((s, event) => reduce(s, event).state, state);

const WORLD: World = {
  workspaces: [
    { id: "w1", name: "one", tabs: [{ id: "t1", name: "a", panes: [{ id: "p1", name: "" }, { id: "p2", name: "" }] }, { id: "t2", name: "b", panes: [{ id: "p3", name: "" }] }] },
    { id: "w2", name: "two", tabs: [{ id: "t3", name: "c", panes: [{ id: "p4", name: "" }] }] },
  ],
};

/** The screen on `world` at `cols` columns, in navigate mode. */
function navigating(keys: unknown = undefined, world: World = WORLD, cols = 120): ModelState {
  const shown = after(initialState(keys), { type: "resize", cols, rows: 40, at: AT }, { type: "world", world, at: AT });
  return after(shown, PREFIX, text("w"));
}

/** What a run of events did: the mode, the preview, the pane shown, and the actions handed to the loop with their targets. */
function outcome(state: ModelState, events: readonly ModelEvent[]) {
  const effects: Effect[] = [];
  let s = state;
  for (const event of events) {
    const step = reduce(s, event);
    effects.push(...step.effects);
    s = step.state;
  }
  const workspace = s.focus.workspace ?? "w1";
  const tab = s.focus.tabs[workspace];
  return {
    mode: s.mode.name,
    preview: s.mode.name === "navigate" ? s.mode.preview : null,
    shown: `${workspace}/${tab ?? "-"}/${tab === undefined ? "-" : s.focus.panes[tab] ?? "-"}`,
    run: effects.map((effect) => effect.type === "run" ? `${effect.action}:${effect.target?.id ?? "-"}${effect.to ? `>${effect.to}` : ""}` : effect.type),
  };
}

describe("navigate mode", () => {
  it("the navigate key table: every key works without the prefix, and the moving keys keep the mode open so they repeat", () => {
    const table: [keys: string, events: ModelEvent[], expected: ReturnType<typeof outcome>][] = [
      ["h", [text("h")], { mode: "navigate", preview: "w1", shown: "w1/t1/p1", run: ["focus_pane_left:p1"] }],
      ["j", [text("j")], { mode: "navigate", preview: "w1", shown: "w1/t1/p1", run: ["focus_pane_down:p1"] }],
      ["k", [text("k")], { mode: "navigate", preview: "w1", shown: "w1/t1/p1", run: ["focus_pane_up:p1"] }],
      ["l", [text("l")], { mode: "navigate", preview: "w1", shown: "w1/t1/p1", run: ["focus_pane_right:p1"] }],
      ["left", [key("ARROW_LEFT")], { mode: "navigate", preview: "w1", shown: "w1/t1/p1", run: ["focus_pane_left:p1"] }],
      ["right", [key("ARROW_RIGHT")], { mode: "navigate", preview: "w1", shown: "w1/t1/p1", run: ["focus_pane_right:p1"] }],
      ["l l l repeats", [text("l"), text("l"), text("l")], { mode: "navigate", preview: "w1", shown: "w1/t1/p1", run: ["focus_pane_right:p1", "focus_pane_right:p1", "focus_pane_right:p1"] }],
      ["n: next tab", [text("n")], { mode: "navigate", preview: "w1", shown: "w1/t2/p3", run: [] }],
      ["n n: next tab twice, round", [text("n"), text("n")], { mode: "navigate", preview: "w1", shown: "w1/t1/p1", run: [] }],
      ["p: previous tab, round", [text("p")], { mode: "navigate", preview: "w1", shown: "w1/t2/p3", run: [] }],
      ["down: the preview moves, focus stays", [key("ARROW_DOWN")], { mode: "navigate", preview: "w2", shown: "w1/t1/p1", run: [] }],
      ["up: the preview moves round, focus stays", [key("ARROW_UP")], { mode: "navigate", preview: "w2", shown: "w1/t1/p1", run: [] }],
      ["down enter: focus goes to the preview and the mode ends", [key("ARROW_DOWN"), key("ENTER")], { mode: "terminal", preview: null, shown: "w2/t3/p4", run: [] }],
      ["2: the second workspace, and the mode ends", [text("2")], { mode: "terminal", preview: null, shown: "w2/t3/p4", run: [] }],
      ["tab: the next pane", [key("TAB")], { mode: "navigate", preview: "w1", shown: "w1/t1/p2", run: [] }],
      ["shift+tab: the previous pane, round", [key("TAB", { shift: true })], { mode: "navigate", preview: "w1", shown: "w1/t1/p2", run: [] }],
      ["shift+up: the previewed workspace up", [key("ARROW_UP", { shift: true })], { mode: "navigate", preview: "w1", shown: "w1/t1/p1", run: ["navigate_move_up:w1"] }],
      ["shift+down: the previewed workspace down", [key("ARROW_DOWN", { shift: true })], { mode: "navigate", preview: "w1", shown: "w1/t1/p1", run: ["navigate_move_down:w1"] }],
      ["down m: the pane into the previewed workspace", [key("ARROW_DOWN"), text("m")], { mode: "terminal", preview: null, shown: "w1/t1/p1", run: ["navigate_move_pane:p1>w2"] }],
      ["esc", [key("ESCAPE")], { mode: "terminal", preview: null, shown: "w1/t1/p1", run: [] }],
      ["ctrl+[", [key("BRACKET_LEFT", { ctrl: true })], { mode: "terminal", preview: null, shown: "w1/t1/p1", run: [] }],
      ["the prefix", [PREFIX], { mode: "terminal", preview: null, shown: "w1/t1/p1", run: [] }],
      ["x: a key bound to nothing does nothing and reaches no pane", [text("x")], { mode: "navigate", preview: "w1", shown: "w1/t1/p1", run: [] }],
    ];
    const start = navigating();
    for (const [keys, events, expected] of table) expect({ keys, ...outcome(start, events) }).toEqual({ keys, ...expected });

    // herdr's next and previous workspace (unset by default) repeat too once the config binds them after the prefix
    const bound = navigating({ next_workspace: "prefix+]", previous_workspace: "prefix+[", next_tab: "prefix+m" });
    expect(outcome(bound, [text("]")])).toEqual({ mode: "navigate", preview: "w1", shown: "w2/t3/p4", run: [] });
    expect(outcome(bound, [text("["), text("[")])).toEqual({ mode: "navigate", preview: "w1", shown: "w1/t1/p1", run: [] });
    // a key the screen fixes keeps it in navigate mode (m moves the pane); after the prefix it still runs next_tab
    expect(outcome(bound, [text("m")]).run).toEqual(["navigate_move_pane:p1>w1"]);
    expect(outcome(after(navigating(), key("ESCAPE")), [PREFIX, text("n")]).shown).toBe("w1/t2/p3");
  });

  it("binds no printable key outside a mode: in Terminal mode the navigate letters reach the pane", () => {
    const terminal = after(navigating(), key("ESCAPE"));
    for (const letter of ["h", "j", "k", "l", "n", "p", "m"]) {
      const step = reduce(terminal, text(letter));
      expect({ letter, levels: step.levels, effects: step.effects }).toEqual({ letter, levels: [6], effects: [{ type: "pane", pane: "p1", input: text(letter) }] });
    }
    const printable = Object.keys(terminal.keymap.direct).filter((id) => /^00[01]00:[\x20-\x7e]$/.test(id));
    expect(printable).toEqual([]);
    expect(chordId({ ctrl: false, alt: false, shift: false, meta: false, hyper: false, key: "n" })).toBe("00000:n");
  });

  it("works while a pane is zoomed: a focus move onto a covered pane moves the shared zoom there, except on a narrow screen", () => {
    const zoomed: World = { workspaces: [{ ...WORLD.workspaces[0]!, tabs: [{ ...WORLD.workspaces[0]!.tabs[0]!, zoomed: "p1" }, WORLD.workspaces[0]!.tabs[1]!] }, WORLD.workspaces[1]!] };
    const wide = navigating(undefined, zoomed);
    // the loop answers l with the neighbour on the tab's whole tree
    expect(outcome(wide, [{ type: "select", target: { kind: "pane", id: "p2" }, at: AT }])).toEqual({ mode: "navigate", preview: "w1", shown: "w1/t1/p2", run: ["zoom_follow:p2"] });
    expect(outcome(wide, [key("TAB")]).run).toEqual(["zoom_follow:p2"]);
    expect(outcome(wide, [text("n")]).run).toEqual([]);
    expect(outcome(navigating(undefined, zoomed, 45), [key("TAB")])).toEqual({ mode: "navigate", preview: "w1", shown: "w1/t1/p2", run: [] });
    // the zoom moved by someone else: the focus follows it, so the pane focused is the pane shown
    const moved: World = { ...zoomed, workspaces: [{ ...zoomed.workspaces[0]!, tabs: [{ ...zoomed.workspaces[0]!.tabs[0]!, zoomed: "p2" }, zoomed.workspaces[0]!.tabs[1]!] }, zoomed.workspaces[1]!] };
    expect(outcome(wide, [{ type: "world", world: moved, at: AT }])).toEqual({ mode: "navigate", preview: "w1", shown: "w1/t1/p2", run: [] });
  });
});

/** A core with two workspaces of five terminals each, every tab split side by side (t1..t5 in w/t, t6..t10 in v/u). */
function twoWorkspaces(zoomed: string | null = null): FakeHcCore {
  const core = new FakeHcCore();
  const tabs = [{ space: "w", tab: "t" }, { space: "v", tab: "u" }].map(({ space, tab }) => {
    const panes: string[] = [];
    for (let n = 0; n < 5; n++) panes.push(place(core, { space, spaceName: space, tab, tabName: tab }, `${space} ${n}\r\n`));
    const root = panes.slice(1).reduce<unknown>((tree, leaf) => ({ split: "right", ratio: 0.5, first: tree, second: { leaf } }), { leaf: panes[0] });
    return { id: space, tabs: [{ id: tab, root, zoomed: space === "w" ? zoomed : null }] };
  });
  core.docs.set(OVIS_LAYOUT_DOC, { value: { schema: 1, workspaces: tabs }, version: 1 });
  return core;
}

const SHOWN = ["t1", "t2", "t3", "t4", "t5"];
const OTHER = ["t6", "t7", "t8", "t9", "t10"];

describe("navigate mode on screen", () => {
  const runs: Run[] = [];
  afterEach(async () => {
    for (const run of runs.splice(0)) await run.close();
  });

  async function start(core: FakeHcCore, cols = 200): Promise<Run> {
    const run = await Run.start({ core, cols, rows: 40 });
    runs.push(run);
    await run.live();
    await run.advance(1);
    return run;
  }

  it("preview sends no frame: moving through five panes and previewing the other workspace attaches nothing, and sends no RESIZE, FOCUS or FACTS", async () => {
    const run = await start(twoWorkspaces());
    await run.keys("ctrl+b,w");
    run.forget();
    const passed: string[] = [];
    const watch = () => passed.push(run.loop.model().focus.panes["t"] ?? "?");
    for (const step of ["l", "l", "l", "l", "h", "h", "h", "h"]) {
      await run.keys(step);
      watch();
    }
    for (const step of ["down", "up", "down"]) await run.keys(step);
    expect(passed).toEqual(["t2", "t3", "t4", "t5", "t4", "t3", "t2", "t1"]);
    expect(run.loop.model().mode).toEqual({ name: "navigate", preview: "v" });
    const quiet = () => ({
      attaches: run.core.calls().filter((call) => call.method === "terminal.attach").length,
      sent: SHOWN.flatMap((terminal) => run.core.sentOn(terminal, { kinds: [FRAME_RESIZE, FRAME_FOCUS, FRAME_FACTS] })),
      viewersOfOthers: OTHER.flatMap((terminal) => run.core.viewers(terminal)).length,
      sizes: SHOWN.map((terminal) => run.core.size(terminal)),
    });
    const moving = quiet();
    expect(moving).toEqual({ attaches: 0, sent: [], viewersOfOthers: 0, sizes: moving.sizes });
    // and nothing leaves once the focus rests either
    await run.advance(1_000);
    expect(quiet()).toEqual(moving);
  }, TEST_MS);

  it("works while a pane is zoomed: l moves the focus and the shared zoom together, again and again", async () => {
    const run = await start(twoWorkspaces("t1"));
    await run.keys("ctrl+b,w");
    for (const [step, pane] of [["l", "t2"], ["l", "t3"], ["h", "t2"]] as const) {
      await run.keys(step);
      // the pane the zoom now shows is attached again at its new size before the next key is read (row 23's drain)
      await run.live();
      await run.advance(1);
      const zoomed = (run.core.docs.get(OVIS_LAYOUT_DOC)?.value as { workspaces: { tabs: { zoomed: string | null }[] }[] }).workspaces[0]!.tabs[0]!.zoomed;
      expect({ step, focus: run.loop.model().focus.panes["t"], zoomed, covered: run.loop.panes.view(pane)?.covered, mode: run.loop.model().mode.name })
        .toEqual({ step, focus: pane, zoomed: pane, covered: false, mode: "navigate" });
    }
    expect(run.loop.model().notices).toEqual([]);
  }, TEST_MS);

  it("on a narrow screen a focus move in a zoomed tab writes no layout", async () => {
    const run = await start(twoWorkspaces("t1"), 45);
    await run.keys("ctrl+b,w,tab,tab");
    await run.advance(10);
    expect([run.loop.model().focus.panes["t"], run.core.calls().filter((call) => call.method === "doc.set").length]).toEqual(["t3", 0]);
  }, TEST_MS);
});
