import { Check, CircleDot, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, MessageSquare, X } from "lucide-react";

import { Markdown } from "../../components/Markdown.tsx";

import type { GithubEntry, GithubThread } from "../../../shared/github.ts";
import { useT } from "../../lib/i18n.ts";

/** "3 hours ago", in the browser's language. */
export function ago(iso: string): string {
  const seconds = (Date.parse(iso) - Date.now()) / 1000;
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, size] of [["year", 31_536_000], ["month", 2_592_000], ["week", 604_800], ["day", 86_400], ["hour", 3_600], ["minute", 60]] as const) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  }
  return format.format(0, "minute");
}

/** Who and when, over a comment. */
function Byline({ author, at, children }: { author: string | null; at: string; children?: React.ReactNode }) {
  const t = useT();
  return <header className="fork-github-byline">
    <strong>{author ?? t("Someone")}</strong>{children}<time dateTime={at} title={new Date(at).toLocaleString()}>{ago(at)}</time>
  </header>;
}

/** GitHub writes Markdown with HTML in it (details, comments, images): read as a file's Markdown, never as raw HTML. */
function Body({ text }: { text: string }) {
  return text.trim() ? <div className="fork-github-text"><Markdown html>{text}</Markdown></div> : null;
}

/** The lines a thread is on, then its comments; a resolved thread stays folded until opened. */
/** A thread still on a line of the head's diff, which the Files tab shows it under; an outdated one, or one on no line, is not. */
export const onDiff = (thread: GithubThread): boolean => !thread.outdated && thread.line !== null;

/** Opens the Files tab at a thread's line. */
export type JumpToLine = (thread: GithubThread) => void;

export function GithubThreadView({ thread, inDiff = false, onJump }: { thread: GithubThread; inDiff?: boolean; onJump?: JumpToLine }) {
  const t = useT();
  const place = <code dir="auto">{thread.path}{thread.line !== null && `:${thread.line}`}</code>;
  // under its line in the diff, the code and the place are already in view; elsewhere the place opens it there
  const where = <>
    {inDiff ? <MessageSquare aria-hidden="true" />
      : onJump && onDiff(thread) ? <button type="button" className="fork-github-jump" title={t("Show in Files")} onClick={(event) => { event.preventDefault(); onJump(thread); }}>{place}</button>
      : place}
    {thread.outdated && <span className="fork-github-tag">{t("Outdated")}</span>}
    {thread.resolved && <span className="fork-github-tag">{t("Resolved")}</span>}
  </>;
  const inner = <>
    {!inDiff && thread.hunk && <pre className="fork-github-hunk">{thread.hunk.split("\n").map((line, index) => (
      <span key={index} className={line.startsWith("+") ? "is-added" : line.startsWith("-") ? "is-removed" : undefined}>{line}{"\n"}</span>
    ))}</pre>}
    <ol className="fork-github-replies">{thread.comments.map((comment, index) => <li key={index}>
      <Byline author={comment.author} at={comment.at} />
      <Body text={comment.body} />
    </li>)}</ol>
  </>;
  return thread.resolved
    ? <details className={`fork-github-thread${inDiff ? " is-in-diff" : ""}`}><summary>{where}{inDiff && t("{count} comments", { count: thread.comments.length })}</summary>{inner}</details>
    : <div className={`fork-github-thread${inDiff ? " is-in-diff" : ""}`}>{!inDiff && <div className="fork-github-thread-where">{where}</div>}{inner}</div>;
}

const eventIcons = { merged: GitMerge, closed: GitPullRequestClosed, reopened: GitPullRequest, ready: GitPullRequest, draft: GitPullRequestDraft } as const;
const reviewIcons = { approved: Check, changes_requested: X, commented: MessageSquare, dismissed: CircleDot } as const;

/** Comments, reviews with their line threads, and state changes, oldest first. */
export function GithubConversation({ entries, onJump }: { entries: GithubEntry[]; onJump?: JumpToLine }) {
  const t = useT();
  const reviewWords = { approved: t("approved"), changes_requested: t("requested changes"), commented: t("reviewed"), dismissed: t("review dismissed") };
  const eventWords = { merged: t("merged it"), closed: t("closed it"), reopened: t("reopened it"), ready: t("marked it ready for review"), draft: t("made it a draft") };
  if (entries.length === 0) return <p className="fork-github-pull-dim">{t("No comments yet.")}</p>;
  return <ol className="fork-github-conversation">{entries.map((entry, index) => {
    if (entry.kind === "event") {
      const Icon = eventIcons[entry.event];
      return <li key={index} className={`fork-github-event is-${entry.event}`}><Icon aria-hidden="true" /><Byline author={entry.author} at={entry.at}><span>{eventWords[entry.event]}</span></Byline></li>;
    }
    if (entry.kind === "review") {
      const Icon = reviewIcons[entry.state];
      return <li key={index} className={`fork-github-review is-${entry.state}`}>
        <div className="fork-github-review-head"><Icon aria-hidden="true" /><Byline author={entry.author} at={entry.at}><span>{reviewWords[entry.state]}</span></Byline></div>
        {(entry.body.trim() || entry.threads.length > 0) && <div className="fork-github-review-body">
          <Body text={entry.body} />
          {entry.threads.map((thread, at) => <GithubThreadView key={at} thread={thread} onJump={onJump} />)}
        </div>}
      </li>;
    }
    return <li key={index} className="fork-github-comment"><Byline author={entry.author} at={entry.at} /><Body text={entry.body} /></li>;
  })}</ol>;
}
