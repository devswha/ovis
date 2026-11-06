/**
 * The pane column's bottom line from 769px, as the Herdr app's status bar (herdr-app
 * defaults/mods/workspace-status, Apache-2.0, THIRD_PARTY_NOTICES.md): where the open pane is (PC,
 * workspace, folder) and its branch on the left; a watching device's View only, the jump to the next
 * session waiting for you and the connection on the right. The header's one row keeps only the tabs
 * and their tools.
 */
import { CircleHelp, GitBranch, Monitor } from "lucide-react";

import "./StatusBar.css";

import { useT } from "../lib/i18n.ts";
import { DETACHED, usePaneBranch } from "../lib/paneBranch.ts";

export interface StatusBarProps {
  machineId: string;
  workspaceId: string;
  place: string;
  path: string | null;
  session: string | null;
  watching: boolean;
  waiting: number;
  onNextWaiting: (() => void) | null;
  connected: boolean;
  connectionWord: string;
}

export function StatusBar({ machineId, workspaceId, place, path, session, watching, waiting, onNextWaiting, connected, connectionWord }: StatusBarProps) {
  const t = useT();
  const branch = usePaneBranch(machineId, workspaceId);
  return (
    <footer className="status-bar">
      <span className="status-bar-item status-bar-place" title={path ?? undefined}>
        <Monitor aria-hidden="true" />
        <span className="status-bar-text">{place}</span>
      </span>
      {branch !== null && <span className="status-bar-item">
        <GitBranch aria-hidden="true" />
        <span className="status-bar-text">{branch === DETACHED ? t("Detached HEAD") : branch}</span>
      </span>}
      {session !== null && <span className="status-bar-item status-bar-text">{session}</span>}
      <span className="status-bar-end">
        {watching && <span className="status-bar-item status-bar-watch">{t("View only")}</span>}
        {waiting > 0 && <button type="button" className="status-bar-item status-bar-waiting" disabled={onNextWaiting === null} onClick={onNextWaiting ?? undefined}
          title={t("Open the next session waiting for you")}>
          <CircleHelp aria-hidden="true" />
          {t("{count} waiting for you", { count: waiting })}
        </button>}
        <span className={`status-bar-item status-bar-conn${connected ? "" : " is-lost"}`}>
          <span className="status-bar-dot" aria-hidden="true" />
          {connected ? t("Connected") : connectionWord}
        </span>
      </span>
    </footer>
  );
}
