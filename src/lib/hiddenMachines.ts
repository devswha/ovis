/**
 * Settings → Remote PCs → Show in sidebar: the PCs one device keeps out of its sidebar, its Agents
 * list and its command palette. Nothing goes to the server: a hidden PC stays connected, its agents
 * keep running, and a link or an alert to one of its panes still opens that pane. One PC is always
 * shown.
 */

import { useEffect, useMemo, useRef, useSyncExternalStore, type RefObject } from "react";

interface HasId { id: string }

/**
 * Kept in a key of its own, as the PC fold state is (`ovis:pc-collapsed:<id>`), never in
 * ovis:settings: a tab still on an older version rewrites that record whole and would erase a field
 * it does not know (docs/development.md, Stored-format changes).
 */
export const HIDDEN_MACHINES_KEY = "ovis:hidden-pcs";
/** PCs a device remembers hiding; more are a hand-edited record */
export const HIDDEN_MACHINES_MAX = 64;

/** A stored list of PC ids: strings only, each once, bounded. Anything else is none hidden. */
export function parseHiddenMachines(raw: string | null): string[] {
  let value: unknown;
  try { value = raw === null ? [] : JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 200))].slice(0, HIDDEN_MACHINES_MAX);
}

const listeners = new Set<() => void>();
let cache: { raw: string | null; ids: string[] } = { raw: null, ids: [] };
// where storage refuses the write (a full or blocked one), the choice lasts for this page
let unsaved: string[] | null = null;

export function readHiddenMachines(): string[] {
  if (unsaved !== null) return unsaved;
  let raw: string | null = null;
  try { raw = window.localStorage.getItem(HIDDEN_MACHINES_KEY); } catch { /* no storage: none hidden */ }
  if (raw !== cache.raw) cache = { raw, ids: parseHiddenMachines(raw) };
  return cache.ids;
}

export function setHiddenMachines(ids: readonly string[]): void {
  try {
    window.localStorage.setItem(HIDDEN_MACHINES_KEY, JSON.stringify(ids));
    unsaved = null;
  } catch {
    unsaved = [...ids];
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // another tab of this browser shows or hides a PC: this one follows
  const onStorage = (event: StorageEvent): void => { if (event.key === HIDDEN_MACHINES_KEY || event.key === null) listener(); };
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(listener); window.removeEventListener("storage", onStorage); };
}

/** The ids this device hides, kept current across its tabs. */
export function useHiddenMachines(): string[] {
  return useSyncExternalStore(subscribe, readHiddenMachines, () => []);
}

/**
 * The roster's PCs this device shows. A PC hidden here (in this tab or another) takes the selection
 * on it to a PC still shown; a pane a link or an alert opens on a hidden PC later stays selected,
 * since only a change of the list moves it.
 */
export function useShownMachines<T extends HasId>({ machines, selectedMachineRef, selectTargetRef }: {
  machines: readonly T[];
  selectedMachineRef: RefObject<string>;
  selectTargetRef: RefObject<(machineId: string, paneId: string | null) => void>;
}): T[] {
  const hidden = useHiddenMachines();
  const shown = useMemo(() => shownMachines(machines, hidden), [machines, hidden]);
  const machinesRef = useRef(machines);
  machinesRef.current = machines;
  const hiddenBefore = useRef(hidden);
  useEffect(() => {
    const before = hiddenBefore.current;
    hiddenBefore.current = hidden;
    if (before === hidden || before.includes(selectedMachineRef.current)) return;
    const next = selectionAfterHiding(machinesRef.current, hidden, selectedMachineRef.current);
    if (next !== null) selectTargetRef.current(next, null);
  }, [hidden]);
  return shown;
}

/** The PCs this device shows, in the roster's order. Were every PC hidden (the one shown was removed), all are shown. */
export function shownMachines<T extends HasId>(machines: readonly T[], hidden: readonly string[]): T[] {
  if (hidden.length === 0) return [...machines];
  const shown = machines.filter((machine) => !hidden.includes(machine.id));
  return shown.length > 0 ? shown : [...machines];
}

/** Whether `id` can be hidden now: it is shown, and another PC stays shown. */
export function canHideMachine(machines: readonly HasId[], hidden: readonly string[], id: string): boolean {
  const shown = shownMachines(machines, hidden);
  return shown.some((machine) => machine.id === id) && shown.length > 1;
}

/** The hidden list after showing or hiding `id`, with the ids of PCs no longer in the roster dropped. */
export function withMachineHidden(machines: readonly HasId[], hidden: readonly string[], id: string, hide: boolean): string[] {
  const inRoster = hidden.filter((other) => machines.some((machine) => machine.id === other));
  // a list that hides every PC is drawn as none hidden (shownMachines), and changes from there
  const drawn = inRoster.length >= machines.length ? [] : inRoster;
  const kept = drawn.filter((other) => other !== id);
  return hide ? [...kept, id] : kept;
}

/** Whether `id` is drawn in the sidebar: what its switch in Settings says. */
export function isMachineShown(machines: readonly HasId[], hidden: readonly string[], id: string): boolean {
  return shownMachines(machines, hidden).some((machine) => machine.id === id);
}

/**
 * Where the selection goes when the PC it is on is hidden here: the Host when it is shown, else the
 * first PC shown; null when the selection may stay (its PC is still shown).
 */
export function selectionAfterHiding(machines: readonly HasId[], hidden: readonly string[], selectedMachineId: string): string | null {
  const shown = shownMachines(machines, hidden);
  if (shown.some((machine) => machine.id === selectedMachineId)) return null;
  return (shown.find((machine) => machine.id === "local") ?? shown[0])?.id ?? null;
}
