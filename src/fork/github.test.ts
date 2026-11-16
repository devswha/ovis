import { expect, test } from "bun:test";
import type { GithubPull, GithubPulls } from "../../shared/github.ts";
import { githubGroups, githubStatus } from "./github.ts";

const row = (repository: string, number: number): GithubPull => ({ repository, number, title: "Title", url: `https://github.com/${repository}/pull/${number}`, branch: "topic", author: "me", draft: false, fork: false, updated_at: `2026-01-0${number}`, checks: "none", review: "none", checkout: null });
const listing: GithubPulls = { accounts: ["me"], review: [row("a/one", 1), row("b/two", 3)], yours: [row("a/one", 2), row("b/two", 3)], team: [row("a/one", 4)] };

test("repo chips count unique PRs, default to All and filter both sorted groups", () => {
  const all = githubGroups(listing, "missing/repo");
  expect(all.selected).toBe("");
  expect(all.repos).toEqual([["a/one", 3], ["b/two", 1]]);
  expect(all.team.map((pr) => pr.number)).toEqual([4]);
  expect(all.review.map((pr) => pr.number)).toEqual([3, 1]);
  expect(all.yours.map((pr) => pr.number)).toEqual([3, 2]);
  expect(githubGroups(listing, "a/one").review.map((pr) => pr.number)).toEqual([1]);
  expect(githubGroups(listing, "a/one").yours.map((pr) => pr.number)).toEqual([2]);
  expect(githubGroups({ accounts: ["me"], review: [], yours: [], team: [] }, "a/one").selected).toBe("");
});

test("uses one deterministic status, never hiding a failed check or requested changes", () => {
  const pr = row("a/one", 1);
  expect(githubStatus({ ...pr, draft: true, checks: "failing", review: "approved" }, true)).toBe("Checks failing");
  expect(githubStatus({ ...pr, checks: "pending", review: "changes_requested" }, true)).toBe("Changes requested");
  expect(githubStatus(pr, true)).toBe("Review requested");
  expect(githubStatus({ ...pr, review: "review_required" }, false)).toBe("Review requested");
  expect(githubStatus({ ...pr, draft: true }, false)).toBe("Draft");
  expect(githubStatus({ ...pr, checks: "pending", review: "approved" }, false)).toBe("Checks running");
  expect(githubStatus({ ...pr, review: "approved" }, false)).toBe("Approved");
});
