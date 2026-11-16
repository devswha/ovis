import type { GithubFilePatch, GithubPull, GithubPullDetail, GithubPulls } from "../../shared/github.ts";
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
    team: [
      row("checkout-api", { number: 145, title: "Cache the tax tables per region", branch: "perf/tax-cache", checks: "passing", review: "review_required", author: "lee" }),
    ],
  };
}

const DEMO_PATCH = `diff --git a/src/retry.ts b/src/retry.ts
--- a/src/retry.ts
+++ b/src/retry.ts
@@ -1,6 +1,9 @@
 export async function retry<T>(run: () => Promise<T>, tries = 3): Promise<T> {
-  for (let attempt = 1; ; attempt++) {
+  for (let attempt = 1; attempt <= tries; attempt++) {
     try { return await run(); }
-    catch (error) { if (attempt >= tries) throw error; }
+    catch (error) {
+      if (attempt === tries) throw error;
+      await new Promise((done) => setTimeout(done, 2 ** attempt * 250));
+    }
   }
 }
`;

/** A listed demo PR's page, built from its row; null for one the demo does not list. */
export function demoGithubPull(workspaces: WorkspaceInfo[], repository: string, number: number): GithubPullDetail | null {
  const { review, yours } = demoGithubPulls(workspaces);
  const row = [...review, ...yours].find((pull) => pull.repository === repository && pull.number === number);
  if (!row) return null;
  const at = row.updated_at;
  const failing = row.checks === "failing" ? 1 : 0;
  const pending = row.checks === "pending" ? 1 : 0;
  return {
    repository, number, url: row.url, title: row.title, state: "open", draft: row.draft, author: row.author, created_at: at, updated_at: at,
    body: "Retries a failed call with a growing wait between tries, so a short outage no longer ends the run.",
    head: row.branch, base: "main", fork: false, additions: 4, deletions: 2, changed_files: 1, commits: 2,
    checks: { passing: 2 - failing - pending, failing, pending, skipped: 0 },
    check_list: [
      { name: "test", workflow: "CI", outcome: failing ? "failing" : pending ? "pending" : "passing", required: true, started_at: at, completed_at: pending ? null : at, description: null, url: null },
      { name: "lint", workflow: "CI", outcome: "passing", required: true, started_at: at, completed_at: at, description: null, url: null },
    ],
    merge: row.draft ? "draft" : failing ? "unstable" : "clean",
    review: row.review, reviewers: row.review === "approved" ? [{ login: "mira", state: "approved" }] : [{ login: "mira", state: "requested" }],
    labels: [{ name: "reliability", color: "0e8a16" }], head_sha: "0000000000000000000000000000000000000000", viewer: "demo",
    can_write: true, merge_methods: ["squash", "merge"],
    conversation: [{
      kind: "review", author: "mira", at, state: "commented", body: "", url: null,
      threads: [{ path: "src/retry.ts", line: 7, side: "new", resolved: false, outdated: false, hunk: "+      await new Promise((done) => setTimeout(done, 2 ** attempt * 250));",
        comments: [{ author: "mira", at, body: "Cap the wait: after eight tries this waits over a minute." }] }],
    }],
    files: [{ path: "src/retry.ts", additions: 4, deletions: 2, change: "modified" }],
  };
}

/** The demo PR's one file, with its patch. */
export const demoGithubFiles = (): GithubFilePatch[] => [{ path: "src/retry.ts", previous: null, patch: DEMO_PATCH }];
