import { paneStorageId } from "../../shared/machines.ts";
import { composerDrafts } from "./composerDraft.ts";
import { restoreDraft } from "./draft.ts";
import { paneLifetimes } from "./paneLifetime.ts";
import { readTerminalDraft } from "./terminalDraft.ts";
import { sameTarget, type SplitTarget } from "./split.ts";

export function followsHerdrFocus(input: {
  enabled: boolean;
  machineId: string;
  paneId: string;
  selection: { machineId: string; paneId: string | null };
  splitOthers: readonly SplitTarget[];
  linkPending: boolean;
  busy: boolean;
  ownMove: boolean;
}): boolean {
  if (!input.enabled || input.linkPending || input.busy || input.ownMove) return false;
  if (input.machineId !== input.selection.machineId || input.paneId === input.selection.paneId) return false;
  return !input.splitOthers.some((other) => sameTarget(other, { machineId: input.machineId, paneId: input.paneId }));
}

const ownMoves = new Map<string, number>();
export const OWN_MOVE_HOLD_MS = 10_000;

export function movingHerdrFocus<T>(machineId: string, request: Promise<T>): Promise<T> {
  ownMoves.set(machineId, (ownMoves.get(machineId) ?? 0) + 1);
  let held = true;
  const release = (): void => {
    if (!held) return;
    held = false;
    const left = (ownMoves.get(machineId) ?? 1) - 1;
    if (left > 0) ownMoves.set(machineId, left);
    else ownMoves.delete(machineId);
  };
  const bound = setTimeout(release, OWN_MOVE_HOLD_MS);
  return request.finally(() => { clearTimeout(bound); release(); });
}

export function movingHerdrFocusOn(machineId: string): boolean {
  return ownMoves.has(machineId);
}

export function deviceBusy(doc: Pick<Document, "activeElement" | "querySelector"> = document): boolean {
  if (doc.querySelector('[aria-modal="true"], dialog[open]') !== null) return true;
  const active = doc.activeElement;
  return active !== null && "matches" in active
    && active.matches("textarea, input, select, [contenteditable]:not([contenteditable='false'])");
}

export interface PaneDrafts {
  composer: (owner: string) => string;
  line: (owner: string) => string;
  held: (owner: string) => string;
}

const draftsHere: PaneDrafts = {
  composer: (owner) => composerDrafts.read(`ovis:composer-draft:${owner}`).text,
  line: (owner) => readTerminalDraft(owner),
  held: (owner) => {
    let raw: string | null = null;
    try { raw = paneLifetimes.paneStorage.getItem(`ovis:terminal-draft:${owner}`); } catch {}
    return restoreDraft(raw, Date.now()).text;
  },
};

export function unsentDraft(selection: { machineId: string; paneId: string | null }, drafts: PaneDrafts = draftsHere): boolean {
  if (selection.paneId === null) return false;
  const owner = paneStorageId(selection.machineId, selection.paneId);
  return [drafts.composer(owner), drafts.line(owner), drafts.held(owner)].some((text) => text.trim() !== "");
}

export function deviceInUse(
  selection: { machineId: string; paneId: string | null },
  doc: Pick<Document, "activeElement" | "hasFocus" | "querySelector"> = document,
  drafts: PaneDrafts = draftsHere,
): boolean {
  return doc.hasFocus() && (deviceBusy(doc) || unsentDraft(selection, drafts));
}
