import type { GithubPull, GithubPulls } from "../../shared/github.ts";

/** Chips count unique URLs, not memberships: a PR may be in both groups. */
export function githubGroups(listing: GithubPulls, selected: string) {
  const unique = new Map([...listing.review, ...listing.yours].map((pr) => [pr.url, pr]));
  const counts = new Map<string, number>();
  for (const pr of unique.values()) counts.set(pr.repository, (counts.get(pr.repository) ?? 0) + 1);
  if (!counts.has(selected)) selected = "";
  const filter = (rows: GithubPull[]) => rows.filter((pr) => !selected || pr.repository === selected).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return { selected, repos: [...counts].sort(([a], [b]) => a.localeCompare(b)), review: filter(listing.review), yours: filter(listing.yours) };
}

/** Problems first; a passing check alone is not an approval. */
export function githubStatus(pr: GithubPull, requested: boolean) {
  if (pr.checks === "failing") return "Checks failing";
  if (pr.review === "changes_requested") return "Changes requested";
  if (requested || pr.review === "review_required") return "Review requested";
  if (pr.draft) return "Draft";
  if (pr.checks === "pending") return "Checks running";
  if (pr.review === "approved") return "Approved";
  return "Ready";
}

const REPO_KEY = "ovis:fork-github-repo";
export function loadGithubRepo(): string {
  try { return window.localStorage.getItem(REPO_KEY) ?? ""; } catch { return ""; }
}
export function saveGithubRepo(repo: string): void {
  try { window.localStorage.setItem(REPO_KEY, repo); } catch { /* storage may be disabled */ }
}
