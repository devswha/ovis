/**
 * The view file of tui/model/view-file.ts on disk: one small file per core id in the screen's state folder (0700, the
 * file 0600), written whole to a new file and renamed over the old one, so a reader never sees half of it. It is
 * written when what it would hold changed, never once per frame; two screens on one core share the file and the last
 * writer wins.
 */
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { errorCode } from "./crash.ts";
import type { ModelState } from "./model/reduce.ts";
import { readView, type SavedView, VIEW_FILE_MAX_BYTES, type ViewProblem, viewText } from "./model/view-file.ts";

/** The file's name for a core id: the id itself when it is a plain word, else its hash (an id never names a path). */
export function viewFileName(core: string): string {
  const plain = /^[A-Za-z0-9_-]{1,64}$/.test(core) ? core : createHash("sha256").update(core).digest("hex").slice(0, 32);
  return `view-${plain}.json`;
}

export class ViewStore {
  private path: string | null = null;
  private last: string | null = null;
  private failed = false;

  constructor(private readonly folder: string) {}

  /** The view kept for core `core`, or why its file could not be used; from now on `keep` writes that core's file. */
  open(core: string): { view: SavedView | null; problem: ViewProblem | null } {
    const path = join(this.folder, viewFileName(core));
    if (path === this.path) return { view: null, problem: null };
    this.path = path;
    this.last = null;
    let text: string;
    try {
      const fd = openSync(path, "r");
      try {
        if (fstatSync(fd).size > VIEW_FILE_MAX_BYTES) return { view: null, problem: "too_large" };
        text = readFileSync(fd, "utf8");
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      return { view: null, problem: errorCode(error) === "ENOENT" ? null : "unreadable" };
    }
    const read = readView(text);
    if ("problem" in read) return { view: null, problem: read.problem };
    this.last = text;
    return { view: read.view, problem: null };
  }

  /**
   * Writes the view of `state` when it differs from what the file holds; not before `open`, not while a kept view
   * waits to be applied. Answers the error's code the first time a write fails (later failures say nothing), else null.
   */
  keep(state: ModelState): string | null {
    if (this.path === null || state.restoring !== null) return null;
    const text = viewText(state.world, state.focus);
    if (text === null || text === this.last) return null;
    this.last = text;
    const temp = `${this.path}.${randomUUID()}.tmp`;
    let made = false;
    try {
      mkdirSync(this.folder, { recursive: true, mode: 0o700 });
      chmodSync(this.folder, 0o700);
      const fd = openSync(temp, "wx", 0o600);
      made = true;
      try {
        writeSync(fd, text);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, this.path);
      return null;
    } catch (error) {
      if (made) rmSync(temp, { force: true });
      if (this.failed) return null;
      this.failed = true;
      return errorCode(error);
    }
  }
}
