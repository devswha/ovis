import { mkdir, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { SessionSnapshot } from "../../shared/protocol.ts";
import type { GithubClonePlace } from "../../shared/github.ts";
import { conflictResponse, jsonResponse } from "../http.ts";
import { githubCheckouts } from "./github.ts";
import { originRepository, PullRequestError, runGit, runGithub } from "./pull-requests.ts";

/** A clone of a large repository takes minutes; gh is given this long before it is stopped. */
const CLONE_DEADLINE_MS = 10 * 60_000;
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;
const ACCOUNT = /^[\w-]+$/;

type Run = typeof runGithub;

/** A folder the user named (`~/…` or absolute), inside the home folder; null for any other. */
export function placeFolder(asked: string, home = homedir()): string | null {
  const text = asked.trim();
  if (text === "" || text.includes("\0")) return null;
  const expanded = text === "~" ? home : text.startsWith("~/") ? join(home, text.slice(2)) : text;
  if (!isAbsolute(expanded)) return null;
  const path = resolve(expanded);
  const inside = relative(home, path);
  return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside) ? path : null;
}

/**
 * The folder a clone of `repository` is suggested in, `<parent>/<name>`: the parent most of the same
 * owner's checkouts on this server share, else the one the last clone went into, else `~/Projects`.
 * `roots` are the checkouts' top folders by repository.
 */
export function suggestedFolder(repository: string, parent: string | null, roots: ReadonlyArray<{ repository: string; root: string }> = [], home = homedir()): string {
  const owner = repository.split("/")[0]!.toLowerCase();
  const counts = new Map<string, number>();
  for (const { repository: other, root } of roots) {
    const folder = other.split("/")[0]!.toLowerCase() === owner ? placeFolder(dirname(root), home) : null;
    if (folder !== null) counts.set(folder, (counts.get(folder) ?? 0) + 1);
  }
  const shared = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  const base = shared ?? (parent ? placeFolder(parent, home) : null) ?? join(home, "Projects");
  return join(base, repository.split("/")[1] ?? repository);
}

/** The top folder of each GitHub checkout among this server's workspaces (a workspace may sit in a subfolder). */
async function checkoutRoots(snapshot: SessionSnapshot): Promise<Array<{ repository: string; root: string }>> {
  return Promise.all((await githubCheckouts(snapshot)).map(async ({ repository, path }) => {
    const top = await runGit(["-C", path, "rev-parse", "--show-toplevel"]);
    return { repository, root: top?.code === 0 && top.stdout.trim() ? top.stdout.trim() : path };
  }));
}

/** What is at a folder: nothing (or an empty folder), a checkout of this repository, or something else. */
export async function placeState(path: string, repository: string): Promise<GithubClonePlace["state"]> {
  const found = await stat(path).catch(() => null);
  if (found === null) return "free";
  if (!found.isDirectory()) return "taken";
  if ((await readdir(path)).length === 0) return "free";
  const origin = await originRepository(path).catch(() => null);
  return origin !== null && origin.toLowerCase() === repository.toLowerCase() ? "same" : "taken";
}

const tilde = (path: string, home = homedir()): string => (path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);

async function place(repository: string, asked: string | null, parent: string | null, snapshot: () => Promise<SessionSnapshot>): Promise<GithubClonePlace | null> {
  const path = asked === null ? suggestedFolder(repository, parent, await checkoutRoots(await snapshot())) : placeFolder(asked);
  if (path === null) return null;
  return { path, shown: tilde(path), state: await placeState(path, repository) };
}

const refused = (code: string, message: string, status = 400): Response => jsonResponse({ error: { code, message } }, status);

/**
 * GET /api/fork/github/clone?repo=&path=|parent=: where a clone of the repository would go and what is
 * there now. POST with `{ repo, account, path }`: clones it there with that account's token, or keeps a
 * checkout of it already there, and answers the folder; something else there is refused, never written over.
 */
export async function handleGithubClone(request: Request, url: URL, readOnly: boolean, snapshot: () => Promise<SessionSnapshot>, run: Run = runGithub): Promise<Response> {
  if (readOnly) return refused("read_only", "This device only watches", 403);
  if (request.method === "GET") {
    const repository = url.searchParams.get("repo") ?? "";
    if (!REPOSITORY.test(repository)) return refused("bad_request", "Name a repository as owner/name");
    const found = await place(repository, url.searchParams.get("path"), url.searchParams.get("parent"), snapshot);
    return found === null ? refused("bad_path", "Choose a folder inside your home folder") : jsonResponse(found);
  }
  if (request.method !== "POST") return refused("method_not_allowed", "Use GET or POST", 405);
  let asked: { repo?: unknown; account?: unknown; path?: unknown };
  try { asked = await request.json(); } catch { asked = {}; }
  const repository = typeof asked.repo === "string" && REPOSITORY.test(asked.repo) ? asked.repo : null;
  const account = typeof asked.account === "string" && ACCOUNT.test(asked.account) ? asked.account : null;
  const path = typeof asked.path === "string" ? placeFolder(asked.path) : null;
  if (repository === null || account === null) return refused("bad_request", "Name a repository and an account");
  if (path === null) return refused("bad_path", "Choose a folder inside your home folder");
  try {
    const state = await placeState(path, repository);
    if (state === "taken") return conflictResponse("path_taken", "Something else is in that folder");
    if (state === "free") await clone(run, repository, account, path);
    return jsonResponse({ path, cloned: state === "free" });
  } catch (error) {
    return conflictResponse(error instanceof PullRequestError ? error.code : "clone_failed", error instanceof PullRequestError ? error.message : "Could not clone the repository");
  }
}

/** `gh repo clone` with the account's token; the clone then names that account to git, so later fetches use it too. */
async function clone(run: Run, repository: string, account: string, path: string): Promise<void> {
  const token = await run(["auth", "token", "--user", account]);
  if (!token) throw new PullRequestError("gh_missing", "The GitHub CLI (gh) is not installed on this PC");
  if (token.code !== 0 || !token.stdout.trim()) throw new PullRequestError("gh_signed_out", "Sign in on this PC with gh auth login");
  await mkdir(dirname(path), { recursive: true });
  const result = await run(["repo", "clone", repository, path], { GH_TOKEN: token.stdout.trim(), GIT_TERMINAL_PROMPT: "0" }, CLONE_DEADLINE_MS);
  if (!result) throw new PullRequestError("gh_missing", "The GitHub CLI (gh) is not installed on this PC");
  if (result.code !== 0) {
    const reason = result.stderr.trim().split("\n").pop()?.slice(0, 300);
    throw new PullRequestError("clone_failed", reason || "Could not clone the repository");
  }
  // a credential helper that serves several accounts (gh's own does) picks the one named here
  await runGit(["-C", path, "config", "credential.https://github.com.username", account]);
}
