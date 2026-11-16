import type { GithubCheck, GithubPull, GithubPullDetail, GithubPulls } from "../../shared/github.ts";
import type { SessionSnapshot } from "../../shared/protocol.ts";
import { conflictResponse, jsonResponse } from "../http.ts";
import { ghAccounts, originRepository, parsePullRequests, PullRequestError, runGithub } from "./pull-requests.ts";

// Search ideas and failure states: ricardofelixb/omarchy-github (MIT),
// Service.qml / omarchy-github-fetch. No code copied. Every signed-in account is read, each with its own
// token (`gh auth token --user`), never by switching gh's active account.
const FIELDS = `number title url headRefName isDraft isCrossRepository updatedAt author { login }
  repository { nameWithOwner } reviewDecision
  commits(last:1) { nodes { commit { statusCheckRollup { state } } } }`;
const QUERY = `query {
  viewer { login }
  review: search(query:"is:pr is:open review-requested:@me sort:updated-desc",type:ISSUE,first:50) { nodes { ... on PullRequest { ${FIELDS} } } }
  yours: search(query:"is:pr is:open author:@me sort:updated-desc",type:ISSUE,first:50) { nodes { ... on PullRequest { ${FIELDS} } } }
}`;
const unreadable = () => new PullRequestError("gh_unreadable", "GitHub's answer could not be read");

/** Translate the GraphQL envelope to the existing PR contract, preserving both search memberships. */
export function parseGithubPulls(output: string): GithubPulls {
  try {
    const { data, errors } = JSON.parse(output);
    if (errors?.length || typeof data?.viewer?.login !== "string") throw unreadable();
    const group = (search: { nodes?: unknown[] }): GithubPull[] => {
      if (!Array.isArray(search?.nodes)) throw unreadable();
      const unique = new Map<string, GithubPull>();
      for (const value of search.nodes.slice(0, 50)) {
        const row = value as { number: number; url: string; repository?: { nameWithOwner?: unknown }; commits?: { nodes?: { commit?: { statusCheckRollup?: { state?: string } | null } }[] } };
        const repository = row?.repository?.nameWithOwner;
        if (typeof repository !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !Number.isSafeInteger(row.number) || row.number < 1 || row.url !== `https://github.com/${repository}/pull/${row.number}`) throw unreadable();
        // The aggregate covers every check, including contexts beyond GitHub's first page.
        const rollup = row.commits?.nodes?.[0]?.commit?.statusCheckRollup;
        const [entry] = parsePullRequests(JSON.stringify([{ ...row, statusCheckRollup: rollup ? [{ state: rollup.state }] : [] }]), []);
        if (!entry) throw unreadable();
        unique.set(entry.url, { ...entry, repository, account: data.viewer.login });
      }
      return [...unique.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    };
    return { accounts: [data.viewer.login], review: group(data.review), yours: group(data.yours) };
  } catch { throw unreadable(); }
}

/** Rows from several accounts as one list: a PR both accounts see appears once per group, newest first. */
export function mergeGithubPulls(listings: GithubPulls[], failed: string[] = []): GithubPulls {
  const merge = (rows: GithubPull[]): GithubPull[] => [...new Map(rows.map((row) => [row.url, row] as const)).values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return {
    accounts: listings.flatMap((listing) => listing.accounts),
    ...(failed.length > 0 ? { failed } : {}),
    review: merge(listings.flatMap((listing) => listing.review)),
    yours: merge(listings.flatMap((listing) => listing.yours)),
  };
}

type Run = typeof runGithub;
/** One account's read, with that account's token. */
async function readAccount(run: Run, account: string): Promise<GithubPulls> {
  const token = await run(["auth", "token", "--user", account]);
  if (!token) throw new PullRequestError("gh_missing", "The GitHub CLI (gh) is not installed on this PC");
  if (token.code !== 0 || !token.stdout.trim()) throw new PullRequestError("gh_signed_out", "Sign in on this PC with gh auth login");
  const result = await run(["api", "graphql", "--hostname", "github.com", "-f", `query=${QUERY}`], { GH_TOKEN: token.stdout.trim() });
  if (!result) throw new PullRequestError("gh_missing", "The GitHub CLI (gh) is not installed on this PC");
  if (result.code !== 0) {
    const detail = `${result.stderr}\n${result.stdout}`;
    if (/rate limit|HTTP 429/i.test(detail)) throw new PullRequestError("rate_limited", "GitHub is limiting requests; try again in a few minutes");
    if (/gh auth login|not logged|authentication|HTTP 401|bad credentials/i.test(detail)) throw new PullRequestError("gh_signed_out", "Sign in on this PC with gh auth login");
    throw new PullRequestError("gh_failed", "Could not read GitHub pull requests");
  }
  return parseGithubPulls(result.stdout);
}

/** One in-flight read and a 20-second cache; no timers or background refreshes. I/O is injectable. Every account gh
 * is signed in with on github.com is read side by side; one that fails is named in `failed` and the others still show. */
export function createGithubReader(run: Run = runGithub, now = Date.now): () => Promise<GithubPulls> {
  let cached: { until: number; value: GithubPulls } | undefined;
  let pending: Promise<GithubPulls> | undefined;
  return () => {
    if (cached && now() < cached.until) return Promise.resolve(cached.value);
    if (pending) return pending;
    pending = (async () => {
      const status = await run(["auth", "status"]);
      if (!status) throw new PullRequestError("gh_missing", "The GitHub CLI (gh) is not installed on this PC");
      const accounts = ghAccounts(`${status.stdout}\n${status.stderr}`);
      if (accounts.length === 0) throw new PullRequestError("gh_signed_out", "Sign in on this PC with gh auth login");
      const reads = await Promise.allSettled(accounts.map((account) => readAccount(run, account)));
      const read = reads.flatMap((outcome) => outcome.status === "fulfilled" ? [outcome.value] : []);
      if (read.length === 0) throw (reads[0] as PromiseRejectedResult).reason;
      const value = mergeGithubPulls(read, accounts.filter((_, index) => reads[index]!.status === "rejected"));
      cached = { value, until: now() + 20_000 };
      return value;
    })().finally(() => { pending = undefined; });
    return pending;
  };
}
const readPulls = createGithubReader();

/** Match only this server's workspaces, never another PC's similarly named branch. */
export async function githubWorkspaces(snapshot: SessionSnapshot, repositoryOf = originRepository): Promise<Map<string, string>> {
  const folders = new Map<string, string>();
  for (const workspace of snapshot.workspaces) {
    // Match the workspace API's repository: metadata or its first pane only. A later pane's
    // repo cannot safely use this workspace ID for checkout (see docs/fork.md).
    const path = workspace.worktree?.repo_root ?? snapshot.panes.find((pane) => pane.workspace_id === workspace.workspace_id)?.cwd;
    if (path && !folders.has(path)) folders.set(path, workspace.workspace_id);
  }
  const entries = [...folders];
  const matches = new Array<readonly [string, string] | null>(entries.length).fill(null);
  let next = 0;
  // No workspace cap: bound subprocess concurrency, not which repositories can match.
  await Promise.all(Array.from({ length: Math.min(4, entries.length) }, async () => {
    while (next < entries.length) {
      const index = next++;
      const [path, id] = entries[index]!;
      try { matches[index] = [await repositoryOf(path), id]; } catch { /* not a GitHub repository */ }
    }
  }));
  return new Map(matches.filter((match) => match !== null).map(([repo, id]) => [repo.toLowerCase(), id]));
}

const PULL_QUERY = `query($owner:String!,$name:String!,$number:Int!) { repository(owner:$owner,name:$name) { pullRequest(number:$number) {
  number title url body state isDraft createdAt updatedAt author { login } headRefName baseRefName isCrossRepository
  additions deletions changedFiles commits { totalCount } reviewDecision mergeStateStatus
  labels(first:20) { nodes { name color } }
  latestReviews(first:30) { nodes { author { login } state } }
  reviewRequests(first:30) { nodes { requestedReviewer { ... on User { login } ... on Team { name } } } }
  statusCheckRollup: commits(last:1) { nodes { commit { statusCheckRollup { contexts(first:100) { nodes {
    __typename
    ... on CheckRun { name status conclusion startedAt completedAt detailsUrl isRequired(pullRequestNumber:$number) checkSuite { workflowRun { workflow { name } } } }
    ... on StatusContext { context state description targetUrl createdAt isRequired(pullRequestNumber:$number) } } } } } } }
} } }`;

type Context = {
  __typename?: string; status?: string; conclusion?: string | null; state?: string; isRequired?: boolean;
  name?: string; startedAt?: string | null; completedAt?: string | null; detailsUrl?: string | null; checkSuite?: { workflowRun?: { workflow?: { name?: string } } | null } | null;
  context?: string; description?: string | null; targetUrl?: string | null; createdAt?: string | null;
};
const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
function outcomeOf(context: Context): GithubCheck["outcome"] {
  const outcome = context.__typename === "StatusContext" ? context.state : context.status === "COMPLETED" ? context.conclusion : "PENDING";
  if (outcome === "SUCCESS") return "passing";
  if (outcome === "SKIPPED" || outcome === "NEUTRAL") return "skipped";
  return FAILED.has(outcome ?? "") ? "failing" : "pending";
}
const safeUrl = (url: unknown): string | null => typeof url === "string" && /^https:\/\//.test(url) ? url : null;
const RANK = { failing: 0, pending: 1, passing: 2, skipped: 3 } as const;
/** Each check run or commit status once: failing, then running, then passing, then skipped; required first within each. */
export function listChecks(contexts: Context[]): GithubCheck[] {
  return contexts.map((context): GithubCheck => {
    const status = context.__typename === "StatusContext";
    return {
      name: (status ? context.context : context.name) ?? "",
      workflow: status ? null : context.checkSuite?.workflowRun?.workflow?.name ?? null,
      outcome: outcomeOf(context), required: context.isRequired === true,
      started_at: (status ? context.createdAt : context.startedAt) ?? null,
      completed_at: status ? null : context.completedAt ?? null,
      description: status ? context.description ?? null : null,
      url: safeUrl(status ? context.targetUrl : context.detailsUrl),
    };
  }).filter((check) => check.name).sort((a, b) => RANK[a.outcome] - RANK[b.outcome] || Number(b.required) - Number(a.required) || a.name.localeCompare(b.name));
}
/** Each check counted once, by what it came to. */
export function countChecks(checks: GithubCheck[]): GithubPullDetail["checks"] {
  const counts = { passing: 0, failing: 0, pending: 0, skipped: 0 };
  for (const check of checks) counts[check.outcome]++;
  return counts;
}
const MERGE = { CLEAN: "clean", HAS_HOOKS: "clean", DIRTY: "conflicts", BEHIND: "behind", BLOCKED: "blocked", UNSTABLE: "unstable", DRAFT: "draft" } as const;

const REVIEW_STATES = { APPROVED: "approved", CHANGES_REQUESTED: "changes_requested", COMMENTED: "commented" } as const;
export function parseGithubPull(output: string, repository: string): GithubPullDetail {
  try {
    const { data, errors } = JSON.parse(output);
    const pr = data?.repository?.pullRequest;
    if (errors?.length || !pr || !Number.isSafeInteger(pr.number) || typeof pr.title !== "string") throw unreadable();
    const reviewers: GithubPullDetail["reviewers"] = [];
    for (const review of pr.latestReviews?.nodes ?? []) {
      const state = REVIEW_STATES[review?.state as keyof typeof REVIEW_STATES];
      if (state && typeof review.author?.login === "string") reviewers.push({ login: review.author.login, state });
    }
    for (const request of pr.reviewRequests?.nodes ?? []) {
      const login = request?.requestedReviewer?.login ?? request?.requestedReviewer?.name;
      if (typeof login === "string" && !reviewers.some((reviewer) => reviewer.login === login)) reviewers.push({ login, state: "requested" });
    }
    const checkList = listChecks(pr.statusCheckRollup?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? []);
    const decision = pr.reviewDecision === "APPROVED" ? "approved" : pr.reviewDecision === "CHANGES_REQUESTED" ? "changes_requested" : pr.reviewDecision === "REVIEW_REQUIRED" ? "review_required" : "none";
    return {
      repository, number: pr.number, url: pr.url, title: pr.title, body: typeof pr.body === "string" ? pr.body : "",
      state: pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : "open", draft: pr.isDraft === true,
      author: pr.author?.login ?? null, created_at: pr.createdAt, updated_at: pr.updatedAt,
      head: pr.headRefName, base: pr.baseRefName, fork: pr.isCrossRepository === true,
      additions: pr.additions ?? 0, deletions: pr.deletions ?? 0, changed_files: pr.changedFiles ?? 0, commits: pr.commits?.totalCount ?? 0,
      checks: countChecks(checkList), check_list: checkList,
      merge: MERGE[pr.mergeStateStatus as keyof typeof MERGE] ?? "unknown",
      review: decision, reviewers,
      labels: (pr.labels?.nodes ?? []).filter((label: { name?: unknown }) => typeof label?.name === "string").map((label: { name: string; color?: string }) => ({ name: label.name, color: /^[0-9a-f]{6}$/i.test(label.color ?? "") ? label.color! : "888888" })),
    };
  } catch { throw unreadable(); }
}

/** A pull request's page with the given account's token; 20 seconds of cache per page. I/O is injectable. */
export function createGithubPullReader(run: Run = runGithub, now = Date.now) {
  const cache = new Map<string, { until: number; value: Promise<GithubPullDetail> }>();
  return (repository: string, number: number, account: string): Promise<GithubPullDetail> => {
    const key = `${account}\n${repository}#${number}`;
    const hit = cache.get(key);
    if (hit && now() < hit.until) return hit.value;
    const value = (async () => {
      const token = await run(["auth", "token", "--user", account]);
      if (!token) throw new PullRequestError("gh_missing", "The GitHub CLI (gh) is not installed on this PC");
      if (token.code !== 0 || !token.stdout.trim()) throw new PullRequestError("gh_signed_out", "Sign in on this PC with gh auth login");
      const [owner, name] = repository.split("/");
      const result = await run(["api", "graphql", "--hostname", "github.com", "-f", `query=${PULL_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${number}`], { GH_TOKEN: token.stdout.trim() });
      if (!result) throw new PullRequestError("gh_missing", "The GitHub CLI (gh) is not installed on this PC");
      if (result.code !== 0) {
        const detail = `${result.stderr}\n${result.stdout}`;
        if (/rate limit|HTTP 429/i.test(detail)) throw new PullRequestError("rate_limited", "GitHub is limiting requests; try again in a few minutes");
        if (/gh auth login|not logged|authentication|HTTP 401|bad credentials/i.test(detail)) throw new PullRequestError("gh_signed_out", "Sign in on this PC with gh auth login");
        throw new PullRequestError("gh_failed", "Could not read this pull request");
      }
      return parseGithubPull(result.stdout, repository);
    })();
    cache.set(key, { until: now() + 20_000, value });
    value.catch(() => cache.delete(key));
    return value;
  };
}
const readPull = createGithubPullReader();

export async function handleGithubPull(request: Request, readOnly: boolean): Promise<Response> {
  if (readOnly) return jsonResponse({ error: { code: "read_only", message: "This device only watches" } }, 403);
  if (request.method !== "GET") return jsonResponse({ error: { code: "method_not_allowed", message: "Use GET" } }, 405);
  const params = new URL(request.url).searchParams;
  const repository = params.get("repo") ?? "";
  const number = Number(params.get("number"));
  const account = params.get("account") ?? "";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !Number.isSafeInteger(number) || number < 1 || !/^[\w-]+$/.test(account)) {
    return jsonResponse({ error: { code: "bad_request", message: "Name a repository, a pull request number and an account" } }, 400);
  }
  try {
    return jsonResponse(await readPull(repository, number, account));
  } catch (error) {
    return conflictResponse(error instanceof PullRequestError ? error.code : "gh_failed", error instanceof PullRequestError ? error.message : "Could not read this pull request");
  }
}

export async function handleGithubPulls(request: Request, snapshot: () => Promise<SessionSnapshot>, readOnly: boolean): Promise<Response> {
  if (readOnly) return jsonResponse({ error: { code: "read_only", message: "This device only watches" } }, 403);
  if (request.method !== "GET") return jsonResponse({ error: { code: "method_not_allowed", message: "Use GET" } }, 405);
  try {
    const listing = await readPulls();
    const known = await githubWorkspaces(await snapshot());
    const match = (pr: GithubPull): GithubPull => ({ ...pr, workspace_id: known.get(pr.repository.toLowerCase()) });
    return jsonResponse({ ...listing, review: listing.review.map(match), yours: listing.yours.map(match) });
  } catch (error) {
    return conflictResponse(error instanceof PullRequestError ? error.code : "gh_failed", error instanceof PullRequestError ? error.message : "Could not read GitHub pull requests");
  }
}
