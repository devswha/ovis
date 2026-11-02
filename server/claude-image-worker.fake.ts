/** Real thread test harness: a held read, an Atomics gate, and deliberately invalid replies. */
import { closeSync, constants, openSync, readSync } from "node:fs";
import type { ClaudeImageRequest } from "./claude-image-pool.ts";

declare const self: Worker;
interface Gate { cells: SharedArrayBuffer; fifo?: string }
self.onmessage = (event: MessageEvent<ClaudeImageRequest>) => {
  const request = event.data;
  const malformed = request.job.path.split("/").at(-1);
  if (malformed?.startsWith("malformed-")) {
    if (malformed === "malformed-reply") postMessage(null);
    else postMessage({ id: request.id, result: malformed === "malformed-number" ? 1 : malformed === "malformed-array" ? [] : malformed === "malformed-generation" ? { generation: 1 } : undefined });
    return;
  }
  if (malformed === "missing-image") { postMessage({ id: request.id, result: null }); return; }
  if (request.job.op !== undefined) { postMessage({ id: request.id, result: { generation: "test-file-generation" } }); return; }
  const task = JSON.parse(request.job.generation) as { bad?: boolean; fail?: boolean; size?: number; open?: boolean; invalidGeneration?: boolean };
  const opened = task.open ? openSync(request.job.path, "r") : -1;
  if (request.opened !== undefined) Atomics.store(request.opened, 0, opened);
  const held = (request.job as typeof request.job & { gate?: Gate }).gate;
  if (held !== undefined) {
    const cells = new Int32Array(held.cells);
    const fd = held.fifo === undefined ? -1 : openSync(held.fifo, constants.O_RDWR);
    Atomics.store(cells, 2, fd);
    Atomics.store(cells, 1, opened >= 0 ? opened : 1);
    Atomics.notify(cells, 1);
    if (fd >= 0) {
      try { readSync(fd, new Uint8Array(1), 0, 1, null); }
      finally { if (Atomics.exchange(cells, 2, -1) >= 0) closeSync(fd); }
    } else Atomics.wait(cells, 0, 0);
  }
  if (opened >= 0 && (request.opened === undefined || Atomics.compareExchange(request.opened, 0, opened, -1) === opened)) closeSync(opened);
  if (task.fail) throw new Error("test failure");
  const bytes = new Uint8Array(task.size ?? 4).fill(17);
  const result = { mediaType: "image/png", generation: task.invalidGeneration ? 1 : request.job.generation, bytes: task.bad ? bytes.subarray(1) : bytes };
  postMessage({ id: request.id, result }, [bytes.buffer]);
};
