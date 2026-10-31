import { useSyncExternalStore } from "react";

/**
 * Whether this page can only watch a pane right now (herdr's observer, the server's "watch":
 * another window types in it), by `paneStorageId`. Each mounted PaneTerminal of the pane (a split
 * may mount it twice, on two connections) reports its own connection's role, and the pane counts
 * as watched only while every mount watches it: a note waits for a composer, which a mount that
 * types still shows. What opens outside the pane (a diff's line notes, #1603) reads it.
 */
export class PaneObserving {
  private mounts = new Map<string, Map<symbol, boolean>>();
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  has = (key: string): boolean => {
    const roles = this.mounts.get(key);
    return roles !== undefined && roles.size > 0 && [...roles.values()].every(Boolean);
  };
  /** `mount`'s role for `key`; null when it unmounts or moves to another pane */
  set(key: string, mount: symbol, observing: boolean | null): void {
    const before = this.has(key);
    const roles = this.mounts.get(key) ?? new Map<symbol, boolean>();
    if (observing === null) roles.delete(mount);
    else roles.set(mount, observing);
    if (roles.size === 0) this.mounts.delete(key);
    else this.mounts.set(key, roles);
    if (this.has(key) !== before) for (const listener of this.listeners) listener();
  }
}

export const paneObserving = new PaneObserving();

export function usePaneObserving(key: string | null): boolean {
  return useSyncExternalStore(paneObserving.subscribe, () => key !== null && paneObserving.has(key));
}
