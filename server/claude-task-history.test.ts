import { afterEach, expect, it, spyOn } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync, openSync, closeSync, writeSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandHistory, historyVersion, resetCommandHistory, waitCommandHistory, watchCommandHistory } from "./claude-command-history.ts";
import { claudeTaskHistory } from "./claude-task-history.ts";
import { foldClaudeTasks, type ClaudeTaskSnapshot } from "./claude-task-state.ts";
import { plain } from "./claude-subagents.ts";
import { transcriptReader, type TranscriptFile } from "./transcript-reader.ts";
const roots: string[] = [];
afterEach(async () => { resetCommandHistory(); await transcriptReader.settled(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("preserves supplied-exact, supplied-changed and default-needed terminal selection", async () => {
  const root = mkdtempSync(join(tmpdir(), "ovis-task-history-")); roots.push(root);
  const path = join(root, "parent.jsonl");
  const at = Date.now();
  writeFileSync(path, `${JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: new Date(at + 10).toISOString(), content: "<task-notification><task-id>A</task-id><status>completed</status><summary>Background command finished</summary><tool-use-id>call-A</tool-use-id></task-notification>" })}\n`);
  const version = (await historyVersion(path))!;
  expect(version).toEqual(plain(path)!); // exact bigint identity and fractional clock conversion agree
  const history = (await waitCommandHistory(path, version.size))!;
  const snapshot: ClaudeTaskSnapshot = { agents: [], sources: [{ generation: 1, launches: [["A", { at, call: "call-A", seq: 1, title: "A" }], ["B", { at, call: "call-B", seq: 2, title: "B" }]], ends: [["A", [{ at: at + 20, status: "completed", call: "call-A", seq: 3 }]]], halt: null }], parent: { version, limit: version.size, windowed: true }, live: true, since: null, now: at + 100, settled: true, behind: false, watch: [], promptAt: null, resting: false };
  const ended = (state: ReturnType<typeof foldClaudeTasks>) => state.tasks.find((task) => task.id === "A")!.ended_at;
  expect(ended(foldClaudeTasks(snapshot, await claudeTaskHistory(path, snapshot, { history })))).toBe(new Date(at + 10).toISOString());
  expect(ended(foldClaudeTasks(snapshot, await claudeTaskHistory(path, snapshot)))).toBe(new Date(at + 20).toISOString());
  appendFileSync(path, "{}\n"); snapshot.parent!.version = (await historyVersion(path))!;
  expect(ended(foldClaudeTasks(snapshot, await claudeTaskHistory(path, snapshot, { history })))).toBe(new Date(at + 20).toISOString());
  snapshot.sources[0]!.launches.pop();
  expect(ended(foldClaudeTasks(snapshot, await claudeTaskHistory(path, snapshot, { history })))).toBe(new Date(at + 20).toISOString());
  // Merely asking for another ID must not turn a locally ended A into an unresolved request.
  expect((await commandHistory(path, version.size, false, new Set(["B"])))!.ends).toEqual([]);
});


it.each(["rewrite and growth", "truncation", "same-size rewrite"])("never trusts captured matching snapshot/proof after %s", async (kind) => {
  const root = mkdtempSync(join(tmpdir(), "ovis-task-proof-generation-")); roots.push(root); const path = join(root, "parent.jsonl");
  const at = Date.now(), line = (id: string) => `${JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: new Date(at + 10).toISOString(), content: `<task-notification><task-id>${id}</task-id><tool-use-id>call</tool-use-id><status>completed</status><summary>Background command finished</summary></task-notification>` })}\n`;
  writeFileSync(path, line("A") + "{}\n");
  const version = (await historyVersion(path))!, history = (await waitCommandHistory(path, version.size))!;
  const snapshot: ClaudeTaskSnapshot = { agents: [], sources: [{ generation: 1, launches: [["A", { at, call: "call", seq: 1, title: "A" }]], ends: [], halt: null }], parent: { version, limit: version.size, windowed: true }, live: true, since: null, now: at + 100, settled: true, behind: false, watch: [], promptAt: null, resting: false };
  if (kind === "truncation") writeFileSync(path, line("A")); // terminal itself survives, but the supplied generation was truncated
  else {
    const fd = openSync(path, "r+");
    try { const changed = Buffer.from(kind === "same-size rewrite" ? "[]\n" : line("B")); writeSync(fd, changed, 0, changed.length, kind === "same-size rewrite" ? Buffer.byteLength(line("A")) : 0); }
    finally { closeSync(fd); }
    if (kind === "rewrite and growth") appendFileSync(path, "{}\n");
  }
  utimesSync(path, new Date(), new Date(version.mtimeMs + 2000));
  const proof = await claudeTaskHistory(path, snapshot, { history });
  expect(foldClaudeTasks(snapshot, proof).tasks).toMatchObject([{ id: "A", status: "running", ended_at: null }]);
});


it("vouches a valid partial terminal in a separate proof budget after prefix time is consumed", async () => {
  const root = mkdtempSync(join(tmpdir(), "ovis-task-prefix-budget-")); roots.push(root); const path = join(root, "parent.jsonl");
  const at = Date.now(), terminal = `${JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: new Date(at + 10).toISOString(), content: "<task-notification><task-id>A</task-id><tool-use-id>call</tool-use-id><status>completed</status><summary>Background command finished</summary></task-notification>" })}\n`;
  writeFileSync(path, terminal + `${JSON.stringify({ type: "progress", value: "x".repeat(1024) })}\n`.repeat(3000));
  const version = (await historyVersion(path))!;
  const snapshot: ClaudeTaskSnapshot = { agents: [], sources: [{ generation: 1, launches: [["A", { at, call: "call", seq: 1, title: "A" }]], ends: [], halt: null }], parent: { version, limit: version.size, windowed: true }, live: true, since: null, now: at + 100, settled: true, behind: false, watch: [], promptAt: null, resting: false };
  let unblock!: () => void, reached!: () => void;
  const gate = new Promise<void>((resolve) => { unblock = resolve; });
  const entered = new Promise<void>((resolve) => { reached = resolve; });
  const run = transcriptReader.read;
  const spy = spyOn(transcriptReader, "read").mockImplementation(<T>(target: string, work: (file: TranscriptFile) => Promise<T>, options?: { signal?: AbortSignal; deadline?: number }) => run(target, (file) => work(target === path ? { ...file, read: async (position, length) => { if (position > 0) { reached(); await gate; } return file.read(position, length); } } : file), options));
  try {
    // Establish the partial prefix and held second window before starting the caller's budget;
    // this tests timeout semantics without assuming native I/O finishes within thirty ms.
    await commandHistory(path, version.size);
    const stop = watchCommandHistory(path, () => {});
    expect(stop).not.toBeNull();
    await entered;
    const candidate = (await waitCommandHistory(path, version.size, 30))!;
    stop!();
    expect(candidate).toMatchObject({ unverified: true, complete: false, ends: [{ id: "A" }] });
    expect(Object.isFrozen(candidate)).toBe(true); expect(Object.isFrozen(candidate.ends)).toBe(true);
    expect(foldClaudeTasks(snapshot, candidate).running).toBe(1);
    unblock();
    const proof = await claudeTaskHistory(path, snapshot, { history: candidate, deadline: Date.now() + 1000 });
    expect(proof?.unverified).not.toBe(true);
    expect(foldClaudeTasks(snapshot, proof).tasks).toMatchObject([{ id: "A", status: "completed", ended_at: new Date(at + 10).toISOString() }]);
  } finally { unblock(); spy.mockRestore(); }
});
