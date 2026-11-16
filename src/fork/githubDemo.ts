import type { GithubPull, GithubPulls } from "../../shared/github.ts";
import type { WorkspaceInfo } from "../../shared/protocol.ts";

type DemoPull = Pick<GithubPull, "number" | "title" | "branch" | "checks" | "review"> & Partial<Pick<GithubPull, "draft" | "author">>;

/** Fictional PRs for the demo's two repositories; never reads gh or the user's session. */
export function demoGithubPulls(workspaces: WorkspaceInfo[]): GithubPulls {
  const row = (repo: string, pr: DemoPull): GithubPull => ({
    draft: false, fork: false, checkout: null, author: "demo", updated_at: "2026-09-25T09:38:00.000Z", ...pr,
    repository: `demo/${repo}`, url: `https://github.com/demo/${repo}/pull/${pr.number}`,
    workspace_id: workspaces.find((workspace) => workspace.worktree?.repo_name === repo)?.workspace_id,
  });
  return {
    accounts: ["demo"],
    review: [
      row("checkout-api", { number: 127, title: "Document the release steps", branch: "docs/release-steps", checks: "passing", review: "review_required", author: "maria" }),
      row("cli-tools", { number: 88, title: "Validate the config file before starting", branch: "fix/config-validation", checks: "failing", review: "review_required", author: "sam" }),
    ],
    yours: [
      row("checkout-api", { number: 142, title: "Retry the export when the connection drops", branch: "feat/export-guard", checks: "passing", review: "approved" }),
      row("cli-tools", { number: 139, title: "Add the retry flag to the CLI", branch: "feat/retry-flag", checks: "pending", review: "none", draft: true }),
    ],
  };
}
