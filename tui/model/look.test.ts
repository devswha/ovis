import { afterEach, describe, expect, it } from "bun:test";
import { tuiEnv } from "../../scripts/plugin-tui.ts";
import { HcConnection } from "../../server/herdr-core/connection.ts";
import { FakeHcCore } from "../../server/herdr-core/core.fake.ts";
import { OVIS_LAYOUT_DOC } from "../../server/herdr-core/layout-doc.ts";
import { PANE_NAME_LABEL, SPACE_LABEL, TAB_LABEL, TAB_NAME_LABEL, WORKSPACE_NAME_LABEL } from "../../server/herdr-core/snapshot.ts";
import { Run } from "../testing/run.ts";
import { focused } from "./focus.ts";
import { look, type LookState } from "./look.ts";

/** the injected clock moves; only the socket's own turns are real */
const TEST_MS = 120_000;
const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";
/** the label every Herdr client reads as the last turn a person looked at */
const SEEN = "herdr.seen";

const runs: Run[] = [];
afterEach(async () => {
  for (const run of runs.splice(0)) await run.close();
});

/**
 * A core with one tab split in two agents, `t1` (named one) and `t2` (named two), each reporting idle at turn 0. `seen`
 * gives each a `herdr.seen` label to start with (none: no label); `first` the state t1 reports before the screen comes.
 */
function twoAgents(seen: string | null = "0", first = "idle"): FakeHcCore {
  const core = new FakeHcCore();
  for (const [name, state] of [["one", first], ["two", "idle"]] as const) {
    const labels: Record<string, string> = { [SPACE_LABEL]: "w", [WORKSPACE_NAME_LABEL]: "work", [TAB_LABEL]: "t", [TAB_NAME_LABEL]: "tab", [PANE_NAME_LABEL]: name };
    if (seen !== null) labels[SEEN] = seen;
    const { address } = core.spawn({ labels });
    core.setPaint(address, { body: `${name}\r\n` });
    core.reportStatus(address, { state, app: "claude" });
  }
  return core;
}

async function started(core: FakeHcCore, live = true): Promise<Run> {
  const run = await Run.start({ core, cols: 120, rows: 40 });
  runs.push(run);
  if (live) {
    await run.live();
    await run.advance(1);
  }
  return run;
}

/** Every `herdr.seen` write the core was asked for, in order: the terminal and the value. */
function seenWrites(run: Run, line?: number): { terminal: unknown; seen: unknown }[] {
  return run.core.calls()
    .filter((call) => call.method === "terminal.label" && (line === undefined || call.line === line))
    .map((call) => ({ terminal: call.params["terminal"], seen: (call.params["labels"] as Record<string, unknown>)[SEEN] }));
}

/** The agent in `terminal` works, then rests: its turn ends (the core raises the turn and tells it). */
async function endTurn(run: Run, terminal: string): Promise<void> {
  run.core.reportStatus(terminal, { state: "working", app: "claude" });
  run.core.reportStatus(terminal, { state: "idle", app: "claude" });
  await run.advance(20);
}

async function hostFocus(run: Run, focus: string): Promise<void> {
  run.type(focus);
  await run.advance(20);
}

const select = async (run: Run, id: string) => {
  run.loop.dispatch({ type: "select", target: { kind: "pane", id }, at: run.clock.current });
  await run.advance(20);
};


describe("the look rule", () => {
  const LOOKING: LookState = { hostFocused: true, inputAfterTurn: false, pane: "t1", live: true, drawn: true, overlay: false, online: true };
  const table: [name: string, change: Partial<LookState>, looked: string | null][] = [
    ["a focused host, the focused pane live, drawn, nothing over it, online", {}, "t1"],
    ["the host unfocused", { hostFocused: false }, null],
    ["the host unfocused, input after the turn notwithstanding", { hostFocused: false, inputAfterTurn: true }, null],
    ["no focus reports and no input after the turn", { hostFocused: null }, null],
    ["no focus reports and input after the turn", { hostFocused: null, inputAfterTurn: true }, "t1"],
    ["no pane", { pane: null }, null],
    ["the first paint not complete", { live: false }, null],
    ["not drawn in the last frame", { drawn: false }, null],
    ["an overlay open", { overlay: true }, null],
    ["the link offline", { online: false }, null],
  ];
  for (const [name, change, looked] of table) it(name, () => expect(look({ ...LOOKING, ...change })).toBe(looked));
});

describe("read state through herdr.seen (UB Q7)", () => {
  it("seen when looked at", async () => {
    const run = await started(twoAgents());
    await hostFocus(run, FOCUS_IN);
    // the look began on t1, whose label already holds its turn 0
    expect(seenWrites(run)).toEqual([]);
    await endTurn(run, "t1");
    expect(seenWrites(run)).toEqual([{ terminal: "t1", seen: "1" }]);
    expect(run.core.terminal("t1").labels[SEEN]).toBe("1");
    // the other pane of the split is shown too, but not looked at: its turn is not marked
    await endTurn(run, "t2");
    expect(seenWrites(run)).toEqual([{ terminal: "t1", seen: "1" }]);
  }, TEST_MS);

  it("seen not otherwise", async () => {
    // the host unfocused: nothing; its focus back: one write
    const unfocused = await started(twoAgents());
    await hostFocus(unfocused, FOCUS_IN);
    await hostFocus(unfocused, FOCUS_OUT);
    await endTurn(unfocused, "t1");
    expect(seenWrites(unfocused)).toEqual([]);
    await hostFocus(unfocused, FOCUS_IN);
    expect(seenWrites(unfocused)).toEqual([{ terminal: "t1", seen: "1" }]);

    // another pane focused
    const other = await started(twoAgents());
    await hostFocus(other, FOCUS_IN);
    await select(other, "t2");
    await endTurn(other, "t1");
    expect(seenWrites(other)).toEqual([]);

    // an overlay open over the panes
    const covered = await started(twoAgents());
    await hostFocus(covered, FOCUS_IN);
    await covered.keys("ctrl+b,?");
    expect(covered.loop.report().mode.overlays).toEqual(["help"]);
    await endTurn(covered, "t1");
    expect(seenWrites(covered)).toEqual([]);

    // the first paint not complete: the pane is not Live yet, so nothing; once it is drawn Live, it comes into view
    const painting = await started(twoAgents(), false);
    painting.type(FOCUS_IN);
    painting.core.reportStatus("t1", { state: "working", app: "claude" });
    painting.core.reportStatus("t1", { state: "idle", app: "claude" });
    await painting.settle();
    expect(painting.loop.panes.view("t1")?.state.kind).not.toBe("Live");
    expect(seenWrites(painting)).toEqual([]);
    await painting.live();
    await painting.advance(20);
    expect(seenWrites(painting)).toEqual([{ terminal: "t1", seen: "1" }]);

    // the link offline: a turn ends meanwhile and nothing is written; the line back, the pane comes into view again
    const offline = await started(twoAgents());
    await hostFocus(offline, FOCUS_IN);
    await offline.cutLine();
    await offline.advance(1_000);
    expect(offline.loop.link.state.kind).toBe("Offline");
    offline.core.reportStatus("t1", { state: "working", app: "claude" });
    offline.core.reportStatus("t1", { state: "idle", app: "claude" });
    await offline.advance(1_000);
    expect(seenWrites(offline)).toEqual([]);
    await offline.listen();
    await offline.advance(6_000);
    await offline.live();
    await offline.advance(20);
    expect(seenWrites(offline)).toEqual([{ terminal: "t1", seen: "1" }]);
  }, TEST_MS);

  it("seen once per turn", async () => {
    const run = await started(twoAgents());
    await hostFocus(run, FOCUS_IN);
    run.core.reportStatus("t1", { state: "working", app: "claude" });
    for (const progress of [10, 20, 30, 40]) run.core.reportStatus("t1", { state: "working", app: "claude", progress });
    await run.advance(20);
    expect(seenWrites(run)).toEqual([]);
    run.core.reportStatus("t1", { state: "idle", app: "claude" });
    await run.advance(20);
    expect(seenWrites(run)).toEqual([{ terminal: "t1", seen: "1" }]);
    await endTurn(run, "t1");
    expect(seenWrites(run)).toEqual([{ terminal: "t1", seen: "1" }, { terminal: "t1", seen: "2" }]);
  }, TEST_MS);

  it("unread stands", async () => {
    const run = await started(twoAgents());
    await hostFocus(run, FOCUS_IN);
    await endTurn(run, "t1");
    const line = run.core.calls().find((call) => call.method === "terminal.label")!.line;
    // another client marks it unread while the pane stays in front: the screen writes nothing
    const otherClient = new HcConnection(() => run.core.transport());
    await otherClient.call("terminal.label", { terminal: "t1", labels: { [SEEN]: "0" } });
    otherClient.close();
    await run.advance(1_000);
    expect(seenWrites(run, line)).toEqual([{ terminal: "t1", seen: "1" }]);
    expect(run.core.terminal("t1").labels[SEEN]).toBe("0");
    // focus away and back: the pane comes into view again, one write
    await select(run, "t2");
    await select(run, "t1");
    expect(seenWrites(run, line)).toEqual([{ terminal: "t1", seen: "1" }, { terminal: "t1", seen: "1" }]);
  }, TEST_MS);

  it("seen only raises", async () => {
    const run = await started(twoAgents("5"));
    await hostFocus(run, FOCUS_IN);
    await endTurn(run, "t1");
    await select(run, "t2");
    await select(run, "t1");
    expect(seenWrites(run)).toEqual([]);
    expect(run.core.terminal("t1").labels[SEEN]).toBe("5");
  }, TEST_MS);

  it("seen joins", async () => {
    const run = await started(twoAgents(null));
    await endTurn(run, "t1");
    expect(seenWrites(run)).toEqual([]);
    await hostFocus(run, FOCUS_IN);
    expect(seenWrites(run)).toEqual([{ terminal: "t1", seen: "1" }]);
  }, TEST_MS);

  it("no focus reports", async () => {
    const run = await started(twoAgents());
    await endTurn(run, "t1");
    await run.advance(1_000);
    expect(run.loop.model().host.focused).toBe(null);
    expect(seenWrites(run)).toEqual([]);
    await run.keys("x");
    await run.advance(20);
    expect(seenWrites(run)).toEqual([{ terminal: "t1", seen: "1" }]);
    // the next turn: no input after it yet, so nothing until the next key
    await endTurn(run, "t1");
    expect(seenWrites(run)).toEqual([{ terminal: "t1", seen: "1" }]);
    await run.keys("y");
    await run.advance(20);
    expect(seenWrites(run)).toEqual([{ terminal: "t1", seen: "1" }, { terminal: "t1", seen: "2" }]);
  }, TEST_MS);

  it("core only", async () => {
    // the launcher hands the screen no Ovis server token or address (scripts/plugin-tui.ts tuiEnv)
    expect(tuiEnv({ TERM: "xterm", OVIS_TOKEN: "exported", OVIS_URL: "http://127.0.0.1:9", HC_SOCKET: "/s/hc.sock" })).toEqual({ TERM: "xterm", HC_SOCKET: "/s/hc.sock" });
    // with no Ovis server at all, the read state reaches every client through the core alone, on the screen's own line
    const run = await started(twoAgents());
    await hostFocus(run, FOCUS_IN);
    await endTurn(run, "t1");
    const lines = new Set(run.core.calls().map((call) => call.line));
    expect(lines.size).toBe(1);
    expect(seenWrites(run)).toEqual([{ terminal: "t1", seen: "1" }]);
  }, TEST_MS);

  it("an agent that finishes or turns blocked gives no notice and no toast, as herdr's default; its mark in the sidebar changes", async () => {
    const run = await started(twoAgents("0", "blocked"));
    await hostFocus(run, FOCUS_IN);
    await endTurn(run, "t2");
    expect(run.grid().some((row) => row.includes("* two /"))).toBe(true);
    run.core.reportStatus("t2", { state: "blocked", app: "claude" });
    await run.advance(20);
    expect(run.grid().some((row) => row.includes("! two /"))).toBe(true);
    expect(run.loop.model().notices).toEqual([]);
    expect(run.loop.report().mode.overlays).toEqual([]);
  }, TEST_MS);

  it("a host's own replies are not a person: on a host that never reports focus they write nothing, a key does", async () => {
    const run = await started(twoAgents());
    await endTurn(run, "t1");
    // the host's own sequences read after the turn: a colour reply and a sequence nobody knows
    run.type("\x1b]11;rgb:1111/2222/3333\x1b\\");
    run.type("\x1b[99;99~");
    await run.advance(20);
    expect(run.loop.report().actions.filter((action) => action.startsWith("read:")).slice(-2)).toEqual(["read:reply", "read:unknown"]);
    expect(seenWrites(run)).toEqual([]);
    await run.keys("x");
    await run.advance(20);
    expect(seenWrites(run)).toEqual([{ terminal: "t1", seen: "1" }]);
  }, TEST_MS);

  it("another client's zoom: the look follows the focus to the zoomed pane, and the covered pane's turn is not marked", async () => {
    const run = await started(twoAgents());
    await hostFocus(run, FOCUS_IN);
    await select(run, "t2");
    await endTurn(run, "t2");
    expect(seenWrites(run)).toEqual([{ terminal: "t2", seen: "1" }]);
    // another client zooms t1: the focus follows the shared zoom (row 35), t2 stays attached and covered
    const otherClient = new HcConnection(() => run.core.transport());
    const doc = (zoomed: string | null) => ({ schema: 1, workspaces: [{ id: "w", tabs: [{ id: "t", root: { split: "right", ratio: 0.5, first: { leaf: "t1" }, second: { leaf: "t2" } }, zoomed }] }] });
    await otherClient.call("doc.set", { name: OVIS_LAYOUT_DOC, value: doc("t1"), version: run.core.docs.get(OVIS_LAYOUT_DOC)?.version ?? 0 });
    otherClient.close();
    await run.advance(1_000);
    expect([run.loop.panes.view("t2")?.covered, focused(run.loop.model().world, run.loop.model().focus).pane?.id]).toEqual([true, "t1"]);
    await endTurn(run, "t2");
    await endTurn(run, "t1");
    expect(seenWrites(run)).toEqual([{ terminal: "t2", seen: "1" }, { terminal: "t1", seen: "1" }]);
  }, TEST_MS);
});
