import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { commandTerminals } from "./claude-subagents.ts";
import type { HistoryCheckpoint, HistoryChunk, HistoryVersion } from "./claude-command-history.ts";

const CHUNK = 1024 * 1024;
/** One bounded buffer, including oversized/torn records; skipped records never prove absence. */
export function historyChunk(task: HistoryChunk): HistoryCheckpoint {
  const fd = openSync(task.path, "r");
  try {
    const stat = fstatSync(fd);
    const version: HistoryVersion = { id: `${stat.dev}:${stat.ino}`, size: stat.size, mtimeMs: stat.mtimeMs };
    if (version.id !== task.version.id || version.size < task.version.size || (version.size === task.version.size && version.mtimeMs !== task.version.mtimeMs)) throw new Error("history replaced");
    const witness = (offset: number): string => {
      const hash = createHash("sha256");
      for (const from of [0, Math.max(0, offset - 256)]) {
        // Only consumed bytes belong to a checkpoint; appending to a short file cannot change it.
        const bytes = Buffer.alloc(Math.min(256, Math.max(0, offset - from)));
        const got = readSync(fd, bytes, 0, bytes.length, from);
        hash.update(bytes.subarray(0, got));
      }
      return hash.digest("hex");
    };
    if (task.witness !== null && witness(task.offset) !== task.witness) throw new Error("history rewritten");
    // A captured boundary may split a record. Finish that record after an append, still within
    // one bounded buffer, so a transient partial write cannot permanently poison coverage.
    const limit = Math.max(task.limit, version.size);
    const buffer = Buffer.alloc(Math.min(CHUNK, limit - task.offset));
    const got = readSync(fd, buffer, 0, buffer.length, task.offset);
    const bytes = buffer.subarray(0, got);
    let from = 0;
    let skipping = task.skipping;
    let uncertain = false;
    let waiting = false;
    const ends: HistoryCheckpoint["ends"] = [];
    if (skipping) {
      const end = bytes.indexOf(10);
      from = end < 0 ? got : end + 1;
      skipping = end < 0;
    }
    let offset = task.offset + from;
    const until = performance.now() + 25;
    while (!skipping && from < got) {
      const end = bytes.indexOf(10, from);
      if (end < 0) {
        if (from === 0 && got === CHUNK) { offset += got; skipping = true; uncertain = true; }
        else if (task.offset + got >= limit) waiting = true; // resume at the partial record once more bytes arrive
        break;
      }
      const line = bytes.subarray(from, end).toString("utf8");
      try { if (line.trim() !== "") JSON.parse(line); } catch { uncertain = true; }
      for (const terminal of commandTerminals(line)) {
        if (ends.length < 5000) ends.push(terminal); else uncertain = true;
      }
      from = end + 1;
      offset = task.offset + from;
      if (performance.now() >= until) break;
    }
    const after = fstatSync(fd);
    if (`${after.dev}:${after.ino}` !== version.id || after.size < version.size || (after.size === version.size && after.mtimeMs !== version.mtimeMs)) throw new Error("history changed during read");
    return { version, offset, skipping, witness: witness(offset), uncertain, waiting, ends };
  } finally { closeSync(fd); }
}
if (!Bun.isMainThread) {
  self.onmessage = (event: MessageEvent<HistoryChunk>) => {
    try { postMessage({ result: historyChunk(event.data) }); }
    catch { postMessage({ error: "historical command evidence unavailable" }); }
  };
}
