import { cloneElement, useEffect, useState, useSyncExternalStore, type MouseEventHandler, type ReactElement, type ReactNode } from "react";
import { ArrowLeft, FolderGit2, GitPullRequest, ListFilter, RefreshCw } from "lucide-react";

import { RowMenu } from "../components/RowMenu.tsx";

import type { GithubPull, GithubPulls } from "../../shared/github.ts";
import type { WorktreeOpened } from "../../shared/protocol.ts";
import { ApiError, getJson } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { useSettings } from "../lib/settings.ts";
import { githubGroups, githubStatus, loadGithubRepo, saveGithubRepo } from "./github.ts";
import { GithubPullPage } from "./GithubPull.tsx";
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
/* The open pull request: the wide pane's page, or the phone's screen over the list on an entry of its own. */
const PULL_KEY = "ovis:fork-github-pull";
let pull: GithubPull | null = null;
let onPullEntry = false;
const pullEntry = (): boolean => typeof window !== "undefined" && (window.history.state as Record<string, unknown> | null)?.[PULL_KEY] === true;
const emit = () => { for (const listener of listeners) listener(); };
function openPull(next: GithubPull, phone: boolean): void {
  if (phone && !pullEntry()) { window.history.pushState({ ...(window.history.state ?? {}), [PULL_KEY]: true }, ""); onPullEntry = true; }
  pull = next; emit();
}
export function closeGithubPull(): void {
  if (onPullEntry && pullEntry()) window.history.back();
  else { pull = null; emit(); }
}
if (typeof window !== "undefined") window.addEventListener("popstate", () => {
  if (!pullEntry() && onPullEntry) { onPullEntry = false; pull = null; emit(); }
  if (githubEntry()) { onEntry = true; setGithubSection("github"); }
  else if (onEntry) { onEntry = false; pull = null; setGithubSection("inbox"); }
});
const useSection = () => useSyncExternalStore(subscribe, () => section, () => "inbox" as Section);
const useOpenPull = () => useSyncExternalStore(subscribe, () => pull, () => null);

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

/** One line in App's pane area: while GitHub is the wide column's section, its page (or a placeholder) covers the chat. */
export function ForkGithubPane({ wide, watching, onOpened }: ViewProps) {
  const { settings } = useSettings();
  const current = useSection();
  const open = useOpenPull();
  const t = useT();
  if (!settings.pullRequests || !wide || current !== "github") return null;
  return <div className="fork-github-pane">
    {open === null ? <p className="inbox-unchosen" role="status">{t("Choose a pull request to open it here.")}</p>
      : <GithubPullPage key={open.url} pull={open} wide watching={watching} onOpened={(opened) => { setGithubSection("inbox"); onOpened(opened); }} />}
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

/** The last list read, kept across visits so going back to GitHub draws it at once. */
let listingCache: { value: GithubPulls; at: number } | null = null;
/** After an action on a pull request: the list is read again, now if it shows, else when it next does. */
let listingVersion = 0;
export function refreshGithubListing(): void { listingCache = null; listingVersion += 1; emit(); }
const useListingVersion = () => useSyncExternalStore(subscribe, () => listingVersion, () => 0);

export function GithubInbox({ wide, watching, onOpened }: ViewProps) {
  const t = useT();
  const open = useOpenPull();
  const [listing, setListing] = useState<GithubPulls | null>(() => listingCache?.value ?? null);
  const [repo, setRepo] = useState(loadGithubRepo);
  const [refresh, setRefresh] = useState(0);
  const version = useListingVersion();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repoMenu, setRepoMenu] = useState<HTMLElement | null>(null);
  const errors: Record<string, string> = {
    gh_missing: t("Install gh on this PC"), gh_signed_out: t("Sign in on this PC with gh auth login"),
    rate_limited: t("GitHub is limiting requests; try again later"), gh_failed: t("Could not read GitHub pull requests"),
  };
  useEffect(() => {
    // Coming back shows the last list at once; it is read again only when a minute old, or on Refresh.
    if (refresh === 0 && listingCache !== null && Date.now() - listingCache.at < 60_000) return;
    let cancelled = false;
    setLoading(true); setError(null);
    getJson<GithubPulls>("/api/fork/github/pulls", { cache: "no-store" }).then((next) => {
      listingCache = { value: next, at: Date.now() };
      if (cancelled) return;
      setListing(next); setLoading(false);
      setRepo((previous) => { const selected = githubGroups(next, previous).selected; saveGithubRepo(selected); return selected; });
    }, (reason: unknown) => {
      if (cancelled) return;
      setLoading(false); setError(reason instanceof ApiError ? reason.code ?? "gh_failed" : "gh_failed");
    });
    return () => { cancelled = true; };
  }, [refresh, version]);
  const groups = githubGroups(listing ?? { accounts: [], review: [], yours: [] }, repo);
  const statuses = { "Checks failing": t("Checks failing"), "Changes requested": t("Changes requested"), "Review requested": t("Review requested"), Draft: t("Draft"), "Checks running": t("Checks running"), Approved: t("Approved"), Ready: t("Ready") };

  const group = (rows: GithubPull[], requested: boolean) => rows.length > 0 && <section aria-label={requested ? t("Review requested") : t("Yours")}>
    <h3>{requested ? t("Review requested") : t("Yours")}</h3>
    <ul className="worktree-list pr-list">{rows.map((pr) => {
      const status = githubStatus(pr, requested);
      return <li key={pr.url} className="fork-github-row">
        <button type="button" className="fork-github-summary" aria-current={open?.url === pr.url ? "true" : undefined} onClick={() => openPull(pr, !wide)}>
          <span className="worktree-path">{pr.repository} · #{pr.number}</span>
          <span className="pr-title" dir="auto">{pr.title}</span>
          <span className={`pill ${statusClasses[status]}`}>{statuses[status]}</span>
        </button>
      </li>;
    })}</ul>
  </section>;
  if (!wide && open !== null) return <GithubPullPage key={open.url} pull={open} wide={false} watching={watching} onOpened={(opened) => { setGithubSection("inbox"); onOpened(opened); }} />;
  return <section className={`mode-inbox fork-github${wide ? " is-wide" : ""}`} aria-label={t("GitHub|fork")}>
    <header className="inbox-top">
      {!wide && <button type="button" className="icon-button inbox-round" aria-label={t("Back|fork inbox")} title={t("Back|fork inbox")} onClick={closeGithub}><ArrowLeft aria-hidden="true" /></button>}
      <span className="fork-github-gap" />
      {groups.repos.length > 1 && <button type="button" className={`icon-button inbox-round inbox-filter-toggle${groups.selected === "" ? "" : " is-on"}`} aria-label={t("Repositories")} title={groups.selected || t("Repositories")}
        aria-haspopup="menu" aria-expanded={repoMenu !== null} onClick={(event) => setRepoMenu(repoMenu === null ? event.currentTarget : null)}><ListFilter aria-hidden="true" /></button>}
      {repoMenu !== null && <RowMenu anchor={repoMenu} title={t("Repositories")} choice onClose={() => setRepoMenu(null)}
        items={[["", 0] as const, ...groups.repos].map(([name]) => ({ id: name || "all", label: name ? name.split("/").pop() ?? name : t("All"), icon: name ? FolderGit2 : ListFilter, checked: groups.selected === name, run: () => { setRepo(name); saveGithubRepo(name); } }))} />}
      <button type="button" className="icon-button inbox-round" aria-label={t("Refresh")} title={t("Refresh")} disabled={loading} onClick={() => setRefresh((value) => value + 1)}><RefreshCw className={loading && listing !== null ? "fork-github-spin" : undefined} aria-hidden="true" /></button></header>
    <div className="inbox-scroll">
      {error === null && (listing?.failed?.length ?? 0) > 0 && <p className="fork-github-note" role="status">{t("Could not read {accounts}", { accounts: listing!.failed!.join(", ") })}</p>}
      {error !== null && listing !== null && <p className="fork-github-note" role="alert">{errors[error] ?? errors.gh_failed}</p>}
      {listing === null ? loading || error === null ? <p className="inbox-empty" role="status">{t("Reading pull requests…")}</p> : <p className="inbox-empty" role="alert">{errors[error] ?? errors.gh_failed}</p> : <>
        {groups.review.length + groups.yours.length === 0 ? <p className="inbox-empty" role="status">{t("Nothing needs you")}</p> : <>{group(groups.review, true)}{group(groups.yours, false)}</>}
      </>}
    </div>
  </section>;
}
