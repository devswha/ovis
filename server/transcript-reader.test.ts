import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, renameSync, rmSync, writeFileSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transcriptVersion, TranscriptBusyError, TranscriptReader, type TranscriptHandle, type TranscriptIO } from "./transcript-reader.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const stat = { dev: 1, ino: 2, size: 4, mtimeMs: 1, isFile: () => true } as Stats;
function backend() {
  const opened: string[] = [], closed: string[] = [], reads: string[] = [];
  const opening = new Map<string, ReturnType<typeof deferred<void>>>();
  const reading = new Map<string, ReturnType<typeof deferred<void>>>();
  const closing = new Map<string, ReturnType<typeof deferred<void>>>();
  const io: TranscriptIO = {
    async stat() { return stat; },
    async open(path) {
      opened.push(path);
      await opening.get(path)?.promise;
      return {
        async stat() { return stat; },
        async read(buffer, offset, length, position) {
          reads.push(path);
          await reading.get(path)?.promise;
          const value = Buffer.from("abcd").subarray(position, position + length);
          value.copy(buffer, offset);
          return { bytesRead: value.length };
        },
        async close() { closed.push(path); await closing.get(path)?.promise; },
      };
    },
  };
  return { io, opened, closed, reads, opening, reading, closing };
}

it("bounds physical work and lets a healthy path pass one held path", async () => {
  const b = backend(); const reader = new TranscriptReader(b.io);
  const held = deferred(); b.reading.set("held", held);
  const first = reader.read("held", (file) => file.read(0, 4));
  await tick();
  expect(await reader.read("healthy", (file) => file.read(1, 2))).toEqual(Buffer.from("bc"));
  const second = reader.read("held", (file) => file.read(0, 1));
  await tick();
  expect(b.opened).toEqual(["held", "healthy"]);
  expect(reader.size()).toEqual({ active: 1, waiting: 1, paths: 1 });
  held.resolve();
  expect(await first).toEqual(Buffer.from("abcd"));
  expect(await second).toEqual(Buffer.from("a"));
  expect(reader.size().active).toBe(0);
});

it("admits an immediately runnable healthy path when one held path fills the metadata queue", async () => {
  const b = backend(); const reader = new TranscriptReader(b.io, 2, 2);
  const gate = deferred(); b.reading.set("held", gate);
  const first = reader.read("held", (file) => file.read(0, 4));
  const queued = [reader.read("held", (file) => file.read(0, 1)), reader.read("held", (file) => file.read(0, 1))];
  await expect(reader.read("held", (file) => file.read(0, 1))).rejects.toBeInstanceOf(TranscriptBusyError);
  expect(await reader.read("healthy", (file) => file.read(1, 2))).toEqual(Buffer.from("bc"));
  expect(reader.size()).toEqual({ active: 1, waiting: 2, paths: 1 });
  expect(b.opened).toEqual(["held", "healthy"]);
  gate.resolve(); await first; await Promise.all(queued);
});

it("retains both physical leases through cancellation, reset and pending close", async () => {
  const b = backend(); const reader = new TranscriptReader(b.io, 2, 2);
  const gate = deferred(), close = deferred();
  b.reading.set("a", gate); b.reading.set("b", gate); b.closing.set("a", close);
  const a = reader.read("a", (file) => file.read(0, 4)).catch((e) => e);
  const bb = reader.read("b", (file) => file.read(0, 4)).catch((e) => e);
  await tick(); reader.reset();
  expect(await a).toBeInstanceOf(TranscriptBusyError); expect(await bb).toBeInstanceOf(TranscriptBusyError);
  const next = reader.read("a", (file) => file.read(0, 4));
  const healthy = reader.read("c", (file) => file.read(0, 4));
  await expect(reader.read("d", (file) => file.read(0, 4))).rejects.toBeInstanceOf(TranscriptBusyError);
  expect(b.opened).toEqual(["a", "b"]);
  gate.resolve();
  expect(await healthy).toEqual(Buffer.from("abcd"));
  expect(b.opened).toEqual(["a", "b", "c"]);
  expect(reader.size()).toEqual({ active: 1, waiting: 1, paths: 1 });
  close.resolve();
  expect(await next).toEqual(Buffer.from("abcd"));
  expect(b.opened).toEqual(["a", "b", "c", "a"]);
});

it("closes a late open after abort without starting a read or admitting its replacement", async () => {
  const b = backend(); const reader = new TranscriptReader(b.io, 1);
  const gate = deferred(), close = deferred(); b.opening.set("a", gate); b.closing.set("a", close);
  const abort = new AbortController();
  const first = reader.read("a", (file) => file.read(0, 4), { signal: abort.signal }).catch((e) => e);
  abort.abort(); expect(await first).toBeInstanceOf(TranscriptBusyError);
  const next = reader.read("b", (file) => file.read(0, 4));
  gate.resolve(); await tick();
  expect(b.closed).toEqual(["a"]); expect(b.reads).toEqual([]); expect(b.opened).toEqual(["a"]);
  close.resolve(); expect(await next).toEqual(Buffer.from("abcd"));
});

it("never opens cancelled queued work and bounds a wait by its deadline", async () => {
  const b = backend(); const reader = new TranscriptReader(b.io, 1);
  const gate = deferred(); b.reading.set("a", gate);
  const first = reader.read("a", (file) => file.read(0, 4));
  const abort = new AbortController();
  const queued = reader.read("b", (file) => file.read(0, 4), { signal: abort.signal }).catch((e) => e);
  abort.abort(); expect(await queued).toBeInstanceOf(TranscriptBusyError);
  await expect(reader.read("c", (file) => file.read(0, 4), { deadline: Date.now() + 10 })).rejects.toBeInstanceOf(TranscriptBusyError);
  expect(b.opened).toEqual(["a"]); gate.resolve(); await first;
});

it.each(["open", "stat", "read", "close"] as const)("releases a settled %s failure and serves the next path", async (method) => {
  const b = backend(); const base = b.io.open;
  b.io.open = async (path) => {
    if (path === "bad" && method === "open") throw new Error("synthetic open");
    const handle = await base(path);
    if (path === "bad") (handle[method as keyof TranscriptHandle] as unknown) = async () => { throw new Error(`synthetic ${method}`); };
    return handle;
  };
  const reader = new TranscriptReader(b.io, 1);
  await expect(reader.read("bad", (file) => file.read(0, 4))).rejects.toThrow(`synthetic ${method}`);
  expect(await reader.read("good", (file) => file.read(0, 4))).toEqual(Buffer.from("abcd"));
  expect(reader.size().active).toBe(0);
});

it("reads owned explicit-position windows and identifies replacement after the lease closes", async () => {
  const root = mkdtempSync(join(tmpdir(), "ovis-transcript-reader-")); roots.push(root);
  const path = join(root, "session.jsonl"), next = join(root, "replacement");
  writeFileSync(path, "first line\nsecond line\n"); writeFileSync(next, "replacement\n");
  const reader = new TranscriptReader();
  const before = await reader.read(path, async (file) => {
    const before = await file.stat();
    const second = await file.read(11, 12);
    expect(second.toString()).toBe("second line\n");
    expect((await file.read(0, 5)).toString()).toBe("first");
    expect(second.toString()).toBe("second line\n");
    expect((await file.pathVersion())!.id).toBe(before.id);
    expect((await file.read(0, 5)).toString()).toBe("first");
    return before;
  });
  // Windows may reject replacement of an open destination. Native replacement is tested
  // after actual close; the deterministic test below changes named identity during a lease.
  renameSync(next, path);
  expect((await reader.read(path, async (file) => file.initial)).id).not.toBe(before.id);
  expect(await reader.read(path, (file) => file.read(0, 100))).toEqual(Buffer.from("replacement\n"));
});

it("keeps pinned bytes distinct from a changed named identity and rejects mismatched admission", async () => {
  const b = backend(); const reader = new TranscriptReader(b.io);
  const replacement = { ...stat, ino: 3 } as Stats;
  let named = stat;
  b.io.stat = async () => named;
  await reader.read("file", async (file) => {
    const before = file.initial;
    expect((await file.read(0, 4)).toString()).toBe("abcd");
    named = replacement;
    expect((await file.pathVersion())!.id).not.toBe(before.id);
    expect((await file.stat()).id).toBe(before.id);
    expect((await file.read(1, 2)).toString()).toBe("bc");
  });
  let called = false;
  await expect(reader.read("file", async () => { called = true; })).rejects.toThrow("the transcript was replaced");
  expect(called).toBe(false);
  expect(b.closed).toEqual(["file", "file"]);
  expect(reader.size()).toEqual({ active: 0, waiting: 0, paths: 0 });
});

it("exposes the metadata checked at admission without another stat", async () => {
  const b = backend(); let metadata = 0, fdStats = 0;
  const base = b.io.open;
  b.io.stat = async () => { metadata++; return stat; };
  b.io.open = async (path) => { const handle = await base(path); return { ...handle, stat: async () => { fdStats++; return stat; } }; };
  const reader = new TranscriptReader(b.io);
  await reader.read("file", async (file) => { expect(file.initial).toEqual(transcriptVersion(stat)!); return file.read(0, 4); });
  expect(fdStats).toBe(1); expect(metadata).toBe(1); expect(b.closed).toEqual(["file"]);
});

it("enforces the absolute deadline before a late callback can publish ahead of its timer", async () => {
  const b = backend(); const reader = new TranscriptReader(b.io);
  const deadline = Date.now() + 10;
  await expect(reader.read("a", async () => {
    // Deliberately retain the JS turn so the timer has not run when the callback returns.
    while (Date.now() <= deadline) { /* synchronous synthetic parser slice */ }
    return "late";
  }, { deadline })).rejects.toBeInstanceOf(TranscriptBusyError);
  await reader.settled(); expect(b.closed).toEqual(["a"]);
});


it("rejects an undefined callback error rather than publishing undefined success", async () => {
  const b = backend(); const reader = new TranscriptReader(b.io); let rejected = false;
  await reader.read("a", async () => { throw undefined; }).then(() => { throw new Error("undefined failure was published"); }, (error) => { rejected = true; expect(error).toBeUndefined(); });
  expect(rejected).toBe(true); expect(b.closed).toEqual(["a"]);
});

it("checks the absolute deadline after a pending close settles before the timer can run", async () => {
  const b = backend(); const reader = new TranscriptReader(b.io); const gate = deferred(); b.closing.set("a", gate);
  const deadline = Date.now() + 10;
  const pending = reader.read("a", async () => "late", { deadline });
  await tick(); expect(b.closed).toEqual(["a"]);
  while (Date.now() <= deadline) { /* retain the JS turn until this close is too late */ }
  gate.resolve(); await expect(pending).rejects.toBeInstanceOf(TranscriptBusyError);
  expect(reader.size().active).toBe(0);
});


it("hands a window's buffer to another lease only once every read into it has settled", async () => {
  const b = backend(); const reader = new TranscriptReader(b.io);
  const buffers: ArrayBufferLike[] = [];
  const base = b.io.open;
  b.io.open = async (path) => { const handle = await base(path); return { ...handle, read: (buffer, ...rest) => { buffers.push(buffer.buffer); return handle.read(buffer, ...rest); } }; };
  const held = deferred(); b.reading.set("held", held);
  const abort = new AbortController();
  const cancelled = reader.read("held", (file) => file.window(0, 4), { signal: abort.signal }).catch((e) => e);
  await tick(); abort.abort();
  expect(await cancelled).toBeInstanceOf(TranscriptBusyError);
  // the cancelled lease's read may still write into its buffer: the next lease gets another
  expect(await reader.read("next", async (file) => (await file.window(1, 2)).toString())).toBe("bc");
  expect(buffers[1]).not.toBe(buffers[0]);
  held.resolve(); await reader.settled();
  await reader.read("last", (file) => file.window(0, 4));
  expect([buffers[0], buffers[1]]).toContain(buffers[2]);
});
