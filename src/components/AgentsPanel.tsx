import { useCallback, useMemo, useState } from "react";
import { Bell, PanelRightClose, PanelRightOpen, Terminal, X } from "lucide-react";

import type { Machine } from "../../shared/machines.ts";
import { paneStorageId } from "../../shared/machines.ts";
import { agentGroup, agentRoster } from "../lib/agentRoster.ts";
import { useT } from "../lib/i18n.ts";
import { useSidebarActivity } from "../lib/sidebarActivity.tsx";
import { paneMark } from "../lib/sidebarAgents.ts";
import { currentSidebarPins } from "../lib/sidebarPins.ts";
import { AgentMark } from "./AgentMark.tsx";
import { AgentSidebar } from "./AgentSidebar.tsx";
import { STATE_WORD } from "./MachineSidebar.tsx";
import "./AgentsPanel.css";

/** the panel's open or folded state, kept on this device: a phone and a desktop each keep their own */
const OPEN_KEY = "ovis:agents-panel-open";

/** The agents panel's open state on this device (it starts open), and whether a phone's agents sheet is out. */
export function useAgentsPanel(): { open: boolean; setOpen(open: boolean): void; sheet: boolean; setSheet(open: boolean): void } {
  const [open, setOpenState] = useState(() => { try { return window.localStorage.getItem(OPEN_KEY) !== "0"; } catch { return true; } });
  const [sheet, setSheet] = useState(false);
  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    try { window.localStorage.setItem(OPEN_KEY, next ? "1" : "0"); } catch { /* private mode: this page keeps it */ }
  }, []);
  return { open, setOpen, sheet, setSheet };
}

/** the panel's order of the states, as herdr-app's Priority sort: waiting, done, working, idle */
const RAIL_ORDER = { blocked: 0, done: 1, working: 2, idle: 3 } as const;

/** Every connected PC's agents, in the panel's order, with the state each is in. */
function useRailRows(machines: readonly Machine[]) {
  const activity = useSidebarActivity();
  return useMemo(() => {
    const { pinned, rest } = agentRoster(machines, { byActivity: false, seqs: activity.seqs, pinned: currentSidebarPins() });
    return [...pinned, ...rest]
      .map((row) => ({ row, status: row.machine.state === "connected" ? activity.status(row.machine.id, row.entry.pane) : undefined }))
      .sort((a, b) => RAIL_ORDER[agentGroup(a.status)] - RAIL_ORDER[agentGroup(b.status)]);
  }, [machines, activity]);
}

/** How many agents wait for the user, on every PC shown. */
export function useWaitingCount(machines: readonly Machine[]): number {
  return useRailRows(machines).filter(({ status }) => status === "blocked").length;
}

interface PanelProps {
  machines: Machine[];
  selectedMachineId: string;
  selectedPaneId: string | null;
  watching: boolean;
  onSelect(machineId: string, paneId: string): void;
}

/**
 * The header's agents button: a bell, the word, and how many agents wait. A desktop opens and folds the panel at
 * the window's right with it, as herdr-app's Files and Changes buttons do theirs; a phone opens the agents' sheet.
 */
export function AgentsToggle({ machines, open, onToggle }: { machines: Machine[]; open: boolean; onToggle(): void }) {
  const t = useT();
  const waiting = useWaitingCount(machines);
  const label = waiting > 0 ? t("Agents: {n} waiting", { n: waiting }) : t("Agents");
  return <button type="button" className={`header-text-button agents-toggle${waiting > 0 ? " has-waiting" : ""}`} aria-label={label} title={label} aria-pressed={open} onClick={onToggle}>
    <Bell aria-hidden="true" />
    <span className="agents-toggle-word" aria-hidden="true">{t("Agents")}</span>
    {waiting > 0 && <span className="agents-toggle-count" aria-hidden="true">{waiting}</span>}
  </button>;
}

/** The agents panel at the window's right (300px), or folded, a 44px rail of the agents' marks, a waiting one marked. */
export function AgentsPanel({ open, onOpen, ...props }: PanelProps & { open: boolean; onOpen(open: boolean): void }) {
  const t = useT();
  const rows = useRailRows(props.machines);
  if (!open) {
    const shown = rows.slice(0, 12);
    return <aside className="agents-panel sidebar-shell is-rail" aria-label={t("Agents")}>
      <button type="button" className="icon-button agents-rail-open" aria-label={t("Show agents")} title={t("Show agents")} onClick={() => onOpen(true)}><PanelRightOpen aria-hidden="true" /></button>
      <ul className="agents-rail">
        {shown.map(({ row, status }) => {
          const mark = paneMark(row.entry);
          const selected = row.machine.id === props.selectedMachineId && row.entry.pane.pane_id === props.selectedPaneId;
          const title = row.entry.pane.label?.trim() || row.entry.agent?.title?.trim() || row.entry.pane.title?.trim() || row.entry.pane.pane_id;
          return <li key={paneStorageId(row.machine.id, row.entry.pane.pane_id)}>
            <button type="button" className={`agents-rail-item${selected ? " is-selected" : ""}`} data-status={agentGroup(status)} aria-current={selected ? "true" : undefined} title={title} aria-label={title}
              disabled={row.machine.state !== "connected"} onClick={() => props.onSelect(row.machine.id, row.entry.pane.pane_id)}>
              {mark !== null ? <AgentMark agent={mark} size={16} /> : <Terminal aria-hidden="true" />}
              {status === "blocked" && <span className="agents-rail-wait" aria-hidden="true">!</span>}
              {(status === "done" || status === "working") && <span className={`agents-rail-dot is-${status}`} aria-hidden="true" />}
            </button>
          </li>;
        })}
      </ul>
      {rows.length > shown.length && <span className="agents-rail-more">+{rows.length - shown.length}</span>}
    </aside>;
  }
  return <aside className="agents-panel sidebar-shell" aria-label={t("Agents")}>
    <div className="agents-panel-head">
      <span className="agents-panel-title">{t("Agents")}</span>
      <button type="button" className="icon-button agents-panel-close" aria-label={t("Hide agents")} title={t("Hide agents")} onClick={() => onOpen(false)}><PanelRightClose aria-hidden="true" /></button>
    </div>
    <AgentSidebar panel machines={props.machines} selectedMachineId={props.selectedMachineId} selectedPaneId={props.selectedPaneId} stateWord={(machine) => t(STATE_WORD[machine.state])} watching={props.watching} onSelect={props.onSelect} />
  </aside>;
}

/** A phone's agents: the header's bell opens them as a sheet from the bottom; a pick opens the agent and closes it. */
export function AgentsSheet({ onClose, ...props }: PanelProps & { onClose(): void }) {
  const t = useT();
  return <div className="agents-sheet-layer">
    <div className="agents-sheet-scrim" aria-hidden="true" onClick={onClose} />
    <div className="agents-sheet sidebar-shell" role="dialog" aria-modal="true" aria-label={t("Agents")} onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}>
      <div className="agents-sheet-head">
        <span className="agents-sheet-grab" aria-hidden="true" />
        <span className="agents-panel-title">{t("Agents")}</span>
        <button type="button" className="icon-button" aria-label={t("Close")} onClick={onClose} autoFocus><X aria-hidden="true" /></button>
      </div>
      <AgentSidebar panel machines={props.machines} selectedMachineId={props.selectedMachineId} selectedPaneId={props.selectedPaneId} stateWord={(machine) => t(STATE_WORD[machine.state])} watching={props.watching}
        onSelect={(machineId, paneId) => { props.onSelect(machineId, paneId); onClose(); }} />
    </div>
  </div>;
}
