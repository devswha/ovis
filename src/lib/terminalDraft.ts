import { looksLikeKey } from "../../shared/secret-prompt.ts";
import { paneLifetimes, paneStateKey } from "./paneLifetime.ts";

const listeners = new Set<() => void>();
const pending = new Map<string, { written: string; canClear: boolean }>();
export function subscribeTerminalDraft(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
function notify(): void { for (const listener of listeners) listener(); }
export function terminalDraftSending(owner: string): boolean { return pending.has(owner); }
export function setTerminalDraftSending(owner: string, value: boolean): void {
  if (value) pending.set(owner, { written: readTerminalDraft(owner), canClear: true });
  else pending.delete(owner);
  notify();
}
const memory = new Map<string, string>();
const versions = new Map<string, number>();
export function terminalDraftVersion(owner: string): number {
  if (!versions.has(owner)) versions.set(owner, 0);
  return versions.get(owner)!;
}
const unsaved = new Set<string>();
const PREFIX = "ovis:terminal-line:";
export const TERMINAL_LINE_LIMIT = 32_768;
const keyLifetimes = new Map<string, string | null | undefined>();
function lifetimeOf(owner: string): string | null | undefined {
  const pane = paneStateKey(PREFIX + owner);
  return pane ? paneLifetimes.generation(pane.machineId) : undefined;
}
export function readTerminalDraft(owner: string): string {
  if (memory.has(owner)) return memory.get(owner)!;
  let stored = "";
  try { stored = (paneLifetimes.paneStorage.getItem(PREFIX + owner) ?? "").slice(0, TERMINAL_LINE_LIMIT); } catch { return ""; }
  if (looksLikeKey(stored)) {
    memory.set(owner, stored);
    keyLifetimes.set(owner, lifetimeOf(owner));
    try { paneLifetimes.paneStorage.removeItem(PREFIX + owner); } catch {}
  }
  return stored;
}
export function writeTerminalDraft(owner: string, text: string): void {
  const value = text.slice(0, TERMINAL_LINE_LIMIT).replace(/[\uD800-\uDBFF]$/, "");
  const sent = pending.get(owner);
  if (sent && !value.startsWith(sent.written)) sent.canClear = false;
  memory.set(owner, value);
  versions.set(owner, terminalDraftVersion(owner) + 1);
  const key = looksLikeKey(value);
  if (key) keyLifetimes.set(owner, lifetimeOf(owner));
  else keyLifetimes.delete(owner);
  try {
    if (value && !key) paneLifetimes.paneStorage.setItem(PREFIX + owner, value);
    else paneLifetimes.paneStorage.removeItem(PREFIX + owner);
    unsaved.delete(owner);
  } catch {
    if (key) unsaved.delete(owner);
    else unsaved.add(owner);
  }
  notify();
}

if (typeof window !== "undefined") paneLifetimes.forgetLineKeys();

paneLifetimes.onRetire((machineId) => {
  for (const owner of new Set([...memory.keys(), ...versions.keys()])) {
    const pane = paneStateKey(PREFIX + owner);
    if (pane?.machineId !== machineId) continue;
    if (memory.has(owner) && keyLifetimes.has(owner) && keyLifetimes.get(owner) === paneLifetimes.generation(machineId)) continue;
    keyLifetimes.delete(owner);
    const line = memory.get(owner);
    if (unsaved.delete(owner) && line !== undefined) paneLifetimes.keep(machineId, pane.paneId, "line", line);
    memory.delete(owner);
    versions.set(owner, terminalDraftVersion(owner) + 1);
  }
  notify();
});

export function acknowledgeTerminalDraft(owner: string): void {
  const sent = pending.get(owner);
  const current = readTerminalDraft(owner);
  if (sent?.canClear && current.startsWith(sent.written)) writeTerminalDraft(owner, current.slice(sent.written.length));
}
