import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";

import type { GithubClonePlace, GithubPull } from "../../../shared/github.ts";
import { ApiError, createWorkspace, getJson, sendJson } from "../../lib/api.ts";
import { useT } from "../../lib/i18n.ts";
import { usePhoneSheetBack } from "../../lib/sheetHistory.ts";
import { useSheetSwipe } from "../../lib/sheets.ts";
import { useFocusTrap } from "../../lib/useFocusTrap.ts";

/** Kept per device: the folder the last clone went into, which the next one is suggested in. */
const PARENT_KEY = "ovis:fork-github-clone-parent";
const savedParent = (): string | null => { try { return localStorage.getItem(PARENT_KEY); } catch { return null; } };
const parentOf = (shown: string): string => shown.slice(0, Math.max(shown.lastIndexOf("/"), 1));

const placeOf = (repository: string, path: string | null): Promise<GithubClonePlace> => {
  const query = new URLSearchParams({ repo: repository, ...path === null ? { parent: savedParent() ?? "" } : { path } });
  return getJson<GithubClonePlace>(`/api/fork/github/clone?${query}`, { cache: "no-store" });
};

/**
 * Where a repository that is on no workspace yet is cloned: a folder in the home folder, suggested
 * from the last one used, checked as it is typed. A checkout of the repository already there is
 * opened as it is; something else there is never written over. Answers the workspace it opened.
 */
export function GithubCloneDialog({ pull, onOpened, onClose }: { pull: GithubPull; onOpened(workspaceId: string): void; onClose(): void }) {
  const t = useT();
  const id = useId();
  const [text, setText] = useState<string | null>(null);
  const [place, setPlace] = useState<GithubClonePlace | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const surface = useFocusTrap<HTMLFormElement>(true, {});
  useSheetSwipe(surface, busy ? null : onClose);
  usePhoneSheetBack(() => { if (busy) return false; onClose(); });

  // the suggestion first, then the folder as typed, a moment after the last key
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      placeOf(pull.repository, text).then(
        (next) => { if (cancelled) return; setPlace(next); setProblem(null); if (text === null) setText(next.shown); },
        (reason: unknown) => { if (!cancelled) { setPlace(null); setProblem(reason instanceof ApiError ? reason.detail : t("Could not check that folder")); } },
      );
    }, text === null ? 0 : 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [pull.repository, text]);

  const current = place !== null && place.shown === text?.trim();
  const go = async (): Promise<void> => {
    if (!current || place.state === "taken" || busy) return;
    setBusy(true); setProblem(null);
    try {
      const { path } = await (await sendJson("/api/fork/github/clone", "POST", { repo: pull.repository, account: pull.account ?? "", path: place.path })).json() as { path: string };
      try { localStorage.setItem(PARENT_KEY, parentOf(place.shown)); } catch { /* private mode */ }
      const { workspace_id } = await createWorkspace({ cwd: path, label: pull.repository.split("/")[1] ?? null });
      onOpened(workspace_id);
    } catch (reason) {
      setProblem(reason instanceof ApiError ? reason.detail : t("Could not clone the repository"));
      setBusy(false);
    }
  };

  const status = place === null || !current ? null
    : place.state === "same" ? t("{repo} is already here; it opens as it is.", { repo: pull.repository })
    : place.state === "taken" ? t("Something else is in this folder. Choose another.")
    : null;
  return createPortal(
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <form ref={surface} className="modal confirm-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1}
        onSubmit={(event) => { event.preventDefault(); void go(); }}
        onKeyDown={(event) => { if (event.key === "Escape" && !busy) { event.stopPropagation(); onClose(); } }}>
        <header className="modal-header"><h2 className="modal-title" id={`${id}-title`}>{t("Clone {repo}", { repo: pull.repository })}</h2></header>
        <div className="modal-body">
          <label className="field">
            <span className="field-label">{t("Folder")}</span>
            <input className="input" autoFocus autoComplete="off" spellCheck={false} dir="ltr" disabled={busy} value={text ?? ""} placeholder="~/Projects"
              onChange={(event) => setText(event.target.value)} />
            <span className="field-hint">{pull.account ? t("Cloned as {account}", { account: pull.account }) : null}</span>
          </label>
          {status !== null && <p className={place?.state === "taken" ? "confirm-error" : "field-hint"} role="status">{status}</p>}
          {problem !== null && <p className="confirm-error" role="alert">{problem}</p>}
        </div>
        <footer className="modal-footer">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>{t("Cancel")}</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !current || place.state === "taken"}>
            {busy ? t("Cloning…") : place?.state === "same" && current ? t("Open and checkout") : t("Clone and checkout")}
          </button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}
