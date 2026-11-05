import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, Inbox as InboxIcon, X } from "lucide-react";

import type { Machine } from "../../shared/machines.ts";
import type { PaneView } from "../lib/actions.ts";
import { agentInbox, type AgentInboxItem, type AgentInboxSource, type AgentInboxState } from "../lib/agentInbox.ts";
import { useT } from "../lib/i18n.ts";
import { agentContext, agentTabName, paneMark } from "../lib/sidebarAgents.ts";
import { useFocusTrap, nativeModalOver } from "../lib/useFocusTrap.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { AgentMark } from "./AgentMark.tsx";
import { agentRowTitle, blockedLabel } from "./AgentSidebar.tsx";
import "./AgentInbox.css";

export interface AgentInboxLauncherProps {
  machines: readonly Machine[];
  source: AgentInboxSource;
  loaded: boolean;
  onOpen(machineId: string, paneId: string, view: PaneView): void;
}

/** The header entry owns the sheet, keeping Inbox state out of App's already-large hook set. */
export function AgentInboxLauncher({ machines, source, loaded, onOpen }: AgentInboxLauncherProps) {
  const [open, setOpen] = useState(false);
  const state = useMemo(() => agentInbox(machines, source, loaded), [machines, source, loaded]);
  const close = useCallback(() => setOpen(false), []);
  return <>
    <AgentInboxButton count={state.items.length} open={open} onOpen={() => setOpen(true)} />
    {open && createPortal(<AgentInbox state={state} onOpen={onOpen} onClose={close} />, document.body)}
  </>;
}

export function AgentInboxButton({ count, open = false, onOpen, className = "" }: { count: number; open?: boolean; onOpen(): void; className?: string }) {
  const t = useT();
  const label = count > 0 ? `${t("Inbox")} · ${t("{count} waiting for you", { count })}` : t("Inbox");
  return <button type="button" className={`agent-inbox-button${className ? ` ${className}` : ""}`} aria-label={label} title={label} aria-haspopup="dialog" aria-expanded={open} onClick={onOpen}>
    <InboxIcon aria-hidden="true" />
    <span className="agent-inbox-button-label">{t("Inbox")}</span>
    {count > 0 && <span className="agent-inbox-count" aria-hidden="true">{count}</span>}
  </button>;
}

export function openAgentInboxItem(item: AgentInboxItem, onOpen: (machineId: string, paneId: string, view: PaneView) => void, onClose: () => void): void {
  onClose();
  onOpen(item.machine.id, item.entry.pane.pane_id, "chat");
}

export interface AgentInboxProps {
  state: AgentInboxState;
  onOpen(machineId: string, paneId: string, view: PaneView): void;
  onClose(): void;
}

/** The all-PC queue of live agent panes that currently wait for a person's answer. */
export function AgentInbox({ state, onOpen, onClose }: AgentInboxProps) {
  const t = useT();
  const surface = useFocusTrap<HTMLElement>(true);
  useSheetSwipe(surface, onClose);
  usePhoneSheetBack(onClose);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !nativeModalOver(surface.current)) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return <div className="modal-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section ref={surface} className="modal agent-inbox" role="dialog" aria-modal="true" aria-labelledby="agent-inbox-title" tabIndex={-1}>
      <header className="modal-header">
        <h2 className="modal-title" id="agent-inbox-title"><InboxIcon aria-hidden="true" />{t("Inbox")}</h2>
        {state.items.length > 0 && <><span className="agent-inbox-total" aria-hidden="true">{state.items.length}</span><span className="visually-hidden">{t("{count} waiting for you", { count: state.items.length })}</span></>}
        <button type="button" className="icon-button" aria-label={t("Close")} onClick={onClose}><X aria-hidden="true" /></button>
      </header>
      <div className="modal-body agent-inbox-body">
        <div className="agent-inbox-intro">
          <p>{t("Review what each agent needs, then jump straight to its chat.")}</p>
        </div>
        <div className="agent-inbox-section-head">
          <h3>{t("Needs you")}</h3>
          {state.items.length > 0 && <span>{state.items.length}</span>}
        </div>
        {state.items.length > 0 ? <ul className="agent-inbox-list">
          {state.items.map((item) => <AgentInboxRow key={`${item.machine.id}:${item.entry.pane.pane_id}`} item={item} onOpen={() => openAgentInboxItem(item, onOpen, onClose)} />)}
        </ul> : <p className="agent-inbox-empty" role="status">{state.loading ? t("Loading…") : t("Nothing needs you right now.")}</p>}
        {state.offline > 0 && <p className="agent-inbox-offline" role="status">{t("Offline PCs are not included.")}</p>}
      </div>
    </section>
  </div>;
}

function AgentInboxRow({ item, onOpen }: { item: AgentInboxItem; onOpen(): void }) {
  const t = useT();
  const { machine, entry } = item;
  const { pane, workspace, tab, agent } = entry;
  const title = agentRowTitle(entry);
  const tabs = machine.snapshot?.tabs.filter((candidate) => candidate.workspace_id === workspace.workspace_id) ?? [];
  const place = agentContext({
    agentLabel: null,
    title,
    markAgent: null,
    machineName: machine.name,
    workspaceLabel: workspace.label,
    tabName: agentTabName(tab, tabs, t),
  }).join(" · ");
  const kind = entry.agentLabel ?? entry.canonicalAgent ?? t("Agent");
  const identity = [...new Set([kind, agent?.name?.trim() || null, pane.pane_id].filter((part): part is string => Boolean(part)))].join(" · ");
  const need = pane.agent_kind ? blockedLabel(pane, t) ?? t("Waiting for your answer") : t("Waiting for your answer");
  const context = pane.agent_message?.trim() || pane.plan?.current?.trim() || null;
  const mark = paneMark(entry) ?? kind;
  return <li>
    <button type="button" className="agent-inbox-item" data-machine={machine.id} data-pane={pane.pane_id} onClick={onOpen}>
      <span className="agent-inbox-mark" aria-hidden="true"><AgentMark agent={mark} size={22} /></span>
      <span className="agent-inbox-copy">
        <span className="agent-inbox-heading">
          <span className="agent-inbox-title">{title}</span>
          <span className="agent-inbox-need">{need}</span>
        </span>
        {context && <span className="agent-inbox-context">{context}</span>}
        <span className="agent-inbox-place">{place}</span>
        <span className="agent-inbox-footer">
          <span className="agent-inbox-identity">{identity}</span>
          <span className="agent-inbox-open">{t("Open chat")}<ArrowUpRight aria-hidden="true" /></span>
        </span>
      </span>
    </button>
  </li>;
}
