import { useEffect, useState } from "react";
import { ArrowLeft, Check, CircleDot, ExternalLink, FileDiff, GitBranch, GitCommitHorizontal, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, LoaderCircle, MessageSquare, X } from "lucide-react";

import { Markdown } from "../components/Markdown.tsx";

import type { GithubPull, GithubPullDetail } from "../../shared/github.ts";
import type { WorktreeOpened } from "../../shared/protocol.ts";
import { ApiError, createWorktree, fetchPullRequestBranch, getJson, listWorktrees, openWorktree } from "../lib/api.ts";
import { useT, type Translate } from "../lib/i18n.ts";
import { closeGithubPull } from "./GithubInbox.tsx";
import "./GithubPull.css";

/** "3 hours ago", in the browser's language. */
function ago(iso: string): string {
  const seconds = (Date.parse(iso) - Date.now()) / 1000;
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, size] of [["year", 31_536_000], ["month", 2_592_000], ["week", 604_800], ["day", 86_400], ["hour", 3_600], ["minute", 60]] as const) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  }
  return format.format(0, "minute");
}

function stateOf(detail: GithubPullDetail, t: Translate) {
  if (detail.state === "merged") return { icon: GitMerge, label: t("Merged"), tone: "merged" };
  if (detail.state === "closed") return { icon: GitPullRequestClosed, label: t("Closed"), tone: "closed" };
  if (detail.draft) return { icon: GitPullRequestDraft, label: t("Draft"), tone: "draft" };
  return { icon: GitPullRequest, label: t("Open"), tone: "open" };
}

const reviewIcons = { approved: Check, changes_requested: X, commented: MessageSquare, requested: CircleDot } as const;

/** One pull request, drawn from GitHub's API in Ovis's own design: the wide pane's page, or the phone's screen. */
export function GithubPullPage({ pull, wide, watching, onOpened }: { pull: GithubPull; wide: boolean; watching: boolean; onOpened(opened: WorktreeOpened): void }) {
  const t = useT();
  const [detail, setDetail] = useState<GithubPullDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const query = new URLSearchParams({ repo: pull.repository, number: String(pull.number), account: pull.account ?? "" });
    getJson<GithubPullDetail>(`/api/fork/github/pull?${query}`, { cache: "no-store" }).then(
      (next) => { if (!cancelled) setDetail(next); },
      (reason: unknown) => { if (!cancelled) setError(reason instanceof ApiError ? reason.code ?? "gh_failed" : "gh_failed"); },
    );
    return () => { cancelled = true; };
  }, [pull.repository, pull.number, pull.account]);

  const checkout = async (): Promise<void> => {
    // Branch names alone cannot establish which fork a local checkout belongs to.
    if (pull.fork || !pull.workspace_id || busy || watching) return;
    setBusy(true); setError(null);
    try {
      // Re-read local checkouts when pressed, rather than assuming a branch isn't already open.
      const listing = await listWorktrees(pull.workspace_id, "local");
      const existing = listing.worktrees.find((entry) => entry.branch === pull.branch && !entry.is_prunable);
      let opened: WorktreeOpened;
      if (existing) opened = await openWorktree({ workspace_id: pull.workspace_id, path: existing.path }, "local");
      else {
        // Creation must start at the main checkout, even when only a linked workspace is open.
        let source = listing.source.source_workspace_id ?? pull.workspace_id;
        if (!listing.source.source_workspace_id && listing.source.source_checkout_path !== listing.source.repo_root) {
          source = (await openWorktree({ workspace_id: pull.workspace_id, path: listing.source.repo_root }, "local")).workspace_id;
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
  const checks = detail?.checks;
  const reviewWords = { approved: t("Approved"), changes_requested: t("Changes requested"), commented: t("Commented"), requested: t("Review requested") };

  return <article className={`fork-github-pull${wide ? " is-wide" : ""}`} aria-label={pull.title}>
    <header className="fork-github-pull-top">
      {!wide && <button type="button" className="icon-button inbox-round" aria-label={t("Back|fork inbox")} title={t("Back|fork inbox")} onClick={closeGithubPull}><ArrowLeft aria-hidden="true" /></button>}
      <span className="fork-github-pull-where">{pull.repository} · #{pull.number}</span>
      {!watching && pull.workspace_id && !pull.fork && <button type="button" className="btn" disabled={busy} onClick={() => void checkout()}>{busy ? t("Checking out…") : t("Checkout")}</button>}
      <a className="icon-button inbox-round" href={pull.url} target="_blank" rel="noreferrer noopener" aria-label={t("Open on GitHub")} title={t("Open on GitHub")}><ExternalLink aria-hidden="true" /></a>
    </header>
    <div className="fork-github-pull-scroll">
      <h1 dir="auto">{detail?.title ?? pull.title}</h1>
      {error !== null && <p className="fork-github-pull-error" role="alert">{errors[error] ?? t("Could not read this pull request")}</p>}
      {detail === null ? error === null && <p className="fork-github-pull-dim" role="status"><LoaderCircle className="fork-github-spin" aria-hidden="true" /> {t("Reading the pull request…")}</p> : <>
        <div className="fork-github-pull-meta">
          {state && <span className={`fork-github-state is-${state.tone}`}><state.icon aria-hidden="true" />{state.label}</span>}
          <span>{t("{author} wants to merge into {base} from {head}", { author: detail.author ?? t("Someone"), base: detail.base, head: detail.head })}</span>
          <span className="fork-github-pull-dim">{t("Updated {when}", { when: ago(detail.updated_at) })}</span>
        </div>
        <ul className="fork-github-facts">
          <li><GitCommitHorizontal aria-hidden="true" />{t("{count} commits", { count: detail.commits })}</li>
          <li><FileDiff aria-hidden="true" />{t("{count} files", { count: detail.changed_files })} <span className="is-added">+{detail.additions}</span> <span className="is-removed">−{detail.deletions}</span></li>
          <li><GitBranch aria-hidden="true" /><code>{detail.head}</code></li>
        </ul>
        {detail.labels.length > 0 && <ul className="fork-github-labels">{detail.labels.map((label) => <li key={label.name} style={{ ["--label" as string]: `#${label.color}` }}>{label.name}</li>)}</ul>}
        <section className="fork-github-status" aria-label={t("Status")}>
          {checks && <p className={checks.failing > 0 ? "is-failing" : checks.pending > 0 ? "is-pending" : checks.passing > 0 ? "is-passing" : ""}>
            {checks.failing + checks.pending + checks.passing + checks.skipped === 0 ? t("No checks")
              : [checks.failing > 0 && t("{count} failing", { count: checks.failing }), checks.pending > 0 && t("{count} running", { count: checks.pending }), checks.passing > 0 && t("{count} passing", { count: checks.passing }), checks.skipped > 0 && t("{count} skipped", { count: checks.skipped })].filter(Boolean).join(" · ")}
          </p>}
          {detail.reviewers.length === 0 ? <p className="fork-github-pull-dim">{t("No review yet")}</p>
            : <ul className="fork-github-reviewers">{detail.reviewers.map((reviewer) => {
              const Icon = reviewIcons[reviewer.state];
              return <li key={reviewer.login} className={`is-${reviewer.state}`} title={reviewWords[reviewer.state]}><Icon aria-hidden="true" />{reviewer.login}<span className="fork-github-pull-dim">{reviewWords[reviewer.state]}</span></li>;
            })}</ul>}
        </section>
        <section className="fork-github-body" aria-label={t("Description")}>
          {detail.body.trim() ? <Markdown>{detail.body}</Markdown> : <p className="fork-github-pull-dim">{t("No description.")}</p>}
        </section>
      </>}
    </div>
  </article>;
}
