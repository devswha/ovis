import { fstatSync, statSync } from "node:fs";

/** A worker's file-generation fence; no transcript bytes or stat calls run on the bridge. */
export function claudeImageFileGeneration(path: string | number): string | null {
  try {
    const stat = typeof path === "number" ? fstatSync(path, { bigint: true }) : statSync(path, { bigint: true });
    if (!stat.isFile()) return null;
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
  } catch { return null; }
}

/** Only the worker supplies this context; the cooperative caller keeps its existing two arguments. */
export interface ClaudeImageRead {
  expected: string;
  opened?: Int32Array<SharedArrayBuffer>;
  observed?: string;
}
