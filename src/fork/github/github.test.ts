import { expect, test } from "bun:test";
import type { GithubPull, GithubPulls } from "../../../shared/github.ts";
import { githubGroups, githubStacks } from "./github.ts";

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


test("shows a stack as its top pull request, where its latest one is, with the rest under it top down", () => {
  const layer = (number: number, position: number, id = "s"): GithubPull => ({ ...row("a/one", number), stack: { id, position, size: 3 } });
  const alone = row("b/two", 9);
  const rows = [layer(12, 2), alone, layer(13, 3), layer(11, 1), layer(21, 1, "t")];
  expect(githubStacks(rows).map(({ pr, below }) => [pr.number, below.map((under) => under.number)])).toEqual([[13, [12, 11]], [9, []], [21, []]]);
});
