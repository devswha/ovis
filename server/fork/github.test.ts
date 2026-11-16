import { expect, test } from "bun:test";
import { createGithubReader, parseGithubPulls } from "./github.ts";

const pr = (number: number, repository = "owner/repo") => ({ number, title: `PR ${number}`, url: `https://github.com/${repository}/pull/${number}`, repository: { nameWithOwner: repository }, headRefName: "feature", updatedAt: `2026-01-${number.toString().padStart(2, "0")}T00:00:00Z`, author: { login: "me" }, reviewDecision: "APPROVED", commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ status: "COMPLETED", conclusion: "FAILURE" }] } } } }] } });
const fixture = () => JSON.stringify({ data: { viewer: { login: "me" }, review: { nodes: [pr(1), pr(3)] }, yours: { nodes: [pr(2), pr(3)] } } });

test("parses both groups, reuses check verdicts, sorts newest first and deduplicates within a group", () => {
  const listing = parseGithubPulls(fixture());
  expect(listing.account).toBe("me");
  expect(listing.review.map((row) => row.number)).toEqual([3, 1]);
  expect(listing.yours.map((row) => row.number)).toEqual([3, 2]);
  expect(listing.review[0]).toMatchObject({ repository: "owner/repo", checks: "failing", review: "approved", checkout: null });
  const data = JSON.parse(fixture()); data.data.review.nodes.push(pr(3));
  expect(parseGithubPulls(JSON.stringify(data)).review).toHaveLength(2);
});

test("rejects malformed and partial GraphQL responses instead of claiming an empty inbox", () => {
  for (const output of ["nope", "{}", '{"errors":[{"message":"oops"}]}', JSON.stringify({ data: { viewer: { login: "me" }, review: { nodes: [] } } })]) expect(() => parseGithubPulls(output)).toThrow();
  const data = JSON.parse(fixture()); data.data.review.nodes[0].url = "javascript:alert(1)";
  expect(() => parseGithubPulls(JSON.stringify(data))).toThrow();
});

test("coalesces reads, caps searches, and expires the cache within 30 seconds", async () => {
  let calls = 0, now = 0;
  const read = createGithubReader(async (args) => { calls++; expect(args.join(" ")).toContain("first:50"); expect(args.join(" ")).toContain("review-requested:@me"); return { code: 0, stdout: fixture(), stderr: "" }; }, () => now);
  await Promise.all([read(), read()]); await read(); expect(calls).toBe(1);
  now = 30_001; await read(); expect(calls).toBe(2);
});

test("reports missing gh, signed out, rate limited, and generic errors without leaking stderr", async () => {
  for (const [result, code] of [[null, "gh_missing"], [{ code: 1, stdout: "", stderr: "To get started with GitHub CLI, please run: gh auth login" }, "gh_signed_out"], [{ code: 1, stdout: "", stderr: "API rate limit exceeded" }, "rate_limited"], [{ code: 1, stdout: "", stderr: "secret unexpected failure" }, "gh_failed"]] as const) {
    const read = createGithubReader(async () => result);
    await expect(read()).rejects.toMatchObject({ code });
  }
});
