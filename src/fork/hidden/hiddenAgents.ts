import { useEffect, useMemo, useSyncExternalStore } from "react";
import { onlyHidden, withoutHidden } from "../../../shared/fork/pane.ts";
import type { Machine } from "../../../shared/machines.ts";
import type { Translate } from "../../lib/i18n.ts";

/**
 * Hidden terminals (`ovis.view=hidden` → `ovis_hidden`, shared/fork/core-terminals.ts; they alert like any agent) reach the browser in every snapshot, in a workspace of
 * their own, and every reader but the inbox's Hidden filter sees the roster without them (`useHiddenLens`). Selecting one
 * (any way) keeps just it in the roster the thread view reads while it is the selected pane; `useListedMachines` keeps it out of every list.
 */
interface Held { machineId: string; paneId: string }

let held: Held | null = null;
const listeners = new Set<() => void>();
const hold = (next: Held | null): void => {
  if (held?.machineId === next?.machineId && held?.paneId === next?.paneId) return;
  held = next;
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

const mapSnapshots = (machines: readonly Machine[], map: (machine: Machine & { snapshot: NonNullable<Machine["snapshot"]> }) => NonNullable<Machine["snapshot"]>): Machine[] => {
  const next = machines.map((machine) => {
    if (machine.snapshot === null) return machine;
    const snapshot = map(machine as Machine & { snapshot: NonNullable<Machine["snapshot"]> });
    return snapshot === machine.snapshot ? machine : { ...machine, snapshot };
  });
  return next.every((machine, at) => machine === machines[at]) ? machines as Machine[] : next;
};

/** The filter's name and its empty list, said here so the words stay out of the upstream dictionary parts. */
export const hiddenWords = (t: Translate): { filter: string; none: string } => ({ filter: t("Hidden|inbox filter"), none: t("No hidden agents") });

/** The roster as every reader but the Hidden filter sees it. */
export function shownMachines(machines: readonly Machine[], keep: Held | null = null): Machine[] {
  return mapSnapshots(machines, (machine) => withoutHidden(machine.snapshot, keep?.machineId === machine.id ? keep.paneId : null));
}

/** What the inbox lists for a filter: the hidden agents alone for Hidden, for any other the shown ones, hidden agents never. */
export function inboxMachines(filter: string, machines: readonly Machine[], all: readonly Machine[]): Machine[] {
  if (filter !== "hidden") return shownMachines(machines);
  const hidden = new Map(mapSnapshots(all, (machine) => onlyHidden(machine.snapshot)).map((machine) => [machine.id, machine]));
  return machines.map((machine) => hidden.get(machine.id) ?? machine);
}

/** The roster the app reads: no hidden agent, except the one open from the Hidden filter. */
export function useHiddenLens(all: Machine[]): Machine[] {
  const keep = useSyncExternalStore(subscribe, () => held, () => null);
  return useMemo(() => shownMachines(all, keep), [all, keep]);
}

/** The roster the lists read: the thread view may have a hidden agent open (`useHiddenLens`), no list shows it. */
export function useListedMachines<T extends Machine>(machines: T[]): T[] {
  return useMemo(() => shownMachines(machines) as T[], [machines]);
}

/** The pane a selection picks joins the roster the thread view reads before the selection lands (a no-op for a pane that is no hidden one), so the Hidden filter, a notification or a link opens a hidden agent without a blank render. */
export const holdSelected = (machineId: string, paneId: string | null): void => hold(paneId === null ? null : { machineId, paneId });

/** Whatever pane is selected joins that roster too, however the selection came about: a saved one, a link or a notification a fresh page opens on. Moving the selection releases the last. */
export function useHiddenSelection(selectedMachineId: string, selectedPaneId: string | null): void {
  useEffect(() => { holdSelected(selectedMachineId, selectedPaneId); }, [selectedMachineId, selectedPaneId]);
}
