/** Fork GitHub inbox, read with every github.com account gh is signed in with. */
import type { PullRequestEntry } from "./workspace-lifecycle.ts";

export interface GithubPull extends PullRequestEntry {
  repository: string;
  workspace_id?: string;
}
export interface GithubPulls {
  /** every gh account on github.com that was read */
  accounts: string[];
  /** signed-in accounts whose read failed; the rest are still listed */
  failed?: string[];
  review: GithubPull[];
  yours: GithubPull[];
}
