/** Fork GitHub inbox, read with every github.com account gh is signed in with. */
import type { PullRequestEntry } from "./workspace-lifecycle.ts";

export interface GithubPull extends PullRequestEntry {
  repository: string;
  /** the gh account that listed it: its page is read with that account's token */
  account?: string;
  workspace_id?: string;
  /** reviewed by that account, then changed: commits came after its latest review */
  updated_since_review?: boolean;
}
export interface GithubPulls {
  /** every gh account on github.com that was read */
  accounts: string[];
  /** signed-in accounts whose read failed; the rest are still listed */
  failed?: string[];
  review: GithubPull[];
  yours: GithubPull[];
  /** others' open pull requests in the repositories open as workspaces, not in the other two */
  team: GithubPull[];
}

/** One pull request's page (GET /api/fork/github/pull), read with the account that listed it. */
export interface GithubPullDetail {
  repository: string;
  number: number;
  url: string;
  title: string;
  /** Markdown, as written */
  body: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  author: string | null;
  created_at: string;
  updated_at: string;
  head: string;
  base: string;
  fork: boolean;
  additions: number;
  deletions: number;
  changed_files: number;
  commits: number;
  /** check runs and commit statuses of the head commit, counted by outcome */
  checks: { passing: number; failing: number; pending: number; skipped: number };
  /** each of them, problems first */
  check_list: GithubCheck[];
  /** whether GitHub would merge it now, and if not, why */
  merge: "clean" | "conflicts" | "behind" | "blocked" | "unstable" | "draft" | "unknown";
  review: "approved" | "changes_requested" | "review_required" | "none";
  /** each reviewer's latest word, then who is still asked */
  reviewers: { login: string; state: "approved" | "changes_requested" | "commented" | "requested" }[];
  labels: { name: string; color: string }[];
  /** the head commit, which a merge names so that GitHub refuses it when commits came after the page was read */
  head_sha: string;
  /** the account the page was read with */
  viewer: string | null;
  /** whether that account may merge */
  can_write: boolean;
  /** the merge methods the repository allows, GitHub's order */
  merge_methods: ("squash" | "merge" | "rebase")[];
  /** comments, reviews and state changes, oldest first */
  conversation: GithubEntry[];
  /** the changed files, as GitHub lists them (the first 100) */
  files: { path: string; additions: number; deletions: number; change: "added" | "deleted" | "renamed" | "copied" | "modified" }[];
}

export type GithubEntry =
  | { kind: "comment"; author: string | null; at: string; body: string; url: string | null }
  | { kind: "review"; author: string | null; at: string; state: "approved" | "changes_requested" | "commented" | "dismissed"; body: string; url: string | null; threads: GithubThread[] }
  | { kind: "event"; author: string | null; at: string; event: "merged" | "closed" | "reopened" | "ready" | "draft" };

/** Comments on lines of code, opened in one review and answered after it. */
export interface GithubThread {
  path: string;
  line: number | null;
  /** the side of the diff the line is on: the base's lines (old) or the head's (new) */
  side: "old" | "new";
  resolved: boolean;
  outdated: boolean;
  /** the last lines of the diff hunk the thread is on, as GitHub sends them (+, - or space first) */
  hunk: string;
  comments: { author: string | null; at: string; body: string }[];
}

export interface GithubCheck {
  name: string;
  /** the Actions workflow a check run belongs to */
  workflow: string | null;
  outcome: "passing" | "failing" | "pending" | "skipped";
  required: boolean;
  started_at: string | null;
  completed_at: string | null;
  /** a status's one-line description */
  description: string | null;
  url: string | null;
}

/** One changed file's patch, git's form from its `diff --git` line on; null when GitHub sends none (binary, or too large). */
export interface GithubFilePatch {
  path: string;
  /** the name before a rename */
  previous: string | null;
  patch: string | null;
}

/** Where a clone of a repository would go, and what is there now: nothing, a checkout of it, or something else. */
export interface GithubClonePlace {
  path: string;
  /** the folder as shown, with `~` for the home folder */
  shown: string;
  state: "free" | "same" | "taken";
}
