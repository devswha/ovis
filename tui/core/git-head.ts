/**
 * The branch of the git checkout a folder is in, for the sidebar's branch row (docs/tui/visual-parity.md S4). The screen
 * starts no process and never asks the Ovis server, so it reads git's own files: `.git` found walking up from the folder
 * as git does (a linked worktree's `.git` is a file naming its git folder), then that folder's `HEAD`. Ahead and behind
 * would need git's object store, so the screen shows the branch alone.
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** More than any HEAD or `.git` file git writes: anything larger is not one. */
const MOST_BYTES = 4096;

/** A regular file's text, when it is one and small; null otherwise (a FIFO in its place must never hold the screen). */
function smallFile(path: string): string | null {
  try {
    const found = statSync(path);
    return found.isFile() && found.size <= MOST_BYTES ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

/** The git folder that `.git` at `dotGit` stands for; undefined when there is no `.git` there, null when it is unreadable. */
function gitFolder(dotGit: string): string | null | undefined {
  let found;
  try {
    found = statSync(dotGit);
  } catch {
    return undefined;
  }
  if (found.isDirectory()) return dotGit;
  const named = /^gitdir: (.+)$/m.exec(smallFile(dotGit) ?? "")?.[1]?.trim();
  return named ? resolve(dirname(dotGit), named) : null;
}

/**
 * The branch checked out in the checkout `folder` is in; a detached HEAD gives its commit's first seven characters.
 * null outside a checkout, for a folder that is not absolute, and when git's files cannot be read.
 */
export function branchOf(folder: string): string | null {
  if (!isAbsolute(folder)) return null;
  for (let at = resolve(folder); ; at = dirname(at)) {
    const git = gitFolder(join(at, ".git"));
    if (git !== undefined) {
      const head = git === null ? null : smallFile(join(git, "HEAD"))?.trim() ?? null;
      if (head === null) return null;
      const branch = /^ref: refs\/heads\/(.+)$/.exec(head)?.[1];
      if (branch) return branch;
      return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(head) ? head.slice(0, 7) : null;
    }
    if (dirname(at) === at) return null;
  }
}
