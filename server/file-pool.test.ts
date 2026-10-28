import { afterEach, describe, expect, it } from "bun:test";
import { closeSync, fstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FileInfo } from "../shared/protocol.ts";
import { FileBusyError, filePoolSize, fileTask, setFilePoolOptions } from "./file-pool.ts";
import type { FileTask, OpenedFile } from "./file-tasks.ts";

const fake = new URL("./file-worker.fake.ts", import.meta.url);

/** A held answer: the thread runs its task, then waits until `release`. */
const gate = () => {
  const cells = new Int32Array(new SharedArrayBuffer(8));
  cells[1] = -1;
  return { buffer: cells.buffer as SharedArrayBuffer, opened: () => cells[1]!, release: () => { Atomics.store(cells, 0, 1); Atomics.notify(cells, 0); } };
};
const held = (task: FileTask, buffer: SharedArrayBuffer): FileTask & { gate: SharedArrayBuffer } => ({ ...task, gate: buffer });
/** The descriptor the held thread opened, once it has opened it (its thread may start late). */
const openedBy = async (hold: ReturnType<typeof gate>): Promise<number> => {
  const deadline = Date.now() + 10_000;
  while (hold.opened() < 0) {
    if (Date.now() > deadline) throw new Error("the held thread never opened its file");
    await Bun.sleep(10);
  }
  return hold.opened();
};

describe("file threads", () => {
  let root: string;
  let file: string;
  const setUp = (options: Parameters<typeof setFilePoolOptions>[0]) => {
    root = mkdtempSync(join(tmpdir(), "ovis-file-pool-"));
    file = join(root, "notes.txt");
    writeFileSync(file, "hello");
    setFilePoolOptions({ worker: fake, ...options });
  };
  afterEach(() => {
    setFilePoolOptions();
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses at once past its threads and its waiting places, and runs the rest once threads answer", async () => {
    setUp({ workers: 2, waiting: 1, deadlineMs: 30_000 });
    const hold = gate();
    const running = [fileTask<FileInfo | null>(held({ op: "info", path: file }, hold.buffer)), fileTask<FileInfo | null>(held({ op: "info", path: file }, hold.buffer))];
    const waiting = fileTask<FileInfo | null>({ op: "info", path: file });
    expect(filePoolSize()).toEqual({ threads: 2, idle: 0, waiting: 1 });
    await expect(fileTask({ op: "info", path: file })).rejects.toBeInstanceOf(FileBusyError);
    hold.release();
    for (const answer of await Promise.all([...running, waiting])) expect(answer).toMatchObject({ name: "notes.txt", size: 5 });
    expect(filePoolSize()).toEqual({ threads: 2, idle: 2, waiting: 0 });
  });

  it("refuses a task at its deadline, and keeps its thread taken until the call returns", async () => {
    setUp({ workers: 1, waiting: 1, deadlineMs: 200 });
    const hold = gate();
    await expect(fileTask(held({ op: "info", path: file }, hold.buffer))).rejects.toBeInstanceOf(FileBusyError);
    // the call has not returned: a task after it waits for its thread, never gets it, and is refused in turn
    await expect(fileTask({ op: "info", path: file })).rejects.toBeInstanceOf(FileBusyError);
    expect(filePoolSize()).toEqual({ threads: 1, idle: 0, waiting: 0 });
    const next = fileTask<FileInfo | null>({ op: "info", path: file });
    hold.release();
    expect(await next).toMatchObject({ size: 5 });
    expect(filePoolSize()).toEqual({ threads: 1, idle: 1, waiting: 0 });
  });

  it("closes a descriptor a late answer opened, and frees its thread for the next task", async () => {
    setUp({ workers: 1, waiting: 1, deadlineMs: 300 });
    const hold = gate();
    await expect(fileTask<OpenedFile | null>(held({ op: "open", path: file }, hold.buffer))).rejects.toBeInstanceOf(FileBusyError);
    // the deadline may pass before the thread even starts: the open still comes, and its answer late
    const fd = await openedBy(hold);
    // the next task waits for that thread, which answers once released; by then the late answer was handled
    const next = fileTask<FileInfo | null>({ op: "info", path: file });
    hold.release();
    expect(await next).toMatchObject({ size: 5 });
    expect(() => fstatSync(fd)).toThrow();
  });

  it("gives a folder walk, many calls rather than one, the longer deadline", async () => {
    setUp({ workers: 2, waiting: 0, deadlineMs: 150, longDeadlineMs: 30_000 });
    const hold = gate();
    const walk = fileTask<string[]>(held({ op: "walk", cwd: root }, hold.buffer));
    // a one-call task held as long is refused at the short deadline; the walk is still waited for
    await expect(fileTask(held({ op: "info", path: file }, hold.buffer))).rejects.toBeInstanceOf(FileBusyError);
    hold.release();
    expect(await walk).toEqual(["notes.txt"]);
  });

  it("closes a descriptor whose thread is ended before it answers", async () => {
    setUp({ workers: 1, waiting: 0, deadlineMs: 30_000 });
    const hold = gate();
    const opening = fileTask<OpenedFile | null>(held({ op: "open", path: file }, hold.buffer));
    const fd = await openedBy(hold);
    expect(fstatSync(fd).size).toBe(5);
    // the thread is ended mid-task, as one that fails would be: what it opened is never handed over
    setFilePoolOptions();
    await expect(opening).rejects.toThrow("replaced");
    expect(() => fstatSync(fd)).toThrow();
  });

  it("refuses a task waiting for a thread at its deadline", async () => {
    setUp({ workers: 1, waiting: 1, deadlineMs: 200 });
    const [stuck, waiting] = await Promise.allSettled([fileTask({ op: "info", path: join(root, "stuck") }), fileTask({ op: "info", path: file })]);
    expect(stuck.status === "rejected" && stuck.reason).toBeInstanceOf(FileBusyError);
    expect(waiting.status === "rejected" && waiting.reason).toBeInstanceOf(FileBusyError);
    expect(filePoolSize()).toEqual({ threads: 1, idle: 0, waiting: 0 });
  });

  it("runs every task on a real thread and answers as the calling thread would", async () => {
    setFilePoolOptions();
    root = mkdtempSync(join(tmpdir(), "ovis-file-pool-"));
    writeFileSync(join(root, "a.log"), "line\n");
    expect(await fileTask<FileInfo | null>({ op: "info", path: join(root, "a.log") })).toMatchObject({ name: "a.log", kind: "text", size: 5 });
    expect(await fileTask({ op: "info", path: root })).toBeNull();
    expect(await fileTask({ op: "walk", cwd: root })).toEqual(["a.log"]);
    const opened = await fileTask<OpenedFile | null>({ op: "open", path: join(root, "a.log") });
    expect(opened?.size).toBe(5);
    expect(fstatSync(opened!.fd).size).toBe(5);
    closeSync(opened!.fd);
  });
});
