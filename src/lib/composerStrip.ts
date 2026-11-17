import { folderName } from "./paneName.ts";

export interface ComposerStrip {
  folder: string | null;
  path: string | null;
  branch: string | null;
}

export function composerStrip(input: { cwd?: string | null | undefined; branch?: string | null | undefined; repo?: string | null | undefined }): ComposerStrip | null {
  const path = input.cwd !== undefined && input.cwd !== null && input.cwd.trim() !== "" ? input.cwd : null;
  const branch = input.branch !== undefined && input.branch !== null && input.branch.trim() !== "" ? input.branch.trim() : null;
  const repo = input.repo !== undefined && input.repo !== null && input.repo.trim() !== "" ? input.repo.trim() : null;
  if (path === null && branch === null && repo === null) return null;
  return { folder: repo ?? (path === null ? null : folderName(path)), path, branch };
}

export function worktreeRepoName(workspace: { worktree?: { is_linked_worktree: boolean; repo_name: string } | null } | undefined): string | null {
  return workspace?.worktree?.is_linked_worktree === true ? workspace.worktree.repo_name : null;
}
