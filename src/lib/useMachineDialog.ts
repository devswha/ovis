import { useCallback, useRef, useState } from "react";
import type { Machine } from "../../shared/machines.ts";
import type { AddPcPreset } from "./actions.ts";
import { focusWorkspaceListToggle } from "./focus.ts";

export function useMachineDialog() {
  const [machineDialog, setMachineDialog] = useState<Machine | "new" | null>(null);
  // a new PC's address, when Add a connection → SSH picked one
  const [addPcPreset, setAddPcPreset] = useState<AddPcPreset | null>(null);
  // Add PC from Settings or the palette leaves no trigger to return focus to once its dialog
  // closes (Settings closed when it opened): the header's workspace-list toggle stands in
  const addPcFocusReturn = useRef(false);
  // the Fleet screen (components/FleetView.tsx), opened from Settings (closed as it opens) or the sidebar's fleet caption
  const [fleetOpen, setFleetOpen] = useState(false);
  const closeFleet = useCallback(() => {
    setFleetOpen(false);
    focusWorkspaceListToggle();
  }, []);
  const closeMachineDialog = useCallback(() => {
    setMachineDialog(null);
    setAddPcPreset(null);
    if (!addPcFocusReturn.current) return;
    addPcFocusReturn.current = false;
    focusWorkspaceListToggle();
  }, []);
  return { machineDialog, setMachineDialog, addPcPreset, setAddPcPreset, addPcFocusReturn, closeMachineDialog, fleetOpen, setFleetOpen, closeFleet };
}
