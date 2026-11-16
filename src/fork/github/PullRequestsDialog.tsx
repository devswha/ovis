/**
 * A workspace's repository's open pull requests, from the row menu's Pull requests…: one row each with its
 * checks and review, and the one action that fits. Checkout fetches the branch and makes a worktree of it as
 * New worktree does (the same herdr call, so the same setup hook runs); a branch that already has a checkout
 * offers Go to workspace (or Open checkout when no workspace shows it) instead of a second one. No agent is
 * started. The list is read with the signed-in `gh` (server/pull-requests.ts), once, as the dialog opens.
 * Escape and the scrim close it, Tab stays inside, and the focus goes back to the ⋯ afterwards.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { ExternalLink, GitPullRequest, X } from "lucide-react";

import "../../components/WorktreeDialog.css";
import "./PullRequestsDialog.css";

import type { PullRequestEntry, PullRequestListing, WorkspaceInfo, WorktreeOpened } from "../../../shared/protocol.ts";
import { ApiError } from "../../lib/api.ts";
import { currentLocale, useT } from "../../lib/i18n.ts";
import { useMachineApi } from "../../lib/machineContext.tsx";
import { useSheetSwipe } from "../../lib/sheets.ts";
import { usePhoneSheetBack } from "../../lib/sheetHistory.ts";

import { pullRequestWords } from "./pullRequestWords.ts";

interface Props {
  workspace: WorkspaceInfo;
  onClose: () => void;
  onOpened: (opened: WorktreeOpened) => void;
}

const said = (reason: unknown): string => reason instanceof ApiError ? reason.detail : reason instanceof Error ? reason.message : String(reason);

export function PullRequestsDialog({ workspace, onClose, onOpened }: Props) {
  const t = useT();
  const id = useId();
  const { createWorktree, fetchPullRequestBranch, listPullRequests, openWorktree } = useMachineApi();
  const [listing, setListing] = useState<PullRequestListing | null>(null);
  const [query, setQuery] = useState("");
  // the pull request whose action runs, by number
  const [pending, setPending] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const surface = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  useSheetSwipe(surface, pending === null ? onClose : null);
  usePhoneSheetBack(() => { if (pending !== null) return false; onClose(); });

  useLayoutEffect(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => { if (opener.current?.isConnected) opener.current.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => { window.requestAnimationFrame(() => search.current?.focus()); }, [listing]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      // another overlay (the palette) over this one owns the keyboard, and Escape, until it goes
      const active = document.activeElement;
      if (active && active !== document.body && !surface.current?.contains(active)) return;
      event.stopPropagation();
      event.preventDefault();
      if (pending === null) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, pending]);
  useEffect(() => {
    let cancelled = false;
    listPullRequests(workspace.workspace_id).then(
      (next) => { if (!cancelled) setListing(next); },
      (reason: unknown) => { if (!cancelled) setError(said(reason)); },
    );
    return () => { cancelled = true; };
  }, [workspace.workspace_id, listPullRequests]);

  const shown = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (listing?.pull_requests ?? []).filter((pr) => {
      const haystack = `#${pr.number} ${pr.title} ${pr.branch} ${pr.author ?? ""}`.toLowerCase();
      return words.every((word) => haystack.includes(word));
    });
  }, [listing, query]);

  const act = async (pr: PullRequestEntry): Promise<void> => {
    if (pending !== null) return;
    setPending(pr.number);
    setError(null);
    try {
      if (pr.checkout) {
        // open_workspace_id names the workspace that shows it: herdr answers with that one when it is open
        onOpened(await openWorktree({ workspace_id: workspace.workspace_id, path: pr.checkout.path }));
        return;
      }
      const { ref } = await fetchPullRequestBranch(workspace.workspace_id, pr.branch);
      onOpened(await createWorktree({ workspace_id: workspace.workspace_id, branch: pr.branch, base: ref }));
    } catch (reason: unknown) {
      setError(said(reason));
      setPending(null);
    }
  };

  const closeFromScrim = (event: MouseEvent<HTMLDivElement>): void => {
    if (pending === null && event.target === event.currentTarget) onClose();
  };
  // modal: Tab and Shift+Tab stay among the dialog's own field, links and buttons
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Tab" || !surface.current) return;
    const stops = [...surface.current.querySelectorAll<HTMLElement>("input:not(:disabled), button:not(:disabled), a[href]")];
    if (stops.length === 0) return;
    const index = stops.indexOf(document.activeElement as HTMLElement);
    const next = event.shiftKey ? (index <= 0 ? stops.length - 1 : index - 1) : (index < 0 || index === stops.length - 1 ? 0 : index + 1);
    event.preventDefault();
    stops[next]?.focus();
  };

  return createPortal(
    <div className="modal-scrim" onMouseDown={closeFromScrim}>
      <div ref={surface} className="modal worktree-modal pr-modal" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} onKeyDown={onKeyDown}>
        <header className="modal-header">
          <h2 className="modal-title" id={`${id}-title`}>{t("Pull requests · {name}", { name: listing?.repository ?? workspace.label })}</h2>
          <button type="button" className="icon-button" aria-label={t("Close pull requests dialog")} disabled={pending !== null} onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="modal-body">
          {listing === null && !error && <p className="field-hint" role="status">{t("Reading pull requests…")}</p>}
          {listing !== null && listing.pull_requests.length === 0 && <p className="field-hint worktree-empty">{t("No open pull requests.")}</p>}
          {listing !== null && listing.pull_requests.length > 0 && (
            <>
              <input ref={search} className="input pr-search" type="search" value={query} placeholder={t("Search pull requests…")} aria-label={t("Search pull requests…")} autoComplete="off" spellCheck={false} onChange={(event) => setQuery(event.target.value)} />
              {shown.length === 0 ? <p className="field-hint worktree-empty">{t("No pull request matches.")}</p> : (
                <ul className="worktree-list pr-list">
                  {shown.map((pr) => <PullRequestRow key={pr.number} pr={pr} busy={pending === pr.number} locked={pending !== null} onAct={() => void act(pr)} />)}
                </ul>
              )}
            </>
          )}
          {error && <p className="field-hint worktree-error" role="alert">{error}</p>}
        </div>
        <footer className="modal-footer">
          <button type="button" className="btn btn-ghost" disabled={pending !== null} onClick={onClose}>{t("Close")}</button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

function PullRequestRow({ pr, busy, locked, onAct }: { pr: PullRequestEntry; busy: boolean; locked: boolean; onAct: () => void }) {
  const t = useT();
  const { checks, reviews } = pullRequestWords(t);
  const blocked = pr.fork && !pr.checkout;
  const label = pr.checkout ? (pr.checkout.open_workspace_id ? t("Go to workspace") : t("Open checkout")) : busy ? t("Checking out…") : t("Checkout");
  return (
    <li className="pr-row">
      <GitPullRequest aria-hidden="true" className={`pr-icon${pr.draft ? " pr-icon-draft" : ""}`} />
      <div className="worktree-copy">
        <a className="pr-title" href={pr.url} target="_blank" rel="noreferrer noopener">
          <span>{pr.title}</span>
          <ExternalLink aria-hidden="true" />
        </a>
        <span className="worktree-path">{`#${pr.number} · ${pr.branch} · ${updated(pr.updated_at)}${pr.author ? ` · ${pr.author}` : ""}`}</span>
        <span className="pr-status">
          {pr.draft && <span className="pill">{t("Draft")}</span>}
          {checks[pr.checks] && <span className={`pill pr-checks-${pr.checks}`}>{checks[pr.checks]}</span>}
          {reviews[pr.review] && <span className={`pill pr-review-${pr.review}`}>{reviews[pr.review]}</span>}
          {pr.fork && <span className="pill">{t("From a fork")}</span>}
        </span>
      </div>
      <button type="button" className="btn pr-action" disabled={locked || blocked} title={blocked ? t("A pull request from a fork cannot be checked out here yet.") : undefined} onClick={onAct}>{label}</button>
    </li>
  );
}

/** how long ago, in the interface language, without a string of its own to translate */
function updated(value: string): string {
  const minutes = Math.round((Date.now() - Date.parse(value)) / 60_000);
  if (!Number.isFinite(minutes)) return "";
  const when = new Intl.RelativeTimeFormat(currentLocale(), { numeric: "auto" });
  if (minutes < 60) return when.format(-Math.max(minutes, 0), "minute");
  if (minutes < 60 * 48) return when.format(-Math.round(minutes / 60), "hour");
  return when.format(-Math.round(minutes / 60 / 24), "day");
}
