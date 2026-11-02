import { expect, it } from "bun:test";
import { foldClaudeTasks, type ClaudeTaskSnapshot } from "./claude-task-state.ts";

const now = Date.parse("2026-11-01T12:00:00Z");
const snapshot = (): ClaudeTaskSnapshot => ({ agents: [], sources: [{ generation: 1, launches: [], ends: [], halt: null }], parent: { version: { id: "1:2", size: 100, mtimeMs: 1 }, limit: 100, windowed: true }, live: true, since: null, now, settled: true, behind: false, watch: [], promptAt: null, resting: true });
const launch = (at = now - 2000, call = "call") => ({ at, title: "synthetic command", call, seq: 1 });

it("preserves source precedence and reserves agent IDs even outside the visible recent list", () => {
  const s = snapshot();
  s.agents.push({ task: { id: "reserved", title: "old agent", category: null, model: null, status: "completed", started_at: new Date(now - 2 * 86400_000).toISOString(), ended_at: new Date(now - 2 * 86400_000).toISOString(), turns: 0, tool_calls: 0, tokens: null, detail_kind: "claude-subagent" }, dispatched: 0 });
  s.sources[0]!.launches = [["reserved", launch()], ["same", launch(now - 1000, "first")]];
  s.sources.push({ generation: 2, launches: [["same", launch(now - 3000, "second")]], ends: [["same", [{ at: now - 2000, status: "completed", call: "second" }]]], halt: null });
  const state = foldClaudeTasks(s);
  expect(state.tasks).toMatchObject([{ id: "same", status: "running", started_at: new Date(now - 1000).toISOString() }]);
  expect(state.shells).toHaveLength(1);
  expect(state.remembered.map((task) => task.id)).toEqual(["reserved", "same"]);
});

it("retains untrimmed shell outcomes and counts before the recent display cap", () => {
  const s = snapshot();
  for (let id = 0; id < 15; id++) {
    s.sources[0]!.launches.push([`${id}`, launch()]);
    s.sources[0]!.ends.push([`${id}`, [{ at: now - id, status: "completed", call: "call" }]]);
  }
  const state = foldClaudeTasks(s);
  expect(state.tasks).toHaveLength(10); expect(state.shells).toHaveLength(15); expect(state.remembered).toHaveLength(15);
  expect(state.running).toBe(0); expect(state.historyNeeded).toBe(false);
});

it("overlays only the same launch while pending and recomputes turn counts from the fresh prompt", () => {
  const s = snapshot(); s.sources[0]!.launches.push(["same", launch()]);
  const old = foldClaudeTasks(s, { version: s.parent!.version, through: 100, complete: true, ends: [{ id: "same", at: now - 1000, status: "completed", call: "call", from: 0, to: 1, digest: 1n }] });
  const pending = new Map(old.shells.map((shell) => [shell.key, shell]));
  s.promptAt = now;
  expect(foldClaudeTasks(s, null, pending)).toMatchObject({ running: 0, turnRunning: 0, promptAt: now, resting: true });
  s.sources[0]!.launches = [["same", launch(now - 500, "new-call")]];
  expect(foldClaudeTasks(s, null, pending)).toMatchObject({ running: 1, turnRunning: 0 });
  s.promptAt = now - 1000;
  expect(foldClaudeTasks(s, null, pending).turnRunning).toBe(1);
  s.sources[0]!.ends.push(["same", [{ at: now - 100, status: "failed", call: "new-call" }]]);
  expect(foldClaudeTasks(s, null, pending).tasks).toMatchObject([{ id: "same", status: "failed" }]);
});

it("preserves call, timestamp, same-source sequence and explicit halt authority", () => {
  const s = snapshot(); const at = now - 1000;
  s.sources[0]!.launches = [["same", launch(at, "call")], ["halted", launch(at, "other")]];
  s.sources[0]!.ends = [["same", [{ at, status: "completed", call: null, seq: 2 }]]];
  s.sources[0]!.halt = at;
  expect(foldClaudeTasks(s).tasks.map((task) => [task.id, task.status])).toEqual([["same", "completed"], ["halted", "cancelled"]]);
  s.sources[0]!.halt = null; s.sources[0]!.ends = [];
  s.sources.push({ generation: 2, launches: [], halt: null, ends: [["same", [{ at, status: "completed", call: null, seq: 2 }, { at: at + 1, status: "failed", call: "different" }]]] });
  expect(foldClaudeTasks(s).running).toBe(2);
});


it("never lets an unverified exact-version candidate close a shell, including after structured clone", () => {
  const s = snapshot(); s.sources[0]!.launches = [["same", launch()]];
  const candidate = { unverified: true as const, version: s.parent!.version, through: 100, complete: false as const, ends: [{ id: "same", at: now - 1000, status: "completed" as const, call: "call", from: 0, to: 1, digest: 1n }] };
  for (const history of [candidate, structuredClone(candidate)]) expect(foldClaudeTasks(s, history).tasks).toMatchObject([{ id: "same", status: "running", ended_at: null }]);
});


it("reclassifies a pending old launch when its process start becomes known", () => {
  const s = snapshot(); s.sources[0]!.launches = [["same", launch(now - 120_000)]];
  const old = foldClaudeTasks(s); expect(old.running).toBe(1);
  const pending = new Map(old.shells.map((shell) => [shell.key, shell]));
  s.since = now;
  expect(foldClaudeTasks(s, null, pending)).toMatchObject({ running: 0, tasks: [{ id: "same", status: "lost" }] });
  s.since = null; s.live = false;
  expect(foldClaudeTasks(s, null, pending)).toMatchObject({ running: 0, tasks: [{ id: "same", status: "lost" }] });
});


it("invalidates pending historical terminals on parent replacement, shrink and same-size rewrite", () => {
  const s = snapshot(); s.sources[0]!.launches = [["same", launch()]];
  const old = foldClaudeTasks(s, { version: s.parent!.version, through: 100, complete: true, ends: [{ id: "same", at: now - 1000, status: "completed", call: "call", from: 0, to: 1, digest: 1n }] });
  const pending = new Map(old.shells.map((shell) => [shell.key, shell]));
  for (const [version, windowed] of [[{ id: "new", size: 3, mtimeMs: 2 }, false], [{ id: "new", size: 200, mtimeMs: 2 }, true], [{ id: "1:2", size: 50, mtimeMs: 2 }, true], [{ id: "1:2", size: 100, mtimeMs: 2 }, true]] as const) {
    s.parent = { version, limit: version.size, windowed };
    expect(foldClaudeTasks(s, null, pending)).toMatchObject({ running: 1, tasks: [{ id: "same", status: "running" }] });
  }
  s.parent = { version: { id: "1:2", size: 101, mtimeMs: 2 }, limit: 101, windowed: true };
  expect(foldClaudeTasks(s, null, pending)).toMatchObject({ running: 1, historyPending: true });
  s.parent = { version: { id: "1:2", size: 100, mtimeMs: 1 }, limit: 100, windowed: true };
  expect(foldClaudeTasks(s, null, pending)).toMatchObject({ running: 0, historyPending: true });
});

it("does not preserve a local terminal as historical authority after its source stops telling it", () => {
  const s = snapshot(); s.sources[0]!.launches = [["same", launch()]];
  s.sources[0]!.ends = [["same", [{ at: now - 1000, status: "completed", call: "call", seq: 2 }]]];
  const old = foldClaudeTasks(s); const pending = new Map(old.shells.map((shell) => [shell.key, shell]));
  s.sources[0]!.ends = [];
  expect(foldClaudeTasks(s, null, pending)).toMatchObject({ running: 1, tasks: [{ id: "same", status: "running" }] });
});
