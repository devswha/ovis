import { afterEach, describe, expect, it } from "bun:test";
import type { CoreChange } from "../../server/herdr-core/core-model.ts";
import { PANE_NAME_LABEL, SPACE_LABEL, TAB_LABEL, TAB_NAME_LABEL, WORKSPACE_NAME_LABEL } from "../../server/herdr-core/snapshot.ts";
import { CoreWorld, jumpOrder } from "../core/world.ts";
import { focused } from "../model/focus.ts";
import { initialState, type ModelEvent, type ModelState, reduce } from "../model/reduce.ts";
import { agents } from "../testing/fixtures/agents.ts";
import { Run } from "../testing/run.ts";
import { agentLines } from "./agents.ts";

const TEST_MS = 120_000;

/** One terminal of workspace `space`, its pane named `name`, its agent reporting `state` (none: no agent). */
const term = (address: string, name: string, state: string | null, extra: Record<string, unknown> = {}, space = "w") => ({
  address, state: "live", cols: 80, rows: 24, cwd: "/home/u/proj", turn: 0, reason: null,
  labels: { [SPACE_LABEL]: space, [WORKSPACE_NAME_LABEL]: space === "w" ? "work" : "docs", [TAB_LABEL]: `${space}-tab`, [TAB_NAME_LABEL]: "tab", [PANE_NAME_LABEL]: name },
  ...(state === null ? {} : { status: { state, app: "claude" }, reported: true }),
  ...extra,
});

function worldOf(terminals: unknown[]): CoreWorld {
  const world = new CoreWorld();
  world.notice({ type: "snapshot", epoch: 1, cause: "connect", seq: 1, terminals });
  world.view();
  return world;
}

/** The core model's record that `terminal` now shows `shown`, as the link hands it on. */
function told(world: CoreWorld, terminal: string, shown: "blocked" | "done" | "working" | "idle", seq: number): void {
  const change: CoreChange = { type: "status", terminal, status: { state: shown, app: "claude" }, shown, agent: "claude" };
  world.notice({ type: "event", epoch: 1, seq, event: { type: "status", terminal }, changes: [change] });
  world.view();
}

const after = (state: ModelState, ...events: ModelEvent[]): ModelState => events.reduce((current, event) => reduce(current, event).state, state);
const shownPane = (state: ModelState) => focused(state.world, state.focus).pane?.id ?? null;

const runs: Run[] = [];
afterEach(async () => {
  for (const run of runs.splice(0)) await run.close();
});

describe("the agent list", () => {
  it("jump order", () => {
    // all four from the first snapshot: blocked t1, done t2; then t3 turns blocked, later t4 done
    const world = worldOf([term("t1", "one", "blocked"), term("t2", "two", "done"), term("t3", "three", "working"), term("t4", "four", "idle"), term("t5", "shell", null)]);
    told(world, "t3", "blocked", 2);
    told(world, "t4", "done", 3);
    const view = world.view();
    // blocked rows first, then done rows, each the longest in that state first
    expect(view.world.waiting).toEqual(["t1", "t3", "t2", "t4"]);
    expect(jumpOrder([{ paneId: "a", status: "done" }, { paneId: "b", status: "blocked" }, { paneId: "c", status: "done" }, { paneId: "d", status: "working" }], new Map([["a", 5], ["c", 2]])))
      .toEqual(["b", "c", "a"]);
    // the jump key goes from the shown pane's place to the next, round; from a pane that needs nothing, to the first
    const start = after(initialState(undefined), { type: "world", world: view.world, at: 0 });
    const jump: ModelEvent = { type: "action", action: "open_notification_target", at: 1 };
    const fromShell = after(start, { type: "select", target: { kind: "pane", id: "t5" }, at: 1 });
    const visits: (string | null)[] = [];
    let state = fromShell;
    for (let press = 0; press < 5; press++) {
      state = after(state, jump);
      visits.push(shownPane(state));
    }
    expect(visits).toEqual(["t1", "t3", "t2", "t4", "t1"]);
    // nothing needs the user: a calm notice says so, and focus stays
    const calm = worldOf([term("t1", "one", "idle"), term("t2", "two", "working")]).view();
    const quiet = after(initialState(undefined), { type: "world", world: calm.world, at: 0 }, jump);
    expect([shownPane(quiet), quiet.notices.map((notice) => [notice.code, notice.calm])]).toEqual(["t1", [["nothing_waiting", true]]]);
  });

  it("sections in the browser's order, an agent and its helpers together, rows numbered in that order", () => {
    // t2 is a helper t1 started: blocked, it brings its agent up into Needs you; t4 is in another workspace
    const view = worldOf([
      term("t1", "lead", "idle"),
      term("t2", "helper", "blocked", { parent: "t1" }),
      term("t3", "build", "working"),
      term("t4", "notes", "done", { turn: 2 }, "v"),
      term("t5", "shell", null),
    ]).view();
    expect(agentLines(view.agents)).toEqual([
      { kind: "section", group: "blocked", count: 2 },
      { kind: "agent", id: "t1", number: 1, helper: false, status: "idle", text: "lead /proj claude", workspace: "work" },
      { kind: "agent", id: "t2", number: 2, helper: true, status: "blocked", text: "helper /proj claude", workspace: "work" },
      { kind: "section", group: "working", count: 1 },
      { kind: "agent", id: "t3", number: 3, helper: false, status: "working", text: "build /proj claude", workspace: "work" },
      { kind: "section", group: "done", count: 1 },
      { kind: "agent", id: "t4", number: 4, helper: false, status: "done", text: "notes /proj claude", workspace: "docs" },
    ]);
    expect(view.world.agents).toEqual(["t1", "t2", "t3", "t4"]);
  });

  it("number keys, the agent keys and the list's own keys focus by the list's order", () => {
    const view = worldOf([term("t1", "one", "working"), term("t2", "two", "blocked"), term("t3", "three", "done", {}, "v"), term("t5", "shell", null)]).view();
    expect(view.world.agents).toEqual(["t2", "t1", "t3"]);
    const start = after(initialState(undefined), { type: "world", world: view.world, at: 0 }, { type: "select", target: { kind: "pane", id: "t5" }, at: 0 });
    const text = (typed: string): ModelEvent => ({ type: "text", text: typed, at: 1 });
    const open: ModelEvent = { type: "action", action: "agents", at: 1 };
    // the list's digit 3 goes to the third row, in another workspace, and closes the list
    const third = after(start, open, text("3"));
    expect([shownPane(third), third.overlays]).toEqual(["t3", []]);
    // a digit past the last row does nothing and keeps the list open
    expect(after(start, open, text("9")).overlays.map((overlay) => overlay.kind)).toEqual(["agents"]);
    // Enter on the row the arrows moved to
    const down: ModelEvent = { type: "key", key: "ARROW_DOWN", mods: {}, action: "press", at: 1 };
    const enter: ModelEvent = { type: "key", key: "ENTER", mods: {}, action: "press", at: 1 };
    expect(shownPane(after(start, open, down, enter))).toBe("t1");
    // a click on a row chooses it as Enter on it would
    expect(shownPane(after(start, open, { type: "choose", entry: 2, at: 1 }))).toBe("t3");
    // herdr's focus_agent N, next_agent and previous_agent go by the same order; from a pane with no agent, the first or the last
    expect(shownPane(after(start, { type: "action", action: "focus_agent", index: 2, at: 1 }))).toBe("t1");
    expect(shownPane(after(start, { type: "action", action: "next_agent", at: 1 }))).toBe("t2");
    expect(shownPane(after(start, { type: "action", action: "previous_agent", at: 1 }))).toBe("t3");
    const onFirst = after(start, { type: "action", action: "next_agent", at: 1 });
    expect(shownPane(after(onFirst, { type: "action", action: "previous_agent", at: 1 }))).toBe("t3");
    expect(shownPane(after(onFirst, { type: "action", action: "next_agent", at: 1 }))).toBe("t1");
    // u marks the row under the cursor unread and keeps the list open
    const marked = reduce(after(start, open, down), text("u"));
    expect([marked.effects, marked.state.overlays.map((overlay) => overlay.kind)]).toEqual([[{ type: "unread", pane: "t1" }], ["agents"]]);
  });

  it("the full-screen list, drawn: sections, numbered rows, the workspace at the right, the cursor's row marked", async () => {
    const run = await Run.start({ fixture: agents, cols: 120, rows: 40 });
    runs.push(run);
    await run.live();
    await run.advance(1);
    await run.keys("ctrl+b,a,down");
    await run.advance(20);
    const pad = (text: string, width: number) => text + " ".repeat(width - [...text].length);
    expect(run.grid().slice(0, 11)).toEqual([
      `+ Agents ${"-".repeat(92)} [close: esc / q] +`,
      `| ${pad("1-9 or Enter: go to · u: mark unread", 117)}|`,
      `| ${pad("Needs you (1)", 117)}|`,
      `|  1   ! ${pad("blocked / claude", 104)}agents|`,
      `| ${pad("Working (1)", 117)}|`,
      `|> 2   ~ ${pad("working / claude", 104)}agents|`,
      `| ${pad("Done (1)", 117)}|`,
      `|  3   * ${pad("done / claude", 104)}agents|`,
      `| ${pad("Ready (1)", 117)}|`,
      `|  4   - ${pad("idle / claude", 104)}agents|`,
      `|${" ".repeat(118)}|`,
    ]);
    expect(run.loop.report().mode.overlays).toEqual(["agents"]);
    // the hit map: a click on the third row goes to that agent
    await run.keys("press@20:7");
    await run.advance(20);
    expect([run.loop.report().mode.overlays, shownPane(run.loop.model())]).toEqual([[], "t3"]);
  }, TEST_MS);
});
