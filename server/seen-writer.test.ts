import { expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SeenStore } from "./seen.ts";
import { writeStateDocument } from "./state-document.ts";

it("serializes commits, publishes only durable state, and drains on close", async () => {
  const dir = mkdtempSync(join(tmpdir(), "seen-writer-"));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let writes = 0;
  const store = new SeenStore(dir, undefined, async (path, text, damaged) => {
    writes++;
    if (writes === 1) { entered.resolve(); await release.promise; }
    writeStateDocument(path, text, damaged);
  });
  const finish = (id: number) => ({ pc: "local", epoch: "e", pane: "p", id });
  const told: number[] = [];
  store.subscribe((value) => told.push(value.id));
  try {
    const first = store.record(finish(2));
    const older = store.record(finish(1));
    const newer = store.record(finish(3));
    await entered.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(store.list()).toEqual([]);
    expect(told).toEqual([]);
    expect(writes).toBe(1);
    let closed = false;
    const closing = store.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    release.resolve();
    expect(await first).toEqual(finish(2));
    expect(await older).toEqual(finish(2));
    await newer;
    await closing;
    expect(told).toEqual([2, 3]);
    expect(writes).toBe(2);
    expect(new SeenStore(dir).list()).toEqual([finish(3)]);
    expect(JSON.parse(readFileSync(join(dir, "seen.json"), "utf8"))).toEqual([finish(3)]);
    await expect(store.record(finish(4))).rejects.toThrow("closed");
  } finally { release.resolve(); await store.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("bounds accepted work and recovers after a failed commit without publishing it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "seen-writer-"));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  const store = new SeenStore(dir, undefined, async (path, text, damaged) => {
    if (++calls === 1) { entered.resolve(); await release.promise; throw new Error("fixture disk failure"); }
    writeStateDocument(path, text, damaged);
  });
  const finish = (id: number) => ({ pc: "local", epoch: "e", pane: "p", id });
  const told: number[] = [];
  store.subscribe((value) => told.push(value.id));
  try {
    const first = store.record(finish(99)).catch((error: Error) => error.message);
    await entered.promise;
    const rest = Array.from({ length: 499 }, () => store.record(finish(2)));
    await expect(store.record(finish(3))).rejects.toThrow("queue is full");
    expect(told).toEqual([]);
    release.resolve();
    expect(await first).toBe("fixture disk failure");
    await Promise.all(rest);
    expect(calls).toBe(2);
    expect(told).toEqual([2]);
    await store.record(finish(3));
    expect(new SeenStore(dir).list()).toEqual([finish(3)]);
  } finally { release.resolve(); await store.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("queues pane moves behind accepted records and ahead of subsequent records", async () => {
  const dir = mkdtempSync(join(tmpdir(), "seen-writer-"));
  const store = new SeenStore(dir);
  const finish = { pc: "local", epoch: "e", pane: "old", id: 2 };
  try {
    const record = store.record(finish);
    const move = store.moved("local", "old", "new", (id) => id + 2);
    const later = store.record({ ...finish, pane: "new", id: 3 });
    await Promise.all([record, move, later]);
    expect(await later).toEqual({ ...finish, pane: "new", id: 4 });
    expect(new SeenStore(dir).list()).toEqual(store.list());
  } finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
});
