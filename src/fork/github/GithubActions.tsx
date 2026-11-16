import { useEffect, useState } from "react";
import { ChevronDown, GitMerge, GitPullRequestArrow, Layers } from "lucide-react";

import { RowMenu } from "../../components/RowMenu.tsx";

import type { GithubPull, GithubPullDetail } from "../../../shared/github.ts";
import { ApiError, sendJson } from "../../lib/api.ts";
import { useT, type Translate } from "../../lib/i18n.ts";

type Method = GithubPullDetail["merge_methods"][number];
type Action = { action: "comment" | "approve" | "request_changes"; body: string } | { action: "merge"; method: Method; sha: string } | { action: "close" | "reopen" };

/** Sends an action with the account that listed the pull request; GitHub's own words when it refuses. */
async function act(pull: GithubPull, action: Action, t: Translate): Promise<string | null> {
  try {
    await sendJson("/api/fork/github/pull/action", "POST", { repo: pull.repository, number: pull.number, account: pull.account ?? "", ...action });
    return null;
  } catch (error) {
    if (!(error instanceof ApiError)) return t("GitHub did not take it");
    if (error.code === "read_only") return t("This device only watches");
    if (error.code === "rate_limited") return t("GitHub is limiting requests; try again later");
    if (error.code === "gh_signed_out") return t("Sign in on this PC with gh auth login");
    return error.code === "gh_refused" && error.detail ? error.detail : t("GitHub did not take it");
  }
}

const methodIcons = { squash: Layers, merge: GitMerge, rebase: GitPullRequestArrow } as const;

/** Kept per device: the merge method last used, while the repository allows it. */
const METHOD_KEY = "ovis:fork-github-merge-method";
const savedMethod = (): string | null => { try { return localStorage.getItem(METHOD_KEY); } catch { return null; } };

/** Merge, by the method last used; the first press asks, the second within a few seconds merges. */
export function GithubMerge({ pull, detail, watching, onDone }: { pull: GithubPull; detail: GithubPullDetail; watching: boolean; onDone(): void }) {
  const t = useT();
  const methods = detail.merge_methods;
  const [method, setMethod] = useState<Method>(() => methods.find((entry) => entry === savedMethod()) ?? methods[0] ?? "squash");
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), 4000);
    return () => window.clearTimeout(timer);
  }, [armed]);
  if (watching || !detail.can_write || detail.state !== "open" || detail.draft || methods.length === 0) return null;
  const words: Record<Method, string> = { squash: t("Squash and merge"), merge: t("Merge"), rebase: t("Rebase and merge") };
  // GitHub cannot merge a conflict; anything else (protection an admin may bypass) is GitHub's to refuse in its own words
  const blocked = detail.merge === "conflicts";
  const press = async (): Promise<void> => {
    if (!armed) { setArmed(true); setError(null); return; }
    setArmed(false); setBusy(true);
    const refused = await act(pull, { action: "merge", method, sha: detail.head_sha }, t);
    setBusy(false); setError(refused);
    if (refused === null) onDone();
  };
  return <div className="fork-github-merge-do">
    <div className="fork-github-split">
      <button type="button" className={armed ? "btn btn-primary" : "btn"} disabled={busy || blocked} onClick={() => void press()}>
        <GitMerge aria-hidden="true" />{busy ? t("Merging…") : armed ? t("Confirm: {how}", { how: words[method] }) : words[method]}
      </button>
      {methods.length > 1 && <button type="button" className="btn" aria-label={t("Merge method")} title={t("Merge method")} aria-haspopup="menu" aria-expanded={menu !== null} disabled={busy}
        onClick={(event) => setMenu(menu === null ? event.currentTarget : null)}><ChevronDown aria-hidden="true" /></button>}
    </div>
    {menu !== null && <RowMenu anchor={menu} title={t("Merge method")} choice onClose={() => setMenu(null)}
      items={methods.map((entry) => ({ id: entry, label: words[entry], icon: methodIcons[entry], checked: entry === method, run: () => { setMethod(entry); setArmed(false); try { localStorage.setItem(METHOD_KEY, entry); } catch { /* private mode */ } } }))} />}
    {error !== null && <p className="fork-github-pull-error" role="alert">{error}</p>}
  </div>;
}

/** Close an open pull request (the first press asks, the second within a few seconds closes), or reopen a closed one. */
export function GithubClose({ pull, detail, watching, onDone }: { pull: GithubPull; detail: GithubPullDetail; watching: boolean; onDone(): void }) {
  const t = useT();
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), 4000);
    return () => window.clearTimeout(timer);
  }, [armed]);
  // its author may close or reopen it without write access; a merged one stays as it is
  if (watching || detail.state === "merged" || !(detail.can_write || detail.viewer !== null && detail.viewer === detail.author)) return null;
  const closing = detail.state === "open";
  const press = async (): Promise<void> => {
    if (closing && !armed) { setArmed(true); setError(null); return; }
    setArmed(false); setBusy(true);
    const refused = await act(pull, { action: closing ? "close" : "reopen" }, t);
    setBusy(false); setError(refused);
    if (refused === null) onDone();
  };
  return <div className="fork-github-merge-do">
    <button type="button" className={armed ? "btn btn-danger" : "btn"} disabled={busy} onClick={() => void press()}>
      {busy ? closing ? t("Closing…") : t("Reopening…") : closing ? armed ? t("Confirm: close") : t("Close") : t("Reopen")}
    </button>
    {error !== null && <p className="fork-github-pull-error" role="alert">{error}</p>}
  </div>;
}

/** The reply box under the conversation: a comment, or a review that approves or asks for changes. */
export function GithubReply({ pull, detail, watching, onDone }: { pull: GithubPull; detail: GithubPullDetail; watching: boolean; onDone(): void }) {
  const t = useT();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<Action["action"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (watching) return null;
  // GitHub takes no review of one's own pull request, nor of a closed one
  const reviewing = detail.state === "open" && detail.viewer !== null && detail.viewer !== detail.author;
  const send = async (action: "comment" | "approve" | "request_changes"): Promise<void> => {
    setBusy(action); setError(null);
    const refused = await act(pull, { action, body: text }, t);
    setBusy(null); setError(refused);
    if (refused === null) { setText(""); onDone(); }
  };
  const empty = text.trim() === "";
  return <form className="fork-github-reply" onSubmit={(event) => { event.preventDefault(); if (!empty) void send("comment"); }}>
    <textarea className="input fork-github-reply-text" dir="auto" rows={3} value={text} disabled={busy !== null}
      placeholder={t("Leave a comment (Markdown)")} aria-label={t("Comment")}
      onChange={(event) => setText(event.target.value)}
      onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !empty) { event.preventDefault(); void send("comment"); } }} />
    {error !== null && <p className="fork-github-pull-error" role="alert">{error}</p>}
    <div className="fork-github-reply-actions">
      {reviewing && <>
        <button type="button" className="btn" disabled={busy !== null || empty} title={empty ? t("Say what should change") : undefined} onClick={() => void send("request_changes")}>{busy === "request_changes" ? t("Sending…") : t("Request changes")}</button>
        <button type="button" className="btn" disabled={busy !== null} onClick={() => void send("approve")}>{busy === "approve" ? t("Sending…") : t("Approve")}</button>
      </>}
      <button type="submit" className="btn btn-primary" disabled={busy !== null || empty}>{busy === "comment" ? t("Sending…") : t("Comment")}</button>
    </div>
  </form>;
}
