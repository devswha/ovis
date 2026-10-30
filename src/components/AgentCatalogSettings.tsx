import { useEffect, useRef, useState, type ReactNode } from "react";
import { RotateCw } from "lucide-react";

import type { AgentCatalogRow } from "../../shared/agent-catalog.ts";
import { ApiError, fetchAgentCatalog } from "../lib/api.ts";
import { agentSections } from "../lib/agentList.ts";
import { useT } from "../lib/i18n.ts";
import { useMachineId } from "../lib/machineContext.tsx";
import { userErrorMessage, type UserError } from "../lib/userError.ts";
import { AgentMark } from "./AgentMark.tsx";
import { AgentTile } from "./AgentTile.tsx";
import { SettingsGroup } from "./SettingsControls.tsx";
import "./AgentCatalogSettings.css";

export interface AgentCatalogSettingsProps {
  /** a watching device may read the list, but an install is a change it cannot make */
  watching: boolean;
  /** shows a pane of `machineId` in its terminal: the tab an install runs in */
  onOpenPane: (machineId: string, paneId: string) => void;
}

function AgentRow({ agent, detail, children }: { agent: AgentCatalogRow; detail?: ReactNode; children?: ReactNode }) {
  return (
    <div className="settings-row settings-agent-row">
      <AgentMark agent={agent.id} size={22} />
      <div className="settings-row-text">
        <span className="settings-label">{agent.name}</span>
        <span className="settings-description">{agent.description}{detail}</span>
      </div>
      {children}
    </div>
  );
}

/**
 * Settings → Agent integrations' own list of the PC open here: what that PC has (with the version it
 * answered), and the rest as the setup guide's tiles, each with its Install (the one tap: the
 * installer runs in a terminal tab while a ring turns on the tile). A watching device only reads it.
 */
export function AgentCatalogSettings({ watching, onOpenPane }: AgentCatalogSettingsProps) {
  const t = useT();
  const machineId = useMachineId();
  const [rows, setRows] = useState<{ machineId: string; agents: AgentCatalogRow[] } | null>(null);
  const [error, setError] = useState<UserError | null>(null);
  // each Check again, and each install that finished, reads the PC again
  const [reads, setReads] = useState(0);
  // why a tile's install did not finish, by agent; a tile that runs again or is done clears its own
  const [failures, setFailures] = useState<Readonly<Record<string, string>>>({});
  const checkAgain = useRef<HTMLButtonElement>(null);
  // an install that finished moves its agent up to Installed: the focus its own tile had goes to Check again
  const finished = (agent: string): void => {
    const at = document.activeElement;
    const lost = at === null || at === document.body || at.closest("li")?.querySelector(`[data-agent="${CSS.escape(agent)}"]`) != null;
    setReads((count) => count + 1);
    if (lost) checkAgain.current?.focus();
  };

  useEffect(() => {
    const abort = new AbortController();
    setError(null);
    fetchAgentCatalog(machineId, abort.signal).then(
      (catalog) => setRows({ machineId, agents: catalog.agents }),
      (reason: unknown) => {
        if (abort.signal.aborted) return;
        // a PC on an Ovis from before the catalog answers 404 for it
        setError(reason instanceof ApiError && reason.status === 404 ? { message: t("This PC's Ovis cannot install agents yet. Update it, then try again."), detail: null } : userErrorMessage(reason));
      },
    );
    return () => abort.abort();
  }, [machineId, reads, t]);

  const note = t("Install runs the maker's own installer in a terminal tab on this PC, where you can watch it.");
  const shown = rows !== null && rows.machineId === machineId ? rows.agents : null;
  const toolbar = (
    <div className="settings-agent-toolbar">
      <button type="button" ref={checkAgain} className="btn btn-ghost" onClick={() => setReads((count) => count + 1)}><RotateCw aria-hidden="true" />{t("Check again")}</button>
    </div>
  );
  if (error !== null) return <><SettingsGroup title={t("Agents")} note={note}><p className="settings-item settings-hint" role="alert">{error.message}{error.detail !== null && <><br /><code>{error.detail}</code></>}</p></SettingsGroup>{toolbar}</>;
  if (shown === null) return <SettingsGroup title={t("Agents")} note={note}><p className="settings-item settings-hint" role="status">{t("Loading…")}</p></SettingsGroup>;
  const { installed, available } = agentSections(shown);
  // only what the PC surely lacks and can install: one it cannot tell about offers no Install
  const installable = available.filter((agent) => agent.state.installed === false && agent.install !== null);
  const failed = Object.values(failures);
  return (
    <>
      <section className="settings-section">
        <h3>{t("Agents")}</h3>
        <p className="settings-description settings-note">{note}</p>
        {toolbar}
      </section>
      <SettingsGroup title={t("Installed")} section="agents-installed">
        {installed.length === 0 ? <p className="settings-item settings-hint">{t("None on this PC yet.")}</p> : installed.map((agent) => (
          <AgentRow key={agent.id} agent={agent} detail={agent.state.meets_min_version === false && agent.min_version !== null && <span className="settings-condition">{t("Ovis needs {version} or later.", { version: agent.min_version.version })}</span>}>
            <span className="settings-agent-version">{agent.state.version ?? t("Installed")}</span>
          </AgentRow>
        ))}
      </SettingsGroup>
      {!watching && installable.length > 0 && <section className="settings-section" aria-labelledby="settings-agents-available">
        <h3 id="settings-agents-available">{t("Can be installed")}</h3>
        <ul className="setup-found settings-agent-tiles">
          {installable.map((agent) => (
            <AgentTile key={`${machineId}:${agent.id}`} agent={agent} has={false} machineId={machineId}
              onOpenTerminal={(paneId) => onOpenPane(machineId, paneId)}
              onInstalled={finished}
              onError={(id, message) => setFailures((current) => {
                const { [id]: _gone, ...rest } = current;
                return message === null ? rest : { ...rest, [id]: message };
              })} />
          ))}
        </ul>
        {failed.length > 0 && <p className="settings-hint settings-agent-error" role="alert">{failed.join(" ")}</p>}
      </section>}
    </>
  );
}
