import { cloneElement, useEffect, useRef, useState, useSyncExternalStore, type MouseEventHandler, type ReactElement } from "react";
import { ArrowLeft, Check, ChevronRight, CircleAlert, CircleCheck, CircleDot, CircleX, Eye, FolderGit2, GitPullRequest, GitPullRequestDraft, ListFilter, RefreshCw, Search, X } from "lucide-react";

import { RowMenu } from "../../components/RowMenu.tsx";

import type { GithubPull, GithubPullDetail, GithubPulls } from "../../../shared/github.ts";
import type { WorktreeOpened } from "../../../shared/protocol.ts";
import { ApiError, getJson } from "../../lib/api.ts";
import { useT } from "../../lib/i18n.ts";
import { useSettings } from "../../lib/settings.ts";
import { githubGroups, githubSearched, githubStatus, loadGithubRepo, saveGithubRepo, useKeptScroll } from "./github.ts";
import { ago } from "./GithubConversation.tsx";
import { GithubPullPage, keepGithubPage } from "./GithubPull.tsx";
import { setPullLinkOpener } from "./pullLinks.ts";
import { closePlace, onPlaceLeft, setPlace, usePlace } from "../inbox/place.ts";
import "./GithubInbox.css";

const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

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
/* On a phone, a pull request a chat's link opened covers the chat (ForkGithubPane) while the list stays as it was. */
let linked = false;
export function closeGithubPull(): void {
  if (onPullEntry && pullEntry()) window.history.back();
  else { pull = null; linked = false; emit(); }
}
if (typeof window !== "undefined") window.addEventListener("popstate", () => {
  if (!pullEntry() && onPullEntry) { onPullEntry = false; pull = null; linked = false; emit(); }
});
// the phone's Back out of Pull requests closes the pull request it had open
onPlaceLeft((from) => { if (from === "github" && pull !== null) { pull = null; emit(); } });
const useOpenPull = () => useSyncExternalStore(subscribe, () => pull, () => null);
const useLinked = () => useSyncExternalStore(subscribe, () => linked, () => false);

/** The row a link stands for: the list's own when it has one, so its account and workspace come with it, else the
    page as the first account that can read it sees it. Unread, the page says so and offers GitHub. */
async function linkedPull(repository: string, number: number, url: string): Promise<GithubPull> {
  if (listingCache === null) listingCache = { value: await getJson<GithubPulls>("/api/fork/github/pulls", { cache: "no-store" }), at: Date.now() };
  const listing = listingCache.value;
  const rows = [...listing.review, ...listing.yours, ...listing.team];
  const sameRepo = (row: GithubPull) => row.repository.toLowerCase() === repository.toLowerCase();
  const listed = rows.find((row) => sameRepo(row) && row.number === number);
  if (listed) return listed;
  const workspace_id = rows.find((row) => sameRepo(row) && row.workspace_id)?.workspace_id;
  const row: GithubPull = { repository, number, url, title: `${repository} #${number}`, branch: "", author: null, draft: false, fork: false,
    updated_at: "", checks: "none", review: "none", checkout: null, account: listing.accounts[0], ...(workspace_id ? { workspace_id } : {}) };
  for (const account of listing.accounts) {
    try {
      const detail = await getJson<GithubPullDetail>(`/api/fork/github/pull?${new URLSearchParams({ repo: repository, number: String(number), account })}`, { cache: "no-store" });
      keepGithubPage(detail);
      const checks = detail.checks.failing > 0 ? "failing" : detail.checks.pending > 0 ? "pending" : detail.checks.passing > 0 ? "passing" : "none";
      return { ...row, url: detail.url, title: detail.title, branch: detail.head, author: detail.author, draft: detail.draft, fork: detail.fork,
        updated_at: detail.updated_at, checks, review: detail.review, account };
    } catch { /* another account may see it */ }
  }
  return row;
}

/** A chat's link opens its pull request: wide, in the inbox's Pull requests; on a phone, over the chat, Back returning to it. */
function openLinked(enter: () => void, inMode: boolean) {
  return (repository: string, number: number, url: string): void => {
    const phone = window.matchMedia?.("(min-width: 769px)").matches !== true;
    if (!phone) { if (!inMode) enter(); setPlace("github"); }
    void linkedPull(repository, number, url).then((row) => {
      if (phone) linked = true;
      openPull(row, phone);
    }, () => window.open(url, "_blank", "noopener,noreferrer"));
  };
}

/** Wrap the existing Inbox button: its original action and focus behavior still run on return. */
export function ForkGithubRail({ children }: { children: ReactElement<{ "aria-current"?: "page"; onClick?: MouseEventHandler<HTMLButtonElement> }> }) {
  const { settings } = useSettings();
  const current = usePlace();
  const t = useT();
  if (!settings.pullRequests) return children;
  return <>
    {cloneElement(children, { "aria-current": current === "inbox" ? "page" : undefined, onClick: (event) => { setPlace("inbox"); children.props.onClick?.(event); } })}
    <button type="button" className="icon-button inbox-rail-item" aria-label={t("Pull requests")} title={t("Pull requests")} aria-current={current === "github" ? "page" : undefined} onClick={() => setPlace("github")}><GitPullRequest aria-hidden="true" /></button>
  </>;
}

export interface ViewProps { wide: boolean; watching: boolean; onOpened(opened: WorktreeOpened): void }

/** One line in App's pane area: while GitHub is the wide column's section, its page (or a placeholder) covers the chat. */
export function ForkGithubPane({ wide, watching, onOpened, inMode = false, enter }: ViewProps & { inMode?: boolean; enter?(): void }) {
  const { settings } = useSettings();
  const current = usePlace();
  const open = useOpenPull();
  const fromLink = useLinked();
  const t = useT();
  useEffect(() => {
    if (watching || enter === undefined) return;
    setPullLinkOpener(openLinked(enter, inMode));
    return () => setPullLinkOpener(null);
  }, [enter, inMode, watching]);
  if (settings.pullRequests && !wide && fromLink && open !== null) {
    return <div className="fork-github-pane"><GithubPullPage key={open.url} pull={open} wide={false} watching={watching} onOpened={onOpened} /></div>;
  }
  if (!settings.pullRequests || !wide || current !== "github") return null;
  return <div className="fork-github-pane">
    {open === null ? <p className="inbox-unchosen" role="status">{t("Choose a pull request to open it here.")}</p>
      : <GithubPullPage key={open.url} pull={open} wide watching={watching} onOpened={(opened) => { setPlace("inbox"); onOpened(opened); }} />}
  </div>;
}

/** The last list read, kept across visits so going back to GitHub draws it at once. */
let listingCache: { value: GithubPulls; at: number } | null = null;
/** After an action on a pull request: the list is read again, now if it shows, else when it next does. */
let listingVersion = 0;
export function refreshGithubListing(): void { listingCache = null; listingVersion += 1; emit(); }
const useListingVersion = () => useSyncExternalStore(subscribe, () => listingVersion, () => 0);

/** The search, kept while the app is open, as the agent inbox keeps its own. */
let searched = "";
/** The sections folded on this device. */
const FOLDED_KEY = "ovis:fork-github-folded";
const loadFolded = (): ReadonlySet<string> => { try { return new Set(JSON.parse(window.localStorage.getItem(FOLDED_KEY) ?? "[]") as string[]); } catch { return new Set(); } };

/** A row's state as one small mark; its words are its name. Problems first, as githubStatus orders them. */
const statusMarks = {
  "Checks failing": [CircleX, "failing"], "Changes requested": [CircleAlert, "failing"], "Review requested": [Eye, "dim"],
  Draft: [GitPullRequestDraft, "dim"], "Checks running": [CircleDot, "pending"], Approved: [CircleCheck, "passing"], Ready: [Check, "passing"],
} as const;

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
  const [query, setQueryState] = useState(searched);
  const setQuery = (next: string): void => { searched = next; setQueryState(next); };
  const [searchAsked, setSearchAsked] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const searchToggle = useRef<HTMLButtonElement>(null);
  const [folded, setFolded] = useState(loadFolded);
  const fold = (id: string): void => setFolded((before) => {
    const next = new Set(before);
    if (!next.delete(id)) next.add(id);
    try { window.localStorage.setItem(FOLDED_KEY, JSON.stringify([...next])); } catch { /* storage may be disabled */ }
    return next;
  });
  const scroll = useKeptScroll<HTMLDivElement>("pull-requests", listing !== null && (wide || open === null));
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
  const groups = githubGroups(listing ?? { accounts: [], review: [], yours: [], team: [] }, repo);
  const review = githubSearched(groups.review, query);
  const yours = githubSearched(groups.yours, query);
  const team = githubSearched(groups.team, query);
  const statuses = { "Checks failing": t("Checks failing"), "Changes requested": t("Changes requested"), "Review requested": t("Review requested"), Draft: t("Draft"), "Checks running": t("Checks running"), Approved: t("Approved"), Ready: t("Ready") };

  const group = (id: string, label: string, rows: GithubPull[], requested: boolean) => rows.length > 0 && <section className="fork-github-group" aria-label={label}>
    <h3><button type="button" className="fork-github-group-head" aria-expanded={!folded.has(id)} onClick={() => fold(id)}>
      <ChevronRight aria-hidden="true" /><span>{label}</span><span className="fork-github-group-count">{rows.length}</span>
    </button></h3>
    {!folded.has(id) && <ul className="fork-github-list">{rows.map((pr) => {
      const status = githubStatus(pr, false);
      // in its own section a review asked of you needs no mark saying so
      const [Mark, tone] = requested && status === "Review requested" && !pr.updated_since_review ? [null, ""] : statusMarks[status];
      return <li key={pr.url} className={`fork-github-row${open?.url === pr.url ? " is-current" : ""}`}>
        <button type="button" className="fork-github-summary" aria-current={open?.url === pr.url ? "true" : undefined} title={pr.title} onClick={() => openPull(pr, !wide)}>
          <span className="fork-github-row-title" dir="auto">{pr.title}</span>
          {Mark !== null && <span className={`fork-github-row-mark is-${tone}`} role="img" aria-label={statuses[status]} title={statuses[status]}><Mark aria-hidden="true" /></span>}
          <span className="fork-github-row-sub"><span title={pr.repository}>{pr.repository.split("/").pop()} #{pr.number}</span>{pr.author && <> · {pr.author}</>} · {ago(pr.updated_at)}{pr.updated_since_review && <> · <span className="fork-github-row-updated" title={t("New commits since your review")}>{t("New commits")}</span></>}</span>
        </button>
      </li>;
    })}</ul>}
  </section>;
  if (!wide && open !== null) return <GithubPullPage key={open.url} pull={open} wide={false} watching={watching} onOpened={(opened) => { setPlace("inbox"); onOpened(opened); }} />;

  // the agent inbox's own search: a field in the wide column's head (folded into its button when narrow), in the phone's foot
  const searchLabel = t("Search pull requests");
  const searchOpen = !wide || searchAsked || query !== "";
  const searchField = (searchOpen || wide) && <div className="inbox-search" role="search">
    {!wide && <Search className="inbox-search-glass" aria-hidden="true" />}
    <input ref={search} className="input inbox-search-input" type="search" value={query} placeholder={searchLabel} aria-label={searchLabel}
      autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} enterKeyHint="search" onChange={(event) => setQuery(event.target.value)}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        if (query !== "") setQuery("");
        else if (wide && searchToggle.current?.getClientRects().length) { setSearchAsked(false); searchToggle.current.focus(); }
        else event.currentTarget.blur();
      }} />
    {query !== "" && <button type="button" className="inbox-search-clear" aria-label={t("Clear search|fork")} onClick={() => { setQuery(""); search.current?.focus(); }}><X aria-hidden="true" /></button>}
  </div>;
  const filterButton = groups.repos.length > 1 && <button type="button" className={`icon-button inbox-round inbox-filter-toggle${groups.selected === "" ? "" : " is-on"}`} aria-label={t("Repositories")} title={groups.selected || t("Repositories")}
    aria-haspopup="menu" aria-expanded={repoMenu !== null} onClick={(event) => setRepoMenu(repoMenu === null ? event.currentTarget : null)}><ListFilter aria-hidden="true" /></button>;
  const refreshButton = <button type="button" className="icon-button inbox-round fork-github-refresh" aria-label={t("Refresh")} title={t("Refresh")} disabled={loading} onClick={() => setRefresh((value) => value + 1)}><RefreshCw className={loading && listing !== null ? "fork-github-spin" : undefined} aria-hidden="true" /></button>;
  const shown = review.length + yours.length + team.length;
  return <section className={`mode-inbox fork-github${wide ? " is-wide" : ""}`} aria-label={t("Pull requests")}>
    <header className={`inbox-top${wide && searchOpen ? " is-search-open" : ""}`}>
      {wide ? <>
        {searchField}
        <button type="button" ref={searchToggle} className="icon-button inbox-round inbox-search-toggle" aria-label={searchLabel} title={searchLabel} aria-expanded={searchOpen}
          onClick={() => { if (!searchOpen) setSearchAsked(true); else if (query === "") setSearchAsked(false); else search.current?.focus(); }}><Search aria-hidden="true" /></button>
        {filterButton}
        {refreshButton}
      </> : <>
        <button type="button" className="icon-button inbox-round" aria-label={t("Back|fork inbox")} title={t("Back|fork inbox")} onClick={closePlace}><ArrowLeft aria-hidden="true" /></button>
        {refreshButton}
      </>}
    </header>
    {repoMenu !== null && <RowMenu anchor={repoMenu} title={t("Repositories")} choice onClose={() => setRepoMenu(null)}
      items={[["", 0] as const, ...groups.repos].map(([name]) => ({ id: name || "all", label: name ? name.split("/").pop() ?? name : t("All"), icon: name ? FolderGit2 : ListFilter, checked: groups.selected === name, run: () => { setRepo(name); saveGithubRepo(name); } }))} />}
    <div ref={scroll} className="inbox-scroll">
      {error === null && (listing?.failed?.length ?? 0) > 0 && <p className="fork-github-note" role="status">{t("Could not read {accounts}", { accounts: listing!.failed!.join(", ") })}</p>}
      {error !== null && listing !== null && <p className="fork-github-note" role="alert">{errors[error] ?? errors.gh_failed}</p>}
      {listing === null ? loading || error === null ? <p className="inbox-empty" role="status">{t("Reading pull requests…")}</p> : <p className="inbox-empty" role="alert">{errors[error] ?? errors.gh_failed}</p>
        : shown > 0 ? <>{group("review", t("Review requested"), review, true)}{group("yours", t("Yours"), yours, false)}{group("team", t("Team"), team, false)}</>
        : <p className="inbox-empty" role="status">{query.trim() !== "" ? t("No pull requests match") : t("Nothing needs you")}</p>}
    </div>
    {!wide && <div className="inbox-foot">
      {filterButton}
      {searchField}
    </div>}
  </section>;
}
