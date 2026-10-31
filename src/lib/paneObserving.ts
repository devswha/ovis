import { useSyncExternalStore } from "react";

/**
 * The panes this page only watches right now (herdr's observer, the server's "watch": another
 * window types in them), by `paneStorageId`. PaneTerminal reports its connection's role here, so
 * what opens outside the pane (a diff's line notes, #1603) takes nothing for it either.
 */
class PaneObserving {
  private observed = new Set<string>();
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  has = (key: string): boolean => this.observed.has(key);
  set(key: string, observing: boolean): void {
    if (observing === this.observed.has(key)) return;
    if (observing) this.observed.add(key);
    else this.observed.delete(key);
    for (const listener of this.listeners) listener();
  }
}

export const paneObserving = new PaneObserving();

export function usePaneObserving(key: string | null): boolean {
  return useSyncExternalStore(paneObserving.subscribe, () => key !== null && paneObserving.has(key));
}
