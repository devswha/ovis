import { describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HerdrPane, OmoTask } from "../shared/protocol.ts";
import * as claudeSubagents from "./claude-subagents.ts";
import { ompSubagents, OmpSubagentStatus, type OmpSession } from "./omp-subagents.ts";
import { MIN, ompSession, records as r, stamp } from "./omp-subagents.fixture.ts";

const states = (tasks: readonly OmoTask[]) => Object.fromEntries(tasks.map((task) => [task.id, task.status]));
const ids = (tasks: readonly OmoTask[]) => tasks.map((task) => task.id);

describe("ompSubagents", () => {
  it("tells each subagent's state from the last record of its own transcript", () => {
    const s = ompSession();
    const now = Date.now();
    const begun = now - 30 * MIN;
    s.agent("Prompted", begun, [r.prompt(begun)]);
    s.agent("Calling", begun, [r.prompt(begun), r.calls(begun + MIN)]);
    s.agent("Answering", begun, [r.prompt(begun), r.calls(begun + MIN), r.mark(begun + MIN), r.result(begun + 2 * MIN)]);
    s.agent("Done", begun, [r.prompt(begun), r.answered(begun + 5 * MIN), r.exit(begun + 12 * MIN)]);
    s.agent("Failed", begun, [r.prompt(begun), r.failed(begun + 3 * MIN)]);
    s.agent("Stopped", begun, [r.prompt(begun), r.calls(begun + MIN), r.interrupted(begun + 4 * MIN)]);
    s.agent("Killed", begun, [r.prompt(begun), r.calls(begun + MIN), r.exit(begun + 6 * MIN, "sighup"), r.killed(begun + 6 * MIN + 100)]);
    s.agent("Quit", begun, [r.prompt(begun), r.calls(begun + MIN), r.exit(begun + 6 * MIN, "sighup")]);
    const { tasks, running } = ompSubagents(s.path, now);
    expect(states(tasks)).toEqual({ Prompted: "running", Calling: "running", Answering: "running", Done: "completed", Failed: "failed", Stopped: "cancelled", Killed: "lost", Quit: "lost" });
    expect(running).toBe(3);
  });

  it("describes a subagent by its name, agent type, model, times and last request, and keeps its work to itself", () => {
    const s = ompSession();
    const now = Date.now();
    const begun = now - 20 * MIN;
    s.agent("Review", begun, [r.prompt(begun), r.calls(begun + MIN, 1200), r.result(begun + 2 * MIN), r.answered(begun + 9 * MIN, 48_000)], { type: "code-reviewer", model: "anthropic/claude-opus-5-5" });
    expect(ompSubagents(s.path, now).tasks).toEqual([{
      id: "Review", title: "Review", category: "code-reviewer", model: "claude-opus-5-5", status: "completed",
      started_at: stamp(begun), ended_at: stamp(begun + 9 * MIN),
      turns: null, tool_calls: null, tokens: 48_000, detail_kind: null,
    }]);
  });

  it("takes an agent that finished as at work again once a message wakes it, whatever its .md says", () => {
    const s = ompSession();
    const now = Date.now();
    const begun = now - 20 * MIN;
    s.agent("Idle", begun, [r.prompt(begun), r.answered(begun + 5 * MIN)]);
    writeFileSync(join(s.dir, "Idle.md"), "Done.");
    expect(states(ompSubagents(s.path, now).tasks)).toEqual({ Idle: "completed" });
    s.append("Idle", r.woken(begun + 9 * MIN));
    expect(states(ompSubagents(s.path, now).tasks)).toEqual({ Idle: "running" });
    s.append("Idle", r.calls(begun + 10 * MIN), r.result(begun + 11 * MIN), r.answered(begun + 12 * MIN), r.exit(begun + 19 * MIN));
    expect(ompSubagents(s.path, now).tasks).toMatchObject([{ id: "Idle", status: "completed", ended_at: stamp(begun + 12 * MIN) }]);
  });

  it("takes what wakes or steers an agent for a turn going on, and the context omp adds after its last answer for none", () => {
    const s = ompSession();
    const now = Date.now();
    const begun = now - 30 * MIN;
    s.agent("Steered", begun, [r.prompt(begun), r.answered(begun + MIN), r.steer(begun + 2 * MIN)]);
    s.agent("Retrying", begun, [r.prompt(begun), r.failed(begun + MIN), r.woken(begun + 2 * MIN, "thinking-loop-redirect")]);
    s.agent("Resumed", begun, [r.prompt(begun), r.answered(begun + MIN), r.woken(begun + 2 * MIN, "async-result")]);
    // an answer that filled the context is followed by a compaction and the state omp re-adds: the agent still ended with its answer
    s.agent("Compacted", begun, [r.prompt(begun), r.answered(begun + MIN), r.compaction(begun + MIN + 20), r.summary(begun + MIN + 30), r.context(begun + MIN + 40), r.exit(begun + 8 * MIN)]);
    s.agent("Reminded", begun, [r.prompt(begun), r.failed(begun + MIN), r.context(begun + 2 * MIN)]);
    const { tasks, running } = ompSubagents(s.path, now);
    expect(states(tasks)).toEqual({ Steered: "running", Retrying: "running", Resumed: "running", Compacted: "completed", Reminded: "failed" });
    expect(running).toBe(3);
    expect(tasks.find((task) => task.id === "Compacted")?.ended_at).toBe(stamp(begun + MIN));
  });

  it("takes an agent still at work for a gone process's when it was made before the omp that now runs the pane started", () => {
    const s = ompSession();
    const now = Date.now();
    const begun = now - 30 * MIN;
    s.agent("Old", begun, [r.prompt(begun), r.calls(begun + MIN)]);
    s.agent("Fine", begun, [r.prompt(begun), r.answered(begun + 2 * MIN)]);
    expect(states(ompSubagents(s.path, now, null).tasks)).toEqual({ Old: "running", Fine: "completed" });
    expect(states(ompSubagents(s.path, now, begun - 5 * MIN).tasks)).toEqual({ Old: "running", Fine: "completed" });
    // the process's start is known to the second: an agent made a moment before it is not told from its own
    expect(states(ompSubagents(s.path, now, begun + 30_000).tasks)).toEqual({ Old: "running", Fine: "completed" });
    const later = ompSubagents(s.path, now, begun + 10 * MIN);
    expect(states(later.tasks)).toEqual({ Old: "lost", Fine: "completed" });
    expect(later.running).toBe(0);
    // a lost agent ended when it was last heard of
    expect(later.tasks.find((task) => task.id === "Old")?.ended_at).toBe(stamp(begun + MIN));
  });

  it("lists only the transcripts of the session's own subagents", () => {
    const s = ompSession();
    const now = Date.now();
    const begun = now - 5 * MIN;
    s.agent("Mine", begun, [r.prompt(begun)]);
    writeFileSync(join(s.dir, "Mine.md"), "an answer");
    writeFileSync(join(s.dir, ".Mine.jsonl.lock.os"), "");
    writeFileSync(join(s.dir, "changes.jsonl"), `${JSON.stringify({ type: "change", at: begun, agent: "Main", tool: "write", path: "/w/x.ts" })}\n`);
    writeFileSync(join(s.dir, "Broken.jsonl"), "not json\n");
    writeFileSync(join(s.dir, "Empty.jsonl"), "");
    writeFileSync(join(s.dir, "Toplevel.jsonl"), `${JSON.stringify({ type: "session", version: 3, id: "x", timestamp: stamp(begun), cwd: "/w" })}\n`);
    writeFileSync(join(s.dir, "Dotted.Name.jsonl"), s.transcript(begun, [r.prompt(begun)]));
    mkdirSync(join(s.dir, "Mine"));
    writeFileSync(join(s.dir, "Mine", "Mine.Child.jsonl"), s.transcript(begun, [r.prompt(begun)]));
    mkdirSync(join(s.dir, "Folder.jsonl"));
    expect(ids(ompSubagents(s.path, now).tasks)).toEqual(["Mine"]);
    expect(ompSubagents(join(s.root, "absent.jsonl"), now)).toEqual({ tasks: [], running: 0 });
    expect(ompSubagents(s.dir, now)).toEqual({ tasks: [], running: 0 });
  });

  it.skipIf(process.platform === "win32")("follows no link: a transcript or a folder that is one lists nothing", () => {
    const s = ompSession();
    const now = Date.now();
    const begun = now - 5 * MIN;
    mkdirSync(join(s.root, "elsewhere"));
    writeFileSync(join(s.root, "elsewhere", "Out.jsonl"), s.transcript(begun, [r.prompt(begun)]));
    symlinkSync(join(s.root, "elsewhere", "Out.jsonl"), join(s.dir, "Linked.jsonl"));
    s.agent("Plain", begun, [r.prompt(begun)]);
    expect(ids(ompSubagents(s.path, now).tasks)).toEqual(["Plain"]);
    symlinkSync(s.dir, join(s.root, "linked"));
    expect(ompSubagents(join(s.root, "linked.jsonl"), now)).toEqual({ tasks: [], running: 0 });
  });

  it("lists the ones at work first, the longest running first, then the newest that ended in the last day, at most ten", () => {
    const s = ompSession();
    const now = Date.now();
    s.agent("Later", now - 10 * MIN, [r.prompt(now - 10 * MIN)]);
    s.agent("Earlier", now - 20 * MIN, [r.prompt(now - 20 * MIN)]);
    for (let n = 0; n < 12; n++) s.agent(`End${String(n).padStart(2, "0")}`, now - 300 * MIN, [r.prompt(now - 300 * MIN), r.answered(now - (200 - n) * MIN)]);
    s.agent("Ancient", now - 30 * 60 * MIN, [r.prompt(now - 30 * 60 * MIN), r.answered(now - 29 * 60 * MIN)]);
    const stale = s.agent("Stale", now - 10 * MIN, [r.prompt(now - 10 * MIN)]);
    const old = new Date(now - 48 * 60 * MIN);
    utimesSync(stale, old, old);
    const { tasks, running } = ompSubagents(s.path, now);
    expect(ids(tasks)).toEqual(["Earlier", "Later", ...Array.from({ length: 10 }, (_, k) => `End${String(11 - k).padStart(2, "0")}`)]);
    expect(running).toBe(2);
  });

  it("reads a file again only when its size or time changed", () => {
    const s = ompSession();
    const now = Date.now();
    const begun = now - 5 * MIN;
    s.agent("A", begun, [r.prompt(begun), r.calls(begun + MIN)]);
    s.agent("B", begun, [r.prompt(begun), r.answered(begun + MIN)]);
    const read = spyOn(claudeSubagents, "readLines");
    try {
      expect(states(ompSubagents(s.path, now).tasks)).toEqual({ A: "running", B: "completed" });
      // the head and the end of each
      expect(read).toHaveBeenCalledTimes(4);
      ompSubagents(s.path, now);
      expect(read).toHaveBeenCalledTimes(4);
      s.append("A", r.answered(begun + 2 * MIN));
      expect(states(ompSubagents(s.path, now).tasks)).toEqual({ A: "completed", B: "completed" });
      // the end of A alone
      expect(read).toHaveBeenCalledTimes(5);
    } finally {
      read.mockRestore();
    }
  });

  it("reads past a last record bigger than the end it first looks at, and takes the tokens of the request before it", () => {
    const s = ompSession();
    const now = Date.now();
    const begun = now - 5 * MIN;
    s.agent("Big", begun, [r.prompt(begun), r.calls(begun + MIN, 7777), r.result(begun + 2 * MIN, "x".repeat(300_000))]);
    expect(ompSubagents(s.path, now).tasks).toMatchObject([{ id: "Big", status: "running", tokens: 7777 }]);
  });

  it("lists an agent whose head outgrows what is read of it, its agent type unknown", () => {
    const s = ompSession();
    const now = Date.now();
    const begun = now - 5 * MIN;
    s.agent("Wide", begun, [r.prompt(begun)], { prompt: "x".repeat(300_000) });
    expect(ompSubagents(s.path, now).tasks).toMatchObject([{ id: "Wide", category: null, model: "claude-sonnet-5-5", status: "running", started_at: stamp(begun) }]);
  });

  it("takes a transcript that is just begun for one at work, and one with no header yet for none", () => {
    const s = ompSession();
    const now = Date.now();
    const begun = now - MIN;
    writeFileSync(join(s.dir, "Fresh.jsonl"), s.transcript(begun, []));
    writeFileSync(join(s.dir, "Starting.jsonl"), `${JSON.stringify({ type: "title", v: 1, title: "", pad: "  " })}\n{"type":"ses`);
    expect(states(ompSubagents(s.path, now).tasks)).toEqual({ Fresh: "running" });
  });
});

describe("OmpSubagentStatus", () => {
  const pane = (pane_id: string, agent = "omp", session = "s1"): HerdrPane => ({ pane_id, agent, cwd: "/w", agent_session: { kind: "path", value: session } } as unknown as HerdrPane);

  it("counts an omp pane's running subagents, tells each change, and the end of the count of a pane that left", async () => {
    const s = ompSession();
    const now = Date.now();
    const begun = now - 10 * MIN;
    s.agent("A", begun, [r.prompt(begun), r.calls(begun + MIN)]);
    s.agent("B", begun + MIN, [r.prompt(begun + MIN)]);
    s.agent("C", begun, [r.prompt(begun), r.answered(begun + MIN)]);
    const told: [string, number][] = [];
    const status = new OmpSubagentStatus({ resolve: async () => ({ path: s.path, startedAt: null }), onChange: (id, running) => told.push([id, running]) });
    await status.refresh([pane("p1")]);
    expect(status.countOf("p1")).toBe(2);
    expect(told).toEqual([["p1", 2]]);
    expect(status.tasksOf("p1").map((task) => [task.id, task.status])).toEqual([["A", "running"], ["B", "running"], ["C", "completed"]]);
    await status.refresh([pane("p1")]);
    expect(told).toEqual([["p1", 2]]);
    s.append("A", r.answered(begun + 2 * MIN));
    status.poll();
    expect(status.countOf("p1")).toBe(1);
    expect(told.at(-1)).toEqual(["p1", 1]);
    await status.refresh([pane("p1", "shell")]);
    expect(told.at(-1)).toEqual(["p1", 0]);
    expect(status.sessionOf("p1")).toBeNull();
    expect(status.countOf("p1")).toBe(0);
    expect(status.tasksOf("p1")).toEqual([]);
  });

  it("tells nothing of a pane it forgets", async () => {
    const s = ompSession();
    const begun = Date.now() - MIN;
    s.agent("A", begun, [r.prompt(begun)]);
    const told: [string, number][] = [];
    const status = new OmpSubagentStatus({ resolve: async () => ({ path: s.path, startedAt: null }), onChange: (id, running) => told.push([id, running]) });
    await status.refresh([pane("p1")]);
    expect(told).toEqual([["p1", 1]]);
    status.forget("p1");
    expect(status.countOf("p1")).toBe(0);
    expect(status.sessionOf("p1")).toBeNull();
    expect(told).toEqual([["p1", 1]]);
  });

  it("gives the process start it found to the reading, which loses what the process before it left at work", async () => {
    const s = ompSession();
    const now = Date.now();
    const begun = now - 30 * MIN;
    s.agent("Old", begun, [r.prompt(begun)]);
    let started: number | null = null;
    const status = new OmpSubagentStatus({ resolve: async () => ({ path: s.path, startedAt: started }), onChange: () => {}, relocateMs: 0 });
    await status.refresh([pane("p1")]);
    expect(status.countOf("p1")).toBe(1);
    started = now - MIN;
    await status.refresh([pane("p1")]);
    expect(status.countOf("p1")).toBe(0);
    expect(status.tasksOf("p1")).toMatchObject([{ id: "Old", status: "lost" }]);
  });

  it("looks the session up again as time passes, and keeps the one it found when a look fails for a moment", async () => {
    const s = ompSession();
    const now = Date.now();
    s.agent("A", now - 10 * MIN, [r.prompt(now - 10 * MIN)]);
    let clock = now;
    let answer: OmpSession | null = { path: s.path, startedAt: null };
    const asked: string[] = [];
    const status = new OmpSubagentStatus({
      resolve: async (found) => { asked.push(String(found.agent_session?.value)); return answer; },
      onChange: () => {},
      now: () => clock,
    });
    await status.refresh([pane("p1", "omp", "a")]);
    expect(asked).toEqual(["a"]);
    clock += 29_000;
    await status.refresh([pane("p1", "omp", "a")]);
    expect(asked).toEqual(["a"]);
    clock += 2_000;
    answer = null;
    await status.refresh([pane("p1", "omp", "a")]);
    expect(asked).toEqual(["a", "a"]);
    expect(status.sessionOf("p1")).toEqual({ path: s.path, startedAt: null });
    expect(status.countOf("p1")).toBe(1);
    // another session in the pane: asked at once, and nothing of the old one is kept
    await status.refresh([pane("p1", "omp", "b")]);
    expect(asked).toEqual(["a", "a", "b"]);
    expect(status.sessionOf("p1")).toBeNull();
    expect(status.countOf("p1")).toBe(0);
    // with none known, asked again each 15 seconds
    clock += 14_000;
    await status.refresh([pane("p1", "omp", "b")]);
    expect(asked).toHaveLength(3);
    clock += 2_000;
    await status.refresh([pane("p1", "omp", "b")]);
    expect(asked).toHaveLength(4);
  });

  it("drops a lookup that ends after its pane left", async () => {
    const { promise, resolve } = Promise.withResolvers<OmpSession | null>();
    const status = new OmpSubagentStatus({ resolve: () => promise, onChange: () => {} });
    const looking = status.refresh([pane("p1")]);
    await status.refresh([pane("p1", "shell")]);
    resolve({ path: "/nowhere.jsonl", startedAt: null });
    await looking;
    expect(status.sessionOf("p1")).toBeNull();
  });

  it("asks again for a pane's new session at once, shares a lookup under way between asks for one session, and keeps what the old one finds for nothing", async () => {
    const asks: { session: string; answer: (found: OmpSession | null) => void }[] = [];
    const status = new OmpSubagentStatus({
      resolve: (found) => {
        const { promise, resolve } = Promise.withResolvers<OmpSession | null>();
        asks.push({ session: String(found.agent_session?.value), answer: resolve });
        return promise;
      },
      onChange: () => {},
    });
    const first = status.refresh([pane("p1", "omp", "a")]);
    const again = status.ensure(pane("p1", "omp", "a"));
    expect(asks.map((ask) => ask.session)).toEqual(["a"]);
    // the pane runs another session while the lookup is under way: not given its answer, but asked for
    const second = status.refresh([pane("p1", "omp", "b")]);
    expect(asks.map((ask) => ask.session)).toEqual(["a", "b"]);
    asks[1]!.answer({ path: "/b.jsonl", startedAt: null });
    await second;
    asks[0]!.answer({ path: "/a.jsonl", startedAt: null });
    await Promise.all([first, again]);
    expect(status.sessionOf("p1")).toEqual({ path: "/b.jsonl", startedAt: null });
  });

  it("drops a lookup a request asked for that ends after its pane was forgotten, and keeps one for a pane the snapshot has not seen yet", async () => {
    const s = ompSession();
    const begun = Date.now() - MIN;
    s.agent("A", begun, [r.prompt(begun)]);
    const told: [string, number][] = [];
    const { promise, resolve } = Promise.withResolvers<OmpSession | null>();
    const status = new OmpSubagentStatus({ resolve: () => promise, onChange: (id, running) => told.push([id, running]) });
    await status.refresh([]);
    const asking = status.ensure(pane("p1"), true);
    status.forget("p1");
    resolve({ path: s.path, startedAt: null });
    await asking;
    status.poll();
    expect(status.sessionOf("p1")).toBeNull();
    expect(status.countOf("p1")).toBe(0);
    expect(told).toEqual([]);
    await status.ensure(pane("p2"), true);
    expect(status.sessionOf("p2")).toEqual({ path: s.path, startedAt: null });
  });

  it("asks nothing for a pane that is not omp, and lists none for one whose session it cannot find", async () => {
    let asked = 0;
    const status = new OmpSubagentStatus({ resolve: async () => { asked++; throw new Error("herdr is busy"); }, onChange: () => {} });
    await status.ensure(pane("p1", "claude"), true);
    expect(asked).toBe(0);
    await status.ensure(pane("p1"), true);
    expect(asked).toBe(1);
    expect(status.sessionOf("p1")).toBeNull();
    expect(status.tasksOf("p1")).toEqual([]);
    expect(status.countOf("p1")).toBe(0);
  });
});
