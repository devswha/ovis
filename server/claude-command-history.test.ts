import { afterEach, expect, it, spyOn } from "bun:test";
import { appendFileSync, chmodSync, closeSync, mkdtempSync, openSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandHistory, commandHistorySize, holdCommandHistory, historyVersion, resetCommandHistory, waitCommandHistory, watchCommandHistory } from "./claude-command-history.ts";

import { transcriptReader, type TranscriptFile } from "./transcript-reader.ts";

const roots: string[] = [];
const release: (() => void)[] = [];
afterEach(async () => {
  for (const done of release.splice(0)) done();
  resetCommandHistory();
  await transcriptReader.settled();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
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
/** Resolves on the first change of `path`'s history for which `test` holds. */
function heard(path: string, test: () => boolean | Promise<boolean>): Promise<void> {
  return new Promise((resolve) => {
    const stop = watchCommandHistory(path, () => { void Promise.resolve(test()).then((yes) => { if (yes) { stop!(); resolve(); } }); });
    expect(stop).not.toBeNull();
    release.push(stop!);
  });
}

it("reuses complete all-ID coverage for newly discovered IDs and scans only appends", async () => {
  const s = fixture();
  writeFileSync(s.path, notice("first") + notice("discovered_later", "failed") + filler);
  const first = await waitCommandHistory(s.path, s.limit());
  expect(first).toMatchObject({ complete: true, through: s.limit() });
  expect(first!.ends.map((end) => end.id)).toEqual(["first", "discovered_later"]);
  const again = await commandHistory(s.path, s.limit());
  expect(first).toEqual(again);
  expect(commandHistorySize().waiting).toBe(0);
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

it("forgets every end once any byte it read is rewritten, though the transcript only grew", async () => {
  const s = fixture();
  // the rewritten notice sits mid-file, far from the first and last bytes read
  const head = filler.repeat(2);
  writeFileSync(s.path, head + notice("same") + filler.repeat(2));
  expect((await waitCommandHistory(s.path, s.limit()))!.ends.map((end) => end.id)).toEqual(["same"]);
  const fd = openSync(s.path, "r+");
  writeSync(fd, Buffer.from(notice("else")), 0, Buffer.byteLength(notice("else")), Buffer.byteLength(head));
  closeSync(fd);
  appendFileSync(s.path, notice("next"));
  const after = await waitCommandHistory(s.path, s.limit());
  expect(after).toMatchObject({ complete: true, through: s.limit() });
  expect(after!.ends.map((end) => end.id)).toEqual(["else", "next"]);
});

it("tells no end it read before a rewrite that also grew the transcript until those bytes are checked again", async () => {
  const s = fixture();
  const head = filler.repeat(2);
  writeFileSync(s.path, head + notice("same") + filler);
  const limit = s.limit();
  expect((await waitCommandHistory(s.path, limit))!.ends.map((end) => end.id)).toEqual(["same"]);
  const fd = openSync(s.path, "r+");
  writeSync(fd, Buffer.from(notice("else")), 0, Buffer.byteLength(notice("else")), Buffer.byteLength(head));
  closeSync(fd);
  appendFileSync(s.path, notice("next"));
  // asked before any check of the grown transcript: what it read is unknown, not ended
  expect(await commandHistory(s.path, limit)).toMatchObject({ complete: false, ends: [] });
  const checked = await waitCommandHistory(s.path, limit);
  expect(checked).toMatchObject({ complete: true });
  expect(checked!.ends.map((end) => end.id)).toEqual(["else", "next"]);
});

it.each([["the newline after it", 0], ["the newline before it (joining it to the record before)", -1]])("tells no end of a line once %s is rewritten", async (_, shift) => {
  const s = fixture();
  const head = json({ type: "progress" });
  writeFileSync(s.path, head + notice("same") + filler);
  const limit = s.limit();
  await waitCommandHistory(s.path, limit);
  const fd = openSync(s.path, "r+");
  const at = shift === 0 ? Buffer.byteLength(head + notice("same")) - 1 : Buffer.byteLength(head) - 1;
  writeSync(fd, Buffer.from(" "), 0, 1, at);
  closeSync(fd);
  appendFileSync(s.path, "\n");
  expect(await commandHistory(s.path, limit, false)).toMatchObject({ complete: false, ends: [] });
});

it("tells an end at once while the transcript grows, when its line begins exactly where a read chunk began", async () => {
  const s = fixture();
  const pad = json({ type: "progress", value: "" });
  // the first record fills the first 1 MiB chunk exactly: the notice begins the next one
  const first = json({ type: "progress", value: "x".repeat(1024 * 1024 - Buffer.byteLength(pad)) });
  expect(Buffer.byteLength(first)).toBe(1024 * 1024);
  writeFileSync(s.path, first + notice("same") + filler);
  const limit = s.limit();
  await waitCommandHistory(s.path, limit);
  appendFileSync(s.path, notice("next"));
  expect(await commandHistory(s.path, limit, false)).toMatchObject({ complete: true, ends: [{ id: "same" }] });
});

it("tells the ends it read at once while the transcript only grows, before any check of it", async () => {
  const s = fixture();
  writeFileSync(s.path, notice("same") + filler);
  const limit = s.limit();
  await waitCommandHistory(s.path, limit);
  appendFileSync(s.path, notice("next"));
  expect(await commandHistory(s.path, limit, false)).toMatchObject({ complete: true, ends: [{ id: "same" }] });
  // only the ids asked for
  expect((await commandHistory(s.path, limit, false, new Set(["other"])))!.ends).toEqual([]);
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

it("takes no end from a row of another session", async () => {
  const s = fixture("this-session.jsonl");
  const foreign = { ...JSON.parse(notice("foreign")), sessionId: "other-session" };
  const own = { ...JSON.parse(notice("own")), sessionId: "this-session" };
  writeFileSync(s.path, json(foreign) + json(own) + notice("unnamed"));
  expect((await waitCommandHistory(s.path, s.limit()))!.ends.map((end) => end.id)).toEqual(["own", "unnamed"]);
});

it("reads through oversized and malformed records, which prove nothing", async () => {
  const s = fixture();
  writeFileSync(s.path, "x".repeat(2 * 1024 * 1024) + "\nnot json\n" + notice("accepted"));
  const evidence = await waitCommandHistory(s.path, s.limit());
  expect(evidence).toMatchObject({ complete: true, through: s.limit() });
  expect(evidence!.ends.map((end) => end.id)).toEqual(["accepted"]);
});

it("answers a request at once while a record waits to be written whole, and reads it once it is", async () => {
  const s = fixture();
  const record = notice("finished");
  writeFileSync(s.path, record.slice(0, -4));
  const boundary = s.limit();
  // the test's own timeout fails it if the request waits for its deadline
  const partial = await waitCommandHistory(s.path, boundary, 60_000);
  expect(partial).toMatchObject({ complete: false, through: 0, ends: [] });
  expect(commandHistorySize().waiting).toBe(0);
  appendFileSync(s.path, record.slice(-4));
  const completed = await waitCommandHistory(s.path, boundary);
  expect(completed).toMatchObject({ complete: true, through: s.limit() });
  expect(completed!.ends.map((end) => end.id)).toEqual(["finished"]);
}, 5000);

it("follows a transcript replaced while a request waits, within the same deadline", async () => {
  const s = fixture();
  writeFileSync(s.path, notice("old") + filler.repeat(4));
  const waiting = waitCommandHistory(s.path, s.limit(), 60_000);
  const replacement = join(s.root, "replacement");
  writeFileSync(replacement, notice("new"));
  renameSync(replacement, s.path);
  await commandHistory(s.path, s.limit());
  expect((await waiting)!.ends.map((end) => end.id)).toEqual(["new"]);
}, 5000);

it("answers a waiting request when a read fails, and tries again after a backoff while watched", async () => {
  if (process.platform === "win32" || process.getuid?.() === 0) return; // an unreadable file needs POSIX modes and no root
  const s = fixture();
  writeFileSync(s.path, notice("late"));
  chmodSync(s.path, 0o000);
  await commandHistory(s.path, s.limit(), false);
  const recovered = heard(s.path, async () => (await commandHistory(s.path, s.limit(), false))?.complete === true);
  const failed = await waitCommandHistory(s.path, s.limit(), 60_000);
  expect(failed).toMatchObject({ complete: false, through: 0 });
  expect(commandHistorySize().timers).toBe(1);
  chmodSync(s.path, 0o644);
  await recovered;
  expect((await commandHistory(s.path, s.limit(), false))!.ends.map((end) => end.id)).toEqual(["late"]);
}, 5000);

it("evicts the least recently used read, never a watched one", async () => {
  const paths = Array.from({ length: 16 }, (_, index) => { const s = fixture(`s${index}`); writeFileSync(s.path, notice(`c${index}`)); return s.path; });
  for (const path of paths) expect(await commandHistory(path, 0, false)).not.toBeNull();
  const owner = watchCommandHistory(paths[0]!, () => {});
  release.push(owner!);
  await commandHistory(paths[1]!, 0, false);
  const extra = fixture("extra");
  writeFileSync(extra.path, notice("x"));
  expect(await commandHistory(extra.path, 0, false)).not.toBeNull();
  expect(commandHistorySize().sessions).toBe(16);
  expect(watchCommandHistory(paths[2]!, () => {})).toBeNull();
  for (const path of [paths[0]!, paths[1]!]) { const watch = watchCommandHistory(path, () => {}); expect(watch).not.toBeNull(); release.push(watch!); }
  for (const path of paths.slice(3)) { const watch = watchCommandHistory(path, () => {}); release.push(watch!); }
  const watched = watchCommandHistory(extra.path, () => {});
  release.push(watched!);
  // every read is watched: a new one is refused, and nothing watched goes
  expect(await commandHistory(paths[2]!, 0, false)).toBeNull();
  expect(commandHistorySize().sessions).toBe(16);
});

it("lets a small session finish before a large one, a slice each in turn", async () => {
  const large = fixture();
  // every line a notice: the large read takes many slices
  writeFileSync(large.path, Array.from({ length: 40_000 }, (_, index) => notice(`l${index}`)).join(""));
  await commandHistory(large.path, large.limit());
  let largeDone = false;
  void heard(large.path, async () => (await commandHistory(large.path, large.limit(), false))?.through === large.limit()).then(() => { largeDone = true; });
  const small = fixture("small");
  writeFileSync(small.path, notice("small"));
  expect((await waitCommandHistory(small.path, small.limit()))!.complete).toBe(true);
  expect(largeDone).toBe(false);
});

it("drops every read and timer once the last server lets go", async () => {
  const hold = holdCommandHistory();
  const s = fixture();
  writeFileSync(s.path, filler.repeat(8));
  await commandHistory(s.path, s.limit());
  release.push(watchCommandHistory(s.path, () => {})!);
  expect(commandHistorySize()).toMatchObject({ sessions: 1 });
  hold();
  expect(commandHistorySize()).toMatchObject({ sessions: 0, waiting: 0, timers: 0 });
});


it("keeps another history and HTTP responsive while one asynchronous positional read is held", async () => {
  const held = fixture("held"), healthy = fixture("healthy");
  writeFileSync(held.path, notice("held") + filler.repeat(2)); writeFileSync(healthy.path, notice("healthy"));
  let unblock!: () => void, reached!: () => void;
  const gate = new Promise<void>((resolve) => { unblock = resolve; });
  const entered = new Promise<void>((resolve) => { reached = resolve; });
  const run = transcriptReader.read;
  const spy = spyOn(transcriptReader, "read").mockImplementation(<T>(path: string, work: (file: TranscriptFile) => Promise<T>, options?: { signal?: AbortSignal; deadline?: number }) => run(path, (file) => work(path === held.path ? { ...file, read: async (position, length) => { reached(); await gate; return file.read(position, length); } } : file), options));
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ ok: true }) });
  const pending = waitCommandHistory(held.path, held.limit());
  try {
    await entered;
    expect(await (await fetch(server.url)).json()).toEqual({ ok: true });
    expect((await waitCommandHistory(healthy.path, healthy.limit()))!.ends).toMatchObject([{ id: "healthy" }]);
    expect(transcriptReader.size().active).toBe(1);
  } finally { unblock(); spy.mockRestore(); server.stop(true); }
  expect((await pending)!.ends).toMatchObject([{ id: "held" }]);
});


it.each(["deadline", "abort", "reset"] as const)("bounds initial asynchronous metadata by %s and discards its late result", async (kind) => {
  const s = fixture(); writeFileSync(s.path, notice("late"));
  let unblock!: () => void, reached!: () => void;
  const gate = new Promise<void>((resolve) => { unblock = resolve; });
  const entered = new Promise<void>((resolve) => { reached = resolve; });
  const run = transcriptReader.version;
  const spy = spyOn(transcriptReader, "version").mockImplementation((path, options) => path !== s.path ? run(path, options) : transcriptReader.read(path, async (file) => { reached(); await gate; return file.initial; }, options));
  const abort = new AbortController();
  const pending = waitCommandHistory(s.path, s.limit(), kind === "deadline" ? 20 : 1000, abort.signal);
  try {
    await entered;
    if (kind === "abort") abort.abort();
    if (kind === "reset") resetCommandHistory();
    expect(await pending).toBeNull();
    expect(transcriptReader.size().active).toBe(1);
    expect(commandHistorySize().sessions).toBe(0);
  } finally { unblock(); spy.mockRestore(); }
  await transcriptReader.settled();
  expect(commandHistorySize().sessions).toBe(0);
  expect(await historyVersion(s.path)).not.toBeNull(); // a caller timeout/abort must not poison the next consumer
});

it("reset cancels only history-owned operations while another shared-reader consumer remains live", async () => {
  const s = fixture(); writeFileSync(s.path, notice("history"));
  const other = fixture("future-image");
  let releaseHistory!: () => void, releaseOther!: () => void, reached!: () => void;
  const historyGate = new Promise<void>((resolve) => { releaseHistory = resolve; });
  const otherGate = new Promise<void>((resolve) => { releaseOther = resolve; });
  const entered = new Promise<void>((resolve) => { reached = resolve; });
  const run = transcriptReader.version;
  const spy = spyOn(transcriptReader, "version").mockImplementation((path, options) => path !== s.path ? run(path, options) : transcriptReader.read(path, async (file) => { reached(); await historyGate; return file.initial; }, options));
  let otherDone = false;
  const independent = transcriptReader.read(other.path, async () => { await otherGate; return "independent"; }).then((value) => { otherDone = true; return value; });
  const history = waitCommandHistory(s.path, s.limit());
  try {
    await entered; resetCommandHistory(); expect(await history).toBeNull();
    expect(otherDone).toBe(false); expect(transcriptReader.size().active).toBe(2);
    releaseHistory();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(otherDone).toBe(false);
    releaseOther(); expect(await independent).toBe("independent");
  } finally { releaseHistory(); releaseOther(); spy.mockRestore(); }
});


it("applies history backoff to metadata failures instead of reopening them on every poll", async () => {
  const s = fixture(); let clock = Date.now(), attempts = 0;
  const now = spyOn(Date, "now").mockImplementation(() => clock);
  const metadata = spyOn(transcriptReader, "version").mockImplementation(async () => { attempts++; throw new Error("synthetic metadata failure"); });
  try {
    expect(await historyVersion(s.path)).toBeNull();
    for (let poll = 0; poll < 5; poll++) expect(await historyVersion(s.path)).toBeNull();
    expect(attempts).toBe(1);
    clock += 1000; expect(await historyVersion(s.path)).toBeNull(); expect(attempts).toBe(2);
    clock += 1000; expect(await historyVersion(s.path)).toBeNull(); expect(attempts).toBe(2);
    clock += 1000; expect(await historyVersion(s.path)).toBeNull(); expect(attempts).toBe(3);
    resetCommandHistory(); expect(await historyVersion(s.path)).toBeNull(); expect(attempts).toBe(4);
  } finally { metadata.mockRestore(); now.mockRestore(); }
});


it("does not open a transcript merely to vouch an empty set of terminal lines", async () => {
  const s = fixture(); writeFileSync(s.path, "{}\n");
  const native = spyOn(transcriptReader, "read");
  try {
    expect(await commandHistory(s.path, s.limit(), false)).toMatchObject({ ends: [], through: 0 });
    expect(native).not.toHaveBeenCalled();
  } finally { native.mockRestore(); }
});


it("resumes a requeued prefix when its last watch is synchronously replaced after learning an end", async () => {
  const s = fixture(); writeFileSync(s.path, notice("first") + filler.repeat(3) + notice("last"));
  await commandHistory(s.path, s.limit());
  let completed!: () => void;
  const done = new Promise<void>((resolve) => { completed = resolve; });
  const first = watchCommandHistory(s.path, () => {
    first!();
    void heard(s.path, async () => (await commandHistory(s.path, s.limit(), false))?.ends.some((end) => end.id === "last") === true).then(completed);
    void commandHistory(s.path, s.limit());
  });
  expect(first).not.toBeNull(); release.push(first!);
  await done;
  expect((await commandHistory(s.path, s.limit(), false))!.ends.map((end) => end.id)).toEqual(["first", "last"]);
});
