import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceStore } from "./devices.ts";
import { createServer } from "./index.ts";
import { PullRequestError, mergePullRequest, pullRequestLog, pullRequestView } from "./pull-request.ts";
import { PULL_REQUEST_LOG_LINES } from "../shared/pull-request.ts";

type Answer = { stdout?: string; stderr?: string; code?: number };

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ovis-pull-request-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A `gh` stand-in: answers by its first words from scenario.json and records each call's arguments. */
function fakeGh(scenario: Record<string, Answer>): { gh: string[]; calls: () => string[][] } {
  const dir = mkdtempSync(join(scratch, "gh-"));
  writeFileSync(join(dir, "scenario.json"), JSON.stringify(scenario));
  writeFileSync(join(dir, "gh.ts"), `
    import { appendFileSync, readFileSync } from "node:fs";
    const args = process.argv.slice(2);
    appendFileSync(${JSON.stringify(join(dir, "calls.jsonl"))}, JSON.stringify(args) + "\\n");
    const scenario = JSON.parse(readFileSync(${JSON.stringify(join(dir, "scenario.json"))}, "utf8"));
    const key = args[0] === "api" ? (args[1] === "graphql" ? "graphql" : "log") : args[0] + " " + args[1];
    const answer = scenario[key] ?? { code: 1, stderr: "unexpected call" };
    process.stdout.write(answer.stdout ?? "");
    process.stderr.write(answer.stderr ?? "");
    process.exit(answer.code ?? 0);
  `);
  return {
    gh: [process.execPath, join(dir, "gh.ts")],
    calls: () => { try { return readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]); } catch { return []; } },
  };
}

const HEAD = "f91f1ecc94f500a3be476b918d6f1fd6c1d8b276";
const prJson = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  number: 12, title: "Fix the thing", url: "https://github.com/acme/widgets/pull/12", state: "OPEN", isDraft: false,
  headRefName: "fix/thing", baseRefName: "main", headRefOid: HEAD, mergeStateStatus: "BLOCKED",
  statusCheckRollup: [
    { __typename: "CheckRun", name: "lint", workflowName: "CI", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://github.com/acme/widgets/actions/runs/1/job/101" },
    { __typename: "CheckRun", name: "build", workflowName: "CI", status: "IN_PROGRESS", conclusion: "", detailsUrl: "https://github.com/acme/widgets/actions/runs/1/job/102" },
    { __typename: "CheckRun", name: "test", workflowName: "CI", status: "COMPLETED", conclusion: "TIMED_OUT", detailsUrl: "https://github.com/acme/widgets/actions/runs/1/job/103" },
    { __typename: "StatusContext", context: "ci/external", state: "FAILURE", targetUrl: "https://ci.example/run/9" },
  ],
  ...overrides,
});
const graphqlJson = (method = "SQUASH") => JSON.stringify({ data: { repository: { viewerDefaultMergeMethod: method, pullRequest: { reviewThreads: { totalCount: 2, nodes: [
  { isResolved: false, isOutdated: false, path: "src/a.ts", line: 7, comments: { totalCount: 2, nodes: [{ author: { login: "rev" }, body: "Rename this.", url: "https://github.com/acme/widgets/pull/12#discussion_r1" }] } },
  { isResolved: true, isOutdated: false, path: "src/b.ts", line: 3, comments: { totalCount: 1, nodes: [{ author: { login: "rev" }, body: "Done already.", url: null }] } },
] } } } } });

describe("reading a branch's pull request through gh", () => {
  it("lists failing checks first with their Actions job, the open threads, and the default merge method", async () => {
    const fake = fakeGh({ "pr view": { stdout: prJson() }, graphql: { stdout: graphqlJson() } });
    const view = await pullRequestView(scratch, { gh: fake.gh });
    expect(view).toMatchObject({ number: 12, state: "open", draft: false, head_ref: "fix/thing", base_ref: "main", head_oid: HEAD, merge_state: "blocked", mergeable: false, merge_method: "squash", threads_truncated: false });
    expect(view.checks.map((check) => [check.name, check.state, check.job_id])).toEqual([["test", "fail", "103"], ["ci/external", "fail", null], ["build", "pending", "102"], ["lint", "pass", "101"]]);
    expect(view.threads).toEqual([{ path: "src/a.ts", line: 7, outdated: false, author: "rev", body: "Rename this.", comments: 2, url: "https://github.com/acme/widgets/pull/12#discussion_r1" }]);
    const graphql = fake.calls().find((args) => args[1] === "graphql")!;
    expect(graphql).toEqual(expect.arrayContaining(["owner=acme", "name=widgets", "number=12"]));
  });

  it("offers a merge only for an open, ready pull request GitHub would merge now", async () => {
    for (const [overrides, mergeable] of [
      [{ mergeStateStatus: "CLEAN" }, true],
      [{ mergeStateStatus: "UNSTABLE" }, true],
      [{ mergeStateStatus: "UNKNOWN" }, false],
      [{ mergeStateStatus: "CLEAN", isDraft: true }, false],
      [{ mergeStateStatus: "CLEAN", state: "MERGED" }, false],
    ] as const) {
      const fake = fakeGh({ "pr view": { stdout: prJson(overrides) }, graphql: { stdout: graphqlJson("MERGE") } });
      expect([overrides, (await pullRequestView(scratch, { gh: fake.gh })).mergeable]).toEqual([overrides, mergeable]);
    }
  });

  it("says why there is nothing to show: no gh, signed out, no pull request", async () => {
    const cases: [string[], string, number][] = [
      [[join(scratch, "no-such-gh")], "gh_missing", 409],
      [fakeGh({ "pr view": { code: 4, stderr: "To get started with GitHub CLI, please run:  gh auth login\n" } }).gh, "gh_signed_out", 409],
      [fakeGh({ "pr view": { code: 1, stderr: "no pull requests found for branch \"fix/thing\"\n" } }).gh, "no_pull_request", 404],
    ];
    for (const [gh, code, status] of cases) {
      const error = await pullRequestView(scratch, { gh }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PullRequestError);
      expect([(error as PullRequestError).code, (error as PullRequestError).status]).toEqual([code, status]);
    }
  });
});

describe("a failing check's log", () => {
  it("keeps the last lines without GitHub's timestamps or colour codes", async () => {
    const lines = Array.from({ length: 200 }, (_, index) => `2026-11-05T08:52:40.${String(index).padStart(7, "0")}Z \u001b[31mline ${index}\u001b[0m`);
    const fake = fakeGh({ log: { stdout: `${lines.join("\n")}\n` } });
    const log = await pullRequestLog(scratch, "103", { gh: fake.gh });
    expect(log.job_id).toBe("103");
    expect(log.truncated).toBe(true);
    const shown = log.text.split("\n");
    expect(shown).toHaveLength(PULL_REQUEST_LOG_LINES);
    expect(shown.at(-1)).toBe("line 199");
    expect(shown[0]).toBe(`line ${200 - PULL_REQUEST_LOG_LINES}`);
    expect(fake.calls()[0]).toEqual(["api", "repos/{owner}/{repo}/actions/jobs/103/logs"]);
  });

  it("refuses a job id that is not a number before running gh", async () => {
    const fake = fakeGh({});
    const error = await pullRequestLog(scratch, "1/../../user", { gh: fake.gh }).catch((caught: unknown) => caught);
    expect([(error as PullRequestError).code, (error as PullRequestError).status]).toEqual(["invalid_job", 400]);
    expect(fake.calls()).toEqual([]);
  });
});

describe("merging", () => {
  it("merges the head that was shown, with the method shown, and keeps the branch", async () => {
    const fake = fakeGh({ "pr merge": { stdout: "" } });
    await mergePullRequest(scratch, { number: 12, head_oid: HEAD, method: "rebase" }, { gh: fake.gh });
    expect(fake.calls()).toEqual([["pr", "merge", "12", "--rebase", "--match-head-commit", HEAD]]);
  });

  it("passes GitHub's refusal on", async () => {
    const fake = fakeGh({ "pr merge": { code: 1, stderr: "X Pull request acme/widgets#12 is not mergeable: the base branch policy prohibits the merge.\n" } });
    const error = await mergePullRequest(scratch, { number: 12, head_oid: HEAD, method: "squash" }, { gh: fake.gh }).catch((caught: unknown) => caught);
    expect([(error as PullRequestError).code, (error as PullRequestError).status]).toEqual(["merge_refused", 409]);
    expect((error as PullRequestError).message).toContain("the base branch policy prohibits the merge");
  });
});

describe("the /api/workspace/pr routes", () => {
  let server: ReturnType<typeof createServer>;
  let base: string;
  let watchCookie: string;
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-pull-request-state-"));
  const owner = { authorization: "Bearer test-pull-request" };
  beforeAll(() => {
    const store = new DeviceStore(stateDir);
    const watchToken = store.pair(store.startPairing().code, "Watch", "watch")!.token;
    expect(store.match(watchToken)).not.toBeNull();
    watchCookie = `ovis_device=${watchToken}`;
    server = createServer({ port: 0, stateDir, token: "test-pull-request", tailscaleOwner: null, machines: false });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => { server.stop(); rmSync(stateDir, { recursive: true, force: true }); });

  it("is closed to a device that can only watch, on this PC and through a PC's route", async () => {
    for (const path of ["workspace/pr", "workspace/pr/log", "machines/pc1/workspace/pr", "machines/pc1/workspace/pr/log"]) {
      const response = await fetch(`${base}/api/${path}?directory=${encodeURIComponent(scratch)}&job_id=1`, { headers: { cookie: watchCookie } });
      expect([path, response.status]).toEqual([path, 403]);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("read_only");
    }
  });

  it("refuses a request without a folder, and a merge without what was shown", async () => {
    const missing = await fetch(`${base}/api/workspace/pr`, { headers: owner });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe("missing_directory");
    for (const body of [{ directory: scratch }, { directory: scratch, number: 12, head_oid: "nope", method: "squash" }, { directory: scratch, number: 12, head_oid: HEAD, method: "fast-forward" }]) {
      const response = await fetch(`${base}/api/workspace/pr/merge`, { method: "POST", headers: { ...owner, "content-type": "application/json", "x-herdr-machine": "1" }, body: JSON.stringify(body) });
      expect([body, response.status]).toEqual([body, 400]);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("invalid_body");
    }
  });
});
