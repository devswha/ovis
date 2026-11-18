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

async function start(core?: FakeHcCore): Promise<Run> {
  if (core) demo.build(core);
  const run = await Run.start({ fixture: demo, ...(core ? { core } : {}), cols: 120, rows: 40 });
  runs.push(run);
  await run.live();
  await run.advance(1);
  return run;
}

/** Each overlay kind, the action that opens it, the close control its frame shows and the keys that close it: written out here. */
const KINDS = [
  { kind: "help", action: "help", control: "[close: esc / q / ?]", keys: ["esc", "q", "?"] },
  { kind: "text", action: "rename_tab", control: "[close: esc]", keys: ["esc"] },
  { kind: "confirm", action: "close_workspace", control: "[close: esc / n]", keys: ["esc", "n"] },
  { kind: "goto", action: "goto", control: "[close: esc]", keys: ["esc"] },
  { kind: "menu", action: "menu", control: "[close: esc]", keys: ["esc"] },
] as const;

describe("the overlays' close keys, the pane id copy and the help's about line", () => {
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

  it("the id copy is one OSC 52 write of the focused pane's id, and a click-free key press writes nothing else to the host", async () => {
    const run = await start();
    const before = run.host.log().length;
    await run.keys("ctrl+b,i");
    await run.advance(20);
    const written = run.host.log().slice(before).filter((entry) => entry.startsWith("write ")).map((entry) => entry.slice("write ".length));
    expect(written.filter((bytes) => bytes.includes("\x1b]52;"))).toEqual([`\x1b]52;c;${Buffer.from("t1").toString("base64")}\x1b\\`]);
    expect(run.loop.model().notices.map(({ code }) => code)).toContain("copied");
    // the key reached no pane: the program was sent nothing for it
    expect(run.core.program("t1").receivedHex()).toBe("");
  }, TEST_MS);

  it("the about line carries the versions the link reported: Ovis's own, herdr-core's from hello, and the session", async () => {
    for (const [core, reported] of [[new FakeHcCore(), "0.1.18"], [new FakeHcCore({ version: "0.1.17", features: FEATURES_0_1_17 }), "0.1.17"]] as const) {
      const run = await start(core);
      await run.keys("ctrl+b,?");
      await run.advance(20);
      expect(run.grid().some((line) => line.includes(` Ovis ${OVIS_VERSION} · herdr-core ${reported} · hc:default `))).toBe(true);
      await run.keys("esc");
      await run.advance(200);
      await run.cutLine();
      await run.advance(1_000);
      run.loop.dispatch({ type: "action", action: "help", at: run.clock.current });
      await run.advance(20);
      expect(run.grid().some((line) => line.includes(` Ovis ${OVIS_VERSION} · herdr-core not connected · hc:default `))).toBe(true);
    }
  }, TEST_MS);
});
