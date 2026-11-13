/**
 * What the inbox mode's shell draws around a thread (App.tsx decides where; the list is InboxList.tsx): a phone
 * thread's title in the app's header. Each piece is one of the app's own primitives with its tokens.
 */
import { useMemo } from "react";

import type { Machine } from "../../shared/machines.ts";
import type { HerdrPane } from "../../shared/protocol.ts";
import { inboxStatus } from "../lib/agentInbox.ts";
import { agentGroup, agentRoster } from "../lib/agentRoster.ts";
import type { HeaderConnection } from "../lib/headerConnection.ts";
import { useT, type Translate } from "../lib/i18n.ts";
import { inboxStateWord } from "../lib/inboxRow.ts";
import { agentName } from "../lib/runtimeMove.ts";
import type { SidebarActivity } from "../lib/sidebarActivity.tsx";
import { paneMark } from "../lib/sidebarAgents.ts";
import { agentRowTitle } from "./AgentSidebar.tsx";
import { InboxAvatar } from "./InboxList.tsx";
import { displayPaneTitle } from "./Sidebar.tsx";
import "./InboxMode.css";

export interface ThreadProps {
  /** every PC of the roster: a thread may be a pane of a PC this device hides from its lists */
  machines: readonly Machine[];
  activity: SidebarActivity;
  machineId: string;
  pane: HerdrPane;
  /** the connection's own word, which stands in the state's place while it has something to say */
  connection: HeaderConnection;
  watching: boolean;
  /** more than one PC is shown: the PC's name stands before the state's word */
  severalPcs: boolean;
}

/** What a thread says of its agent: the mark and the name its row in the list draws, and its state in words. */
function threadFacts({ machines, activity, machineId, pane, connection, watching, severalPcs }: ThreadProps, t: Translate) {
  const machine = machines.find((candidate) => candidate.id === machineId);
  const row = agentRoster(machines, { byActivity: false, seqs: activity.seqs, pinned: [] }).rest
    .find((candidate) => candidate.machine.id === machineId && candidate.entry.pane.pane_id === pane.pane_id);
  // a pane that runs no agent is named as its tab is, and is the terminal it shows
  const state = machine !== undefined && machine.state !== "connected" ? t("Offline")
    : row ? inboxStateWord(agentGroup(inboxStatus(row, activity)), t) : t("Terminal");
  const said = connection !== null ? t(connection === "connected" ? "Connected" : "Reconnecting…")
    : [watching ? t("View only") : null, severalPcs && machine ? machine.name : null, state].filter((part) => part !== null).join(" · ");
  return {
    name: row ? agentRowTitle(row, false).title : displayPaneTitle(pane),
    kind: row?.entry.canonicalAgent ?? null,
    mark: row ? paneMark(row.entry) ?? "" : null,
    said,
  };
}

/**
 * A phone thread's title, in the header between Back and the monitor button: the agent's mark, its name over one
 * line that says its state, as the classic header says the place under a pane's title.
 */
export function ThreadTitle(props: ThreadProps) {
  const t = useT();
  const { machines, activity, machineId, pane, connection, watching, severalPcs } = props;
  const { name, kind, mark, said } = useMemo(() => threadFacts({ machines, activity, machineId, pane, connection, watching, severalPcs }, t), [machines, activity, machineId, pane, connection, watching, severalPcs, t]);
  return (
    <div className="thread-title" title={name}>
      <InboxAvatar mark={mark} />
      <div className="thread-title-words">
        <span className="thread-name">{kind && <span className="visually-hidden">{agentName(kind)}: </span>}{name}</span>
        <span className={`thread-state${connection === null ? "" : ` is-${connection}`}`}>{said}</span>
      </div>
    </div>
  );
}
