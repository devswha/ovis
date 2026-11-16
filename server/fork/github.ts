import type { GithubCheck, GithubEntry, GithubFilePatch, GithubPull, GithubPullDetail, GithubPulls, GithubThread } from "../../shared/github.ts";
import type { SessionSnapshot } from "../../shared/protocol.ts";
import { conflictResponse, jsonResponse } from "../http.ts";
import { ghAccounts, originRepository, parsePullRequests, PullRequestError, runGithub } from "./pull-requests.ts";

// Search ideas and failure states: ricardofelixb/omarchy-github (MIT),
// Service.qml / omarchy-github-fetch. No code copied. Every signed-in account is read, each with its own
// token (`gh auth token --user`), never by switching gh's active account.
const FIELDS = `number title url headRefName isDraft isCrossRepository updatedAt author { login }
  repository { nameWithOwner } reviewDecision
  commits(last:1) { nodes { commit { statusCheckRollup { state } } } }`;
const REVIEWED = `headRefOid viewerLatestReview { commit { oid } }`;
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;
const TEAM_PREFIX = "is:pr is:open -author:@me sort:updated-desc";
const REVIEW_SEARCH = "is:pr is:open reviewed-by:@me -author:@me -review-requested:@me sort:updated-desc";

/** GitHub bounds search query length; keep each alias below that bound. */
function teamBatches(repositories: readonly string[]): string[][] {
  const batches: string[][] = [];
  for (const repository of new Set(repositories.filter((value) => REPOSITORY.test(value)))) {
    let batch = batches.at(-1);
    if (!batch || `${TEAM_PREFIX} ${[...batch, repository].map((value) => `repo:${value}`).join(" ")}`.length > 256) { batch = []; batches.push(batch); }
    batch.push(repository);
  }
  return batches;
}
const teamSearch = (repositories: readonly string[]) => `${TEAM_PREFIX} ${repositories.map((repository) => `repo:${repository}`).join(" ")}`;
/**
 * One account's read: what asks for its review, what it wrote, what it reviewed (kept when commits came
 * after its review), and the open pull requests of the repositories open as workspaces (`t0`, `t1`…),
 * split into bounded search aliases so an inaccessible repository does not hide readable ones.
 */
export function githubQuery(repositories: readonly string[]): string {
  const team = teamBatches(repositories).map((batch, index) => `  t${index}: search(query:${JSON.stringify(teamSearch(batch))},type:ISSUE,first:100) { nodes { ... on PullRequest { ${FIELDS} } } }`);
  return `query {
  viewer { login }
  review: search(query:"is:pr is:open review-requested:@me sort:updated-desc",type:ISSUE,first:50) { nodes { ... on PullRequest { ${FIELDS} } } }
  yours: search(query:"is:pr is:open author:@me sort:updated-desc",type:ISSUE,first:50) { nodes { ... on PullRequest { ${FIELDS} } } }
  reviewed: search(query:${JSON.stringify(REVIEW_SEARCH)},type:ISSUE,first:100) { pageInfo { hasNextPage endCursor } nodes { ... on PullRequest { ${FIELDS} ${REVIEWED} } } }
${team.join("\n")}
}`;
}
const unreadable = () => new PullRequestError("gh_unreadable", "GitHub's answer could not be read");

/** Translate the GraphQL envelope to the existing PR contract, preserving each search's memberships. */
export function parseGithubPulls(output: string): GithubPulls {
  try {
    const { data, errors } = JSON.parse(output);
    // a repository of the Team section this account cannot see fails alone; any other error fails the read
    const teamOnly = (errors ?? []).every((error: { path?: unknown[] }) => typeof error?.path?.[0] === "string" && /^t\d+$/.test(error.path[0] as string));
    if (!teamOnly || typeof data?.viewer?.login !== "string") throw unreadable();
    const viewer: string = data.viewer.login;
    const rowOf = (value: unknown): GithubPull => {
      const row = value as { number: number; url: string; repository?: { nameWithOwner?: unknown }; commits?: { nodes?: { commit?: { statusCheckRollup?: { state?: string } | null } }[] } };
      const repository = row?.repository?.nameWithOwner;
      if (typeof repository !== "string" || !REPOSITORY.test(repository) || !Number.isSafeInteger(row.number) || row.number < 1 || row.url !== `https://github.com/${repository}/pull/${row.number}`) throw unreadable();
      // The aggregate covers every check, including contexts beyond GitHub's first page.
      const rollup = row.commits?.nodes?.[0]?.commit?.statusCheckRollup;
      const [entry] = parsePullRequests(JSON.stringify([{ ...row, statusCheckRollup: rollup ? [{ state: rollup.state }] : [] }]), []);
      if (!entry) throw unreadable();
      return { ...entry, repository, account: viewer };
    };
    const group = (nodes: unknown, keep: (value: Record<string, unknown>) => boolean = () => true, extra: Partial<GithubPull> = {}): GithubPull[] => {
      if (!Array.isArray(nodes)) throw unreadable();
      const unique = new Map<string, GithubPull>();
      for (const value of nodes) if (keep(value as Record<string, unknown>)) { const entry = { ...rowOf(value), ...extra }; unique.set(entry.url, entry); }
      return [...unique.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    };
    const review = group(data.review?.nodes);
    const yours = group(data.yours?.nodes);
    // reviewed, then changed: commits came after this account's latest review, and nobody asked it again
    const changed = group(data.reviewed?.nodes, (value) => {
      const reviewed = (value.viewerLatestReview as { commit?: { oid?: unknown } } | null)?.commit?.oid;
      return typeof reviewed === "string" && typeof value.headRefOid === "string" && reviewed !== value.headRefOid;
    }, { updated_since_review: true });
    const listed = new Set([...review, ...yours, ...changed].map((pull) => pull.url));
    const team = group(Object.keys(data).filter((key) => /^t\d+$/.test(key)).flatMap((key) => data[key]?.nodes ?? []),
      (value) => (value.author as { login?: unknown } | null)?.login !== viewer).filter((pull) => !listed.has(pull.url));
    return { accounts: [viewer], review: [...review, ...changed].sort((a, b) => b.updated_at.localeCompare(a.updated_at)), yours, team };
  } catch { throw unreadable(); }
}

/** Rows from several accounts as one list: a PR both accounts see appears once per group, newest first. */
export function mergeGithubPulls(listings: GithubPulls[], failed: string[] = []): GithubPulls {
  const mine = new Set(listings.flatMap((listing) => [...listing.review, ...listing.yours]).map((pull) => pull.url));
  const merge = (rows: GithubPull[]): GithubPull[] => [...new Map(rows.map((row) => [row.url, row] as const)).values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return {
    accounts: listings.flatMap((listing) => listing.accounts),
    ...(failed.length > 0 ? { failed } : {}),
    review: merge(listings.flatMap((listing) => listing.review)),
    yours: merge(listings.flatMap((listing) => listing.yours)),
    // another account's request or its own pull request is not the team's
    team: merge(listings.flatMap((listing) => listing.team)).filter((pull) => !mine.has(pull.url)),
  };
}

type Run = typeof runGithub;
/** One account's read, with that account's token. */
async function readAccount(run: Run, account: string, repositories: readonly string[]): Promise<GithubPulls> {
  const token = await run(["auth", "token", "--user", account]);
  if (!token) throw new PullRequestError("gh_missing", "The GitHub CLI (gh) is not installed on this PC");
  if (token.code !== 0 || !token.stdout.trim()) throw new PullRequestError("gh_signed_out", "Sign in on this PC with gh auth login");
  const result = await run(["api", "graphql", "--hostname", "github.com", "-f", `query=${githubQuery(repositories)}`], { GH_TOKEN: token.stdout.trim() });
  if (!result) throw new PullRequestError("gh_missing", "The GitHub CLI (gh) is not installed on this PC");
  if (result.code !== 0) {
    // gh exits 1 when any part of the answer failed: a Team repository this account cannot see fails alone
    try { parseGithubPulls(result.stdout); } catch {
      const detail = `${result.stderr}\n${result.stdout}`;
      if (/rate limit|HTTP 429/i.test(detail)) throw new PullRequestError("rate_limited", "GitHub is limiting requests; try again in a few minutes");
      if (/gh auth login|not logged|authentication|HTTP 401|bad credentials/i.test(detail)) throw new PullRequestError("gh_signed_out", "Sign in on this PC with gh auth login");
      throw new PullRequestError("gh_failed", "Could not read GitHub pull requests");
    }
  }
  let envelope;
  try { envelope = JSON.parse(result.stdout); } catch { throw unreadable(); }
  // Validate the primary fields and reject unrelated GraphQL errors before making any retries.
  parseGithubPulls(result.stdout);
  // If a whole alias fails, retry its repositories separately so one inaccessible
  // repository cannot hide its peers.
  const batches = teamBatches(repositories);
  for (const error of envelope.errors ?? []) {
    const alias = error?.path?.[0];
    const index = typeof alias === "string" && /^t\d+$/.test(alias) ? Number(alias.slice(1)) : -1;
    if (index < 0 || !batches[index]) continue;
    const nodes: unknown[] = [];
    for (const repo of batches[index]!) {
      const query = `query { t0: search(query:${JSON.stringify(teamSearch([repo]))},type:ISSUE,first:100) { nodes { ... on PullRequest { ${FIELDS} } } } }`;
      const single = await run(["api", "graphql", "--hostname", "github.com", "-f", `query=${query}`], { GH_TOKEN: token.stdout.trim() });
      if (!single) throw new PullRequestError("gh_missing", "The GitHub CLI (gh) is not installed on this PC");
      let answer;
      try { answer = JSON.parse(single.stdout); } catch { throw unreadable(); }
      if (answer.errors !== undefined && !Array.isArray(answer.errors)) throw unreadable();
      if (answer.errors?.length) {
        if (!answer.errors.every((item: { path?: unknown[]; type?: string }) => item.path?.length === 1 && item.path[0] === "t0" && (item.type === "NOT_FOUND" || item.type === "FORBIDDEN"))) throw unreadable();
        continue;
      }
      if (single.code !== 0 || !Array.isArray(answer.data?.t0?.nodes)) throw unreadable();
      nodes.push(...answer.data.t0.nodes);
    }
    envelope.data[alias] = { nodes };
  }
  const reviewed = envelope.data?.reviewed;
  for (let page = 1; page < 3 && reviewed?.pageInfo?.hasNextPage; page++) {
    const cursor = reviewed.pageInfo.endCursor;
    if (typeof cursor !== "string" || !cursor) throw unreadable();
    const query = `query { reviewed: search(query:${JSON.stringify(REVIEW_SEARCH)},type:ISSUE,first:100,after:${JSON.stringify(cursor)}) { pageInfo { hasNextPage endCursor } nodes { ... on PullRequest { ${FIELDS} ${REVIEWED} } } } }`;
    const next = await run(["api", "graphql", "--hostname", "github.com", "-f", `query=${query}`], { GH_TOKEN: token.stdout.trim() });
    if (!next || next.code !== 0) throw new PullRequestError("gh_failed", "Could not read GitHub pull requests");
    let answer;
    try { answer = JSON.parse(next.stdout); } catch { throw unreadable(); }
    if (answer.errors?.length || !Array.isArray(answer.data?.reviewed?.nodes) || typeof answer.data.reviewed.pageInfo?.hasNextPage !== "boolean") throw unreadable();
    reviewed.nodes.push(...answer.data.reviewed.nodes);
    reviewed.pageInfo = answer.data.reviewed.pageInfo;
  }
  return parseGithubPulls(JSON.stringify(envelope));
}

/** One in-flight read and a 20-second cache; no timers or background refreshes. I/O is injectable. Every account gh
 * is signed in with on github.com is read side by side; one that fails is named in `failed` and the others still show. */
export function createGithubReader(run: Run = runGithub, now = Date.now): ((repositories?: readonly string[]) => Promise<GithubPulls>) & { forget(): void } {
  let cached: { until: number; key: string; value: GithubPulls } | undefined;
  let pending: { key: string; value: Promise<GithubPulls> } | undefined;
  return Object.assign((repositories: readonly string[] = []) => {
    // the Team section's repositories are part of what was read: another set is read again
    const key = [...repositories].sort().join(" ");
    if (cached && cached.key === key && now() < cached.until) return Promise.resolve(cached.value);
    if (pending && pending.key === key) return pending.value;
    const value = (async () => {
      const status = await run(["auth", "status"]);
      if (!status) throw new PullRequestError("gh_missing", "The GitHub CLI (gh) is not installed on this PC");
      const accounts = ghAccounts(`${status.stdout}\n${status.stderr}`);
      if (accounts.length === 0) throw new PullRequestError("gh_signed_out", "Sign in on this PC with gh auth login");
      const reads = await Promise.allSettled(accounts.map((account) => readAccount(run, account, repositories)));
      const read = reads.flatMap((outcome) => outcome.status === "fulfilled" ? [outcome.value] : []);
      if (read.length === 0) throw (reads[0] as PromiseRejectedResult).reason;
      const merged = mergeGithubPulls(read, accounts.filter((_, index) => reads[index]!.status === "rejected"));
      cached = { key, value: merged, until: now() + 20_000 };
      return merged;
    })().finally(() => { if (pending?.value === value) pending = undefined; });
    pending = { key, value };
    return value;
  }, { forget: () => { cached = undefined; } });
}
const readPulls = createGithubReader();

/** A GitHub repository checked out in one of this server's workspaces, at the workspace's folder. */
export interface GithubCheckout { repository: string; path: string; workspaceId: string }

/** Only this server's workspaces, never another PC's similarly named branch. */
export async function githubCheckouts(snapshot: SessionSnapshot, repositoryOf = originRepository): Promise<GithubCheckout[]> {
  const folders = new Map<string, string>();
  for (const workspace of snapshot.workspaces) {
    // Match the workspace API's repository: metadata or its first pane only. A later pane's
    // repo cannot safely use this workspace ID for checkout (see docs/fork.md).
    const path = workspace.worktree?.repo_root ?? snapshot.panes.find((pane) => pane.workspace_id === workspace.workspace_id)?.cwd;
    if (path && !folders.has(path)) folders.set(path, workspace.workspace_id);
  }
  const entries = [...folders];
  const matches = new Array<GithubCheckout | null>(entries.length).fill(null);
  let next = 0;
  // No workspace cap: bound subprocess concurrency, not which repositories can match.
  await Promise.all(Array.from({ length: Math.min(4, entries.length) }, async () => {
    while (next < entries.length) {
      const index = next++;
      const [path, id] = entries[index]!;
      try { matches[index] = { repository: await repositoryOf(path), path, workspaceId: id }; } catch { /* not a GitHub repository */ }
    }
  }));
  return matches.filter((match) => match !== null);
}

/** The workspace each repository is checked out in, by its lowercased `owner/name`. */
export async function githubWorkspaces(snapshot: SessionSnapshot, repositoryOf = originRepository): Promise<Map<string, string>> {
  return new Map((await githubCheckouts(snapshot, repositoryOf)).map((checkout) => [checkout.repository.toLowerCase(), checkout.workspaceId]));
}

const PULL_QUERY = `query($owner:String!,$name:String!,$number:Int!) { viewer { login } repository(owner:$owner,name:$name) { viewerPermission squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed pullRequest(number:$number) {
  number title url body state isDraft createdAt updatedAt author { login } headRefName headRefOid baseRefName isCrossRepository
  additions deletions changedFiles commits { totalCount } reviewDecision mergeStateStatus
  labels(first:20) { nodes { name color } }
  latestReviews(first:30) { nodes { author { login } state } }
  reviewRequests(first:30) { nodes { requestedReviewer { ... on User { login } ... on Team { name } } } }
  statusCheckRollup: commits(last:1) { nodes { commit { statusCheckRollup { contexts(first:100) { nodes {
    __typename
    ... on CheckRun { name status conclusion startedAt completedAt detailsUrl isRequired(pullRequestNumber:$number) checkSuite { workflowRun { workflow { name } } } }
    ... on StatusContext { context state description targetUrl createdAt isRequired(pullRequestNumber:$number) } } } } } } }
  timelineItems(last:100, itemTypes:[ISSUE_COMMENT, PULL_REQUEST_REVIEW, MERGED_EVENT, CLOSED_EVENT, REOPENED_EVENT, READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT]) { nodes {
    __typename
    ... on IssueComment { author { login } createdAt body url }
    ... on PullRequestReview { id author { login } submittedAt createdAt state body url }
    ... on MergedEvent { actor { login } createdAt }
    ... on ClosedEvent { actor { login } createdAt }
    ... on ReopenedEvent { actor { login } createdAt }
    ... on ReadyForReviewEvent { actor { login } createdAt }
    ... on ConvertToDraftEvent { actor { login } createdAt } } }
  files(first:100) { nodes { path additions deletions changeType } }
  reviewThreads(last:100) { nodes { isResolved isOutdated path line originalLine diffSide
    comments(first:50) { nodes { author { login } createdAt body diffHunk pullRequestReview { id } } } } }
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
type Login = { login?: unknown } | null | undefined;
const login = (who: Login): string | null => typeof who?.login === "string" ? who.login : null;
const text = (value: unknown): string => typeof value === "string" ? value : "";
/** The last few lines of a hunk: the ones a line comment sits under. */
const hunkTail = (hunk: string): string => hunk.split("\n").filter((line) => !line.startsWith("@@")).slice(-4).join("\n");
const EVENTS = { MergedEvent: "merged", ClosedEvent: "closed", ReopenedEvent: "reopened", ReadyForReviewEvent: "ready", ConvertToDraftEvent: "draft" } as const;
const ENTRY_REVIEW = { APPROVED: "approved", CHANGES_REQUESTED: "changes_requested", COMMENTED: "commented", DISMISSED: "dismissed" } as const;

/** The conversation, oldest first: each line thread under the review that opened it; a review that only answered threads, with nothing of its own, is left out. */
export function parseConversation(timeline: any[], threads: any[]): GithubEntry[] {
  const byReview = new Map<string, GithubThread[]>();
  for (const thread of threads) {
    const comments = (thread?.comments?.nodes ?? []).filter((comment: { createdAt?: unknown }) => typeof comment?.createdAt === "string");
    const first = comments[0];
    if (!first || typeof thread.path !== "string") continue;
    const review = typeof first.pullRequestReview?.id === "string" ? first.pullRequestReview.id : "";
    const list = byReview.get(review) ?? [];
    list.push({
      path: thread.path, line: thread.line ?? thread.originalLine ?? null, side: thread.diffSide === "LEFT" ? "old" : "new", resolved: thread.isResolved === true, outdated: thread.isOutdated === true,
      hunk: hunkTail(text(first.diffHunk)),
      comments: comments.map((comment: { author?: Login; createdAt: string; body?: unknown }) => ({ author: login(comment.author), at: comment.createdAt, body: text(comment.body) })),
    });
    byReview.set(review, list);
  }
  const entries: GithubEntry[] = [];
  for (const node of timeline) {
    if (node?.__typename === "IssueComment" && typeof node.createdAt === "string") {
      entries.push({ kind: "comment", author: login(node.author), at: node.createdAt, body: text(node.body), url: safeUrl(node.url) });
    } else if (node?.__typename === "PullRequestReview") {
      const state = ENTRY_REVIEW[node.state as keyof typeof ENTRY_REVIEW];
      const at = node.submittedAt ?? node.createdAt;
      const found = byReview.get(node.id) ?? [];
      if (!state || typeof at !== "string" || (state === "commented" && !text(node.body).trim() && found.length === 0)) continue;
      entries.push({ kind: "review", author: login(node.author), at, state, body: text(node.body), url: safeUrl(node.url), threads: found });
    } else if (node?.__typename in EVENTS && typeof node.createdAt === "string") {
      entries.push({ kind: "event", author: login(node.actor), at: node.createdAt, event: EVENTS[node.__typename as keyof typeof EVENTS] });
    }
  }
  // GitHub closes a pull request as it merges it: the merge says it all.
  const merged = new Set(entries.filter((entry) => entry.kind === "event" && entry.event === "merged").map((entry) => entry.at.slice(0, 16)));
  return entries.filter((entry) => !(entry.kind === "event" && entry.event === "closed" && merged.has(entry.at.slice(0, 16))));
}

const FILE_CHANGES = { ADDED: "added", DELETED: "deleted", RENAMED: "renamed", COPIED: "copied", MODIFIED: "modified", CHANGED: "modified" } as const;
const MERGE = { CLEAN: "clean", HAS_HOOKS: "clean", DIRTY: "conflicts", BEHIND: "behind", BLOCKED: "blocked", UNSTABLE: "unstable", DRAFT: "draft" } as const;

const REVIEW_STATES = { APPROVED: "approved", CHANGES_REQUESTED: "changes_requested", COMMENTED: "commented" } as const;
export function parseGithubPull(output: string, repository: string): GithubPullDetail {
  try {
    const { data, errors } = JSON.parse(output);
    const repo = data?.repository;
    const pr = repo?.pullRequest;
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
      head_sha: typeof pr.headRefOid === "string" ? pr.headRefOid : "",
      viewer: typeof data?.viewer?.login === "string" ? data.viewer.login : null,
      can_write: ["ADMIN", "MAINTAIN", "WRITE"].includes(repo?.viewerPermission),
      merge_methods: (["squash", "merge", "rebase"] as const).filter((method) => repo?.[{ squash: "squashMergeAllowed", merge: "mergeCommitAllowed", rebase: "rebaseMergeAllowed" }[method]] === true),
      files: (pr.files?.nodes ?? []).filter((file: { path?: unknown }) => typeof file?.path === "string").map((file: { path: string; additions?: number; deletions?: number; changeType?: string }) => ({
        path: file.path, additions: file.additions ?? 0, deletions: file.deletions ?? 0,
        change: FILE_CHANGES[file.changeType as keyof typeof FILE_CHANGES] ?? "modified",
      })),
      conversation: parseConversation(pr.timelineItems?.nodes ?? [], pr.reviewThreads?.nodes ?? []),
      labels: (pr.labels?.nodes ?? []).filter((label: { name?: unknown }) => typeof label?.name === "string").map((label: { name: string; color?: string }) => ({ name: label.name, color: /^[0-9a-f]{6}$/i.test(label.color ?? "") ? label.color! : "888888" })),
    };
  } catch { throw unreadable(); }
}

/** `gh` with one account's token, without switching the account gh itself uses; its output, or why there is none. */
async function ghAs(run: Run, account: string, args: string[], failed: string): Promise<string> {
  const token = await run(["auth", "token", "--user", account]);
  if (!token) throw new PullRequestError("gh_missing", "The GitHub CLI (gh) is not installed on this PC");
  if (token.code !== 0 || !token.stdout.trim()) throw new PullRequestError("gh_signed_out", "Sign in on this PC with gh auth login");
  const result = await run(args, { GH_TOKEN: token.stdout.trim() });
  if (!result) throw new PullRequestError("gh_missing", "The GitHub CLI (gh) is not installed on this PC");
  if (result.code !== 0) {
    const detail = `${result.stderr}\n${result.stdout}`;
    if (/rate limit|HTTP 429/i.test(detail)) throw new PullRequestError("rate_limited", "GitHub is limiting requests; try again in a few minutes");
    if (/gh auth login|not logged|authentication|HTTP 401|bad credentials/i.test(detail)) throw new PullRequestError("gh_signed_out", "Sign in on this PC with gh auth login");
    // a write GitHub refused (405 not mergeable, 409 head moved, 422 e.g. approving your own) says why in its own words
    const refused = /^gh: (.+?) \(HTTP (?:403|404|405|409|422)\)/m.exec(result.stderr)?.[1];
    if (refused) throw new PullRequestError("gh_refused", refused);
    throw new PullRequestError("gh_failed", failed);
  }
  return result.stdout;
}

/** Answers kept 20 seconds per key; a failed one is forgotten at once. */
function cached<T>(now: () => number): ((key: string, read: () => Promise<T>) => Promise<T>) & { forget(key: string): void } {
  const cache = new Map<string, { until: number; value: Promise<T> }>();
  return Object.assign((key: string, read: () => Promise<T>) => {
    const hit = cache.get(key);
    if (hit && now() < hit.until) return hit.value;
    const value = read();
    cache.set(key, { until: now() + 20_000, value });
    value.catch(() => cache.delete(key));
    return value;
  }, { forget: (key: string) => { cache.delete(key); } });
}

/** A pull request's page with the given account's token. I/O is injectable. */
export function createGithubPullReader(run: Run = runGithub, now = Date.now) {
  const cache = cached<GithubPullDetail>(now);
  return Object.assign((repository: string, number: number, account: string): Promise<GithubPullDetail> => cache(`${account}\n${repository}#${number}`, async () => {
    const [owner, name] = repository.split("/");
    const output = await ghAs(run, account, ["api", "graphql", "--hostname", "github.com", "-f", `query=${PULL_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${number}`], "Could not read this pull request");
    return parseGithubPull(output, repository);
  }), { forget: (repository: string, number: number, account: string) => cache.forget(`${account}\n${repository}#${number}`) });
}

const PATCH_CHANGES = { added: "added", removed: "deleted", renamed: "renamed", copied: "copied", modified: "modified", changed: "modified", unchanged: "modified" } as const;
/** Each file's patch as GitHub sends it (hunks only; none for a binary or too large file), with the git header the diff view reads put back. */
export function parseGithubFiles(output: string): GithubFilePatch[] {
  // Compare includes all changed files (up to 300) on its first page, not on later commit pages.
  const pages: unknown = JSON.parse(output);
  if (!Array.isArray(pages) || !Array.isArray(pages[0]?.files)) throw unreadable();
  const files = pages[0].files as { filename?: unknown; previous_filename?: unknown; status?: string; patch?: unknown }[];
  return files.filter((file) => typeof file?.filename === "string").map((file) => {
    const path = file.filename as string;
    const before = typeof file.previous_filename === "string" ? file.previous_filename : path;
    const change = PATCH_CHANGES[file.status as keyof typeof PATCH_CHANGES] ?? "modified";
    const hunks = typeof file.patch === "string" && file.patch.startsWith("@@") ? file.patch : null;
    const header = `diff --git a/${before} b/${path}\n${change === "added" ? "new file mode 100644\n" : change === "deleted" ? "deleted file mode 100644\n" : ""}--- ${change === "added" ? "/dev/null" : `a/${before}`}\n+++ ${change === "deleted" ? "/dev/null" : `b/${path}`}\n`;
    return { path, previous: before === path ? null : before, patch: hunks === null ? null : `${header}${hunks}${hunks.endsWith("\n") ? "" : "\n"}` };
  });
}

/** A pull request's changed files with their patches, the first 300 GitHub lists. */
export function createGithubFilesReader(run: Run = runGithub, now = Date.now) {
  const cache = cached<GithubFilePatch[]>(now);
  return (repository: string, number: number, account: string, head: string, base: string): Promise<GithubFilePatch[]> => cache(`${account}\n${repository}#${number}@${base}\n${head}`, async () => {
    const output = await ghAs(run, account, ["api", "--hostname", "github.com", "--paginate", "--slurp", `repos/${repository}/compare/${encodeURIComponent(base)}...${head}?per_page=100`], "Could not read this pull request's files");
    try { return parseGithubFiles(output); } catch { throw unreadable(); }
  });
}
const readFiles = createGithubFilesReader();

const readPull = createGithubPullReader();

/** The repository, number and account a pull request's routes are asked about, or a 400/403/405 answer. */
function pullAsked(request: Request, readOnly: boolean): { repository: string; number: number; account: string } | Response {
  if (readOnly) return jsonResponse({ error: { code: "read_only", message: "This device only watches" } }, 403);
  if (request.method !== "GET") return jsonResponse({ error: { code: "method_not_allowed", message: "Use GET" } }, 405);
  const params = new URL(request.url).searchParams;
  const repository = params.get("repo") ?? "";
  const number = Number(params.get("number"));
  const account = params.get("account") ?? "";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !Number.isSafeInteger(number) || number < 1 || !/^[\w-]+$/.test(account)) {
    return jsonResponse({ error: { code: "bad_request", message: "Name a repository, a pull request number and an account" } }, 400);
  }
  return { repository, number, account };
}

export async function handleGithubPull(request: Request, readOnly: boolean): Promise<Response> {
  const asked = pullAsked(request, readOnly);
  if (asked instanceof Response) return asked;
  try {
    return jsonResponse(await readPull(asked.repository, asked.number, asked.account));
  } catch (error) {
    return conflictResponse(error instanceof PullRequestError ? error.code : "gh_failed", error instanceof PullRequestError ? error.message : "Could not read this pull request");
  }
}

export async function handleGithubFiles(request: Request, readOnly: boolean): Promise<Response> {
  const asked = pullAsked(request, readOnly);
  if (asked instanceof Response) return asked;
  try {
    const head = new URL(request.url).searchParams.get("head") ?? "";
    if (!/^[a-f0-9]{40,64}$/i.test(head)) return jsonResponse({ error: { code: "bad_request", message: "Name the head commit" } }, 400);
    const base = new URL(request.url).searchParams.get("base") ?? "";
    if (!base || base.length > 1024 || /[\x00-\x20\x7f]/.test(base)) return jsonResponse({ error: { code: "bad_request", message: "Name the base branch" } }, 400);
    return jsonResponse({ files: await readFiles(asked.repository, asked.number, asked.account, head, base) });
  } catch (error) {
    return conflictResponse(error instanceof PullRequestError ? error.code : "gh_failed", error instanceof PullRequestError ? error.message : "Could not read this pull request's files");
  }
}

/** What can be done to a pull request from its page. */
export type GithubPullAction =
  | { action: "comment"; body: string }
  | { action: "approve" | "request_changes"; body: string }
  | { action: "merge"; method: "squash" | "merge" | "rebase"; sha: string }
  | { action: "close" | "reopen" };

/** The `gh api` call for an action; null when the action is not one we know or misses what it needs. */
export function githubActionArgs(repository: string, number: number, asked: unknown): string[] | null {
  const action = asked as Partial<{ action: string; body: unknown; method: unknown; sha: unknown }> | null;
  const body = typeof action?.body === "string" ? action.body : "";
  if (body.length > 65_000) return null;
  const api = ["api", "--hostname", "github.com", "--silent"];
  if (action?.action === "comment") return body.trim() ? [...api, "-X", "POST", `repos/${repository}/issues/${number}/comments`, "-f", `body=${body}`] : null;
  if (action?.action === "approve") return [...api, "-X", "POST", `repos/${repository}/pulls/${number}/reviews`, "-f", "event=APPROVE", "-f", `body=${body}`];
  // GitHub asks for words with a request for changes
  if (action?.action === "request_changes") return body.trim() ? [...api, "-X", "POST", `repos/${repository}/pulls/${number}/reviews`, "-f", "event=REQUEST_CHANGES", "-f", `body=${body}`] : null;
  if (action?.action === "close" || action?.action === "reopen") return [...api, "-X", "PATCH", `repos/${repository}/pulls/${number}`, "-f", `state=${action.action === "close" ? "closed" : "open"}`];
  if (action?.action === "merge") {
    // the head the page showed: GitHub refuses the merge when commits came after it
    if (!["squash", "merge", "rebase"].includes(action.method as string) || typeof action.sha !== "string" || !/^[0-9a-f]{40}$/.test(action.sha)) return null;
    return [...api, "-X", "PUT", `repos/${repository}/pulls/${number}/merge`, "-f", `merge_method=${action.method}`, "-f", `sha=${action.sha}`];
  }
  return null;
}

/** POST /api/fork/github/pull/action: comments, reviews or merges with the account that listed the pull request. */
export async function handleGithubAction(request: Request, readOnly: boolean, run: Run = runGithub): Promise<Response> {
  if (readOnly) return jsonResponse({ error: { code: "read_only", message: "This device only watches" } }, 403);
  if (request.method !== "POST") return jsonResponse({ error: { code: "method_not_allowed", message: "Use POST" } }, 405);
  let asked: { repo?: unknown; number?: unknown; account?: unknown };
  try { asked = await request.json(); } catch { asked = {}; }
  const repository = typeof asked.repo === "string" ? asked.repo : "";
  const number = Number(asked.number);
  const account = typeof asked.account === "string" ? asked.account : "";
  const args = /^[\w.-]+\/[\w.-]+$/.test(repository) && Number.isSafeInteger(number) && number > 0 && /^[\w-]+$/.test(account) ? githubActionArgs(repository, number, asked) : null;
  if (args === null) return jsonResponse({ error: { code: "bad_request", message: "Name a repository, a pull request, an account and an action with what it needs" } }, 400);
  try {
    await ghAs(run, account, args, "GitHub did not take it");
  } catch (error) {
    return conflictResponse(error instanceof PullRequestError ? error.code : "gh_failed", error instanceof PullRequestError ? error.message : "GitHub did not take it");
  } finally {
    // the next read shows what changed, whatever GitHub answered
    readPull.forget(repository, number, account);
    readPulls.forget();
  }
  return jsonResponse({ ok: true });
}

export async function handleGithubPulls(request: Request, snapshot: () => Promise<SessionSnapshot>, readOnly: boolean): Promise<Response> {
  if (readOnly) return jsonResponse({ error: { code: "read_only", message: "This device only watches" } }, 403);
  if (request.method !== "GET") return jsonResponse({ error: { code: "method_not_allowed", message: "Use GET" } }, 405);
  try {
    const checkouts = await githubCheckouts(await snapshot());
    const known = new Map(checkouts.map((checkout) => [checkout.repository.toLowerCase(), checkout.workspaceId]));
    const listing = await readPulls([...new Set(checkouts.map((checkout) => checkout.repository))]);
    const match = (pr: GithubPull): GithubPull => ({ ...pr, workspace_id: known.get(pr.repository.toLowerCase()) });
    return jsonResponse({ ...listing, review: listing.review.map(match), yours: listing.yours.map(match), team: listing.team.map(match) });
  } catch (error) {
    return conflictResponse(error instanceof PullRequestError ? error.code : "gh_failed", error instanceof PullRequestError ? error.message : "Could not read GitHub pull requests");
  }
}
