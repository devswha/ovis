import { afterEach, describe, expect, it } from "bun:test";
import { closeSync, constants, fstatSync, mkdtempSync, openSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claudeImageGeneration, claudeImagePoolSize, claudeImageTask, claudeImageThreadClosed, holdClaudeImagePool, setClaudeImagePoolOptions, type ClaudeImageJob } from "./claude-image-pool.ts";
import { MAX_IMAGE_BYTES } from "./codex-images.ts";
import { FileBusyError, fileTask, fileThreadsClosed, holdFilePool } from "./file-pool.ts";

const fake = new URL("./claude-image-worker.fake.ts", import.meta.url);
const waitAsync = (Atomics as unknown as { waitAsync: (cells: Int32Array, index: number, value: number, timeout: number) => { async: boolean; value: Promise<string> | string } }).waitAsync;
const roots: string[] = [];
interface HeldRead { data: { cells: SharedArrayBuffer; fifo?: string }; ran(): Promise<number>; release(): void; close(): void }
const gates: HeldRead[] = [];
const temporary = (): string => { const root = mkdtempSync(join(tmpdir(), "ovis-image-pool-")); roots.push(root); return root; };
const job = (ref = "image", config: object = {}): ClaudeImageJob => ({ path: "/synthetic/history.jsonl", ref, binding: "pane-session", generation: JSON.stringify(config) });
function gate(fifo?: string): HeldRead {
  const cells = new Int32Array(new SharedArrayBuffer(12));
  cells[1] = -1;
  cells[2] = -1;
  const hold = {
    data: { cells: cells.buffer as SharedArrayBuffer, ...(fifo === undefined ? {} : { fifo }) },
    async ran() {
      const wait = waitAsync(cells, 1, -1, 10_000);
      if ((wait.async ? await wait.value : wait.value) === "timed-out") throw new Error("the image thread never entered its held read");
      return cells[1]!;
    },
    release() {
      if (Atomics.exchange(cells, 0, 1) !== 0) return;
      Atomics.notify(cells, 0);
      if (fifo !== undefined && cells[1] !== -1) {
        const fd = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
        try { writeSync(fd, "x"); } finally { closeSync(fd); }
      }
    },
    close() { const fd = Atomics.exchange(cells, 2, -1); if (fd >= 0) closeSync(fd); },
  };
  gates.push(hold);
  return hold;
}
const held = (task: ClaudeImageJob, hold: ReturnType<typeof gate>): ClaudeImageJob => ({ ...task, gate: hold.data } as ClaudeImageJob);
const configure = (deadlineMs = 10_000) => setClaudeImagePoolOptions({ worker: fake, deadlineMs });

afterEach(async () => {
  for (const hold of gates) hold.release();
  setClaudeImagePoolOptions();
  await claudeImageThreadClosed();
  for (const hold of gates.splice(0)) hold.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Claude image disk isolation", () => {
  it("bounds one physical thread and eight queued jobs, independently of the existing file pool", async () => {
    configure();
    const hold = gate();
    const running = claudeImageTask(held(job("running"), hold));
    await hold.ran();
    const queued = Array.from({ length: 8 }, (_, at) => claudeImageTask(job(`queued-${at}`)));
    expect(claudeImagePoolSize()).toEqual({ physical: 1, retiring: 0, running: 1, waiting: 8, waiters: 9 });
    await expect(claudeImageTask(job("overflow"))).rejects.toBeInstanceOf(FileBusyError);
    const root = temporary();
    const file = join(root, "session.jsonl");
    writeFileSync(file, "");
    const releaseFiles = holdFilePool();
    try {
      expect(await fileTask({ op: "info", path: file })).toMatchObject({ size: 0 });
      expect(await fileTask({ op: "commands", agent: "claude", cwd: root, home: root, roots: {}, version: null, serverEnv: {} })).toBeArray();
      expect(await fileTask({ op: "claude-tasks", path: file, live: true, since: null })).toEqual([]);
    } finally { releaseFiles(); await fileThreadsClosed(); }
    hold.release();
    for (const result of await Promise.all([running, ...queued])) expect([...result!.bytes]).toEqual([17, 17, 17, 17]);
  });

  it("uses worker metadata to identify a generation and refuses an already elapsed absolute deadline", async () => {
    configure();
    expect(await claudeImageGeneration("/synthetic/history.jsonl", "pane-session")).toBe("test-file-generation");
    await expect(claudeImageTask(job(), undefined, performance.now() - 1)).rejects.toThrow("in time");
    expect(claudeImagePoolSize()).toMatchObject({ running: 0, waiting: 0, waiters: 0 });
  });

  it("coalesces only matching bindings and generations, with bounded per-job and total waiters", async () => {
    configure();
    const hold = gate();
    const task = held(job(), hold);
    const shared = Array.from({ length: 8 }, () => claudeImageTask(task));
    await hold.ran();
    await expect(claudeImageTask(task)).rejects.toBeInstanceOf(FileBusyError);
    const other = [
      { ...job(), binding: "another-pane-session" },
      { ...job(), generation: JSON.stringify({ size: 5 }) },
      job("another-ref"),
    ].flatMap((different) => Array.from({ length: 8 }, () => claudeImageTask(different)));
    expect(claudeImagePoolSize()).toMatchObject({ waiting: 3, waiters: 32 });
    await expect(claudeImageTask(job("total-overflow"))).rejects.toBeInstanceOf(FileBusyError);
    hold.release();
    const same = await Promise.all(shared);
    for (const result of same) expect(result).toBe(same[0]!);
    await Promise.all(other);
    expect(claudeImagePoolSize().waiters).toBe(0);
  });

  it("cancels one coalesced waiter without cancelling the others, and drops unclaimed queued jobs", async () => {
    configure();
    const hold = gate();
    const cancel = new AbortController();
    const task = held(job(), hold);
    const first = claudeImageTask(task, cancel.signal);
    const second = claudeImageTask(task);
    await hold.ran();
    cancel.abort();
    await expect(first).rejects.toThrow("cancelled");
    expect(claudeImagePoolSize()).toMatchObject({ physical: 1, running: 1, waiters: 1 });
    const queuedCancel = new AbortController();
    const queued = claudeImageTask(job("queued"), queuedCancel.signal);
    queuedCancel.abort();
    await expect(queued).rejects.toThrow("cancelled");
    expect(claudeImagePoolSize().waiting).toBe(0);
    hold.release();
    expect((await second)!.bytes.length).toBe(4);
    await expect(claudeImageTask(job(), AbortSignal.abort())).rejects.toThrow("cancelled");
  });

  it("includes queue time in deadlines and keeps expired running work attached until its answer", async () => {
    configure(150);
    const hold = gate();
    const running = claudeImageTask(held(job(), hold));
    const expired = expect(running).rejects.toThrow("in time");
    await hold.ran();
    const queued = expect(claudeImageTask(job("queued"))).rejects.toThrow("in time");
    await Promise.all([expired, queued]);
    expect(claudeImagePoolSize()).toEqual({ physical: 1, retiring: 0, running: 1, waiting: 0, waiters: 0 });
    // Repeated retries cannot replace a syscall that still runs.
    for (let at = 0; at < 2; at += 1) await expect(claudeImageTask(job(`retry-${at}`))).rejects.toThrow("in time");
    expect(claudeImagePoolSize().physical).toBe(1);
    configure();
    const next = claudeImageTask(job("after-retirement"));
    hold.release();
    expect((await next)!.bytes.length).toBe(4);
  });

  it.skipIf(process.platform === "win32")("retains its physical slot through a real blocked read, termination, final release and reacquisition", async () => {
    configure();
    const root = temporary();
    const fifo = join(root, "held-disk-read");
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    const hold = gate(fifo);
    const release = holdClaudeImagePool();
    const file = join(root, "transcript.jsonl");
    writeFileSync(file, "synthetic");
    const reading = claudeImageTask(held({ ...job("opened", { open: true }), path: file }, hold));
    const fd = await hold.ran();
    const original = fstatSync(fd);
    expect(original.size).toBe(9);
    const ownsOriginal = (): boolean => {
      try { const now = fstatSync(fd); return now.dev === original.dev && now.ino === original.ino; }
      catch { return false; }
    };
    release();
    release();
    await expect(reading).rejects.toThrow("stopped");
    expect(claudeImagePoolSize()).toMatchObject({ physical: 1, retiring: 1, running: 1 });
    expect(fstatSync(fd)).toMatchObject({ dev: original.dev, ino: original.ino, size: 9 });
    const later = holdClaudeImagePool();
    const next = claudeImageTask(job("new-server"));
    expect(claudeImagePoolSize()).toMatchObject({ physical: 1, retiring: 1, waiting: 1 });
    // Reset must preserve the same bound too, even while a later server has work waiting.
    configure();
    await expect(next).rejects.toThrow("replaced");
    const replacement = claudeImageTask(job("after-reset"));
    expect(claudeImagePoolSize()).toMatchObject({ physical: 1, retiring: 1, waiting: 1 });
    hold.release();
    expect((await replacement)!.bytes.length).toBe(4);
    // The replacement thread may reuse the number after close; it must no longer own this file.
    expect(ownsOriginal()).toBe(false);
    later();
    await claudeImageThreadClosed();
    expect(claudeImagePoolSize().physical).toBe(0);
  });

  it.skipIf(process.platform === "win32")("lets the last server's process exit while its retired thread is still in a disk syscall", async () => {
    const fifo = join(temporary(), "shutdown-read");
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    const source = `
      import { claudeImageTask, holdClaudeImagePool, setClaudeImagePoolOptions } from ${JSON.stringify(new URL("./claude-image-pool.ts", import.meta.url).pathname)};
      setClaudeImagePoolOptions({ worker: new URL(${JSON.stringify(fake.href)}) });
      const release = holdClaudeImagePool();
      const cells = new Int32Array(new SharedArrayBuffer(12));
      cells[1] = -1; cells[2] = -1;
      const reading = claudeImageTask({ path: "/synthetic/history", ref: "image", binding: "pane", generation: "{}", gate: { cells: cells.buffer, fifo: ${JSON.stringify(fifo)} } });
      reading.catch(() => {});
      const wait = Atomics.waitAsync(cells, 1, -1, 10000);
      if ((wait.async ? await wait.value : wait.value) === "timed-out") throw new Error("the child never reached its disk read");
      release();
      await reading.catch(() => {});
      console.log("last server released");
    `;
    const child = Bun.spawn([process.execPath, "--eval", source], { stdout: "pipe", stderr: "pipe", env: { ...process.env, HERDR_TEST_MODE: "unit" } });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let code: number | null;
    try {
      code = await Promise.race([child.exited, new Promise<null>((done) => { timer = setTimeout(() => done(null), 3_000); })]);
      if (code === null) {
        // Release a regressed child too; the test must never leave a blocked worker behind.
        const fd = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
        try { writeSync(fd, "x"); } finally { closeSync(fd); }
        await child.exited;
      }
      const stderr = await new Response(child.stderr).text();
      expect(stderr).toBe("");
      expect(await new Response(child.stdout).text()).toContain("last server released");
      expect(code).toBe(0);
    } finally { clearTimeout(timer); child.kill(); await child.exited; }
  });

  it.skipIf(process.platform === "win32")("keeps timers, health HTTP and WebSocket messages responsive during a real held disk read", async () => {
    configure();
    const fifo = join(temporary(), "held-read");
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    const hold = gate(fifo);
    const reading = claudeImageTask(held(job(), hold));
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch(request, server) {
        if (new URL(request.url).pathname === "/ws" && server.upgrade(request)) return;
        return new Response("healthy");
      },
      websocket: { message(ws, message) { ws.send(message); } },
    });
    let ws: WebSocket | undefined;
    try {
      await hold.ran();
      let timerRan = false;
      await new Promise<void>((done) => setImmediate(() => { timerRan = true; done(); }));
      expect(timerRan).toBe(true);
      expect(await (await fetch(`http://127.0.0.1:${server.port}/health`)).text()).toBe("healthy");
      const pong = new Promise<string>((done, fail) => {
        ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
        ws.onopen = () => ws!.send("ping");
        ws.onmessage = (event) => done(String(event.data));
        ws.onerror = () => fail(new Error("the test websocket failed"));
      });
      expect(await pong).toBe("ping");
      expect(claudeImagePoolSize().running).toBe(1);
    } finally { ws?.close(); server.stop(true); hold.release(); await reading; }
  });

  it("accepts exact owned buffers through the size limit and rejects extra backing bytes", async () => {
    configure();
    expect((await claudeImageTask(job("maximum", { size: MAX_IMAGE_BYTES })))!.bytes.buffer.byteLength).toBe(MAX_IMAGE_BYTES);
    const oversized = await claudeImageTask(job("oversized", { size: MAX_IMAGE_BYTES + 1 })).catch((error: Error) => error);
    expect(oversized).toBeInstanceOf(Error);
    expect((oversized as Error).message).toContain("invalid answer");
    await claudeImageThreadClosed();
    const backing = await claudeImageTask(job("pooled-backing", { bad: true })).catch((error: Error) => error);
    expect(backing).toBeInstanceOf(Error);
    expect((backing as Error).message).toContain("invalid answer");
    await claudeImageThreadClosed();
    expect((await claudeImageTask(job("recovered")))!.bytes.length).toBe(4);
  });

  it("retires malformed image and metadata replies without throwing on the bridge", async () => {
    configure();
    for (const name of ["number", "array", "undefined", "reply", "generation"]) {
      const path = `/synthetic/malformed-${name}`;
      for (const work of [() => claudeImageTask({ ...job(), path }), () => claudeImageGeneration(path, "pane-session")]) {
        const error = await work().catch((error: Error) => error);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("invalid answer");
        await claudeImageThreadClosed();
      }
    }
    const malformedGeneration = await claudeImageTask(job("bad-image-generation", { invalidGeneration: true })).catch((error: Error) => error);
    expect(malformedGeneration).toBeInstanceOf(Error);
    expect((malformedGeneration as Error).message).toContain("invalid answer");
    await claudeImageThreadClosed();
    expect(await claudeImageTask({ ...job(), path: "/synthetic/missing-image" })).toBeNull();
    expect(await claudeImageGeneration("/synthetic/missing-image", "pane-session")).toBeNull();
  });

  it("recovers from worker errors only after close, and rejects module startup failures", async () => {
    configure();
    await expect(claudeImageTask(job("worker-error", { fail: true }))).rejects.toThrow("failed");
    await claudeImageThreadClosed();
    expect((await claudeImageTask(job("recovered")))!.bytes.length).toBe(4);
    setClaudeImagePoolOptions({ worker: new URL("./missing-image-worker-for-test.ts", import.meta.url) });
    await expect(claudeImageTask(job("cannot-start"))).rejects.toThrow();
    await claudeImageThreadClosed();
  });
});
