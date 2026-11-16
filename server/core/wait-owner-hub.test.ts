import { afterEach, describe, expect, it, setSystemTime, spyOn } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HerdrPane } from "../../shared/protocol.ts";
import * as agyStore from "../agy-store.ts";
import * as conversation from "../conversation.ts";
import * as gjcStatus from "../gjc-status.ts";
import * as lettaStore from "../letta-store.ts";
import * as omoRuntime from "../omo.ts";
import type { OmoPane } from "../omo-status.ts";
import * as processStart from "../process-start.ts";
import * as served from "../runtime/capabilities.ts";
import { HERDR_CORE } from "../runtime/capabilities.ts";
import { at, claude, handlers, hub, line, opencode, root, workingClaude } from "./status.fake.ts";

// One pane, and the agents that follow each other in it. Each holds the pane's background wait in its turn
// (the rule at the top of server/core/status.ts): GJC on its transcript's jobs, native OmO on its session's
// tasks, with no time limit, Claude Code on its subagents. Letta holds none.
const PANE = claude.pane_id;
const ts = (ms: number) => new Date(at + ms).toISOString();
const prompt = (ms: number) => line({ type: "message", timestamp: ts(ms), message: { role: "user" } });
const answer = (ms: number) => line({ type: "message", timestamp: ts(ms), message: { role: "assistant", stopReason: "stop" } });
const started = (ms: number) => line({ type: "message", timestamp: ts(ms), message: { role: "toolResult", toolName: "task", toolCallId: "t",
  content: [{ type: "text", text: "Started 1 background task job using executor.\n- `0-Cleanup` (job `0-Cleanup`)" }],
  details: { async: { state: "running", jobId: "0-Cleanup", type: "task" } } } });
const WAITING = { status: "done", tasks: 1, bg: true };

let stages = 0;
const spies: { mockRestore(): void }[] = [];
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); setSystemTime(); });

/**
 * The hub with each agent's own lookup of the pane stood in: what GJC's and OmO's discovery find there is the
 * test's to say (`unread`: OmO's lookup of the pane's processes failed), and Letta's finds no local messages.
 */
function stage(h: ReturnType<typeof hub> = hub()) {
  const id = ++stages;
  const proj = join(root, `wait-owner-${id}`);
  mkdirSync(join(proj, ".omo", "senpi-task", "tasks"), { recursive: true });
  const found: { gjc: OmoPane | null; omo: OmoPane | "unread" | null } = { gjc: null, omo: null };
  spies.push(
    spyOn(gjcStatus, "gjcPanes").mockImplementation(async () => new Map(found.gjc ? [[PANE, found.gjc]] : [])),
    spyOn(omoRuntime, "omoPanes").mockImplementation(async () => new Map(found.omo === null ? [] : [[PANE, found.omo === "unread" ? null : found.omo]])),
    spyOn(lettaStore, "resolveLettaTranscript").mockResolvedValue(null),
  );
  /** the pane as herdr names it from now on */
  const named = (agent: string | null, status = "idle"): HerdrPane => {
    const pane: HerdrPane = { ...claude, agent, agent_status: status, agent_session: null, cwd: proj, focused: false, revision: 0, terminal_id: "wait-owner" };
    h.herdrSays(pane);
    return pane;
  };
  const session = `abcdef12-3456-4789-8abc-${String(id).padStart(12, "0")}`;
  const omoFile = join(root, `2026-11-15T00-00-00_${session}.jsonl`);
  return { h, found, named,
    /** GJC found in the pane, its turn at rest: on a background job it started (BG), or on nothing */
    async gjc(resting: "on a job" | "on nothing") {
      const path = join(root, `wait-owner-gjc-${id}.jsonl`);
      writeFileSync(path, prompt(0));
      found.gjc = { path, startedAt: null };
      await h.status.gjc.refresh([named("gjc", "working")]);
      appendFileSync(path, resting === "on a job" ? started(100) + answer(200) : answer(200));
      await h.status.gjc.poll();
      expect(h.last()).toEqual(resting === "on a job" ? WAITING : { status: "done", tasks: 0, bg: false });
    },
    /** native OmO found in the pane: its turn at rest on a task it started (BG, with no time limit), or at rest on nothing */
    async omo(resting: "on a task" | "on nothing", startedAt: number | null = null) {
      writeFileSync(omoFile, resting === "on a task" ? prompt(1000) : prompt(1000) + answer(2000));
      found.omo = { path: omoFile, startedAt };
      await h.status.omo.refresh([named("pi")]);
      if (resting === "on nothing") return;
      writeFileSync(join(proj, ".omo", "senpi-task", "tasks", "st_1.json"), JSON.stringify({ status: "running", parent_session_id: session }));
      appendFileSync(omoFile, answer(2000));
      await h.status.omo.poll();
      expect(h.last()).toEqual(WAITING);
    },
    /** OmO's next discovery reads the pane, which herdr names `agent` now, and finds no OmO there */
    async omoLeaves(agent: string | null, status = "idle") {
      found.omo = null;
      const pane = named(agent, status);
      await h.status.omo.refresh([pane]);
      return pane;
    },
    /** the server serves herdr-core, where a Letta pane reports nothing and Letta's own tracker reads it */
    core() { spies.push(spyOn(served, "capabilities").mockReturnValue(HERDR_CORE)); },
    /** Claude's lookup of the pane's session finds nothing */
    claudeUnknown() { spyOn(conversation, "claudePaneSession").mockResolvedValue(null); },
    /** the wait in the pane's last frame and in a snapshot read now */
    async waiting() { return { frame: h.last().bg, snapshot: (await h.status.clientSnapshot()).panes[0]?.background_wait === true }; },
  };
}

/** a Claude pane whose turn came to rest while its background subagent runs: BG */
async function claudeWaits() {
  const h = await workingClaude();
  h.rest();
  h.poll();
  expect(h.last()).toEqual(WAITING);
  return stage(h);
}

/** an OpenCode pane whose turn came to rest while its subagent runs: BG */
async function opencodeWaits() {
  const h = hub();
  h.herdrSays(opencode("ses_parent"));
  handlers.onBaseline([opencode("ses_parent")]);
  await h.snapshot();
  handlers.onStatus(PANE, "working", "opencode");
  handlers.onStatus(PANE, "idle", "opencode");
  expect(h.last()).toEqual(WAITING);
  return h;
}

/**
 * A pane at rest on its agent's background work (BG), and `replaced`: another session or process of that same
 * agent is found there, as its tracker's next lookup tells.
 */
const sameAgent = {
  async claude() {
    const h = await workingClaude();
    h.rest();
    h.poll();
    const other = join(root, `wait-owner-claude-${++stages}.jsonl`);
    writeFileSync(other, "");
    return { h, replaced: async () => {
      spyOn(conversation, "claudePaneSession").mockResolvedValue({ path: other, startedAt: null, pid: null } as never);
      h.herdrSays({ ...h.pane, agent_session: { ...h.pane.agent_session, value: "44444444-4444-4444-8444-444444444444" } });
      await h.snapshot();
    } };
  },
  async opencode() {
    const h = await opencodeWaits();
    return { h, replaced: async () => {
      h.herdrSays(opencode("ses_other"));
      await h.snapshot();
      await h.settle();
    } };
  },
  async agy() {
    const id = ++stages;
    const step = (type: string, status: string, offset: number, content: string) => line({ step_index: offset, source: type === "USER_INPUT" ? "USER_EXPLICIT" : "MODEL", type, status, created_at: ts(offset), content });
    const path = join(root, `wait-owner-agy-${id}.jsonl`);
    writeFileSync(path, step("USER_INPUT", "DONE", 0, "deploy it") + step("GENERIC", "RUNNING", 10, "Tool is running as a background task with task id: s1/task-2\nTask Description: gh run watch 1"));
    const other = join(root, `wait-owner-agy-${id}-next.jsonl`);
    writeFileSync(other, step("USER_INPUT", "DONE", 0, "hello"));
    const h = hub();
    const store = spyOn(agyStore, "resolveAgyStore").mockResolvedValue({ root, session: "s1", path, pid: 1, started: "x" });
    spies.push(store, spyOn(processStart, "processStartUpperBoundAsync").mockResolvedValue(null));
    const agy = { ...claude, agent: "agy", agent_session: null } as unknown as HerdrPane;
    h.herdrSays(agy);
    handlers.onBaseline([agy]);
    await h.snapshot();
    await h.status.taskAgents.refresh([agy]);
    handlers.onStatus(PANE, "working", "agy");
    handlers.onStatus(PANE, "idle", "agy");
    return { h, replaced: async () => {
      store.mockResolvedValue({ root, session: "s2", path: other, pid: 2, started: "y" });
      // past the time a session that was found stands before it is looked up again
      setSystemTime(Date.now() + 31_000);
      await h.status.taskAgents.refresh([agy]);
    } };
  },
};

describe("a pane's background wait when the pane passes from GJC to another agent", () => {
  it.each([
    { to: "claude", pane: { ...claude, agent_session: null } },
    { to: "opencode", pane: opencode(null) },
  ])("ends when herdr names $to there before GJC's discovery looks again, though $to's session is not found", async ({ to, pane }) => {
    // Given a GJC pane at rest on a job.
    const s = stage();
    await s.gjc("on a job");
    s.claudeUnknown();
    // When gjc exits and the other agent starts there: herdr's event names it first, and its own lookup finds no session.
    s.found.gjc = null;
    s.h.herdrSays(pane);
    handlers.onStatus(PANE, "idle", to);
    await s.h.settle();
    // Then nothing of GJC's holds the pane.
    expect(await s.waiting()).toEqual({ frame: false, snapshot: false });
    // And the turn that agent runs there finishes as its own: DONE, alerted as a finish.
    handlers.onStatus(PANE, "working", to);
    handlers.onStatus(PANE, "idle", to);
    await s.h.settle();
    expect(s.h.last()).toMatchObject({ status: "done", bg: false });
    expect(s.h.alerts.at(-1)).toBe("done");
  });

  it("ends, and is told, when OmO's discovery finds native OmO there", async () => {
    // Given a GJC pane at rest on a job.
    const s = stage();
    await s.gjc("on a job");
    const told = s.h.alerts.length;
    // When gjc is gone and OmO's own discovery finds native OmO in the pane, at rest.
    s.found.gjc = null;
    await s.omo("on nothing");
    // Then the pane no longer waits, and the finish GJC's job held back is alerted.
    expect(await s.waiting()).toEqual({ frame: false, snapshot: false });
    expect(s.h.alerts.slice(told)).toEqual(["done"]);
  });

  it("holds nothing of OmO's once gjc is back in a pane OmO took from it, with no word of herdr's in between", async () => {
    // Given GJC tracked in the pane, at rest on nothing.
    const s = stage();
    await s.gjc("on nothing");
    // And native OmO takes the pane, its turn ending on a task (a wait with no time limit), which only snapshots tell.
    await s.omo("on a task");
    await s.h.status.clientSnapshot();
    expect(s.h.status.gjc.runs(PANE)).toBe(false);
    // When OmO exits and gjc returns, with a transcript that cannot be read.
    s.found.omo = null;
    s.found.gjc = { path: null, startedAt: null };
    s.named("gjc");
    await s.h.status.clientSnapshot();
    expect(s.h.status.gjc.runs(PANE)).toBe(true);
    // Then nothing holds the pane.
    expect(await s.waiting()).toEqual({ frame: false, snapshot: false });
  });
});

describe("a pane's background wait when Letta's own discovery finds Letta in the pane", () => {
  it.each(["gjc", "claude"] as const)("ends the wait %s held there", async (from) => {
    // Given a pane at rest on its agent's background work.
    const s = from === "claude" ? await claudeWaits() : stage();
    if (from === "gjc") await s.gjc("on a job");
    // When that agent is gone and Letta's tracker finds Letta there, before any other lookup or word of herdr's.
    s.core();
    s.found.gjc = null;
    await s.h.status.letta.refresh([s.named("letta", "unknown")]);
    // Then the pane no longer waits.
    expect(await s.waiting()).toEqual({ frame: false, snapshot: false });
  });
});

describe("a pane's background wait when native OmO leaves the pane", () => {
  it.each(["gjc", "letta", "claude", "no agent"] as const)("ends once OmO's discovery finds no OmO there, and %s follows", async (next) => {
    // Given an OmO pane at rest on a task.
    const s = stage();
    await s.omo("on a task");
    s.claudeUnknown();
    if (next === "letta") s.core();
    // When OmO exits and its next discovery reads the pane.
    const pane = await s.omoLeaves(next === "no agent" ? null : next, next === "letta" ? "unknown" : "idle");
    // Then OmO's wait is over, and the finish it held back is alerted.
    expect(s.h.last().bg).toBe(false);
    expect(s.h.alerts.at(-1)).toBe("done");
    // And what follows in the pane holds nothing of OmO's.
    if (next === "gjc") {
      s.found.gjc = { path: null, startedAt: null };
      await s.h.status.gjc.refresh([pane]);
    } else if (next === "letta") await s.h.status.letta.refresh([pane]);
    else if (next === "claude") {
      for (const status of ["idle", "working", "idle"] as const) handlers.onStatus(PANE, status, "claude");
      expect(s.h.last()).toMatchObject({ status: "done", bg: false });
      expect(s.h.alerts.at(-1)).toBe("done");
    }
    expect(await s.waiting()).toEqual({ frame: false, snapshot: false });
  });

  it("stands while a lookup of the pane's processes fails, which says nothing of OmO there", async () => {
    // Given an OmO pane at rest on a task.
    const s = stage();
    await s.omo("on a task");
    const told = s.h.alerts.length;
    const pane = s.named("pi");
    // When OmO's next discovery cannot read the pane's processes.
    s.found.omo = "unread";
    setSystemTime(Date.now() + 6_000);
    await s.h.status.omo.refresh([pane]);
    // Then the pane is still OmO's, waiting as before, and nothing is alerted.
    expect(s.h.status.omo.runs(PANE)).toBe(true);
    expect(await s.waiting()).toEqual({ frame: true, snapshot: true });
    expect(s.h.alerts).toHaveLength(told);
  });

  it("stands when another OmO process is found holding the session, whose tasks still run", async () => {
    // Given an OmO pane at rest on a task, its process's start known.
    const s = stage();
    await s.omo("on a task", at);
    const told = s.h.alerts.length;
    const pane = s.named("pi");
    // When discovery finds an OmO process there that started later (OmO restarted and resumed the session).
    s.found.omo = { ...(s.found.omo as OmoPane), startedAt: at + 500 };
    setSystemTime(Date.now() + 6_000);
    await s.h.status.omo.refresh([pane]);
    // Then the wait is still the session's: its task runs, and no finish is alerted.
    expect(await s.waiting()).toEqual({ frame: true, snapshot: true });
    expect(s.h.alerts.slice(told)).not.toContain("done");
  });
});

describe("a pane's background wait when the pane passes from Claude to another agent", () => {
  it("ends, and is told, when OmO's discovery finds native OmO there", async () => {
    // Given a Claude pane at rest on its background subagent.
    const s = await claudeWaits();
    const told = s.h.alerts.length;
    // When OmO's own discovery finds native OmO in the pane, at rest.
    await s.omo("on nothing");
    // Then the pane no longer waits, and the finish Claude's subagent held back is alerted.
    expect(await s.waiting()).toEqual({ frame: false, snapshot: false });
    expect(s.h.alerts.slice(told)).toEqual(["done"]);
  });

  it.each([
    { next: "no agent", agent: null, status: "unknown" },
    { next: "codex at work", agent: "codex", status: "working" },
  ] as const)("ends in the one frame herdr's word of $next there sends, with no finish alerted for Claude", async ({ agent, status }) => {
    // Given a Claude pane at rest on its background subagent.
    const s = await claudeWaits();
    const told = s.h.alerts.length;
    // When Claude exits, and herdr's event says what the pane runs now.
    s.named(agent, status);
    handlers.onStatus(PANE, status, agent);
    // Then nothing holds the pane, and that status is all that is alerted.
    expect(await s.waiting()).toEqual({ frame: false, snapshot: false });
    expect(s.h.alerts.slice(told)).toHaveLength(1);
    expect(s.h.alerts.slice(told)).not.toContain("done");
  });
});

describe("a pane's background wait when its agent ends and only a snapshot tells", () => {
  it("ends at once when OpenCode is gone from the pane, not once its work's grace is over", async () => {
    // Given an OpenCode pane at rest on its subagent.
    const h = await opencodeWaits();
    // When OpenCode exits with no status event: the next snapshot names no agent there.
    h.herdrSays({ ...claude, agent: null, agent_status: "unknown", agent_session: null });
    const after = (await h.status.clientSnapshot()).panes[0];
    await h.settle();
    // Then nothing holds the pane, and the finish that work held back is alerted.
    expect(after?.background_wait).toBeUndefined();
    expect(h.last().bg).toBe(false);
    expect(h.alerts.at(-1)).toBe("done");
  });
});

describe("a pane's background wait when another session or process of its agent is found in the pane", () => {
  it.each(["claude", "opencode", "agy"] as const)("ends the wait the %s session before it held", async (agent) => {
    // Given a pane at rest on its agent's background work.
    const { h, replaced } = await sameAgent[agent]();
    expect(h.last()).toEqual(WAITING);
    // When the agent's tracker finds another session or process of it there, with no work of its own.
    await replaced();
    // Then nothing holds the pane.
    expect(h.last().bg).toBe(false);
    expect((await h.status.clientSnapshot()).panes[0]?.background_wait).toBeUndefined();
  });
});
