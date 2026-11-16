import { expect, test } from "bun:test";
import type { SessionSnapshot } from "../../shared/protocol.ts";
import { createGithubFilesReader, createGithubReader, githubActionArgs, githubQuery, githubWorkspaces, handleGithubFiles, handleGithubPulls, mergeGithubPulls, parseGithubPulls } from "./github.ts";

const pr = (number: number, repository = "owner/repo") => ({ number, title: `PR ${number}`, url: `https://github.com/${repository}/pull/${number}`, repository: { nameWithOwner: repository }, headRefName: "feature", updatedAt: `2026-01-${number.toString().padStart(2, "0")}T00:00:00Z`, author: { login: "me" }, reviewDecision: "APPROVED", commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE", contexts: { nodes: [{ status: "COMPLETED", conclusion: "FAILURE" }] } } } }] } });
const fixture = () => JSON.stringify({ data: { viewer: { login: "me" }, review: { nodes: [pr(1), pr(3)] }, yours: { nodes: [pr(2), pr(3)] }, reviewed: { nodes: [] } } });

test("parses both groups, reuses check verdicts, sorts newest first and deduplicates within a group", () => {
  const listing = parseGithubPulls(fixture());
  expect(listing.accounts).toEqual(["me"]);
  expect(listing.review.map((row) => row.number)).toEqual([3, 1]);
  expect(listing.yours.map((row) => row.number)).toEqual([3, 2]);
  expect(listing.review[0]).toMatchObject({ repository: "owner/repo", checks: "failing", review: "approved", checkout: null });
  const data = JSON.parse(fixture()); data.data.review.nodes.push(pr(3));
  expect(parseGithubPulls(JSON.stringify(data)).review).toHaveLength(2);
});

test("uses the aggregate state when a failed check is beyond 100 passing contexts", () => {
  const data = JSON.parse(fixture());
  const commit = data.data.review.nodes[0].commits.nodes[0].commit;
  // GitHub's aggregate includes the failed 101st check, absent from this first page.
  commit.statusCheckRollup = { state: "FAILURE", contexts: { pageInfo: { hasNextPage: true }, nodes: Array.from({ length: 100 }, () => ({ status: "COMPLETED", conclusion: "SUCCESS" })) } };
  expect(parseGithubPulls(JSON.stringify(data)).review.find((row) => row.number === 1)?.checks).toBe("failing");
  for (const [state, expected] of [["ERROR", "failing"], ["PENDING", "pending"], ["EXPECTED", "pending"], ["SUCCESS", "passing"], [null, "none"]] as const) {
    commit.statusCheckRollup = state === null ? null : { state };
    expect(parseGithubPulls(JSON.stringify(data)).review.find((row) => row.number === 1)?.checks).toBe(expected);
  }
});

test("rejects malformed and partial GraphQL responses instead of claiming an empty inbox", () => {
  for (const output of ["nope", "{}", '{"errors":[{"message":"oops"}]}', JSON.stringify({ data: { viewer: { login: "me" }, review: { nodes: [] } } })]) expect(() => parseGithubPulls(output)).toThrow();
  const data = JSON.parse(fixture()); data.data.review.nodes[0].url = "javascript:alert(1)";
  expect(() => parseGithubPulls(JSON.stringify(data))).toThrow();
});

test("brings back a reviewed PR that got commits after the review, and lists others' PRs of open repositories as Team", () => {
  const other = (number: number, repository = "owner/repo", login = "ana") => ({ ...pr(number, repository), author: { login } });
  const reviewed = (number: number, at: string, head: string) => ({ ...other(number), headRefOid: head, viewerLatestReview: { commit: { oid: at } } });
  const data = JSON.parse(fixture());
  data.data.reviewed.nodes = [reviewed(5, "aaa", "bbb"), reviewed(6, "ccc", "ccc")];
  data.data.t0 = { nodes: [other(7), other(2), pr(8), other(5)] };
  data.data.t1 = null;
  data.errors = [{ path: ["t1"], message: "Could not resolve to a Repository" }];
  const listing = parseGithubPulls(JSON.stringify(data));
  expect(listing.review.map((row) => [row.number, row.updated_since_review ?? false])).toEqual([[5, true], [3, false], [1, false]]);
  // its own PRs and ones listed above stay out of Team
  expect(listing.team.map((row) => row.number)).toEqual([7]);
  data.errors = [{ path: ["review"], message: "boom" }];
  expect(() => parseGithubPulls(JSON.stringify(data))).toThrow();
});

test("includes every repository's team PRs before excluding listed and authored rows", () => {
  const data = JSON.parse(fixture());
  for (let repo = 0; repo < 3; repo++) {
    data.data[`t${repo}`] = { nodes: Array.from({ length: 20 }, (_, i) => ({
      ...pr(i + 1, `owner/repo${repo}`), author: { login: "other" }, updatedAt: `2026-02-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
    })) };
  }
  data.data.t0.nodes[0].author.login = "me";
  const result = parseGithubPulls(JSON.stringify(data));
  expect(result.team).toHaveLength(59);
  expect(result.team.filter((row) => row.repository === "owner/repo2")).toHaveLength(20);
  expect(result.team[0]!.updated_at).toBe("2026-02-20T00:00:00Z");
});

test("asks for each open repository's PRs by alias, skipping names that are not owner/name", () => {
  const query = githubQuery(["owner/repo", "bad name", "corp/app"]);
  expect(query).toContain("repo:owner/repo");
  expect(query).toContain("repo:corp/app");
  expect(query).toContain("-author:@me");
  expect(query).not.toContain("bad name");
  expect(query).toContain("reviewed-by:@me");
});

test("searches every workspace repository in bounded queries without filtering out older teammate PRs", () => {
  const repos = Array.from({ length: 41 }, (_, i) => `owner/repository${i}`);
  const query = githubQuery(repos);
  for (const repo of repos) expect(query).toContain(`repo:${repo}`);
  const searches = [...query.matchAll(/t\d+: search\(query:("(?:[^"\\]|\\.)*"),type:ISSUE,first:100/g)].map((match) => JSON.parse(match[1]!));
  expect(searches.length).toBeGreaterThan(1);
  expect(searches.every((search: string) => search.length <= 256 && search.includes("-author:@me"))).toBe(true);
  const data = JSON.parse(fixture());
  data.data.t0 = { nodes: [{ ...pr(21, repos[40]), author: { login: "teammate" } }] };
  expect(parseGithubPulls(JSON.stringify(data)).team[0]?.repository).toBe(repos[40]);
});

test("another account's own PR is not Team", () => {
  const listing = mergeGithubPulls([
    { accounts: ["me"], review: [], yours: [], team: [{ ...parseGithubPulls(fixture()).yours[0]!, url: "https://github.com/owner/repo/pull/9" }] },
    { accounts: ["work"], review: [], yours: [{ ...parseGithubPulls(fixture()).yours[0]!, url: "https://github.com/owner/repo/pull/9" }], team: [] },
  ]);
  expect(listing.team).toEqual([]);
});

test("file patches cache separately for each head and reject a missing head", async () => {
  let calls = 0;
  const read = createGithubFilesReader(async (args) => {
    if (args[1] === "token") return ok("token");
    calls++;
    expect(args.join(" ")).toContain(`repos/owner/repo/compare/feature%2Fbase...${(calls === 1 ? "a" : "b").repeat(40)}`);
    return ok(JSON.stringify([{ files: [{ filename: "a.txt", patch: `@@ -1 +1 @@\n-old\n+version${calls}` }] }, { commits: [] }]));
  }, () => 0);
  expect((await read("owner/repo", 1, "me", "a".repeat(40), "feature/base"))[0]?.patch).toContain("version1");
  expect((await read("owner/repo", 1, "me", "a".repeat(40), "feature/base"))[0]?.patch).toContain("version1");
  expect((await read("owner/repo", 1, "me", "b".repeat(40), "feature/base"))[0]?.patch).toContain("version2");
  expect(calls).toBe(2);
  const request = new Request("http://localhost/api/fork/github/pull/files?repo=owner/repo&number=1&account=me");
  expect((await handleGithubFiles(request, false)).status).toBe(400);
});

test("an unavailable compare revision returns an error instead of current PR files", async () => {
  const calls: string[] = [];
  const read = createGithubFilesReader(async (args) => {
    if (args[1] === "token") return ok("token");
    calls.push(args.join(" "));
    return { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
  });
  await expect(read("owner/repo", 1, "me", "a".repeat(40), "main")).rejects.toMatchObject({ code: "gh_refused" });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain(`/compare/main...${"a".repeat(40)}`);
  expect(calls[0]).not.toContain("/pulls/1/files");
});

test("closes and reopens with a PATCH of the state", () => {
  expect(githubActionArgs("owner/repo", 4, { action: "close" })).toEqual(["api", "--hostname", "github.com", "--silent", "-X", "PATCH", "repos/owner/repo/pulls/4", "-f", "state=closed"]);
  expect(githubActionArgs("owner/repo", 4, { action: "reopen" })?.at(-1)).toBe("state=open");
});

const signedIn = (...accounts: string[]) => accounts.map((name) => `  ✓ Logged in to github.com account ${name} (keyring)`).join("\n");
const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });

test("coalesces reads, caps searches, and expires the cache within 30 seconds", async () => {
  let calls = 0, now = 0;
  const read = createGithubReader(async (args) => {
    if (args[1] === "status") return ok(signedIn("me"));
    if (args[1] === "token") return ok("token\n");
    calls++; expect(args.join(" ")).toContain("first:50"); expect(args.join(" ")).toContain("review-requested:@me"); expect(args.join(" ")).toContain("statusCheckRollup { state }"); expect(args.join(" ")).not.toContain("contexts("); return ok(fixture());
  }, () => now);
  await Promise.all([read(), read()]); await read(); expect(calls).toBe(1);
  now = 30_001; await read(); expect(calls).toBe(2);
});

test("reads later reviewed-search pages before comparing review commits and caches the result", async () => {
  let queries = 0;
  const initial = JSON.parse(fixture());
  initial.data.reviewed = { nodes: Array.from({ length: 100 }, (_, i) => ({ ...pr(i + 10), headRefOid: "same", viewerLatestReview: { commit: { oid: "same" } } })), pageInfo: { hasNextPage: true, endCursor: "next-page" } };
  const later = { data: { reviewed: { nodes: [{ ...pr(200), headRefOid: "new", viewerLatestReview: { commit: { oid: "old" } } }], pageInfo: { hasNextPage: false, endCursor: null } } } };
  const read = createGithubReader(async (args) => {
    if (args[1] === "status") return ok(signedIn("me"));
    if (args[1] === "token") return ok("token");
    queries++;
    return ok(JSON.stringify(queries === 1 ? initial : later));
  });
  expect((await read()).review.some((row) => row.number === 200 && row.updated_since_review)).toBe(true);
  await read(); expect(queries).toBe(2);
});

test("retries a failed Team search per repository without losing readable peers", async () => {
  const initial = JSON.parse(fixture());
  initial.data.t0 = null; initial.errors = [{ path: ["t0"], message: "Could not resolve repository" }];
  const calls: string[] = [];
  const read = createGithubReader(async (args) => {
    if (args[1] === "status") return ok(signedIn("me"));
    if (args[1] === "token") return ok("token");
    const query = args.join(" "); calls.push(query);
    if (calls.length === 1) return { code: 1, stdout: JSON.stringify(initial), stderr: "" };
    if (query.includes("repo:owner/private")) return { code: 1, stdout: JSON.stringify({ data: { t0: null }, errors: [{ path: ["t0"], type: "FORBIDDEN", message: "not accessible" }] }), stderr: "" };
    return ok(JSON.stringify({ data: { t0: { nodes: [{ ...pr(21, "owner/public"), author: { login: "teammate" } }] } } }));
  });
  expect((await read(["owner/private", "owner/public"])).team.map((row) => row.number)).toEqual([21]);
  expect(calls).toHaveLength(3);
});

test("does not hide untyped Team search failures", async () => {
  const initial = JSON.parse(fixture());
  initial.data.t0 = null; initial.errors = [{ path: ["t0"], message: "Something went wrong while executing your query" }];
  const read = createGithubReader(async (args) => args[1] === "status" ? ok(signedIn("me")) : args[1] === "token" ? ok("token") : { code: 1, stdout: JSON.stringify(initial), stderr: "" });
  await expect(read(["owner/repo"])).rejects.toMatchObject({ code: "gh_unreadable" });
});

test("rejects partial Team retry data when the retry also has an error", async () => {
  const initial = JSON.parse(fixture());
  initial.data.t0 = null; initial.errors = [{ path: ["t0"], message: "batch failed" }];
  for (const retry of [
    { code: 1, stdout: JSON.stringify({ data: { t0: { nodes: [] } }, errors: [{ path: ["t0", "nodes", 0], type: "RATE_LIMITED", message: "rate limit" }] }), stderr: "" },
    { code: 1, stdout: JSON.stringify({ data: { t0: { nodes: [] } } }), stderr: "unexpected error" },
  ]) {
    let calls = 0;
    const read = createGithubReader(async (args) => args[1] === "status" ? ok(signedIn("me")) : args[1] === "token" ? ok("token") : ++calls === 1 ? { code: 1, stdout: JSON.stringify(initial), stderr: "" } : retry);
    await expect(read(["owner/repo"])).rejects.toMatchObject({ code: "gh_unreadable" });
  }
});

test("reads every signed-in account with its own token and lists what the readable ones see", async () => {
  const tokens: string[] = [];
  const own = (login: string, number: number, repository: string) => JSON.stringify({ data: { viewer: { login }, review: { nodes: [pr(number, repository)] }, yours: { nodes: [pr(3)] }, reviewed: { nodes: [] } } });
  const read = createGithubReader(async (args, env = {}) => {
    if (args[1] === "status") return { code: 1, stdout: "", stderr: signedIn("me", "work", "gone") };
    if (args[1] === "token") return args[3] === "gone" ? { code: 1, stdout: "", stderr: "no token" } : ok(`t-${args[3]}\n`);
    tokens.push(env.GH_TOKEN ?? "");
    return ok(env.GH_TOKEN === "t-me" ? own("me", 1, "owner/repo") : own("work", 2, "corp/app"));
  });
  const listing = await read();
  expect(tokens.sort()).toEqual(["t-me", "t-work"]);
  expect(listing.accounts).toEqual(["me", "work"]);
  expect(listing.failed).toEqual(["gone"]);
  expect(listing.review.map((row) => row.repository)).toEqual(["corp/app", "owner/repo"]);
  expect(listing.yours.map((row) => row.number)).toEqual([3]);
});

test("keeps an answer gh exits 1 on because one Team repository could not be read", async () => {
  const data = JSON.parse(fixture()); data.data.t0 = null; data.errors = [{ path: ["t0"], type: "NOT_FOUND", message: "Could not resolve to a Repository" }];
  const read = createGithubReader(async (args) => args[1] === "status" ? ok(signedIn("me")) : args[1] === "token" ? ok("t\n") : { code: 1, stdout: JSON.stringify(data), stderr: "gh: Could not resolve to a Repository" });
  expect((await read(["owner/gone"])).yours.map((row) => row.number)).toEqual([3, 2]);
});

test("fails as the first account failed when no account can be read", async () => {
  const read = createGithubReader(async (args) => args[1] === "status" ? ok(signedIn("me")) : args[1] === "token" ? ok("t\n") : { code: 1, stdout: "", stderr: "HTTP 429 rate limit" });
  await expect(read()).rejects.toMatchObject({ code: "rate_limited" });
  expect(mergeGithubPulls([]).failed).toBeUndefined();
});

test("matches repositories by local roots or pane folders and tolerates non-GitHub workspaces", async () => {
  const snapshot = { workspaces: [{ workspace_id: "w1", worktree: { repo_root: "/repo" } }, { workspace_id: "w2" }, { workspace_id: "w3" }], panes: [{ workspace_id: "w2", cwd: "/other" }, { workspace_id: "w3", cwd: "/offline" }] } as SessionSnapshot;
  const known = await githubWorkspaces(snapshot, async (path) => { if (path === "/offline") throw new Error("not git"); return path === "/repo" ? "Owner/Repo" : "other/tools"; });
  expect([...known]).toEqual([["owner/repo", "w1"], ["other/tools", "w2"]]);
});

test("matches beyond 50 workspaces with bounded repository reads", async () => {
  const workspaces = Array.from({ length: 60 }, (_, i) => ({
    workspace_id: `w${i}`, active_tab_id: "", agent_status: "idle", focused: false, label: "repo", number: i, pane_count: 0, tab_count: 0,
    worktree: { repo_root: `/repo${i}`, checkout_path: `/repo${i}`, repo_key: `r${i}`, repo_name: `repo${i}`, is_linked_worktree: false },
  }));
  let active = 0, peak = 0, calls = 0;
  const known = await githubWorkspaces({ workspaces, panes: [], agents: [], layouts: [], tabs: [], protocol: 1, version: "fixture" }, async (path) => {
    calls++; active++; peak = Math.max(peak, active);
    await Promise.resolve();
    active--;
    return `owner/${path.slice(1)}`;
  });
  expect(known.get("owner/repo59")).toBe("w59");
  expect(calls).toBe(60);
  expect(peak).toBeGreaterThan(1);
  expect(peak).toBeLessThanOrEqual(4);
});

test("does not advertise a second pane's repository that workspace APIs cannot resolve", async () => {
  const snapshot = { workspaces: [{ workspace_id: "w1" }], panes: [{ workspace_id: "w1", cwd: "/home/user" }, { workspace_id: "w1", cwd: "/repo" }] } as SessionSnapshot;
  const folders: string[] = [];
  const known = await githubWorkspaces(snapshot, async (path) => { folders.push(path); throw new Error("not git"); });
  expect(folders).toEqual(["/home/user"]);
  expect(known.size).toBe(0);
});

test("refuses observers and non-GET requests before reading gh or the user's snapshot", async () => {
  const never = async (): Promise<SessionSnapshot> => { throw new Error("must not read"); };
  expect((await handleGithubPulls(new Request("http://localhost/api/fork/github/pulls"), never, true)).status).toBe(403);
  expect((await handleGithubPulls(new Request("http://localhost/api/fork/github/pulls", { method: "POST" }), never, false)).status).toBe(405);
});

test("reports missing gh, signed out, rate limited, and generic errors without leaking stderr", async () => {
  for (const [result, code] of [[null, "gh_missing"], [{ code: 1, stdout: "", stderr: "To get started with GitHub CLI, please run: gh auth login" }, "gh_signed_out"], [{ code: 1, stdout: "", stderr: "API rate limit exceeded" }, "rate_limited"], [{ code: 1, stdout: "", stderr: "secret unexpected failure" }, "gh_failed"]] as const) {
    const read = createGithubReader(async (args) => result !== null && args[1] === "status" ? ok(signedIn("me")) : result !== null && args[1] === "token" ? ok("t\n") : result);
    await expect(read()).rejects.toMatchObject({ code });
  }
});
