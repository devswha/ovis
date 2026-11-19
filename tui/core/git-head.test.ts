import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branchOf } from "./git-head.ts";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** A scratch folder holding `files` (path to text), as git leaves them on disk. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(process.env["TMPDIR"] || tmpdir(), "git-head-"));
  folders.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

describe("the branch a folder's checkout is on, from git's files", () => {
  it("reads HEAD from the folder or any folder above it", () => {
    const root = tree({ "repo/.git/HEAD": "ref: refs/heads/feature/sidebar\n", "repo/src/deep/keep": "" });
    expect(branchOf(join(root, "repo"))).toBe("feature/sidebar");
    expect(branchOf(join(root, "repo", "src", "deep"))).toBe("feature/sidebar");
  });

  it("follows a linked worktree's .git file to its git folder, relative or absolute", () => {
    const root = tree({ "main/.git/worktrees/wt/HEAD": "ref: refs/heads/topic\n", "wt/.git": "gitdir: ../main/.git/worktrees/wt\n" });
    expect(branchOf(join(root, "wt"))).toBe("topic");
    writeFileSync(join(root, "wt", ".git"), `gitdir: ${join(root, "main", ".git", "worktrees", "wt")}\n`);
    expect(branchOf(join(root, "wt"))).toBe("topic");
  });

  it("gives a detached HEAD's commit by its first seven characters", () => {
    expect(branchOf(join(tree({ "repo/.git/HEAD": `${COMMIT}\n` }), "repo"))).toBe("0123456");
  });

  it("is null outside a checkout, for a relative folder, and where git's files make no sense", () => {
    const root = tree({ "plain/keep": "", "odd/.git/HEAD": "nonsense\n", "nohead/.git/config": "", "badlink/.git": "not a gitdir line\n" });
    // the scratch folder sits under the user's temp folder: nothing above it may be a checkout for this case to hold
    expect(branchOf(join(root, "plain"))).toBeNull();
    expect(branchOf("repo")).toBeNull();
    for (const folder of ["odd", "nohead", "badlink"]) expect({ folder, branch: branchOf(join(root, folder)) }).toEqual({ folder, branch: null });
  });

  it("reads no HEAD that is not a regular file, so a FIFO in its place cannot hold the screen", async () => {
    const root = tree({ "repo/.git/keep": "" });
    const made = Bun.spawn(["mkfifo", join(root, "repo", ".git", "HEAD")], { env: { PATH: "/usr/bin:/bin" } });
    expect(await made.exited).toBe(0);
    expect(branchOf(join(root, "repo"))).toBeNull();
  });
});
