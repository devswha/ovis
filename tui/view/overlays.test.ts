import { afterEach, describe, expect, it } from "bun:test";
import { version as OVIS_VERSION } from "../../package.json";
import { FakeHcCore, FEATURES_0_1_17 } from "../../server/herdr-core/core.fake.ts";
import { NOTICE_SHOW_MS } from "../model/deadlines.ts";
import { OVERLAYS } from "../model/overlays.ts";
import { demo } from "../testing/fixtures/demo.ts";
import { place } from "../testing/fixtures/fixture.ts";
import { Run } from "../testing/run.ts";
import { SIDEBAR_COLUMNS } from "./screen.ts";

const TEST_MS = 120_000;

const runs: Run[] = [];
afterEach(async () => {
  for (const run of runs.splice(0)) await run.close();
});

async function start(core?: FakeHcCore, cols = 120, rows = 40): Promise<Run> {
  if (core) demo.build(core);
  const run = await Run.start({ fixture: demo, ...(core ? { core } : {}), cols, rows });
  runs.push(run);
  await run.live();
  await run.advance(1);
  return run;
}

/**
 * Each overlay kind, the action that opens it, the control a tap closes it with and the keys that close it: written out
 * here. A dialog drawn as herdr's (the text field, the confirm) closes by its cancel button; the help has no close
 * control until its own content changes with herdr's (docs/tui/visual-parity.md O5) and closes by its keys.
 */
const KINDS = [
  { kind: "help", action: "help", control: null, keys: ["esc", "q", "?"] },
  { kind: "agents", action: "agents", control: "[close: esc / q]", keys: ["esc", "q"] },
  { kind: "about", action: "about", control: "[close: esc / q]", keys: ["esc", "q"] },
  { kind: "text", action: "rename_tab", control: " esc cancel ", keys: ["esc"] },
  { kind: "confirm", action: "close_workspace", control: " esc cancel ", keys: ["esc", "n"] },
  { kind: "goto", action: "goto", control: "[close: esc]", keys: ["esc"] },
  { kind: "menu", action: "menu", control: "[close: esc]", keys: ["esc"] },
] as const;

const osc52Writes = (run: Run, from: number): string[] =>
  run.host.log().slice(from).filter((entry) => entry.startsWith("write ")).map((entry) => entry.slice("write ".length)).filter((bytes) => bytes.includes("\x1b]52;"));

const clipboardOf = (text: string): string => `\x1b]52;c;${Buffer.from(text).toString("base64")}\x1b\\`;

const menuLabel = (run: Run, action: string): string => {
  const menu = run.loop.model().overlays.at(-1) as { entries: readonly { kind: string; action?: string; label: string | null }[] };
  return menu.entries.find((entry) => entry.kind === "action" && entry.action === action)!.label!;
};

describe("the overlays' close keys, the pane id copy and the about page", () => {
  it("every overlay registry entry shows its close control, and each of its close keys closes it", async () => {
    // a kind added to the registry without a row here fails this line
    expect(Object.keys(OVERLAYS).sort()).toEqual(KINDS.map(({ kind }) => kind).sort());
    const run = await start();
    for (const { kind, action, control, keys } of KINDS) {
      for (const key of keys) {
        run.loop.dispatch({ type: "action", action, at: run.clock.current });
        await run.advance(20);
        expect({ kind, open: run.loop.model().overlays.map((overlay) => overlay.kind) }).toEqual({ kind, open: [kind] });
        if (control !== null) expect({ kind, drawn: run.grid().some((line) => line.includes(control)) }).toEqual({ kind, drawn: true });
        await run.keys(key);
        await run.advance(200);
        expect({ kind, key, open: run.loop.model().overlays.length }).toEqual({ kind, key, open: 0 });
      }
    }
  }, TEST_MS);

  it("a tap on the close control closes every overlay kind at 45 columns, with no call to the core and no focus change", async () => {
    const run = await start(undefined, 45, 30);
    // the seen marker reads a terminal after any input (terminal.get); nothing else may be asked
    const calls = () => run.core.calls().map((call) => call.method).filter((method) => method !== "machine.list" && method !== "terminal.get");
    await run.keys("x");
    await run.advance(200);
    const focus = JSON.stringify(run.loop.model().focus);
    for (const { kind, action, control } of KINDS) {
      if (control === null) continue;
      run.loop.dispatch({ type: "action", action, at: run.clock.current });
      await run.advance(20);
      const before = calls();
      const row = run.grid().findIndex((line) => line.includes(control));
      expect({ kind, drawn: row >= 0 }).toEqual({ kind, drawn: true });
      await run.keys(`click@${run.grid()[row]!.indexOf(control) + 1}:${row}`);
      await run.advance(20);
      expect({ kind, open: run.loop.model().overlays.length, calls: calls(), focus: JSON.stringify(run.loop.model().focus) }).toEqual({ kind, open: 0, calls: before, focus });
    }
  }, TEST_MS);

  it("a dialog's buttons do what their keys do: clear empties the field, save renames, cancel closes with nothing written", async () => {
    const run = await start();
    const field = () => (run.loop.model().overlays.at(-1) as { field?: { graphemes: readonly string[] } } | undefined)?.field?.graphemes.join("") ?? null;
    const button = (text: string) => {
      const row = run.grid().findIndex((line) => line.includes(text));
      return `click@${run.grid()[row]!.indexOf(text) + 2}:${row}`;
    };
    await run.keys("ctrl+b,T");
    await run.advance(20);
    // the tab's name in the field, the cursor after it, nothing selected
    expect(field()).toBe("main");
    await run.keys(button("^c clear"));
    await run.advance(20);
    expect(field()).toBe("");
    await run.keys("x,y");
    await run.keys(button("↵ save"));
    await run.advance(50);
    expect(run.loop.model().overlays).toEqual([]);
    expect(run.loop.model().world.workspaces[0]!.tabs[0]!.name).toBe("xy");
    const before = run.core.calls().length;
    await run.keys("ctrl+b,T");
    await run.advance(20);
    await run.keys(button("esc cancel"));
    await run.advance(20);
    expect({ open: run.loop.model().overlays.length, name: run.loop.model().world.workspaces[0]!.tabs[0]!.name }).toEqual({ open: 0, name: "xy" });
    expect(run.core.calls().slice(before).filter((call) => call.method !== "machine.list" && call.method !== "terminal.get")).toEqual([]);
  }, TEST_MS);

  it("a new tab's field holds the number it will have; the tab bar's + opens it too", async () => {
    const run = await start();
    const row = run.grid()[0]!;
    await run.keys(`click@${row.indexOf("+")}:0`);
    await run.advance(20);
    expect(run.loop.model().overlays.at(-1)).toMatchObject({ kind: "text", purpose: "new_tab", field: { graphemes: ["3"], cursor: 1 } });
  }, TEST_MS);

  it("the tab bar's scroll buttons step to the tab before and after the one in front", async () => {
    const core = new FakeHcCore();
    for (let n = 0; n < 9; n++) place(core, { space: "w", spaceName: "work", tab: `tab${n}`, tabName: `tab-${n}` }, "ready\r\n");
    const run = await Run.start({ core, cols: 70, rows: 20 });
    runs.push(run);
    await run.live();
    const tab = () => run.loop.model().focus.tabs["w"];
    expect(tab()).toBe("tab0");
    const row = run.grid()[0]!;
    await run.keys(`click@${row.indexOf(" > ") + 1}:0`);
    await run.live();
    expect(tab()).toBe("tab1");
    await run.keys(`click@${row.indexOf(" < ") + 1}:0`);
    await run.live();
    expect(tab()).toBe("tab0");
  }, TEST_MS);

  it("the id copy is one OSC 52 write of the focused pane's id, and the program is sent nothing for it", async () => {
    const run = await start();
    const from = run.host.log().length;
    await run.keys("ctrl+b,i");
    await run.advance(20);
    expect(osc52Writes(run, from)).toEqual([clipboardOf("t1")]);
    expect(run.loop.model().notices.map(({ code }) => code)).toContain("copied");
    expect(run.core.program("t1").receivedHex()).toBe("");
  }, TEST_MS);

  it("the id copy follows the focused pane, not the tab's first", async () => {
    const run = await start();
    run.loop.dispatch({ type: "select", target: { kind: "pane", id: "t2" }, at: run.clock.current });
    await run.advance(20);
    const from = run.host.log().length;
    await run.keys("ctrl+b,i");
    await run.advance(20);
    expect(osc52Writes(run, from)).toEqual([clipboardOf("t2")]);
  }, TEST_MS);

  it("the id copy is also an entry of the menu and a tap on the id on the border, each one OSC 52 write", async () => {
    const run = await start();
    await run.keys("ctrl+b,enter,up");
    await run.advance(20);
    const label = menuLabel(run, "copy_pane_id");
    for (const name of ["copy pane id", "terms and about", "lock"]) expect({ name, drawn: run.grid().some((line) => line.includes(name)) }).toEqual({ name, drawn: true });
    let from = run.host.log().length;
    await run.keys(label);
    await run.advance(20);
    expect({ open: run.loop.model().overlays.length, writes: osc52Writes(run, from) }).toEqual({ open: 0, writes: [clipboardOf("t1")] });
    // the copy toast lies over the bottom border at the panes' middle until its notice ends
    await run.advance(NOTICE_SHOW_MS + 1);
    const row = run.grid().findIndex((line) => line.includes(" id t1 (prefix+i copies) "));
    from = run.host.log().length;
    await run.keys(`click@${run.grid()[row]!.indexOf(" id t1 (") + 3}:${row}`);
    await run.advance(20);
    expect(osc52Writes(run, from)).toEqual([clipboardOf("t1")]);
  }, TEST_MS);

  it("under an input method the id copy and the about page are reached through the menu: its letter chooses them", async () => {
    const run = await start();
    await run.keys("ctrl+b,ㅑ");
    await run.advance(20);
    expect(run.loop.model().notices.map(({ code }) => code)).toContain("ime_prefix");
    await run.keys("ctrl+b,enter");
    await run.advance(20);
    await run.keys(menuLabel(run, "about"));
    await run.advance(20);
    expect(run.loop.model().overlays.map((overlay) => overlay.kind)).toEqual(["about"]);
  }, TEST_MS);

  it("the lock is an entry of the menu too: choosing it locks the screen", async () => {
    const run = await start();
    await run.keys("ctrl+b,enter");
    await run.advance(20);
    await run.keys(menuLabel(run, "lock"));
    await run.advance(20);
    expect({ locked: run.loop.model().locked, open: run.loop.model().overlays.length }).toEqual({ locked: true, open: 0 });
  }, TEST_MS);

  it("a menu opened in navigate mode lists the three moves no phone keyboard types, each chosen by its own label; outside navigate mode it lists none", async () => {
    const run = await start();
    const entriesOf = () => (run.loop.model().overlays.at(-1) as { entries: readonly { kind: string; action?: string; label: string | null }[] }).entries;
    const MOVES = ["navigate_move_up", "navigate_move_down", "navigate_move_pane"];
    run.loop.dispatch({ type: "action", action: "menu", at: run.clock.current });
    await run.advance(20);
    expect(entriesOf().filter((entry) => MOVES.includes(entry.action ?? ""))).toEqual([]);
    await run.keys("esc");
    await run.advance(200);
    await run.keys("ctrl+b,w");
    await run.advance(20);
    run.loop.dispatch({ type: "action", action: "menu", at: run.clock.current });
    await run.advance(20);
    const labels = entriesOf().flatMap((entry) => (entry.label === null ? [] : [entry.label]));
    expect({ unique: new Set(labels).size === labels.length, actionsLabelled: entriesOf().every((entry) => entry.kind !== "action" || /^\S$/.test(entry.label ?? "")) }).toEqual({ unique: true, actionsLabelled: true });
    expect(entriesOf().filter((entry) => MOVES.includes(entry.action ?? "")).map((entry) => entry.action).sort()).toEqual([...MOVES].sort());
    for (const move of MOVES) {
      const before = run.loop.report().actions.length;
      await run.keys(menuLabel(run, move));
      await run.advance(50);
      expect({ move, ran: run.loop.report().actions.slice(before).includes(`run:${move}`), mode: run.loop.model().mode.name }).toEqual({ move, ran: true, mode: move === "navigate_move_pane" ? "terminal" : "navigate" });
      if (move !== "navigate_move_pane") {
        run.loop.dispatch({ type: "action", action: "menu", at: run.clock.current });
        await run.advance(20);
      }
    }
  }, TEST_MS);

  it("a locked screen unlocks by a tap on its LOCKED badge when the chord cannot be typed", async () => {
    const run = await start();
    await run.keys("ctrl+b,enter");
    await run.advance(20);
    await run.keys(menuLabel(run, "lock"));
    await run.advance(20);
    expect(run.loop.model().locked).toBe(true);
    // the mode bar lies over the panes' last row, right of the sidebar
    await run.keys(`click@${SIDEBAR_COLUMNS + 1}:${run.grid().length - 1}`);
    await run.advance(20);
    expect(run.loop.model().locked).toBe(false);
  }, TEST_MS);

  it("the about page carries the versions the link reported: Ovis's own, herdr-core's from hello, and the session", async () => {
    for (const [core, reported] of [[new FakeHcCore(), "0.1.18"], [new FakeHcCore({ version: "0.1.17", features: FEATURES_0_1_17 }), "0.1.17"]] as const) {
      const run = await start(core);
      await run.keys("ctrl+b,?");
      await run.advance(20);
      expect(run.grid().some((line) => line.includes(" a: terms and about "))).toBe(true);
      await run.keys("a");
      await run.advance(20);
      expect(run.loop.model().overlays.map((overlay) => overlay.kind)).toEqual(["help", "about"]);
      expect(run.grid().some((line) => line.includes(`hc:default · Ovis ${OVIS_VERSION} · herdr-core ${reported}`))).toBe(true);
      await run.keys("esc");
      await run.advance(200);
      expect(run.loop.model().overlays.map((overlay) => overlay.kind)).toEqual(["help"]);
      await run.keys("esc");
      await run.advance(200);
      await run.cutLine();
      await run.advance(1_000);
      run.loop.dispatch({ type: "action", action: "about", at: run.clock.current });
      await run.advance(20);
      expect(run.grid().some((line) => line.includes(`hc:default · Ovis ${OVIS_VERSION} · herdr-core not connected`))).toBe(true);
    }
  }, TEST_MS);

  it("at 45 columns the about line is cut at its end: the session and both programs' names stay", async () => {
    const run = await start(undefined, 45, 30);
    run.loop.dispatch({ type: "action", action: "about", at: run.clock.current });
    await run.advance(20);
    expect(run.grid().some((line) => line.includes(`hc:default · Ovis ${OVIS_VERSION} · herdr-core`))).toBe(true);
  }, TEST_MS);
});
