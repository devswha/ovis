import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";

/**
 * A shared state document as it is on disk (preferences.json, seen.json): absent, JSON for its
 * store to check, or bytes that are not JSON. A read that fails otherwise (permissions, a
 * directory in its place) throws: an unreadable file is not an absent one.
 */
export type StateDocument = { kind: "missing" } | { kind: "json"; value: unknown } | { kind: "malformed" };

export function readStateDocument(path: string): StateDocument {
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw error;
  }
  try { return { kind: "json", value: JSON.parse(text) }; } catch { return { kind: "malformed" }; }
}

/** The name a damaged document is kept under until the next damaged one replaces it. */
export const damagedCopy = (path: string): string => `${path}.bad`;

/**
 * Moves a document that is not JSON out of the way at once, bytes untouched, to
 * `<path>.corrupt-<time>` (0600, as damagedCopy's), so its store can start empty instead of
 * refusing to start. Each one keeps a name of its own: these documents (machines.json,
 * herdr-profile-state.json) hold what cannot be recomputed, so an earlier damaged copy is never
 * replaced. Returns the new path; throws, leaving `path` as it was, when the file cannot be moved,
 * saying why so a start that stops on it can be understood from its log.
 */
export function setAsideDamaged(path: string, now = new Date()): string {
  // no ':' in a Windows file name
  const aside = `${path}.corrupt-${now.toISOString().replace(/[:.]/g, "-")}`;
  try {
    chmodSync(path, 0o600);
    renameSync(path, aside);
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : String(error));
    throw new Error(`${basename(path)} is not JSON and cannot be set aside as ${basename(aside)} (${reason})`);
  }
  return aside;
}

/**
 * Replaces the document at `path` with `text` through a private temporary file. With
 * `keepDamaged`, the file now at `path` is first moved, bytes untouched, to `<path>.bad` (0600),
 * replacing an older one; when it cannot be kept the write is refused and `path` is left as it
 * was. Synchronous, so nothing else in this process writes the file in between.
 */
export function writeStateDocument(path: string, text: string, keepDamaged: boolean): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  if (keepDamaged) {
    try {
      chmodSync(path, 0o600);
      renameSync(path, damagedCopy(path));
    } catch (error) {
      rmSync(temporary, { force: true });
      const reason = (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : String(error));
      throw new Error(`Cannot keep the damaged ${basename(path)} as ${basename(damagedCopy(path))} (${reason}), so it was not replaced`);
    }
  }
  renameSync(temporary, path);
}
