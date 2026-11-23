import type { Machine } from "../../../shared/machines.ts";

/** Use the unfiltered roster: a hidden Pi can be the phone's assistant. */
export function assistantTargets(machines: readonly Machine[]) {
  return machines.flatMap(({ id, name, snapshot }) => (snapshot?.panes ?? []).flatMap((pane) =>
    pane.agent === "pi" ? [{
      machineId: id, paneId: pane.pane_id, machineName: name,
      label: pane.label?.trim() || pane.cwd?.split("/").filter(Boolean).at(-1) || pane.pane_id,
    }] : []));
}
