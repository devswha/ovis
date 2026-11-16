import { cloneElement, useEffect, useState, useSyncExternalStore, type MouseEventHandler, type ReactElement, type ReactNode } from "react";
import { GitPullRequest, RefreshCw } from "lucide-react";

import type { GithubPull, GithubPulls } from "../../shared/github.ts";
import type { WorktreeOpened } from "../../shared/protocol.ts";
import { ApiError, createWorktree, fetchPullRequestBranch, getJson, listWorktrees, openWorktree } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { useSettings } from "../lib/settings.ts";
import { githubGroups, githubStatus, loadGithubRepo, saveGithubRepo } from "./github.ts";
import { pullRequestWords } from "./pullRequestWords.ts";
import "./PullRequestsDialog.css";
import "./GithubInbox.css";

type Section = "inbox" | "github";
let section: Section = "inbox";
const listeners = new Set<() => void>();
export function setGithubSection(next: Section): void { section = next; for (const listener of listeners) listener(); }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
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
  const t = useT();
  if (!settings.pullRequests) return children;
  return <div className="fork-github-slot">
    {!props.wide && <nav className="fork-github-nav" aria-label={t("Inbox mode")}>
      <button type="button" className="btn btn-ghost" aria-current={current === "inbox" ? "page" : undefined} onClick={() => setGithubSection("inbox")}>{t("Agent inbox")}</button>
      <button type="button" className="btn btn-ghost" aria-current={current === "github" ? "page" : undefined} onClick={() => setGithubSection("github")}><GitPullRequest aria-hidden="true" />{t("GitHub|fork")}</button>
    </nav>}
    {current === "github" ? <GithubInbox {...props} /> : children}
  </div>;
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
  const groups = githubGroups(listing ?? { account: "", review: [], yours: [] }, repo);
  const { checks, reviews } = pullRequestWords(t);
  const statuses = { "Checks failing": t("Checks failing"), "Changes requested": t("Changes requested"), "Review requested": t("Review requested"), Draft: t("Draft"), "Checks running": t("Checks running"), Approved: t("Approved"), Ready: t("Ready") };

  const checkout = async (pr: GithubPull): Promise<void> => {
    if (!pr.workspace_id || busy !== null || watching) return;
    setBusy(pr.url); setError(null);
    try {
      // Re-read local checkouts when pressed, rather than assuming a branch isn't already open.
      const listing = await listWorktrees(pr.workspace_id, "local");
      const existing = listing.worktrees.find((entry) => entry.branch === pr.branch && !entry.is_prunable);
      let opened: WorktreeOpened;
      if (existing) opened = await openWorktree({ workspace_id: pr.workspace_id, path: existing.path }, "local");
      else {
        const { ref } = await fetchPullRequestBranch(pr.workspace_id, pr.branch, "local");
        opened = await createWorktree({ workspace_id: pr.workspace_id, branch: pr.branch, base: ref }, "local");
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
      return <li key={pr.url} className="fork-github-row">
        <button type="button" className="fork-github-summary" aria-expanded={open} onClick={() => setExpanded(open ? null : key)}>
          <span className="worktree-path">{pr.repository} · #{pr.number}</span>
          <span className="pr-title" dir="auto">{pr.title}</span>
          <span className={`pill pr-checks-${pr.checks} pr-review-${pr.review}`}>{statuses[githubStatus(pr, requested)]}</span>
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
    <header className="inbox-top"><h2>{t("GitHub|fork")}</h2><button type="button" className="icon-button" aria-label={t("Refresh")} title={t("Refresh")} disabled={loading || busy !== null} onClick={() => setRefresh((value) => value + 1)}><RefreshCw aria-hidden="true" /></button></header>
    <div className="inbox-scroll">
      {loading ? <p className="inbox-empty" role="status">{t("Reading pull requests…")}</p> : error !== null ? <p className="inbox-empty" role="alert">{error === "checkout_failed" ? t("Could not check out this pull request") : errors[error] ?? errors.gh_failed}</p> : listing !== null && <>
        <div className="fork-github-chips" role="group" aria-label={t("Repositories")}>
          <button type="button" className="btn btn-ghost" aria-pressed={groups.selected === ""} onClick={() => { setRepo(""); saveGithubRepo(""); }}>{t("All")}</button>
          {groups.repos.map(([name, count]) => <button type="button" className="btn btn-ghost" key={name} aria-pressed={groups.selected === name} onClick={() => { setRepo(name); saveGithubRepo(name); }}>{name}<span className="pill">{count}</span></button>)}
        </div>
        {groups.review.length + groups.yours.length === 0 ? <p className="inbox-empty" role="status">{t("Nothing needs you")}</p> : <>{group(groups.review, true)}{group(groups.yours, false)}</>}
      </>}
    </div>
  </section>;
}
