import type { Machine } from "../../shared/machines.ts";
import { LOCAL_MACHINE, paneStorageId } from "../../shared/machines.ts";

export const paneMuteKey = paneStorageId;

let muted: readonly string[] | null = null;
const listeners = new Set<() => void>();

export function currentPaneMutes(): readonly string[] | null {
  return muted;
}

export function setPaneMutes(keys: readonly string[] | null): void {
  const next = keys === null ? null : [...new Set(keys)];
  if (next === null ? muted === null : muted !== null && next.length === muted.length && next.every((key, index) => key === muted![index])) return;
  muted = next;
  for (const listener of [...listeners]) listener();
}

export function subscribePaneMutes(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function togglePaneMute(keys: readonly string[], key: string): string[] {
  return keys.includes(key) ? keys.filter((current) => current !== key) : [...keys, key];
}

export function prunePaneMutes(keys: readonly string[], machines: readonly Pick<Machine, "id" | "state" | "snapshot">[]): string[] {
  const authoritative = machines.filter((machine) => machine.state === "connected" && machine.snapshot !== null);
  const live = new Set(authoritative.flatMap((machine) => machine.snapshot!.panes.map((pane) => paneStorageId(machine.id, pane.pane_id))));
  const onPc = (key: string, machineId: string): boolean => machineId === LOCAL_MACHINE ? !key.startsWith("remote:") : key.startsWith(paneStorageId(machineId, ""));
  return keys.filter((key) => live.has(key) || !authoritative.some((machine) => onPc(key, machine.id)));
}
