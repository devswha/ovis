import { afterEach, expect, it, setSystemTime, spyOn } from "bun:test";
import { appendFileSync, chmodSync, closeSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandHistory, commandHistorySettled, commandHistorySize, holdCommandHistory, resetCommandHistory, waitCommandHistory, watchCommandHistory } from "./claude-command-history.ts";
import { TranscriptBusyError, transcriptReader, type TranscriptFile } from "./transcript-reader.ts";

const roots: string[] = [];
const release: (() => void)[] = [];
afterEach(() => {
  for (const done of release.splice(0)) done();
  resetCommandHistory();
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
function heard(path: string, test: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const stop = watchCommandHistory(path, () => { if (test()) { stop!(); resolve(); } });
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
  const again = commandHistory(s.path, s.limit());
  expect(again).toEqual(first);
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
  expect(commandHistory(s.path, limit)).toMatchObject({ complete: false, ends: [] });
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
  expect(commandHistory(s.path, limit, false)).toMatchObject({ complete: false, ends: [] });
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
  expect(commandHistory(s.path, limit, false)).toMatchObject({ complete: true, ends: [{ id: "same" }] });
});

it("tells the ends it read at once while the transcript only grows, before any check of it", async () => {
  const s = fixture();
  writeFileSync(s.path, notice("same") + filler);
  const limit = s.limit();
  await waitCommandHistory(s.path, limit);
  appendFileSync(s.path, notice("next"));
  expect(commandHistory(s.path, limit, false)).toMatchObject({ complete: true, ends: [{ id: "same" }] });
  // only the ids asked for
  expect(commandHistory(s.path, limit, false, new Set(["other"]))!.ends).toEqual([]);
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
  commandHistory(s.path, s.limit());
  expect((await waiting)!.ends.map((end) => end.id)).toEqual(["new"]);
}, 5000);

it("answers a waiting request when a read fails, and tries again after a backoff while watched", async () => {
  if (process.platform === "win32" || process.getuid?.() === 0) return; // an unreadable file needs POSIX modes and no root
  const s = fixture();
  writeFileSync(s.path, notice("late"));
  chmodSync(s.path, 0o000);
  commandHistory(s.path, s.limit(), false);
  const recovered = heard(s.path, () => commandHistory(s.path, s.limit(), false)?.complete === true);
  const failed = await waitCommandHistory(s.path, s.limit(), 60_000);
  expect(failed).toMatchObject({ complete: false, through: 0 });
  expect(commandHistorySize().timers).toBe(1);
  chmodSync(s.path, 0o644);
  await recovered;
  expect(commandHistory(s.path, s.limit(), false)!.ends.map((end) => end.id)).toEqual(["late"]);
}, 5000);

it("evicts the least recently used read, never a watched one", () => {
  const paths = Array.from({ length: 16 }, (_, index) => { const s = fixture(`s${index}`); writeFileSync(s.path, notice(`c${index}`)); return s.path; });
  for (const path of paths) expect(commandHistory(path, 0, false)).not.toBeNull();
  const owner = watchCommandHistory(paths[0]!, () => {});
  release.push(owner!);
  commandHistory(paths[1]!, 0, false);
  const extra = fixture("extra");
  writeFileSync(extra.path, notice("x"));
  expect(commandHistory(extra.path, 0, false)).not.toBeNull();
  expect(commandHistorySize().sessions).toBe(16);
  expect(watchCommandHistory(paths[2]!, () => {})).toBeNull();
  for (const path of [paths[0]!, paths[1]!]) { const watch = watchCommandHistory(path, () => {}); expect(watch).not.toBeNull(); release.push(watch!); }
  for (const path of paths.slice(3)) { const watch = watchCommandHistory(path, () => {}); release.push(watch!); }
  const watched = watchCommandHistory(extra.path, () => {});
  release.push(watched!);
  // every read is watched: a new one is refused, and nothing watched goes
  expect(commandHistory(paths[2]!, 0, false)).toBeNull();
  expect(commandHistorySize().sessions).toBe(16);
});

it("lets a small session finish before a large one, a slice each in turn", async () => {
  const large = fixture();
  // every line a notice: the large read takes many slices
  writeFileSync(large.path, Array.from({ length: 40_000 }, (_, index) => notice(`l${index}`)).join(""));
  commandHistory(large.path, large.limit());
  let largeDone = false;
  void heard(large.path, () => commandHistory(large.path, large.limit(), false)?.through === large.limit()).then(() => { largeDone = true; });
  const small = fixture("small");
  writeFileSync(small.path, notice("small"));
  expect((await waitCommandHistory(small.path, small.limit()))!.complete).toBe(true);
  expect(largeDone).toBe(false);
});

it("drops every read and timer once the last server lets go", async () => {
  const hold = holdCommandHistory();
  const s = fixture();
  writeFileSync(s.path, filler.repeat(8));
  commandHistory(s.path, s.limit());
  release.push(watchCommandHistory(s.path, () => {})!);
  expect(commandHistorySize()).toMatchObject({ sessions: 1, waiting: 1 });
  hold();
  expect(commandHistorySize()).toMatchObject({ sessions: 0, waiting: 0, timers: 0 });
});

const gate = () => { let open!: () => void; const opened = new Promise<void>((resolve) => { open = resolve; }); return { opened, open }; };
type Work = (file: TranscriptFile) => Promise<unknown>;
/** Runs every history read's work through `wrap`, for as long as the test lasts. */
function wrapReads(wrap: (path: string, work: Work) => Work): void {
  const read = transcriptReader.read.bind(transcriptReader);
  const spy = spyOn(transcriptReader, "read").mockImplementation(((path: string, work: Work, options?: { deadline?: number }) => read(path, wrap(path, work), options)) as typeof transcriptReader.read);
  release.push(() => spy.mockRestore());
}
/** Holds every slice after its lease opened (its first stat taken) until `release` is called; `entered` opens as one is held. */
function holdSlices() {
  const entered = gate(), held = gate();
  wrapReads((_, work) => async (file) => { entered.open(); await held.opened; return work(file); });
  return { entered: entered.opened, release: held.open };
}
/**
 * Every window read takes 10 ms of the clock (performance.now), more than a slice, though no time
 * passes: storage as slow as an SSHFS home. Counts the reads of each path, and the leases they were
 * read in (`leases`); `read` hears of each read.
 */
function slowReads(read: (path: string, reads: number) => void = () => {}) {
  const clock = performance.now.bind(performance);
  let waited = 0;
  const reads = new Map<string, number>(), leases = new Map<string, number>();
  const now = spyOn(performance, "now").mockImplementation(() => clock() + waited);
  release.push(() => now.mockRestore());
  wrapReads((path, work) => { leases.set(path, (leases.get(path) ?? 0) + 1); return (file) => work({ ...file, window: async (position, length) => {
    const bytes = await file.window(position, length);
    waited += 10;
    reads.set(path, (reads.get(path) ?? 0) + 1);
    read(path, reads.get(path)!);
    return bytes;
  } }); });
  return Object.assign((path: string) => reads.get(path) ?? 0, { leases: (path: string) => leases.get(path) ?? 0 });
}
const MIB = 1024 * 1024;

it("backs off a read the reader is too busy for without counting it a failure of the transcript", async () => {
  const s = fixture();
  writeFileSync(s.path, notice("late"));
  let now = Date.now();
  const busy = spyOn(transcriptReader, "read").mockImplementation(() => Promise.reject(new TranscriptBusyError()));
  try {
    // more refusals than the failures a read is given up after (and then told complete with no end)
    for (let round = 0; round < 6; round++) {
      setSystemTime(new Date(now += 60_000)); // past any backoff
      expect(await waitCommandHistory(s.path, s.limit(), 60_000)).toMatchObject({ complete: false, through: 0, ends: [] });
    }
    expect(busy.mock.calls.length).toBeGreaterThanOrEqual(6);
    busy.mockRestore();
    setSystemTime(new Date(now += 60_000));
    const read = await waitCommandHistory(s.path, s.limit(), 60_000);
    expect(read).toMatchObject({ complete: true, through: s.limit() });
    expect(read!.ends.map((end) => end.id)).toEqual(["late"]);
  } finally { busy.mockRestore(); setSystemTime(); }
}, 5000);

it("keeps the chunks it read and checked when a read gives up on its stat after a chunk", async () => {
  const s = fixture();
  writeFileSync(s.path, notice("first") + filler.repeat(4));
  const chunks = Math.ceil(s.limit() / MIB);
  let windows = 0, failed = false;
  // the stat after the second chunk runs out of time (the reader's deadline): TranscriptBusyError
  wrapReads((_, work) => (file) => work({ ...file,
    window: async (position, length) => { windows++; return file.window(position, length); },
    stat: async () => { if (windows === 2 && !failed) { failed = true; throw new TranscriptBusyError(); } return file.stat(); } }));
  let now = Date.now();
  try {
    expect(await waitCommandHistory(s.path, s.limit(), 60_000)).toMatchObject({ complete: false });
    expect(failed).toBe(true);
    setSystemTime(new Date(now += 60_000)); // past the backoff
    const read = await waitCommandHistory(s.path, s.limit(), 60_000);
    expect(read).toMatchObject({ complete: true, through: s.limit() });
    expect(read!.ends.map((end) => end.id)).toEqual(["first"]);
    // the chunk whose stat failed is read again, and nothing is checked over
    expect(windows).toBe(chunks + 1);
  } finally { setSystemTime(); }
}, 5000);

it("lets the event loop run while a slice waits for the disk", async () => {
  const s = fixture();
  writeFileSync(s.path, notice("slow") + filler);
  const held = holdSlices();
  let answered = false;
  const waiting = waitCommandHistory(s.path, s.limit(), 60_000).then((found) => { answered = true; return found; });
  await held.entered;
  // a macrotask comes round while the read is still under way
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(answered).toBe(false);
  expect(commandHistorySize().draining).toBe(true);
  held.release();
  expect((await waiting)!.ends.map((end) => end.id)).toEqual(["slow"]);
}, 5000);

it("queues a session asked for while its slice reads only once", async () => {
  const s = fixture();
  writeFileSync(s.path, notice("slow") + filler.repeat(3));
  // asked for again while its first read is under way; that read alone outlasts the slice
  const reads = slowReads((_, count) => { if (count === 1) commandHistory(s.path, s.limit()); });
  const waits: number[] = [];
  const waiting = waitCommandHistory(s.path, s.limit(), 60_000);
  release.push(watchCommandHistory(s.path, () => waits.push(commandHistorySize().waiting))!);
  expect((await waiting)!.ends.map((end) => end.id)).toEqual(["slow"]);
  expect(reads(s.path)).toBeGreaterThan(1);
  expect(Math.max(...waits)).toBe(1);
}, 5000);

it("keeps what it read when a slice's stat is older than one a poll took while the slice waited", async () => {
  const s = fixture();
  writeFileSync(s.path, notice("kept") + filler);
  expect((await waitCommandHistory(s.path, s.limit()))!.ends.map((end) => end.id)).toEqual(["kept"]);
  appendFileSync(s.path, notice("next"));
  const held = holdSlices();
  commandHistory(s.path, s.limit());
  await held.entered;
  // the transcript grows on, and a status poll sees it: the held slice's stat is now behind
  appendFileSync(s.path, notice("later"));
  commandHistory(s.path, s.limit(), false);
  const changed = heard(s.path, () => true);
  held.release();
  await changed;
  // an ordinary append never starts the read over: the end read before stays told
  expect(commandHistory(s.path, s.limit(), false)!.ends.map((end) => end.id)).toContain("kept");
  expect((await waitCommandHistory(s.path, s.limit()))!.ends.map((end) => end.id)).toEqual(["kept", "next", "later"]);
}, 5000);

it("starts over on a transcript cut short in place while a slice reads it", async () => {
  const s = fixture();
  writeFileSync(s.path, notice("old") + filler.repeat(3));
  // rewritten shorter, the same file, as the first read returns
  slowReads((_, count) => { if (count === 1) writeFileSync(s.path, notice("new")); });
  // answered well before the test's timeout: a read that never starts over waits out the request
  const read = await waitCommandHistory(s.path, s.limit(), 3000);
  expect(read).toMatchObject({ complete: true, through: s.limit() });
  expect(read!.ends.map((end) => end.id)).toEqual(["new"]);
}, 5000);

it("reads on by whole chunks when every read outlasts a slice, as on slow storage", async () => {
  const s = fixture();
  // a notice every 2 KiB, about 3 MiB: each chunk is far less than a slice's work
  writeFileSync(s.path, Array.from({ length: 1500 }, (_, index) => notice(`c${index}`) + json({ type: "progress", value: "x".repeat(2048) })).join(""));
  const reads = slowReads();
  const history = await waitCommandHistory(s.path, s.limit(), 60_000);
  expect(history).toMatchObject({ complete: true, through: s.limit() });
  expect(history!.ends).toHaveLength(1500);
  // a read for each chunk, not one for each record
  expect(reads(s.path)).toBeLessThanOrEqual(Math.ceil(s.limit() / MIB) + 1);
}, 5000);

it("takes in the rest of a window a slice ended in without reading it again", async () => {
  const s = fixture();
  // a notice every 1 KiB or so, about 3 MiB
  const ids = Array.from({ length: 3000 }, (_, index) => `c${index}`);
  writeFileSync(s.path, ids.map((id) => notice(id) + json({ type: "progress", value: "x".repeat(1024) })).join(""));
  // a clock that moves on at every look: slices end several times inside each window
  const clock = performance.now.bind(performance);
  let moved = 0;
  const now = spyOn(performance, "now").mockImplementation(() => clock() + (moved += 0.02));
  release.push(() => now.mockRestore());
  let windows = 0;
  wrapReads((_, work) => (file) => work({ ...file, window: (position, length) => { windows++; return file.window(position, length); } }));
  const history = await waitCommandHistory(s.path, s.limit(), 60_000);
  expect(history).toMatchObject({ complete: true, through: s.limit() });
  expect(history!.ends.map((end) => end.id)).toEqual(ids);
  expect(windows).toBeLessThanOrEqual(Math.ceil(s.limit() / MIB) + 1);
}, 5000);

it("starts over on a transcript rewritten and grown while it reads a window ahead", async () => {
  const s = fixture();
  writeFileSync(s.path, notice("a") + filler.repeat(4));
  let rewritten = false;
  wrapReads((_, work) => (file) => work({ ...file, ahead: (position, length) => {
    file.ahead(position, length);
    // the same file, its first record another: whatever the read ahead finds, what was read before it is gone
    if (!rewritten) { rewritten = true; writeFileSync(s.path, notice("b") + filler.repeat(5)); }
  } }));
  const read = await waitCommandHistory(s.path, s.limit(), 60_000);
  expect(rewritten).toBe(true);
  expect(read).toMatchObject({ complete: true });
  expect(read!.ends.map((end) => end.id)).toEqual(["b"]);
}, 5000);

it("lets a small session have its turn after each slow read of a large one", async () => {
  const large = fixture();
  writeFileSync(large.path, notice("large") + filler.repeat(8));
  const small = fixture("small");
  writeFileSync(small.path, notice("small"));
  // the small one is asked for while the large one's first read is under way
  let answered: Promise<number> | undefined;
  const reads = slowReads((path, count) => {
    if (path === large.path && count === 1) answered = waitCommandHistory(small.path, small.limit(), 60_000).then((found) => {
      expect(found!.ends.map((end) => end.id)).toEqual(["small"]);
      return reads(large.path);
    });
  });
  const reading = waitCommandHistory(large.path, large.limit(), 60_000);
  expect((await reading)!.complete).toBe(true);
  expect(reads(large.path)).toBeGreaterThan(8);
  // read before the large one went on past the slice its first read began
  expect(await answered!).toBe(1);
}, 5000);

it("keeps a transcript open across turns while no other session waits", async () => {
  const s = fixture();
  writeFileSync(s.path, notice("large") + filler.repeat(8));
  const reads = slowReads();
  expect((await waitCommandHistory(s.path, s.limit(), 60_000))!.complete).toBe(true);
  // a turn for every slow read, but the transcript opened (and checked) once, not for each turn
  expect(reads(s.path)).toBeGreaterThan(8);
  expect(reads.leases(s.path) * 4).toBeLessThan(reads(s.path));
}, 5000);

it("lets go of a transcript it keeps open at the end of the turn another session is asked for in", async () => {
  const large = fixture();
  writeFileSync(large.path, notice("large") + filler.repeat(8));
  const small = fixture("small");
  writeFileSync(small.path, notice("small"));
  let answered: Promise<number> | undefined;
  const reads = slowReads((path, count) => {
    if (path === large.path && count === 3) answered = waitCommandHistory(small.path, small.limit(), 60_000).then((found) => {
      expect(found!.ends.map((end) => end.id)).toEqual(["small"]);
      return reads(large.path);
    });
  });
  expect((await waitCommandHistory(large.path, large.limit(), 60_000))!.complete).toBe(true);
  // the small one was read while the large one still had reads to go: it let go, and opened again after
  expect(await answered!).toBeLessThan(reads(large.path));
}, 5000);

it("lets go of a transcript it keeps open well before the read's deadline", async () => {
  const s = fixture();
  writeFileSync(s.path, notice("large") + filler.repeat(8));
  let now = Date.now();
  setSystemTime(new Date(now));
  try {
    // half the read's deadline passes during the second read, and as much again two reads later: a
    // lease still held then would run out of time, and the read would give up for now
    slowReads((_, count) => { if (count === 2 || count === 4) setSystemTime(new Date(now += 5_000)); });
    expect(await waitCommandHistory(s.path, s.limit(), 60_000)).toMatchObject({ complete: true, through: s.limit() });
  } finally { setSystemTime(); }
}, 5000);

it("lets go of a transcript it keeps open at the end of the turn another reader waits for it in", async () => {
  const s = fixture();
  writeFileSync(s.path, notice("large") + filler.repeat(8));
  // another reader of the same transcript (one lease a path) asks while the third read is under way
  let other: Promise<number> | undefined;
  const reads = slowReads((_, count) => { if (count === 3) other = transcriptReader.read(s.path, async () => reads(s.path)); });
  expect((await waitCommandHistory(s.path, s.limit(), 60_000))!.complete).toBe(true);
  expect(await other!).toBe(3);
}, 5000);

it("lets go of a transcript it keeps open at the end of a turn that told a watcher of an end", async () => {
  const s = fixture();
  writeFileSync(s.path, notice("first") + filler.repeat(8));
  let heard = -1;
  const reads = slowReads();
  commandHistory(s.path, s.limit(), false);
  release.push(watchCommandHistory(s.path, () => { if (heard < 0 && commandHistory(s.path, s.limit(), false)!.ends.length > 0) heard = reads(s.path); })!);
  expect((await waitCommandHistory(s.path, s.limit(), 60_000))!.complete).toBe(true);
  expect(heard).toBe(1);
}, 5000);

it("reads on in the same lease when the session it reads is asked for again", async () => {
  const s = fixture();
  writeFileSync(s.path, notice("large") + filler.repeat(8));
  // the leases there were as each read was made
  let leases = 0;
  const reads = slowReads((_, count) => { leases = reads.leases(s.path); if (count === 3) commandHistory(s.path, s.limit()); });
  expect((await waitCommandHistory(s.path, s.limit(), 60_000))!.complete).toBe(true);
  expect(reads(s.path)).toBeGreaterThan(8);
  expect(leases).toBe(1);
}, 5000);

it("gives each turn of a transcript it keeps open a slice of its own", async () => {
  const s = fixture();
  writeFileSync(s.path, notice("large") + filler.repeat(16));
  // storage that answers at once, so the event loop runs only when a turn ends, and a clock that
  // moves only by 1 ms a read: four reads to a slice
  const bytes = readFileSync(s.path);
  let waited = 0;
  const base = performance.now();
  const now = spyOn(performance, "now").mockImplementation(() => base + waited);
  release.push(() => now.mockRestore());
  wrapReads((_, work) => (file) => work({ ...file, stat: async () => file.initial, ahead: () => {}, window: async (position, length) => {
    waited += 1;
    return bytes.subarray(position, position + length);
  } }));
  // the clock each time the event loop runs
  const runs: number[] = [];
  let probing = true;
  const probe = () => { runs.push(waited); if (probing) setImmediate(probe); };
  release.push(() => { probing = false; });
  probe();
  expect((await waitCommandHistory(s.path, s.limit(), 60_000))!.complete).toBe(true);
  probing = false;
  expect(waited).toBeGreaterThan(16);
  // the reads between one run of the event loop and the next that saw any
  const turns = runs.slice(1).map((at, index) => at - runs[index]!).filter((reads) => reads > 0);
  // a turn ends every few reads, not after each one (the read's last may be short), and none runs
  // on past its slice and the read that ended it
  expect(turns.slice(0, -1).every((reads) => reads >= 2)).toBe(true);
  expect(Math.max(...turns)).toBeLessThanOrEqual(5);
}, 5000);

it("reads one slice for a request nobody watches or waits for", async () => {
  const s = fixture();
  writeFileSync(s.path, notice("large") + filler.repeat(9));
  slowReads();
  commandHistory(s.path, s.limit());
  await commandHistorySettled();
  // read on some way, and nothing left to read it on
  const { through } = commandHistory(s.path, s.limit(), false)!;
  expect(through).toBeGreaterThan(0);
  expect(through).toBeLessThan(s.limit());
  expect(commandHistorySize()).toMatchObject({ draining: false, waiting: 0, timers: 0 });
}, 5000);

it("reads on in one lease for a tracker's watch after it hears the first end", async () => {
  const s = fixture();
  writeFileSync(s.path, notice("large") + filler.repeat(9));
  const reads = slowReads();
  // as a tracker asks: a read, and a watch of it until it is no longer needed
  commandHistory(s.path, s.limit());
  const done = gate();
  let first: number | null = null;
  release.push(watchCommandHistory(s.path, () => {
    const history = commandHistory(s.path, s.limit(), false)!;
    if (first === null && history.ends.length > 0) first = history.through;
    if (history.complete) done.open();
  })!);
  await done.opened;
  expect(reads(s.path)).toBeGreaterThan(9);
  // the end from the first chunk is heard while the read goes on
  expect(first).not.toBeNull();
  expect(first!).toBeLessThan(s.limit());
}, 5000);

it("lets go of a transcript it keeps open at the end of the turn it started over in", async () => {
  const s = fixture();
  writeFileSync(s.path, notice("a") + filler.repeat(16));
  expect((await waitCommandHistory(s.path, s.limit(), 60_000))!.ends.map((end) => end.id)).toEqual(["a"]);
  // a clock that moves only by 1 ms a read: four reads to a slice
  let waited = 0, reads = 0, heard = -1, through = -1;
  const base = performance.now();
  const now = spyOn(performance, "now").mockImplementation(() => base + waited);
  release.push(() => now.mockRestore());
  wrapReads((_, work) => (file) => work({ ...file, window: async (position, length) => {
    const bytes = await file.window(position, length);
    waited += 1;
    reads++;
    return bytes;
  } }));
  release.push(watchCommandHistory(s.path, () => { if (heard < 0) { heard = reads; through = commandHistory(s.path, s.limit(), false)!.through; } })!);
  // rewritten in place and grown: the same file, its first record another; a check finds it
  writeFileSync(s.path, notice("b") + filler.repeat(17));
  const read = await waitCommandHistory(s.path, s.limit(), 60_000);
  expect(read!.ends.map((end) => end.id)).toEqual(["b"]);
  expect(reads).toBeGreaterThan(16);
  // the watcher hears of the start over in the turn it happened, not once the transcript is read again
  expect(heard).toBeGreaterThan(0);
  expect(through).toBeLessThan(s.limit());
}, 5000);

it("counts the time it keeps a transcript open from when its read was asked for", async () => {
  const s = fixture();
  writeFileSync(s.path, notice("large") + filler.repeat(8));
  let now = Date.now();
  setSystemTime(new Date(now));
  try {
    // another reader of the same transcript (one lease a path) holds it while most of half the
    // read's deadline goes by
    const held = gate(), entered = gate();
    const other = transcriptReader.read(s.path, async () => { entered.open(); await held.opened; });
    await entered.opened;
    // and as much again at the third read: a lease held by its own start would run out of time then
    slowReads((_, count) => { if (count === 3) setSystemTime(new Date(now += 5_000)); });
    const reading = waitCommandHistory(s.path, s.limit(), 60_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    setSystemTime(new Date(now += 6_000));
    held.open();
    await other;
    expect(await reading).toMatchObject({ complete: true, through: s.limit() });
  } finally { setSystemTime(); }
}, 5000);
