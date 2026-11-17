import { useCallback, useState } from "react";
import { paneStorageId } from "../../shared/machines.ts";
import type { HerdrPane } from "../../shared/protocol.ts";
import type { PaneView } from "./actions.ts";
import { composerDrafts } from "./composerDraft.ts";
import { paneLifetimes } from "./paneLifetime.ts";
import { holdsQuoteLine } from "./replyComments.ts";

export function useUnsentRecovery({ selectedMachineId, selectedPaneId, setView, pickView }: {
  selectedMachineId: string;
  selectedPaneId: string | null;
  setView: (next: PaneView, source: null) => void;
  pickView: (machineId: string, paneId: string, next: PaneView, source: null) => void;
}) {
  const [unsentFor, setUnsentFor] = useState<{ machineId: string; pane: HerdrPane } | null>(null);
  const recover = useCallback((text: string, agentOnly = false): boolean => {
    if (unsentFor === null) return false;
    const { machineId, pane } = unsentFor;
    const key = `ovis:composer-draft:${paneStorageId(machineId, pane.pane_id)}`;
    if (agentOnly || holdsQuoteLine(text)) composerDrafts.markAgentOnly(key);
    composerDrafts.set(key, (current) => current.trim() === "" ? text : `${current}\n\n${text}`);
    if (machineId === selectedMachineId && pane.pane_id === selectedPaneId) setView("chat", null);
    else pickView(machineId, pane.pane_id, "chat", null);
    return paneLifetimes.stored(machineId) && !composerDrafts.isUnsaved(key);
  }, [unsentFor, selectedMachineId, selectedPaneId, setView, pickView]);
  return { unsentFor, openUnsent: setUnsentFor, closeUnsent: useCallback(() => setUnsentFor(null), []), recover };
}
