/**
 * Test support, never served: a file thread (`file-worker.ts`) whose tasks can be held. It runs
 * each task for real, then
 * - never answers a task whose path ends in `/stuck`, as a call that never returns would not;
 * - with a `gate` (a SharedArrayBuffer of two Int32 cells), records in cell 1 the descriptor the
 *   task opened, if any, and answers only once cell 0 is set, as a call that returns late would.
 */
import { type FileTask, runFileTask, transferablesOf } from "./file-tasks.ts";

declare const self: Worker;

self.onmessage = (event: MessageEvent<FileTask & { gate?: SharedArrayBuffer }>) => {
  const task = event.data;
  if ("path" in task && task.path.endsWith("/stuck")) return;
  const result = runFileTask(task);
  if (task.gate !== undefined) {
    const cells = new Int32Array(task.gate);
    if (result !== null && typeof result === "object" && "fd" in result) Atomics.store(cells, 1, result.fd);
    Atomics.wait(cells, 0, 0);
  }
  postMessage({ result }, transferablesOf(result));
};
