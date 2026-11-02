import type { BigIntStats, Stats } from "node:fs";

/** Exact native identity, with numeric byte positions and sub-millisecond clocks for parsers. */
export interface TranscriptVersion { id: string; size: number; mtimeMs: number }
/** Convert once at millisecond precision; converting the whole epoch nanoseconds first double-rounds. */
export const transcriptMilliseconds = (ns: bigint): number => Number(ns / 1_000_000n) + Number(ns % 1_000_000n) / 1_000_000;
export const transcriptVersion = (stat: Stats | BigIntStats): TranscriptVersion | null => stat.isFile()
  ? { id: `${stat.dev}:${stat.ino}`, size: Number(stat.size), mtimeMs: "mtimeNs" in stat ? transcriptMilliseconds(stat.mtimeNs) : stat.mtimeMs } : null;
export const sameTranscriptVersion = (a: TranscriptVersion, b: TranscriptVersion): boolean =>
  a.id === b.id && a.size === b.size && a.mtimeMs === b.mtimeMs;

/** Metadata permits an append; unchanged terminal bytes still need their separate line proof. */
export const appendCompatibleTranscript = (older: TranscriptVersion, newer: TranscriptVersion): boolean =>
  older.id === newer.id && newer.size >= older.size && (newer.size !== older.size || newer.mtimeMs === older.mtimeMs);
