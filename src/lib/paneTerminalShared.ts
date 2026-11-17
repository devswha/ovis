import { HerdrSocket } from "./ws.ts";
import { userErrorMessage } from "./userError.ts";

export const RESIZE_SETTLE_MS = 120;
export const RELEASE_AFTER_MS = 1000;
export const IDLE_RELEASE_MS = 10_000;
export const RESUME_INPUT_WAIT_MS = 5_000;
export const VIEW_BUFFER_MAX = 512 * 1024;
export const VIEW_HOLD_MS = 1000;

const viewHold = { held: false, queued: new Set<() => void>(), timer: 0 };

export function holdViews(): void {
  viewHold.held = true;
  window.clearTimeout(viewHold.timer);
  viewHold.timer = window.setTimeout(releaseViews, VIEW_HOLD_MS);
}

export function releaseViews(): void {
  if (!viewHold.held) return;
  viewHold.held = false;
  window.clearTimeout(viewHold.timer);
  const run = [...viewHold.queued];
  viewHold.queued.clear();
  for (const change of run) change();
}

export function afterSwitch(change: () => void): void {
  // the switch's own effects run in the same commit: a microtask sees the hold its pane set
  queueMicrotask(() => {
    if (viewHold.held) viewHold.queued.add(change);
    else change();
  });
}

export function dropViewChange(change: () => void): void {
  viewHold.queued.delete(change);
}

export const inUse = (): boolean => document.visibilityState === "visible" && document.hasFocus();

export const connectedSockets = new WeakSet<HerdrSocket>();

export const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

export const plainError = (cause: unknown): string => {
  const failure = userErrorMessage(cause);
  return failure.detail === null ? failure.message : `${failure.message} (${failure.detail})`;
};

export type StillOpen = { pane: string; agent: string; command: string; named: boolean; history: string | undefined };
