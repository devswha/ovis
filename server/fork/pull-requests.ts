/**
 * A repository's open pull requests, read with the `gh` CLI the user is already signed in with, and the
 * git fetch that brings a pull request's branch in before a worktree is made from it. No token is stored
 * and no account is switched (`gh auth switch` changes the account of every agent on the PC): each call
 * names the account it uses through `GH_TOKEN`, taken from `gh auth token --user`.
 *
 * Which account reads a repository is found, not configured: the one named like the repository's owner is
 * tried first, then the others, and the first that can see the repository is remembered for it.
 */
import type { PullRequestChecks, PullRequestEntry, PullRequestListing, WorktreeEntry } from "../../shared/protocol.ts";

const PULL_REQUEST_LIMIT = 50;
const GH_DEADLINE_MS = 20_000;
const FETCH_DEADLINE_MS = 60_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const PR_FIELDS = "number,title,url,headRefName,author,isDraft,isCrossRepository,updatedAt,statusCheckRollup,reviewDecision";

/** A refusal the page shows as it is: `code` says which, `message` says what to do. */
export class PullRequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

interface PullRequestOptions {
  /** the programs to run (stand-ins, in tests) */
  gh: string;
  git: string;
  deadlineMs: number;
}

const DEFAULTS: PullRequestOptions = { gh: "gh", git: "git", deadlineMs: GH_DEADLINE_MS };
let options = DEFAULTS;

/** For tests: stand-in programs or a shorter deadline. No argument restores the defaults. */
export function setPullRequestOptions(next: Partial<PullRequestOptions> = {}): void {
  options = { ...DEFAULTS, ...next };
}

/** The account that read each repository last, by `owner/name`: tried first the next time. */
const accountOf = new Map<string, string>();

/** For tests: forget which account read which repository. */
export function forgetPullRequestAccounts(): void {
  accountOf.clear();
}

interface Run { code: number | null; stdout: string; stderr: string }

/**
 * This process's environment without a repository it was started inside (a hook, a test runner) or a token of
 * its own, plus `extra`: every call names the account it reads with.
 */
function processEnvironment(extra: Record<string, string>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) delete env[name];
  return { ...env, ...extra };
}

/** One process: its output up to a cap, killed at the deadline. A program that is not there is `gh_missing`-shaped: null. */
async function run(argv: string[], env: Record<string, string>, cwd: string | undefined, deadlineMs: number): Promise<Run | null> {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: processEnvironment(env), ...(cwd === undefined ? {} : { cwd }) });
  } catch {
    return null;
  }
  const timer = setTimeout(() => proc.kill(), deadlineMs);
  try {
    const read = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
      const text = await new Response(stream).text();
      return text.length > MAX_OUTPUT_BYTES ? text.slice(0, MAX_OUTPUT_BYTES) : text;
    };
    const [stdout, stderr] = await Promise.all([read(proc.stdout), read(proc.stderr)]);
    return { code: await proc.exited, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

/** git never asks for a password here. */
const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };

/** `owner/name` from a GitHub remote (https, ssh, or an ssh host alias such as `github.com-work`); null for any other host. */
export function githubRepository(remote: string): string | null {
  const match = /^(?:[\w+.-]+:\/\/)?(?:[^@/\s]+@)?([^/:\s]+)[/:](?:\d+\/)?([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(remote.trim());
  if (!match || !/^github(?:\.com)?(?:-[\w.-]+)?$/i.test(match[1]!)) return null;
  return `${match[2]}/${match[3]}`;
}

/** The accounts `gh` is signed in with on github.com, from `gh auth status` (stdout since 2.4x, stderr before). */
export function ghAccounts(status: string): string[] {
  const names: string[] = [];
  for (const match of status.matchAll(/Logged in to github\.com (?:account|as) (\S+)/g)) if (!names.includes(match[1]!)) names.push(match[1]!);
  return names;
}

/** The worst of a pull request's check runs and commit statuses. */
export function checksOf(rollup: unknown): PullRequestChecks {
  if (!Array.isArray(rollup) || rollup.length === 0) return "none";
  let result: PullRequestChecks = "passing";
  for (const item of rollup) {
    if (typeof item !== "object" || item === null) continue;
    const { status, conclusion, state } = item as { status?: unknown; conclusion?: unknown; state?: unknown };
    // a check run is done when its status says so, and then its conclusion; a commit status has only a state
    const verdict = typeof state === "string" && status === undefined ? state : status !== "COMPLETED" ? "PENDING" : String(conclusion ?? "");
    if (["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "STARTUP_FAILURE", "ACTION_REQUIRED"].includes(verdict)) return "failing";
    if (["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"].includes(verdict)) result = "pending";
  }
  return result;
}

const REVIEWS: Record<string, PullRequestEntry["review"]> = { APPROVED: "approved", CHANGES_REQUESTED: "changes_requested", REVIEW_REQUIRED: "review_required" };

/** `gh pr list --json` as entries, most recently updated first, each with the checkout of its branch. */
export function parsePullRequests(output: string, worktrees: readonly WorktreeEntry[]): PullRequestEntry[] {
  let rows: unknown;
  try { rows = JSON.parse(output); } catch { throw new PullRequestError("gh_unreadable", "GitHub's answer could not be read"); }
  if (!Array.isArray(rows)) throw new PullRequestError("gh_unreadable", "GitHub's answer could not be read");
  const entries: PullRequestEntry[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const pr = row as Record<string, unknown>;
    if (typeof pr.number !== "number" || typeof pr.title !== "string" || typeof pr.url !== "string" || typeof pr.headRefName !== "string") continue;
    const checkout = worktrees.find((entry) => entry.branch === pr.headRefName && !entry.is_prunable) ?? null;
    const author = (pr.author as { login?: unknown } | null)?.login;
    entries.push({
      number: pr.number,
      title: pr.title,
      url: pr.url,
      branch: pr.headRefName,
      author: typeof author === "string" ? author : null,
      draft: pr.isDraft === true,
      fork: pr.isCrossRepository === true,
      updated_at: typeof pr.updatedAt === "string" ? pr.updatedAt : "",
      checks: checksOf(pr.statusCheckRollup),
      review: REVIEWS[String(pr.reviewDecision)] ?? "none",
      checkout: checkout ? { path: checkout.path, open_workspace_id: checkout.open_workspace_id } : null,
    });
  }
  return entries.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

/** The repository's GitHub name from its `origin` remote. */
async function originRepository(repoRoot: string): Promise<string> {
  const result = await run([options.git, "-C", repoRoot, "remote", "get-url", "origin"], GIT_ENV, undefined, options.deadlineMs);
  const repository = result?.code === 0 ? githubRepository(result.stdout) : null;
  if (!repository) throw new PullRequestError("not_github", "This repository's origin is not on GitHub");
  return repository;
}

/** Whether `gh` could not see the repository with this account (so another may), as against GitHub being down or limiting. */
const REFUSED = /not found|could not resolve|404|403|401|bad credentials|authentication|requires authentication|saml|forbidden/i;

/**
 * The open pull requests of the repository at `repoRoot`, with the checkouts of their branches among
 * `worktrees`, read with the first signed-in account that can see the repository.
 */
export async function listPullRequests(repoRoot: string, worktrees: readonly WorktreeEntry[]): Promise<PullRequestListing> {
  const repository = await originRepository(repoRoot);
  const status = await run([options.gh, "auth", "status"], {}, undefined, options.deadlineMs);
  if (status === null) throw new PullRequestError("gh_missing", "The GitHub CLI (gh) is not installed on this PC");
  const signedIn = ghAccounts(`${status.stdout}\n${status.stderr}`);
  if (signedIn.length === 0) throw new PullRequestError("gh_signed_out", "The GitHub CLI is not signed in on this PC: run `gh auth login`");
  const owner = repository.split("/")[0]!.toLowerCase();
  const first = accountOf.get(repository);
  const order = [...signedIn].sort((a, b) => Number(b === first) - Number(a === first) || Number(b.toLowerCase() === owner) - Number(a.toLowerCase() === owner));
  let refusal = "";
  for (const account of order) {
    const token = await run([options.gh, "auth", "token", "--user", account], {}, undefined, options.deadlineMs);
    if (token?.code !== 0 || !token.stdout.trim()) continue;
    const listed = await run(
      [options.gh, "pr", "list", "--repo", repository, "--state", "open", "--limit", String(PULL_REQUEST_LIMIT), "--json", PR_FIELDS],
      { GH_TOKEN: token.stdout.trim(), GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" }, undefined, options.deadlineMs,
    );
    if (listed === null) throw new PullRequestError("gh_missing", "The GitHub CLI (gh) is not installed on this PC");
    if (listed.code === 0) {
      accountOf.set(repository, account);
      return { repository, account, pull_requests: parsePullRequests(listed.stdout, worktrees) };
    }
    const said = `${listed.stderr}${listed.stdout}`.trim();
    if (/rate limit/i.test(said)) throw new PullRequestError("rate_limited", "GitHub is limiting requests from this account; try again in a few minutes");
    if (!REFUSED.test(said)) throw new PullRequestError("gh_failed", said.split("\n")[0]?.slice(0, 300) || "gh could not list the pull requests");
    refusal = said;
  }
  throw new PullRequestError("repository_unreachable", refusal ? `No signed-in GitHub account can see ${repository}` : `The GitHub CLI has no usable token for ${repository}`);
}

/**
 * A pull request's branch fetched from origin into `origin/<branch>`, so a worktree can start from it.
 * Returns that ref. The branch is checked the way git names branches before it reaches a command line.
 */
export async function fetchPullRequestBranch(repoRoot: string, branch: string): Promise<string> {
  if (branch === "" || branch.startsWith("-")) throw new PullRequestError("invalid_branch", "That is not a branch name");
  const valid = await run([options.git, "check-ref-format", `refs/heads/${branch}`], GIT_ENV, undefined, options.deadlineMs);
  if (valid?.code !== 0) throw new PullRequestError("invalid_branch", "That is not a branch name");
  const ref = `origin/${branch}`;
  const fetched = await run([options.git, "-C", repoRoot, "fetch", "--no-tags", "origin", `+refs/heads/${branch}:refs/remotes/${ref}`], GIT_ENV, undefined, Math.max(options.deadlineMs, FETCH_DEADLINE_MS));
  if (fetched?.code !== 0) throw new PullRequestError("fetch_failed", (fetched?.stderr.trim().split("\n").pop() ?? "git could not fetch the branch").slice(0, 300));
  return ref;
}
