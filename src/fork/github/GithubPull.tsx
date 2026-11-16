import { useEffect, useState } from "react";
import { ArrowLeft, Check, ChevronDown, CircleAlert, CircleCheck, CircleDot, CircleSlash, CircleX, ExternalLink, FileDiff, GitBranch, GitCommitHorizontal, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, LoaderCircle, MessageSquare, X } from "lucide-react";

import { Markdown } from "../../components/Markdown.tsx";
import { Segmented } from "../../components/SettingsControls.tsx";

import type { GithubCheck, GithubPull, GithubPullDetail } from "../../../shared/github.ts";
import type { WorktreeOpened } from "../../../shared/protocol.ts";
import { ApiError, createWorktree, fetchPullRequestBranch, getJson, listWorktrees, openWorktree } from "../../lib/api.ts";
import { useT, type Translate } from "../../lib/i18n.ts";
import { closeGithubPull, refreshGithubListing } from "./GithubInbox.tsx";
import { GithubClose, GithubMerge, GithubReply } from "./GithubActions.tsx";
import { ago, GithubConversation, type JumpToLine } from "./GithubConversation.tsx";
import { GithubCloneDialog } from "./GithubClone.tsx";
import { GithubFiles, type FilesJump } from "./GithubFiles.tsx";
import { useKeptScroll } from "./github.ts";
import "./GithubPull.css";

function stateOf(detail: GithubPullDetail, t: Translate) {
  if (detail.state === "merged") return { icon: GitMerge, label: t("Merged"), tone: "merged" };
  if (detail.state === "closed") return { icon: GitPullRequestClosed, label: t("Closed"), tone: "closed" };
  if (detail.draft) return { icon: GitPullRequestDraft, label: t("Draft"), tone: "draft" };
  return { icon: GitPullRequest, label: t("Open"), tone: "open" };
}

/** Pages read this visit: reopening one draws it at once while it is read again behind it. */
const pageCache = new Map<string, GithubPullDetail>();
type Tab = "overview" | "conversation" | "checks" | "files";
/** The tab each pull request was left on, so coming back to it opens where it was. */
const tabs = new Map<string, Tab>();

const reviewIcons = { approved: Check, changes_requested: X, commented: MessageSquare, requested: CircleDot } as const;

function MergeIcon({ merge }: { merge: GithubPullDetail["merge"] }) {
  const Icon = merge === "clean" ? GitMerge : merge === "conflicts" || merge === "blocked" ? CircleAlert : merge === "unknown" ? LoaderCircle : CircleDot;
  return <Icon className={merge === "unknown" ? "fork-github-spin" : undefined} aria-hidden="true" />;
}

/** "4m 12s" */
function span(from: string | null, to: string | null): string | null {
  if (!from) return null;
  const seconds = Math.max(0, Math.round(((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 1000));
  if (!Number.isFinite(seconds)) return null;
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60), rest = seconds % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`;
}

const checkIcons = { passing: CircleCheck, failing: CircleX, pending: LoaderCircle, skipped: CircleSlash } as const;
/** Every check, problems first: the failing and running ones always shown, the passing and skipped ones folded behind their count when asked. */
function ChecksBox({ checks }: { checks: GithubCheck[] }) {
  const t = useT();
  const [open, setOpen] = useState(true);
  if (checks.length === 0) return <p className="fork-github-pull-dim">{t("No checks")}</p>;
  const counts = { failing: 0, pending: 0, passing: 0, skipped: 0 };
  for (const check of checks) counts[check.outcome]++;
  const settled = counts.passing + counts.skipped;
  const shown = open ? checks : checks.filter((check) => check.outcome === "failing" || check.outcome === "pending");
  const summary = [counts.failing > 0 && t("{count} failing", { count: counts.failing }), counts.pending > 0 && t("{count} running", { count: counts.pending }),
    counts.passing > 0 && t("{count} passing", { count: counts.passing }), counts.skipped > 0 && t("{count} skipped", { count: counts.skipped })].filter(Boolean).join(" · ");
  return <div className="fork-github-checks">
    <button type="button" className={`fork-github-checks-head is-${counts.failing > 0 ? "failing" : counts.pending > 0 ? "pending" : "passing"}`} aria-expanded={open} disabled={settled === 0} onClick={() => setOpen(!open)}>
      <span>{summary}</span>{settled > 0 && <ChevronDown className={open ? "is-open" : undefined} aria-hidden="true" />}
    </button>
    {shown.length > 0 && <ul>{shown.map((check, index) => {
      const Icon = checkIcons[check.outcome];
      const time = check.outcome === "pending" ? span(check.started_at, null) : span(check.started_at, check.completed_at);
      const inner = <>
        <Icon className={`is-${check.outcome}${check.outcome === "pending" ? " fork-github-spin" : ""}`} aria-hidden="true" />
        <span className="fork-github-check-name"><span dir="auto">{check.name}</span>{check.workflow && <span className="fork-github-pull-dim">{check.workflow}</span>}{check.description && <span className="fork-github-pull-dim">{check.description}</span>}</span>
        {check.required && <span className="fork-github-required">{t("Required")}</span>}
        {time && <span className="fork-github-pull-dim fork-github-check-time">{time}</span>}
      </>;
      return <li key={`${check.name}:${index}`}>{check.url ? <a href={check.url} target="_blank" rel="noreferrer noopener">{inner}</a> : <span>{inner}</span>}</li>;
    })}</ul>}
  </div>;
}

/** A tab's name with its count, when there is one. */
const counted = (label: string, count: number): string => count > 0 ? `${label} ${count}` : label;

/** One pull request, drawn from GitHub's API in Ovis's own design: the wide pane's page, or the phone's screen. */
export function GithubPullPage({ pull, wide, watching, onOpened }: { pull: GithubPull; wide: boolean; watching: boolean; onOpened(opened: WorktreeOpened): void }) {
  const t = useT();
  const [detail, setDetail] = useState<GithubPullDetail | null>(() => pageCache.get(pull.url) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTabState] = useState<Tab>(() => tabs.get(pull.url) ?? "overview");
  const setTab = (next: Tab): void => { tabs.set(pull.url, next); setTabState(next); };
  const [jump, setJump] = useState<FilesJump | null>(null);
  // each tab of each pull request opens where it was scrolled to
  const scroll = useKeptScroll<HTMLDivElement>(`${pull.url}#${tab}`, detail !== null);
  const jumpTo: JumpToLine = (thread) => {
    if (thread.line === null) return;
    setJump({ path: thread.path, side: thread.side, line: thread.line, seq: (jump?.seq ?? 0) + 1 });
    setTab("files");
  };
  // bumped after an action, so the page is read again and shows what GitHub made of it
  const [reload, setReload] = useState(0);
  const acted = (): void => { setReload((value) => value + 1); refreshGithubListing(); };
  useEffect(() => {
    let cancelled = false;
    const query = new URLSearchParams({ repo: pull.repository, number: String(pull.number), account: pull.account ?? "" });
    getJson<GithubPullDetail>(`/api/fork/github/pull?${query}`, { cache: "no-store" }).then(
      (next) => { pageCache.set(pull.url, next); if (!cancelled) setDetail(next); },
      (reason: unknown) => { if (!cancelled && !pageCache.has(pull.url)) setError(reason instanceof ApiError ? reason.code ?? "gh_failed" : "gh_failed"); },
    );
    return () => { cancelled = true; };
  }, [pull.repository, pull.number, pull.account, pull.url, reload]);

  const [cloning, setCloning] = useState(false);
  const checkout = async (workspaceId: string): Promise<void> => {
    // Branch names alone cannot establish which fork a local checkout belongs to.
    if (pull.fork || busy || watching) return;
    setBusy(true); setError(null);
    try {
      // Re-read local checkouts when pressed, rather than assuming a branch isn't already open.
      const listing = await listWorktrees(workspaceId, "local");
      const existing = listing.worktrees.find((entry) => entry.branch === pull.branch && !entry.is_prunable);
      let opened: WorktreeOpened;
      if (existing) opened = await openWorktree({ workspace_id: workspaceId, path: existing.path }, "local");
      else {
        // Creation must start at the main checkout, even when only a linked workspace is open.
        let source = listing.source.source_workspace_id ?? workspaceId;
        if (!listing.source.source_workspace_id && listing.source.source_checkout_path !== listing.source.repo_root) {
          source = (await openWorktree({ workspace_id: workspaceId, path: listing.source.repo_root }, "local")).workspace_id;
        }
        const { ref } = await fetchPullRequestBranch(source, pull.branch, "local");
        opened = await createWorktree({ workspace_id: source, branch: pull.branch, base: ref }, "local");
      }
      onOpened(opened);
    } catch { setError("checkout_failed"); }
    finally { setBusy(false); }
  };

  const errors: Record<string, string> = {
    gh_missing: t("Install gh on this PC"), gh_signed_out: t("Sign in on this PC with gh auth login"),
    rate_limited: t("GitHub is limiting requests; try again later"), checkout_failed: t("Could not check out this pull request"),
  };
  const state = detail && stateOf(detail, t);
  const mergeWords = {
    clean: t("Ready to merge"), conflicts: t("Conflicts with {base}", { base: detail?.base ?? "" }), behind: t("Behind {base}", { base: detail?.base ?? "" }),
    blocked: t("Merging is blocked"), unstable: t("Some checks are not passing"), draft: t("Draft: not ready to merge"), unknown: t("Checking whether it can merge…"),
  };
  const reviewWords = { approved: t("Approved"), changes_requested: t("Changes requested"), commented: t("Commented"), requested: t("Review requested") };

  return <article className={`fork-github-pull${wide ? " is-wide" : ""}`} aria-label={pull.title}>
    <header className="fork-github-pull-top">
      {!wide && <button type="button" className="icon-button inbox-round" aria-label={t("Back|fork inbox")} title={t("Back|fork inbox")} onClick={closeGithubPull}><ArrowLeft aria-hidden="true" /></button>}
      <span className="fork-github-pull-where">{pull.repository} · #{pull.number}</span>
      {!watching && !pull.fork && <button type="button" className="btn" disabled={busy}
        onClick={() => { if (pull.workspace_id) void checkout(pull.workspace_id); else setCloning(true); }}>
        {busy ? t("Checking out…") : pull.workspace_id ? t("Checkout") : t("Clone and checkout")}</button>}
      {cloning && <GithubCloneDialog pull={pull} onClose={() => setCloning(false)}
        onOpened={(workspaceId) => { setCloning(false); refreshGithubListing(); void checkout(workspaceId); }} />}
      <a className="icon-button inbox-round" href={pull.url} target="_blank" rel="noreferrer noopener" aria-label={t("Open on GitHub")} title={t("Open on GitHub")}><ExternalLink aria-hidden="true" /></a>
    </header>
    <div ref={scroll} className="fork-github-pull-scroll">
      <h1 dir="auto">{detail?.title ?? pull.title}</h1>
      {error !== null && <p className="fork-github-pull-error" role="alert">{errors[error] ?? t("Could not read this pull request")}</p>}
      {detail === null ? error === null && <p className="fork-github-pull-dim" role="status"><LoaderCircle className="fork-github-spin" aria-hidden="true" /> {t("Reading the pull request…")}</p> : <>
        <div className="fork-github-pull-meta">
          {state && <span className={`fork-github-state is-${state.tone}`}><state.icon aria-hidden="true" />{state.label}</span>}
          <span>{t("{author} wants to merge into {base} from {head}", { author: detail.author ?? t("Someone"), base: detail.base, head: detail.head })}</span>
          <span className="fork-github-pull-dim">{t("Updated {when}", { when: ago(detail.updated_at) })}</span>
        </div>
        {detail.state !== "merged" && <div className="fork-github-merge-row">
          {detail.state === "open" && <p className={`fork-github-merge is-${detail.merge}`}><MergeIcon merge={detail.merge} />{mergeWords[detail.merge]}</p>}
          <div className="fork-github-merge-actions">
            {detail.state === "open" && <GithubMerge pull={pull} detail={detail} watching={watching} onDone={acted} />}
            <GithubClose pull={pull} detail={detail} watching={watching} onDone={acted} />
          </div>
        </div>}
        <div className="fork-github-tabs">
          <Segmented<Tab> label={t("Pull request")} value={tab} onChange={setTab} options={[
            { value: "overview", label: t("Overview") },
            { value: "conversation", label: counted(t("Conversation"), detail.conversation?.length ?? 0) },
            { value: "checks", label: counted(t("Checks"), detail.check_list.length) },
            { value: "files", label: counted(t("Files"), detail.changed_files) },
          ]} />
        </div>
        {tab === "overview" && <>
          <ul className="fork-github-facts">
            <li><GitCommitHorizontal aria-hidden="true" />{t("{count} commits", { count: detail.commits })}</li>
            <li><FileDiff aria-hidden="true" />{t("{count} files", { count: detail.changed_files })} <span className="is-added">+{detail.additions}</span> <span className="is-removed">−{detail.deletions}</span></li>
            <li><GitBranch aria-hidden="true" /><code>{detail.head}</code></li>
          </ul>
          {detail.labels.length > 0 && <ul className="fork-github-labels">{detail.labels.map((label) => <li key={label.name} style={{ ["--label" as string]: `#${label.color}` }}>{label.name}</li>)}</ul>}
          <section className="fork-github-status" aria-label={t("Reviews")}>
            {detail.reviewers.length === 0 ? <p className="fork-github-pull-dim fork-github-reviews-none">{t("No review yet")}</p>
              : <ul className="fork-github-reviewers">{detail.reviewers.map((reviewer) => {
                const Icon = reviewIcons[reviewer.state];
                return <li key={reviewer.login} className={`is-${reviewer.state}`} title={reviewWords[reviewer.state]}><Icon aria-hidden="true" />{reviewer.login}<span className="fork-github-pull-dim">{reviewWords[reviewer.state]}</span></li>;
              })}</ul>}
          </section>
          <section className="fork-github-body" aria-label={t("Description")}>
            {detail.body.trim() ? <Markdown html>{detail.body}</Markdown> : <p className="fork-github-pull-dim">{t("No description.")}</p>}
          </section>
        </>}
        {tab === "conversation" && <section className="fork-github-tab-page" aria-label={t("Conversation")}><GithubConversation entries={detail.conversation ?? []} onJump={jumpTo} /><GithubReply key={pull.url} pull={pull} detail={detail} watching={watching} onDone={acted} /></section>}
        {tab === "checks" && <section className="fork-github-tab-page" aria-label={t("Checks")}><ChecksBox checks={detail.check_list} /></section>}
        {tab === "files" && <section className="fork-github-tab-page" aria-label={t("Files")}><GithubFiles key={`${pull.url}@${detail.base}@${detail.head_sha}`} pull={pull} detail={detail} jump={jump} /></section>}
      </>}
    </div>
  </article>;
}
