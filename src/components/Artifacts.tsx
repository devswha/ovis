import { useEffect, useId, useRef, useState } from "react";
import { AppWindow, ExternalLink } from "lucide-react";

import "./BackgroundTasks.css";

import { formatChatTimestamp } from "../lib/chatTimestamp.ts";
import { useLocale, useT } from "../lib/i18n.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import type { AgentStatus, ClaudeArtifact } from "../../shared/protocol.ts";

/**
 * The status line's chip for the pages a Claude Code session published with its Artifact tool
 * (GET /api/pane/artifacts), beside the background tasks chip, whose look it takes
 * (BackgroundTasks.css). Each row opens its page on claude.ai in a new tab. A page is published
 * during a turn, so the list is read when the pane is shown, when its status changes and when the
 * list opens; the chip shows only once there is a page. A PC from before the route answers 404,
 * which reads as none.
 */
export function Artifacts({ paneId, status }: { paneId: string; status: AgentStatus | undefined }) {
  const t = useT();
  const locale = useLocale();
  const { fetchPaneArtifacts } = useMachineApi();
  const machineId = useMachineId();
  const [artifacts, setArtifacts] = useState<ClaudeArtifact[]>([]);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const id = useId();
  usePhoneSheetBack(() => setOpen(false), open);
  // another pane or PC: its own pages, never these
  useEffect(() => { setArtifacts([]); setOpen(false); }, [paneId, machineId]);
  useEffect(() => {
    let alive = true;
    fetchPaneArtifacts(paneId).then((found) => { if (alive) setArtifacts(found); }, () => undefined);
    return () => { alive = false; };
  }, [fetchPaneArtifacts, paneId, status, open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent): void => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent): void => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("pointerdown", outside); window.removeEventListener("keydown", escape); };
  }, [open]);

  if (artifacts.length === 0) return null;
  const name = t(artifacts.length === 1 ? "{n} artifact" : "{n} artifacts", { n: artifacts.length });
  const now = Date.now();
  // a phone's status line keeps the icon and the number (BackgroundTasks.css), the button's name has the words
  return <span className="bg-tasks" ref={root}>
    <button type="button" className="bg-tasks-toggle is-idle" aria-label={name} title={name} aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
      <AppWindow aria-hidden="true" /><span className="bg-tasks-label">{name}</span><span className="bg-tasks-count" aria-hidden="true">{artifacts.length}</span>
    </button>
    {open && <div id={id} className="menu bg-tasks-menu" role="dialog" aria-label={t("Artifacts")}>
      <div className="menu-heading">{t("Artifacts")}</div>
      <ul className="bg-task-list">{artifacts.map((artifact) => {
        const when = formatChatTimestamp(artifact.at, now, locale, t);
        return <li key={artifact.url} className="bg-task is-openable">
          <a className="bg-task-open" href={artifact.url} target="_blank" rel="noopener noreferrer">
            <AppWindow className="bg-task-icon" aria-hidden="true" />
            <span className="bg-task-main">
              <span className="bg-task-title">{artifact.title ?? artifact.url}</span>
              {when && <span className="bg-task-meta" title={when.full}>{when.label}</span>}
            </span>
            <ExternalLink className="bg-task-caret" aria-hidden="true" />
          </a>
        </li>;
      })}</ul>
    </div>}
  </span>;
}
