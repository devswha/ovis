import type { GithubPull, GithubPulls } from "../../shared/github.ts";
import type { SessionSnapshot } from "../../shared/protocol.ts";
import { conflictResponse, jsonResponse } from "../http.ts";
import { originRepository, parsePullRequests, PullRequestError, runGithub } from "./pull-requests.ts";

// Search ideas and failure states: ricardofelixb/omarchy-github (MIT),
// Service.qml / omarchy-github-fetch. No code copied; one active account here.
const FIELDS = `number title url headRefName isDraft isCrossRepository updatedAt author { login }
  repository { nameWithOwner } reviewDecision
  commits(last:1) { nodes { commit { statusCheckRollup { contexts(first:100) {
    pageInfo { hasNextPage } nodes { ... on CheckRun { status conclusion } ... on StatusContext { state } }
  } } } } }`;
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
        const row = value as { number: number; url: string; repository?: { nameWithOwner?: unknown }; commits?: { nodes?: { commit?: { statusCheckRollup?: { contexts?: { nodes?: unknown[]; pageInfo?: { hasNextPage?: boolean } } } } }[] } };
        const repository = row?.repository?.nameWithOwner;
        if (typeof repository !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !Number.isSafeInteger(row.number) || row.number < 1 || row.url !== `https://github.com/${repository}/pull/${row.number}`) throw unreadable();
        const contexts = row.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts;
        const [entry] = parsePullRequests(JSON.stringify([{ ...row, statusCheckRollup: contexts?.nodes }]), []);
        if (!entry) throw unreadable();
        if (contexts?.pageInfo?.hasNextPage && entry.checks !== "failing") entry.checks = "pending";
        unique.set(entry.url, { ...entry, repository });
      }
      return [...unique.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    };
    return { account: data.viewer.login, review: group(data.review), yours: group(data.yours) };
  } catch { throw unreadable(); }
}

/** One in-flight read and a 20-second cache; no timers or background refreshes. I/O is injectable. */
export function createGithubReader(run = runGithub, now = Date.now): () => Promise<GithubPulls> {
  let cached: { until: number; value: GithubPulls } | undefined;
  let pending: Promise<GithubPulls> | undefined;
  return () => {
    if (cached && now() < cached.until) return Promise.resolve(cached.value);
    if (pending) return pending;
    pending = (async () => {
      const result = await run(["api", "graphql", "--hostname", "github.com", "-f", `query=${QUERY}`]);
      if (!result) throw new PullRequestError("gh_missing", "The GitHub CLI (gh) is not installed on this PC");
      if (result.code !== 0) {
        const detail = `${result.stderr}\n${result.stdout}`;
        if (/rate limit|HTTP 429/i.test(detail)) throw new PullRequestError("rate_limited", "GitHub is limiting requests; try again in a few minutes");
        if (/gh auth login|not logged|authentication|HTTP 401|bad credentials/i.test(detail)) throw new PullRequestError("gh_signed_out", "Sign in on this PC with gh auth login");
        throw new PullRequestError("gh_failed", "Could not read GitHub pull requests");
      }
      const value = parseGithubPulls(result.stdout);
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
    const path = workspace.worktree?.repo_root ?? snapshot.panes.find((pane) => pane.workspace_id === workspace.workspace_id && pane.cwd)?.cwd;
    if (path && folders.size < 50 && !folders.has(path)) folders.set(path, workspace.workspace_id);
  }
  const matches = await Promise.all([...folders].map(async ([path, id]) => {
    try { return [await repositoryOf(path), id] as const; } catch { return null; }
  }));
  return new Map(matches.filter((match) => match !== null).map(([repo, id]) => [repo.toLowerCase(), id]));
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
