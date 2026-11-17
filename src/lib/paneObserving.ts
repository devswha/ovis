import { useSyncExternalStore } from "react";

export class PaneObserving {
  private mounts = new Map<string, Map<symbol, boolean>>();
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  known = (key: string): boolean => (this.mounts.get(key)?.size ?? 0) > 0;
  has = (key: string): boolean => {
    const roles = this.mounts.get(key);
    return roles !== undefined && roles.size > 0 && [...roles.values()].every(Boolean);
  };
  set(key: string, mount: symbol, observing: boolean | null): void {
    const before = `${this.known(key)}:${this.has(key)}`;
    const roles = this.mounts.get(key) ?? new Map<symbol, boolean>();
    if (observing === null) roles.delete(mount);
    else roles.set(mount, observing);
    if (roles.size === 0) this.mounts.delete(key);
    else this.mounts.set(key, roles);
    if (`${this.known(key)}:${this.has(key)}` !== before) for (const listener of this.listeners) listener();
  }
}

export function mountRole({ observing, inputReady }: { observing: boolean; inputReady: boolean }): boolean | null {
  return observing ? true : inputReady ? false : null;
}

export const paneObserving = new PaneObserving();

export function usePaneObserving(key: string | null): "unknown" | "watching" | "typing" {
  return useSyncExternalStore(paneObserving.subscribe, () => key === null || !paneObserving.known(key) ? "unknown" : paneObserving.has(key) ? "watching" : "typing");
}
