import { useLayoutEffect, useRef } from "react";

import type { GithubPull, GithubPulls } from "../../../shared/github.ts";

/** Chips count unique URLs, not memberships: a PR may be in more than one group. */
export function githubGroups(listing: GithubPulls, selected: string) {
  const team = listing.team ?? [];
  const unique = new Map([...listing.review, ...listing.yours, ...team].map((pr) => [pr.url, pr]));
  const counts = new Map<string, number>();
  for (const pr of unique.values()) counts.set(pr.repository, (counts.get(pr.repository) ?? 0) + 1);
  if (!counts.has(selected)) selected = "";
  const filter = (rows: GithubPull[]) => rows.filter((pr) => !selected || pr.repository === selected).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return { selected, repos: [...counts].sort(([a], [b]) => a.localeCompare(b)), review: filter(listing.review), yours: filter(listing.yours), team: filter(team) };
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

/** The rows whose title, repository, #number, author or branch hold every word typed, in any case. */
export function githubSearched(rows: readonly GithubPull[], query: string): GithubPull[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...rows];
  return rows.filter((pr) => {
    const text = `${pr.title} ${pr.repository} #${pr.number} ${pr.author ?? ""} ${pr.branch}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/** Where each list and page was scrolled to, kept for this visit to the app. */
const scrolls = new Map<string, number>();

/**
 * Keeps a scrolling element where it was left, per key: once `ready`, it goes back there, again each
 * frame as its content grows into place (lazy diffs), until it gets there, two seconds pass or the user
 * scrolls. Its position is kept as it scrolls.
 */
export function useKeptScroll<T extends HTMLElement>(key: string, ready: boolean) {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const host = ref.current;
    if (host === null || !ready) return;
    const target = scrolls.get(key) ?? 0;
    let holding = target > 0;
    let frame = 0;
    const started = performance.now();
    const hold = (): void => {
      if (!holding) return;
      host.scrollTop = target;
      if (Math.abs(host.scrollTop - target) < 1 || performance.now() - started > 2000) holding = false;
      else frame = requestAnimationFrame(hold);
    };
    if (target === 0) host.scrollTop = 0;
    else hold();
    const release = (): void => { holding = false; };
    const keep = (): void => { if (!holding) scrolls.set(key, host.scrollTop); };
    const kinds = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
    host.addEventListener("scroll", keep, { passive: true });
    for (const kind of kinds) host.addEventListener(kind, release, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      host.removeEventListener("scroll", keep);
      for (const kind of kinds) host.removeEventListener(kind, release);
    };
  }, [key, ready]);
  return ref;
}
