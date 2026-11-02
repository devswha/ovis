import { afterEach, expect, it } from "bun:test";
import { appendFileSync, closeSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandHistory, commandHistorySize, resetCommandHistory, setCommandHistoryWorker, waitCommandHistory, watchCommandHistory } from "./claude-command-history.ts";
import { historyChunk } from "./claude-command-history-worker.ts";
import { fileTask } from "./file-pool.ts";

const roots: string[] = [];
const release: (() => void)[] = [];
afterEach(async () => {
  for (const done of release.splice(0)) done();
  resetCommandHistory();
  await until(() => commandHistorySize().threads === 0);
  setCommandHistoryWorker();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function until(test: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!test()) { if (Date.now() > deadline) throw new Error("history condition not reached"); await Bun.sleep(5); }
}
function fixture(name = "parent") {
  const root = mkdtempSync(join(tmpdir(), "ovis-command-history-"));
  roots.push(root);
  const path = join(root, name);
  writeFileSync(path, "");
  return { path, root, limit: () => statSync(path).size };
}
const json = (entry: unknown): string => `${JSON.stringify(entry)}\n`;
const notice = (id: string, status = "completed"): string => json({ type: "queue-operation", operation: "enqueue", timestamp: "2026-10-01T12:00:00.000Z", content: `<task-notification><task-id>${id}</task-id><status>${status}</status><summary>Background command finished</summary></task-notification>` });
const filler = json({ type: "progress", value: "x".repeat(1024) }).repeat(1024);

it("reuses complete all-ID coverage for newly discovered IDs and scans only appends", async () => {
  const s = fixture();
  writeFileSync(s.path, notice("first") + notice("discovered_later", "failed") + filler);
  const first = await waitCommandHistory(s.path, s.limit());
  expect(first).toMatchObject({ complete: true, through: s.limit() });
  expect(first!.ends.map((end) => end.id)).toEqual(["first", "discovered_later"]);
  const again = commandHistory(s.path, s.limit());
  expect(again).toEqual(first);
  expect(commandHistorySize().active).toBe(false);
  appendFileSync(s.path, notice("next"));
  const next = await waitCommandHistory(s.path, s.limit());
  expect(next!.ends.map((end) => end.id)).toEqual(["first", "discovered_later", "next"]);
});

it("invalidates completion authority on replacement, truncation and same-size rewrites", async () => {
  const s = fixture();
  writeFileSync(s.path, notice("old"));
  expect((await waitCommandHistory(s.path, s.limit()))!.ends).toHaveLength(1);
  const replacement = join(s.root, "replacement");
  writeFileSync(replacement, notice("new"));
  renameSync(replacement, s.path);
  expect((await waitCommandHistory(s.path, s.limit()))!.ends.map((end) => end.id)).toEqual(["new"]);
  writeFileSync(s.path, notice("alt"));
  expect((await waitCommandHistory(s.path, s.limit()))!.ends.map((end) => end.id)).toEqual(["alt"]);
  writeFileSync(s.path, "{}\n");
  expect((await waitCommandHistory(s.path, s.limit()))!.ends).toEqual([]);
});

it("shares accepted notice and successful TaskStop semantics without accepting quoted output", async () => {
  const s = fixture();
  const timestamp = "2026-10-01T12:00:00.000Z";
  writeFileSync(s.path, notice("accepted")
    + json({ type: "queue-operation", operation: "remove", timestamp, content: JSON.parse(notice("removed")).content })
    + json({ type: "user", timestamp, message: { content: [{ type: "tool_result", content: JSON.parse(notice("quoted")).content }] } })
    + json({ type: "user", timestamp, message: { content: [{ type: "tool_result" }] }, toolUseResult: { task_type: "shell", task_id: "stopped" } })
    + json({ type: "user", timestamp, message: { content: [{ type: "tool_result", is_error: true }] }, toolUseResult: { task_type: "shell", task_id: "failed_stop" } }));
  expect((await waitCommandHistory(s.path, s.limit()))!.ends.map((end) => [end.id, end.status])).toEqual([["accepted", "completed"], ["stopped", "cancelled"]]);
});

it("retains uncertainty across oversized and malformed records", async () => {
  const s = fixture();
  writeFileSync(s.path, "x".repeat(2 * 1024 * 1024) + "\nnot json\n" + notice("accepted"));
  const evidence = await waitCommandHistory(s.path, s.limit());
  expect(evidence).toMatchObject({ complete: false, through: s.limit() });
  expect(evidence!.ends.map((end) => end.id)).toEqual(["accepted"]);
});

it("resumes a partial record after append, including beyond the original requested boundary", async () => {
  const s = fixture();
  const record = notice("finished");
  writeFileSync(s.path, record.slice(0, -4));
  const boundary = s.limit();
  const partial = await waitCommandHistory(s.path, boundary, 20);
  expect(partial).toMatchObject({ complete: false, through: 0, ends: [] });
  expect(commandHistorySize().active).toBe(false);
  appendFileSync(s.path, record.slice(-4));
  const completed = await waitCommandHistory(s.path, boundary);
  expect(completed).toMatchObject({ complete: true, through: s.limit() });
  expect(completed!.ends.map((end) => end.id)).toEqual(["finished"]);
});

it("preserves a replacement cursor and its listeners until a terminated held worker really closes", async () => {
  if (process.platform === "win32") return;
  const s = fixture();
  writeFileSync(s.path, notice("replacement"));
  const fifo = join(s.root, "fifo");
  const ready = join(s.root, "ready");
  const nextReady = join(s.root, "next-ready");
  expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
  writeFileSync(`${s.path}.hold`, JSON.stringify({ fifo, ready }));
  let opened = -1;
  let unblocked = false;
  const unblock = () => {
    if (unblocked || !existsSync(ready)) return;
    unblocked = true;
    opened = Number(readFileSync(ready, "utf8"));
    writeFileSync(fifo, "x");
  };
  release.push(unblock);
  setCommandHistoryWorker(new URL("./claude-command-history-worker.fake.ts", import.meta.url));
  commandHistory(s.path, s.limit());
  await until(() => existsSync(ready));
  resetCommandHistory();
  // A second physical thread would enter this independent gate before the first one closes.
  writeFileSync(`${s.path}.hold`, JSON.stringify({ fifo, ready: nextReady }));
  const replacement = waitCommandHistory(s.path, s.limit());
  expect((await fileTask({ op: "info", path: s.path }))).toMatchObject({ kind: "text" });
  expect(existsSync(nextReady)).toBe(false);
  expect(commandHistorySize()).toMatchObject({ threads: 1, waiting: 1, sessions: 1 });
  rmSync(`${s.path}.hold`);
  unblock();
  expect(await replacement).toMatchObject({ complete: true, through: s.limit() });
  expect(commandHistorySize().sessions).toBe(1);
  if (opened >= 0) { try { closeSync(opened); } catch {} }
});

it("bounds each worker checkpoint and detects changed prefix witnesses", () => {
  const s = fixture();
  writeFileSync(s.path, filler.repeat(3));
  const stat = statSync(s.path);
  const task = { path: s.path, version: { id: `${stat.dev}:${stat.ino}`, size: stat.size, mtimeMs: stat.mtimeMs }, offset: 0, limit: s.limit(), skipping: false, witness: null };
  const first = historyChunk(task);
  expect(first.offset).toBeGreaterThan(0);
  expect(first.offset).toBeLessThanOrEqual(1024 * 1024);
  writeFileSync(s.path, notice("changed") + filler.repeat(4));
  expect(() => historyChunk({ ...task, offset: first.offset, witness: first.witness })).toThrow("rewritten");
});

it("keeps a blocked physical slot through deadlines, invalidation and restart while file work proceeds", async () => {
  if (process.platform === "win32") return; // FIFO gates exercise a Unix filesystem syscall.
  const s = fixture();
  writeFileSync(s.path, notice("old"));
  const fifo = join(s.root, "fifo");
  const ready = join(s.root, "ready");
  expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
  writeFileSync(`${s.path}.hold`, JSON.stringify({ fifo, ready }));
  let opened = -1;
  const unblock = () => {
    if (existsSync(ready)) {
      writeFileSync(fifo, "x");
      opened = Number(readFileSync(ready, "utf8"));
    }
  };
  release.push(unblock);
  setCommandHistoryWorker(new URL("./claude-command-history-worker.fake.ts", import.meta.url));
  const pending = waitCommandHistory(s.path, s.limit(), 20);
  await until(() => existsSync(ready));
  expect((await pending)!.through).toBe(0);
  expect(await fileTask({ op: "info", path: s.path })).toMatchObject({ kind: "text" });
  const other = fixture();
  writeFileSync(other.path, notice("queued"));
  commandHistory(other.path, other.limit());
  const statusOwner = watchCommandHistory(other.path, () => {});
  const abort = new AbortController();
  const cancelled = waitCommandHistory(other.path, other.limit(), 10_000, abort.signal);
  abort.abort();
  await cancelled;
  expect(commandHistorySize().waiting).toBe(1);
  statusOwner();
  expect(commandHistorySize().waiting).toBe(0);
  for (let reset = 0; reset < 3; reset++) {
    resetCommandHistory();
    commandHistory(s.path, s.limit());
    await Bun.sleep(5);
    expect(commandHistorySize().threads).toBe(1);
  }
  rmSync(`${s.path}.hold`);
  unblock();
  release.length = 0;
  await until(() => !existsSync(ready) || commandHistorySize().active === false);
  // Terminated Bun workers cannot run finally after the held syscall: close its test descriptor.
  if (opened >= 0) { try { closeSync(opened); } catch {} }
});

it("bounds the queue, coalesces sessions and lets a small session finish before a large one", async () => {
  const large = fixture();
  writeFileSync(large.path, filler.repeat(20));
  commandHistory(large.path, large.limit());
  const order: string[] = [];
  const unwatch = watchCommandHistory(large.path, () => { if (commandHistory(large.path, large.limit())?.through === large.limit()) order.push("large"); });
  release.push(unwatch);
  const small = fixture();
  writeFileSync(small.path, notice("small"));
  expect((await waitCommandHistory(small.path, small.limit()))!.complete).toBe(true);
  expect(order).toEqual([]);
  for (let index = 0; index < 30; index++) { const s = fixture(); writeFileSync(s.path, filler); commandHistory(s.path, s.limit()); }
  expect(commandHistorySize().sessions).toBeLessThanOrEqual(16);
  expect(commandHistorySize().waiting).toBeLessThanOrEqual(16);
});
