/** Fork GitHub inbox, read with the active github.com account in gh. */
import type { PullRequestEntry } from "./workspace-lifecycle.ts";

export interface GithubPull extends PullRequestEntry {
  repository: string;
  workspace_id?: string;
}
export interface GithubPulls {
  account: string;
  review: GithubPull[];
  yours: GithubPull[];
}
