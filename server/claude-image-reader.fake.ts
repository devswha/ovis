/** Holds the real scanner inside its first filesystem read, never used by the server. */
import { spyOn } from "bun:test";
import * as fs from "node:fs";
import type { ClaudeImageRequest } from "./claude-image-pool.ts";
import { readClaudeImage } from "./claude-image-worker.ts";

declare const self: Worker;
interface Gate { cells: SharedArrayBuffer; fifo: string }
self.onmessage = async (event: MessageEvent<ClaudeImageRequest>) => {
  const request = event.data;
  const gate = (request.job as typeof request.job & { readGate?: Gate }).readGate;
  const original = fs.readSync;
  let held = false;
  const spy = gate === undefined ? null : spyOn(fs, "readSync").mockImplementation(((fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null) => {
    if (!held) {
      held = true;
      const cells = new Int32Array(gate.cells);
      const fifo = fs.openSync(gate.fifo, fs.constants.O_RDWR);
      Atomics.store(cells, 2, fifo);
      Atomics.store(cells, 1, fd);
      Atomics.notify(cells, 1);
      try { original(fifo, new Uint8Array(1), 0, 1, null); }
      finally { if (Atomics.exchange(cells, 2, -1) >= 0) fs.closeSync(fifo); }
    }
    return original(fd, buffer, offset, length, position);
  }) as typeof fs.readSync);
  try {
    const result = await readClaudeImage(request);
    postMessage({ id: request.id, result }, result !== null && "bytes" in result ? [result.bytes.buffer] : []);
  } catch (error) { postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) }); }
  finally { spy?.mockRestore(); }
};
