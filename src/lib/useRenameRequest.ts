import { useCallback, useState } from "react";

/** The pane whose tab should open its name field: one press of the Rename tab shortcut or palette action. */
export interface RenameRequest { machineId: string; paneId: string }

/**
 * A one-shot request from the app to the tab strip: the strip acts on it and calls `clear`, so it
 * never outlives the press that made it (a strip that stays mounted across selections would
 * otherwise open the field again when its pane is selected later).
 */
export function useRenameRequest() {
  const [renameRequest, setRenameRequest] = useState<RenameRequest | null>(null);
  const requestRename = useCallback((machineId: string, paneId: string) => setRenameRequest({ machineId, paneId }), []);
  const clearRenameRequest = useCallback(() => setRenameRequest(null), []);
  return { renameRequest, requestRename, clearRenameRequest };
}
