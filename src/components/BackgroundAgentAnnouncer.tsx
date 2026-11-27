import { useEffect, useRef, useState } from "react";
import { paneStorageId, type Machine } from "../../shared/machines.ts";
import type { AgentStatus } from "../../shared/protocol.ts";
import { agentDisplayLabel } from "../lib/compose.ts";
import { useT } from "../lib/i18n.ts";
import { shownStatus } from "../lib/sidebarOrder.ts";
import { useAnnouncedText } from "../lib/useAnnouncedText.ts";
import { usePageVisible } from "../lib/visibility.ts";
import { alertPaneTitle } from "./Sidebar.tsx";

type PaneState = { readonly status: AgentStatus | undefined; readonly epoch: string | undefined; readonly lastDone: number };

export function BackgroundAgentAnnouncer({ machines, openMachineId, openPaneId }: {
  readonly machines: readonly Machine[];
  readonly openMachineId: string;
  readonly openPaneId: string | null;
}) {
  const t = useT();
  const visible = usePageVisible();
  const previous = useRef(new Map<string, PaneState>());
  const [announcement, setAnnouncement] = useState<{ readonly id: number; readonly text: string } | null>(null);
  useEffect(() => {
    const next = new Map<string, PaneState>();
    const lines: string[] = [];
    for (const machine of machines) {
      if (machine.state !== "connected" || !machine.snapshot) continue;
      const { panes, workspaces, finish_epoch: epoch } = machine.snapshot;
      for (const pane of panes) {
        if (!pane.agent || pane.restore_error) continue;
        const key = paneStorageId(machine.id, pane.pane_id);
        // Use the observed state, not the badge's read/unread presentation.
        const status = shownStatus(pane, null);
        const finish = status === "done" ? pane.finish_id ?? 0 : 0;
        const before = previous.current.get(key);
        const samePane = before !== undefined && before.epoch === epoch;
        const lastDone = samePane ? before.lastDone : 0;
        next.set(key, { status, epoch, lastDone: Math.max(lastDone, finish) });
        if (!visible || (machine.id === openMachineId && pane.pane_id === openPaneId) || (status !== "blocked" && status !== "done")) continue;
        if (!samePane || (finish > 0 && finish <= lastDone)) continue;
        const newFinish = finish > lastDone && lastDone > 0;
        if (before.status === status && !newFinish) continue;
        const workspace = workspaces.find((row) => row.workspace_id === pane.workspace_id)?.label || pane.workspace_id;
        // Name the pane as its alert does, so two agents of one kind in a workspace stay apart.
        const title = alertPaneTitle(pane);
        lines.push(t(status === "blocked" ? "{agent} needs input in {workspace}" : "{agent} finished in {workspace}", {
          agent: title === pane.pane_id ? agentDisplayLabel(pane.agent) : title, workspace,
        }));
      }
    }
    previous.current = next;
    if (!visible) setAnnouncement(null);
    else if (lines.length > 0) setAnnouncement((last) => ({ id: (last?.id ?? 0) + 1, text: lines.join(". ") }));
  }, [machines, openMachineId, openPaneId, t, visible]);
  const text = useAnnouncedText(visible ? announcement?.text ?? null : null);
  return <p className="visually-hidden agent-announcement" aria-live="polite" aria-atomic="true">{text && <span key={announcement?.id}>{text}</span>}</p>;
}
