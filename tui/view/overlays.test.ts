import { afterEach, describe, expect, it } from "bun:test";
import { version as OVIS_VERSION } from "../../package.json";
import { FakeHcCore, FEATURES_0_1_17 } from "../../server/herdr-core/core.fake.ts";
import { OVERLAYS } from "../model/overlays.ts";
import { demo } from "../testing/fixtures/demo.ts";
import { Run } from "../testing/run.ts";

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

/** Each overlay kind, the action that opens it, the close control its frame shows and the keys that close it: written out here. */
const KINDS = [
  { kind: "help", action: "help", control: "[close: esc / q / ?]", keys: ["esc", "q", "?"] },
  { kind: "about", action: "about", control: "[close: esc / q]", keys: ["esc", "q"] },
  { kind: "text", action: "rename_tab", control: "[close: esc]", keys: ["esc"] },
  { kind: "confirm", action: "close_workspace", control: "[close: esc / n]", keys: ["esc", "n"] },
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
  it("every overlay registry entry has its close keys in its frame, and each of them closes it", async () => {
    // a kind added to the registry without a row here fails this line
    expect(Object.keys(OVERLAYS).sort()).toEqual(KINDS.map(({ kind }) => kind).sort());
    const run = await start();
    for (const { kind, action, control, keys } of KINDS) {
      for (const key of keys) {
        run.loop.dispatch({ type: "action", action, at: run.clock.current });
        await run.advance(20);
        expect({ kind, open: run.loop.model().overlays.map((overlay) => overlay.kind) }).toEqual({ kind, open: [kind] });
        expect({ kind, drawn: run.grid().some((line) => line.includes(control)) }).toEqual({ kind, drawn: true });
        await run.keys(key);
        await run.advance(200);
        expect({ kind, key, open: run.loop.model().overlays.length }).toEqual({ kind, key, open: 0 });
      }
    }
  }, TEST_MS);

  it("a tap on the close control closes every overlay kind at 45 columns, with no call to the core and no focus change", async () => {
    const run = await start(undefined, 45, 30);
    const calls = () => run.core.calls().map((call) => call.method).filter((method) => method !== "machine.list");
    const focus = JSON.stringify(run.loop.model().focus);
    const before = calls();
    for (const { kind, action, control } of KINDS) {
      run.loop.dispatch({ type: "action", action, at: run.clock.current });
      await run.advance(20);
      const row = run.grid().findIndex((line) => line.includes(control));
      expect({ kind, drawn: row >= 0 }).toEqual({ kind, drawn: true });
      await run.keys(`click@${run.grid()[row]!.indexOf(control) + 1}:${row}`);
      await run.advance(20);
      expect({ kind, open: run.loop.model().overlays.length, calls: calls(), focus: JSON.stringify(run.loop.model().focus) }).toEqual({ kind, open: 0, calls: before, focus });
    }
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
