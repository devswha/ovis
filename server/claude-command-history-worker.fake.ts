/** A real blocking syscall gate: terminate cannot release its physical worker slot. */
import { closeSync, constants, existsSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import type { HistoryChunk } from "./claude-command-history.ts";
import { historyChunk } from "./claude-command-history-worker.ts";
self.onmessage = (event: MessageEvent<HistoryChunk>) => {
  const task = event.data;
  if (existsSync(`${task.path}.hold`)) {
    const gate = JSON.parse(readFileSync(`${task.path}.hold`, "utf8")) as { fifo: string; ready: string };
    const fd = openSync(gate.fifo, constants.O_RDWR);
    writeFileSync(gate.ready, String(fd));
    try { readSync(fd, new Uint8Array(1), 0, 1, null); } finally { closeSync(fd); }
  }
  try { postMessage({ result: historyChunk(task) }); } catch { postMessage({ error: "unavailable" }); }
};
