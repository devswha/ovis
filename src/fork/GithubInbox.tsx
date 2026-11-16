import { cloneElement, useEffect, useState, useSyncExternalStore, type MouseEventHandler, type ReactElement, type ReactNode } from "react";
import { ArrowLeft, FolderGit2, GitPullRequest, ListFilter, RefreshCw } from "lucide-react";

import { RowMenu } from "../components/RowMenu.tsx";

import type { GithubPull, GithubPulls } from "../../shared/github.ts";
import type { WorktreeOpened } from "../../shared/protocol.ts";
import { ApiError, createWorktree, fetchPullRequestBranch, getJson, listWorktrees, openWorktree } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { useSettings } from "../lib/settings.ts";
import { githubGroups, githubStatus, loadGithubRepo, saveGithubRepo } from "./github.ts";
import { pullRequestWords } from "./pullRequestWords.ts";
import "./PullRequestsDialog.css";
import "./GithubInbox.css";

const statusClasses = {
  "Checks failing": "pr-checks-failing", "Changes requested": "pr-review-changes_requested",
  "Checks running": "pr-checks-pending", Approved: "pr-review-approved", Ready: "pr-checks-passing",
  "Review requested": "", Draft: "",
};

type Section = "inbox" | "github";
let section: Section = "inbox";
const listeners = new Set<() => void>();
export function setGithubSection(next: Section): void { section = next; for (const listener of listeners) listener(); }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/* A phone opens GitHub on a history entry of its own, so the phone's Back leaves it like the arrow does. The entry
   copies the state it stands on (the app's own keys stay), adding one key; the listener only reads. */
const GITHUB_KEY = "ovis:fork-github";
let onEntry = false;
const githubEntry = (): boolean => typeof window !== "undefined" && (window.history.state as Record<string, unknown> | null)?.[GITHUB_KEY] === true;
function openGithub(phone: boolean): void {
  if (phone && !githubEntry()) { window.history.pushState({ ...(window.history.state ?? {}), [GITHUB_KEY]: true }, ""); onEntry = true; }
  setGithubSection("github");
}
function closeGithub(): void {
  if (onEntry && githubEntry()) window.history.back();
  else setGithubSection("inbox");
}
if (typeof window !== "undefined") window.addEventListener("popstate", () => {
  if (githubEntry()) { onEntry = true; setGithubSection("github"); }
  else if (onEntry) { onEntry = false; setGithubSection("inbox"); }
});
const useSection = () => useSyncExternalStore(subscribe, () => section, () => "inbox" as Section);

/** Wrap the existing Inbox button: its original action and focus behavior still run on return. */
export function ForkGithubRail({ children }: { children: ReactElement<{ "aria-current"?: "page"; onClick?: MouseEventHandler<HTMLButtonElement> }> }) {
  const { settings } = useSettings();
  const current = useSection();
  const t = useT();
  if (!settings.pullRequests) return children;
  return <>
    {cloneElement(children, { "aria-current": current === "inbox" ? "page" : undefined, onClick: (event) => { setGithubSection("inbox"); children.props.onClick?.(event); } })}
    <button type="button" className="icon-button inbox-rail-item" aria-label={t("GitHub|fork")} title={t("GitHub|fork")} aria-current={current === "github" ? "page" : undefined} onClick={() => setGithubSection("github")}><GitPullRequest aria-hidden="true" /></button>
  </>;
}

interface ViewProps { wide: boolean; watching: boolean; onOpened(opened: WorktreeOpened): void }
/** One line in App: same list slot on desktop and phone, no changes to thread selection. */
export function ForkGithubSection({ children, ...props }: ViewProps & { children: ReactNode }) {
  const { settings } = useSettings();
  const current = useSection();
  if (!settings.pullRequests) return children;
  return <div className="fork-github-slot">
    {current === "github" ? <GithubInbox {...props} /> : children}
  </div>;
}

/** The phone's way in: a round button in the agent inbox's top row, beside New workspace. */
export function ForkGithubOpen() {
  const { settings } = useSettings();
  const t = useT();
  if (!settings.pullRequests) return null;
  return <button type="button" className="icon-button inbox-round fork-github-open" aria-label={t("GitHub|fork")} title={t("GitHub|fork")}
    onClick={() => openGithub(true)}><GitPullRequest aria-hidden="true" /></button>;
}

export function GithubInbox({ wide, watching, onOpened }: ViewProps) {
  const t = useT();
  const [listing, setListing] = useState<GithubPulls | null>(null);
  const [repo, setRepo] = useState(loadGithubRepo);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [repoMenu, setRepoMenu] = useState<HTMLElement | null>(null);
  const errors: Record<string, string> = {
    gh_missing: t("Install gh on this PC"), gh_signed_out: t("Sign in on this PC with gh auth login"),
    rate_limited: t("GitHub is limiting requests; try again later"), gh_failed: t("Could not read GitHub pull requests"),
  };
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    getJson<GithubPulls>("/api/fork/github/pulls", { cache: "no-store" }).then((next) => {
      if (cancelled) return;
      setListing(next); setLoading(false);
      setRepo((previous) => { const selected = githubGroups(next, previous).selected; saveGithubRepo(selected); return selected; });
    }, (reason: unknown) => {
      if (cancelled) return;
      setLoading(false); setError(reason instanceof ApiError ? reason.code ?? "gh_failed" : "gh_failed");
    });
    return () => { cancelled = true; };
  }, [refresh]);
  const groups = githubGroups(listing ?? { accounts: [], review: [], yours: [] }, repo);
  const { checks, reviews } = pullRequestWords(t);
  const statuses = { "Checks failing": t("Checks failing"), "Changes requested": t("Changes requested"), "Review requested": t("Review requested"), Draft: t("Draft"), "Checks running": t("Checks running"), Approved: t("Approved"), Ready: t("Ready") };

  const checkout = async (pr: GithubPull): Promise<void> => {
    // Branch names alone cannot establish which fork a local checkout belongs to.
    if (pr.fork || !pr.workspace_id || busy !== null || watching) return;
    setBusy(pr.url); setError(null);
    try {
      // Re-read local checkouts when pressed, rather than assuming a branch isn't already open.
      const listing = await listWorktrees(pr.workspace_id, "local");
      const existing = listing.worktrees.find((entry) => entry.branch === pr.branch && !entry.is_prunable);
      let opened: WorktreeOpened;
      if (existing) opened = await openWorktree({ workspace_id: pr.workspace_id, path: existing.path }, "local");
      else {
        // Creation must start at the main checkout, even when only a linked workspace is open.
        let source = listing.source.source_workspace_id ?? pr.workspace_id;
        if (!listing.source.source_workspace_id && listing.source.source_checkout_path !== listing.source.repo_root) {
          source = (await openWorktree({ workspace_id: pr.workspace_id, path: listing.source.repo_root }, "local")).workspace_id;
        }
        const { ref } = await fetchPullRequestBranch(source, pr.branch, "local");
        opened = await createWorktree({ workspace_id: source, branch: pr.branch, base: ref }, "local");
      }
      setGithubSection("inbox"); onOpened(opened);
    } catch { setError("checkout_failed"); }
    finally { setBusy(null); }
  };
  const group = (rows: GithubPull[], requested: boolean) => rows.length > 0 && <section aria-label={requested ? t("Review requested") : t("Yours")}>
    <h3>{requested ? t("Review requested") : t("Yours")}</h3>
    <ul className="worktree-list pr-list">{rows.map((pr) => {
      const key = `${requested ? "review" : "yours"}:${pr.url}`;
      const open = expanded === key;
      const status = githubStatus(pr, requested);
      return <li key={pr.url} className="fork-github-row">
        <button type="button" className="fork-github-summary" aria-expanded={open} onClick={() => setExpanded(open ? null : key)}>
          <span className="worktree-path">{pr.repository} · #{pr.number}</span>
          <span className="pr-title" dir="auto">{pr.title}</span>
          <span className={`pill ${statusClasses[status]}`}>{statuses[status]}</span>
        </button>
        {open && <div className="fork-github-details">
          <p>{checks[pr.checks] ?? t("No checks")} · {reviews[pr.review] ?? t("No review yet")}</p>
          <p className="worktree-path">{pr.branch}</p>
          <div className="fork-github-actions">
            {!watching && pr.workspace_id && !pr.fork && <button type="button" className="btn" disabled={busy !== null} onClick={() => void checkout(pr)}>{busy === pr.url ? t("Checking out…") : t("Checkout")}</button>}
            <a className="btn btn-ghost" href={pr.url} target="_blank" rel="noreferrer noopener">{t("Open on GitHub")}</a>
          </div>
        </div>}
      </li>;
    })}</ul>
  </section>;
  return <section className={`mode-inbox fork-github${wide ? " is-wide" : ""}`} aria-label={t("GitHub|fork")}>
    <header className="inbox-top">
      {!wide && <button type="button" className="icon-button inbox-round" aria-label={t("Back|fork inbox")} title={t("Back|fork inbox")} onClick={closeGithub}><ArrowLeft aria-hidden="true" /></button>}
      <span className="fork-github-gap" />
      {groups.repos.length > 1 && <button type="button" className={`icon-button inbox-round inbox-filter-toggle${groups.selected === "" ? "" : " is-on"}`} aria-label={t("Repositories")} title={groups.selected || t("Repositories")}
        aria-haspopup="menu" aria-expanded={repoMenu !== null} onClick={(event) => setRepoMenu(repoMenu === null ? event.currentTarget : null)}><ListFilter aria-hidden="true" /></button>}
      {repoMenu !== null && <RowMenu anchor={repoMenu} title={t("Repositories")} choice onClose={() => setRepoMenu(null)}
        items={[["", 0] as const, ...groups.repos].map(([name]) => ({ id: name || "all", label: name ? name.split("/").pop() ?? name : t("All"), icon: name ? FolderGit2 : ListFilter, checked: groups.selected === name, run: () => { setRepo(name); saveGithubRepo(name); } }))} />}
      <button type="button" className="icon-button inbox-round" aria-label={t("Refresh")} title={t("Refresh")} disabled={loading || busy !== null} onClick={() => setRefresh((value) => value + 1)}><RefreshCw aria-hidden="true" /></button></header>
    <div className="inbox-scroll">
      {!loading && error === null && (listing?.failed?.length ?? 0) > 0 && <p className="fork-github-note" role="status">{t("Could not read {accounts}", { accounts: listing!.failed!.join(", ") })}</p>}
      {loading ? <p className="inbox-empty" role="status">{t("Reading pull requests…")}</p> : error !== null ? <p className="inbox-empty" role="alert">{error === "checkout_failed" ? t("Could not check out this pull request") : errors[error] ?? errors.gh_failed}</p> : listing !== null && <>
        {groups.review.length + groups.yours.length === 0 ? <p className="inbox-empty" role="status">{t("Nothing needs you")}</p> : <>{group(groups.review, true)}{group(groups.yours, false)}</>}
      </>}
    </div>
  </section>;
}
