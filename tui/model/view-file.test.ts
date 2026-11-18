import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeHcCore } from "../../server/herdr-core/core.fake.ts";
import { demo } from "../testing/fixtures/demo.ts";
import { Run } from "../testing/run.ts";
import { ViewStore, viewFileName } from "../view-store.ts";
import { type Focus, nextFocus, type World } from "./focus.ts";
import { initialState, type ModelState, reduce } from "./reduce.ts";
import { readView, restoredFocus, VIEW_FILE_MAX_BYTES, type ViewProblem, viewText } from "./view-file.ts";

const TEST_MS = 120_000;
const folders: string[] = [];
const runs: Run[] = [];
afterEach(async () => {
  for (const run of runs.splice(0)) await run.close();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function scratch(): string {
  const folder = mkdtempSync(join(process.env["TMPDIR"] || tmpdir(), "view-file-"));
  folders.push(folder);
  return folder;
}

const pane = (id: string, created?: number) => ({ id, name: `name of ${id}`, ...(created === undefined ? {} : { created }) });
const WORLD: World = {
  workspaces: [
    { id: "w1", name: "one", tabs: [{ id: "t1", name: "a", panes: [pane("p1", 1), pane("p2", 2), pane("p3", 3)] }, { id: "t2", name: "b", panes: [pane("p4", 4)] }] },
    { id: "w2", name: "two", tabs: [{ id: "t3", name: "c", panes: [pane("p5", 5)] }] },
  ],
};
const AT_P2: Focus = { workspace: "w1", tabs: { w1: "t1", w2: "t3" }, panes: { t1: "p2", t2: "p4", t3: "p5" }, previous: null };

const saved = (world: World, focus: Focus) => {
  const read = readView(viewText(world, focus)!);
  if (!("view" in read)) throw new Error(`not read: ${read.problem}`);
  return read.view;
};
const without = (world: World, gone: string): World => ({
  workspaces: world.workspaces.map((workspace) => ({ ...workspace, tabs: workspace.tabs.map((tab) => ({ ...tab, panes: tab.panes.filter((one) => one.id !== gone) })) })),
});
const stateOf = (world: World, focus: Focus): ModelState => ({ ...reduce(initialState(undefined), { type: "world", world, at: 0 }).state, focus });

describe("what the view file holds", () => {
  it("ids only: the focus and the workspaces, tabs and terminals it was taken among, with no name", () => {
    expect(JSON.parse(viewText(WORLD, AT_P2)!)).toEqual({
      v: 1,
      focus: { workspace: "w1", tabs: { w1: "t1", w2: "t3" }, panes: { t1: "p2", t2: "p4", t3: "p5" }, previous: null },
      world: [
        { id: "w1", tabs: [{ id: "t1", panes: [{ id: "p1", created: 1 }, { id: "p2", created: 2 }, { id: "p3", created: 3 }] }, { id: "t2", panes: [{ id: "p4", created: 4 }] }] },
        { id: "w2", tabs: [{ id: "t3", panes: [{ id: "p5", created: 5 }] }] },
      ],
    });
    expect(viewText(WORLD, AT_P2)).not.toContain("name of");
  });

  it("nothing to keep when no pane shows", () => {
    expect(viewText({ workspaces: [] }, AT_P2)).toBeNull();
    expect(viewText({ workspaces: [{ id: "w1", name: "", tabs: [] }] }, AT_P2)).toBeNull();
  });

  it("a file this screen did not write is no view, and the problem is named", () => {
    const valid = JSON.parse(viewText(WORLD, AT_P2)!);
    const table: [name: string, text: string, problem: ViewProblem][] = [
      ["not JSON", "{\"v\":1,", "not_json"],
      ["another version's", JSON.stringify({ ...valid, v: 2 }), "version"],
      ["no version", JSON.stringify({ focus: valid.focus, world: valid.world }), "version"],
      ["a list", "[]", "shape"],
      ["a focus id that is no string", JSON.stringify({ ...valid, focus: { ...valid.focus, workspace: 7 } }), "shape"],
      ["an empty id", JSON.stringify({ ...valid, focus: { ...valid.focus, panes: { t1: "" } } }), "shape"],
      ["an id of 257 characters", JSON.stringify({ ...valid, focus: { ...valid.focus, previous: "x".repeat(257) } }), "shape"],
      ["a pane without an id", JSON.stringify({ ...valid, world: [{ id: "w1", tabs: [{ id: "t1", panes: [{ created: 1 }] }] }] }), "shape"],
      ["a created time that is no number", JSON.stringify({ ...valid, world: [{ id: "w1", tabs: [{ id: "t1", panes: [{ id: "p1", created: "1" }] }] }] }), "shape"],
      ["too large", " ".repeat(VIEW_FILE_MAX_BYTES + 1), "too_large"],
    ];
    for (const [name, text, problem] of table) expect({ name, read: readView(text) }).toEqual({ name, read: { problem } });
  });
});

describe("reopening the same place", () => {
  it("a rerun with the saved file focuses the same pane", () => {
    expect(restoredFocus(saved(WORLD, AT_P2), WORLD)).toEqual({ focus: AT_P2, moved: false });
  });

  it("a saved pane that no longer exists falls back by the next-focus function: the next pane of its tab in tree order", () => {
    const now = without(WORLD, "p2");
    const back = restoredFocus(saved(WORLD, AT_P2), now);
    expect(back).toEqual({ focus: { ...AT_P2, panes: { ...AT_P2.panes, t1: "p3" } }, moved: true });
    expect(back.focus).toEqual(nextFocus(saved(WORLD, AT_P2).world, now, AT_P2));
  });

  it("a saved pane gone gives way to the saved previous pane while that one lives", () => {
    const back = restoredFocus(saved(WORLD, { ...AT_P2, previous: "p1" }), without(WORLD, "p2"));
    expect(back.focus.panes["t1"]).toBe("p1");
    expect(back.moved).toBe(true);
  });

  it("a saved workspace gone: the next workspace, with its own remembered tab and pane", () => {
    const now: World = { workspaces: [WORLD.workspaces[1]!] };
    expect(restoredFocus(saved(WORLD, AT_P2), now)).toEqual({ focus: { workspace: "w2", tabs: { w2: "t3" }, panes: { t3: "p5" }, previous: null }, moved: true });
  });

  it("an address the core now gives a newer terminal counts as gone", () => {
    const reused: World = { workspaces: [{ ...WORLD.workspaces[0]!, tabs: [{ id: "t1", name: "a", panes: [pane("p1", 1), pane("p2", 99), pane("p3", 3)] }, WORLD.workspaces[0]!.tabs[1]!] }, WORLD.workspaces[1]!] };
    expect(restoredFocus(saved(WORLD, AT_P2), reused)).toEqual({ focus: { ...AT_P2, panes: { ...AT_P2.panes, t1: "p3" } }, moved: true });
  });

  it("the reducer applies a kept view once the world has something in it, and says so when the place moved", () => {
    const empty = initialState(undefined);
    const waiting = reduce(empty, { type: "restore", view: saved(WORLD, AT_P2), problem: null, at: 1 }).state;
    expect(waiting.restoring).not.toBeNull();
    const shown = reduce(waiting, { type: "world", world: WORLD, at: 2 }).state;
    expect([shown.restoring, shown.focus, shown.notices]).toEqual([null, AT_P2, []]);
    const moved = reduce(waiting, { type: "world", world: without(WORLD, "p2"), at: 2 }).state;
    expect([moved.focus.panes["t1"], moved.notices.map((notice) => [notice.code, notice.calm])]).toEqual(["p3", [["view_moved", true]]]);
  });

  it("a file that could not be used is said so, and the screen opens where it would without one", () => {
    const base = stateOf(WORLD, { workspace: null, tabs: {}, panes: {}, previous: null });
    const step = reduce(base, { type: "restore", view: null, problem: "not_json", at: 1 }).state;
    expect([step.focus, step.notices.map((notice) => [notice.code, notice.data, notice.calm])]).toEqual([base.focus, [["view_unread", { reason: "not_json" }, true]]]);
  });
});

describe("the file on disk", () => {
  it("one file per core id, named by the id when it is a plain word and by its hash otherwise", () => {
    expect(viewFileName("c0ffee-01_A")).toBe("view-c0ffee-01_A.json");
    expect(viewFileName("../../etc/passwd")).toMatch(/^view-[0-9a-f]{32}\.json$/);
    expect(viewFileName("x".repeat(65))).toMatch(/^view-[0-9a-f]{32}\.json$/);
  });

  it("written by rename: the file 0600 in a 0700 folder, nothing else left there", () => {
    const folder = join(scratch(), "state");
    const store = new ViewStore(folder);
    expect(store.open("core1")).toEqual({ view: null, problem: null });
    expect(store.keep(stateOf(WORLD, AT_P2))).toBeNull();
    expect(store.keep(stateOf(WORLD, { ...AT_P2, workspace: "w2" }))).toBeNull();
    expect(readdirSync(folder)).toEqual(["view-core1.json"]);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(statSync(join(folder, "view-core1.json")).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(folder, "view-core1.json"), "utf8")).focus.workspace).toBe("w2");
  });

  it("written only when what it holds changed: the same view again writes nothing", () => {
    const folder = scratch();
    const store = new ViewStore(folder);
    store.open("core1");
    store.keep(stateOf(WORLD, AT_P2));
    const first = statSync(join(folder, "view-core1.json")).ino;
    for (let n = 0; n < 5; n++) store.keep({ ...stateOf(WORLD, AT_P2), nextNotice: n });
    expect(statSync(join(folder, "view-core1.json")).ino).toBe(first);
    store.keep(stateOf(WORLD, { ...AT_P2, panes: { ...AT_P2.panes, t1: "p3" } }));
    expect(statSync(join(folder, "view-core1.json")).ino).not.toBe(first);
  });

  it("nothing is written before the core is known, nor while a kept view waits to be applied", () => {
    const folder = scratch();
    const store = new ViewStore(folder);
    store.keep(stateOf(WORLD, AT_P2));
    expect(readdirSync(folder)).toEqual([]);
    store.open("core1");
    store.keep({ ...stateOf(WORLD, AT_P2), restoring: saved(WORLD, AT_P2) });
    expect(readdirSync(folder)).toEqual([]);
  });

  it("two screens on one core share the file and the last writer wins", () => {
    const folder = scratch();
    const [one, two] = [new ViewStore(folder), new ViewStore(folder)];
    one.open("core1");
    two.open("core1");
    one.keep(stateOf(WORLD, AT_P2));
    two.keep(stateOf(WORLD, { ...AT_P2, workspace: "w2" }));
    expect(new ViewStore(folder).open("core1").view?.focus.workspace).toBe("w2");
    one.keep(stateOf(WORLD, { ...AT_P2, panes: { ...AT_P2.panes, t1: "p1" } }));
    expect(new ViewStore(folder).open("core1").view?.focus).toEqual({ ...AT_P2, panes: { ...AT_P2.panes, t1: "p1" } });
  });

  it("a corrupt or oversized file is no view and says why; a missing one is no problem", () => {
    const folder = scratch();
    writeFileSync(join(folder, viewFileName("bad")), "{\"v\":1,\"focus\":");
    writeFileSync(join(folder, viewFileName("big")), " ".repeat(VIEW_FILE_MAX_BYTES + 1));
    expect(new ViewStore(folder).open("bad")).toEqual({ view: null, problem: "not_json" });
    expect(new ViewStore(folder).open("big")).toEqual({ view: null, problem: "too_large" });
    expect(new ViewStore(folder).open("none")).toEqual({ view: null, problem: null });
  });

  it("a write that fails is told once, by its code", () => {
    const parent = scratch();
    const folder = join(parent, "file");
    writeFileSync(folder, "not a folder");
    const store = new ViewStore(folder);
    store.open("core1");
    expect(store.keep(stateOf(WORLD, AT_P2))).toBe("EEXIST");
    expect(store.keep(stateOf(WORLD, { ...AT_P2, workspace: "w2" }))).toBeNull();
  });
});

describe("a rerun of the screen on the same core", () => {
  async function first(core: FakeHcCore, folder: string, cols = 120, rows = 40): Promise<Run> {
    const run = await Run.start({ core, views: new ViewStore(folder), cols, rows });
    runs.push(run);
    await run.live();
    await run.advance(1);
    return run;
  }
  const close = async (run: Run) => {
    runs.splice(runs.indexOf(run), 1);
    await run.close();
  };

  it("a rerun with the saved file focuses the same pane, at 45 columns too, and its file holds nothing private", async () => {
    const folder = scratch();
    const core = new FakeHcCore();
    demo.build(core);
    const before = await first(core, folder);
    await before.keys("ctrl+b,n,ctrl+b,p,ctrl+b,tab");
    await before.live();
    await before.advance(1);
    await before.keys("typed-secret-1234");
    core.program("t2").output("printed-secret-5678\r\n");
    await before.advance(100);
    expect(before.loop.model().focus.panes["t-main"]).toBe("t2");
    await close(before);
    const files = readdirSync(folder);
    expect(files).toEqual(["view-fake0000.json"]);
    const text = readFileSync(join(folder, files[0]!), "utf8");
    // names would show as JSON strings ("ovis"); the ids of the fake core contain them (w-ovis), so the quotes count
    for (const secret of ["typed-secret", "printed-secret", "\"ovis\"", "\"main\"", "\"logs\"", "shell", "files", "문서", "안녕"]) expect({ secret, found: text.includes(secret) }).toEqual({ secret, found: false });
    const again = await first(core, folder, 45, 30);
    expect(again.loop.model().focus.panes["t-main"]).toBe("t2");
    expect(again.loop.panes.views().map((view) => view.terminal)).toEqual(["t2"]);
    expect(again.loop.model().notices).toEqual([]);
  }, TEST_MS);

  it("the saved pane gone on the core: the screen opens on the next one and says so", async () => {
    const folder = scratch();
    const core = new FakeHcCore();
    demo.build(core);
    const before = await first(core, folder);
    await before.keys("ctrl+b,tab");
    await before.advance(1);
    await close(before);
    core.remove("t2");
    const again = await first(core, folder);
    await again.advance(10);
    expect(again.loop.model().focus.panes["t-main"]).toBe("t1");
    expect(again.loop.model().notices.map((notice) => notice.code)).toEqual(["view_moved"]);
    expect(again.grid()[39]).toContain("view_moved: the place this core was left at is gone");
  }, TEST_MS);
});
