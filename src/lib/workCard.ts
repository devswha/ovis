import { useSyncExternalStore } from "react";

import type { PlanStep, PlanSummary } from "../../shared/protocol.ts";

/**
 * Whether the plan card (components/WorkCard.tsx) is drawn: the pane keeps a plan, or a background
 * task runs. The chip also stays for tasks that ended; the card has nothing to say of those.
 */
export function workCardShown(plan: PlanSummary | null, backgroundTasks: number): boolean {
  return plan !== null || backgroundTasks > 0;
}

/** The step the card keeps in view: the one in progress, else the next one waiting; none once every step is done. `steps` in the order they are drawn. */
export function currentStepId(steps: readonly PlanStep[]): string | null {
  return (steps.find((step) => step.status === "in_progress") ?? steps.find((step) => step.status === "pending"))?.id ?? null;
}

export interface Span { top: number; height: number }

/**
 * Where a list that is scrolled to `view.top`, and shows `view.height` of its rows, goes to show the
 * row at `row`: null when the row is in view whole; else the row in the middle of the view, or at
 * its top when it is taller than the view.
 */
export function revealScrollTop(view: Span, row: Span): number | null {
  if (row.top >= view.top && row.top + row.height <= view.top + view.height) return null;
  const top = row.height >= view.height ? row.top : row.top - (view.height - row.height) / 2;
  return Math.max(0, Math.round(top));
}

/**
 * Whether the card is folded to its header. Kept per device in a key of its own, never in
 * ovis:settings (an older tab saves that record whole): every card on the device follows it, in this
 * tab and in the others. It starts open.
 */
export const WORK_CARD_FOLD_KEY = "ovis:work-card-folded";

const listeners = new Set<() => void>();
// the choice where storage refused it: kept for as long as this tab lives
let unsaved: boolean | null = null;

export function workCardFolded(): boolean {
  if (unsaved !== null) return unsaved;
  try { return window.localStorage.getItem(WORK_CARD_FOLD_KEY) === "true"; } catch { return false; }
}

export function foldWorkCard(folded: boolean): void {
  try {
    window.localStorage.setItem(WORK_CARD_FOLD_KEY, String(folded));
    unsaved = null;
  } catch {
    unsaved = folded;
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== WORK_CARD_FOLD_KEY && event.key !== null) return;
    unsaved = null;
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(listener); window.removeEventListener("storage", onStorage); };
}

export function useWorkCardFolded(): boolean {
  return useSyncExternalStore(subscribe, workCardFolded, () => false);
}
