import type { WorkspaceBranchCache } from "../lib/worktreeBranches.ts";

const savedKey = (machineId: string): string => `ovis:branches:${machineId}`;

/** Only the optional fork header restores and persists cold-start branch names. */
export function restoreForkBranches(cache: WorkspaceBranchCache, machineId: string, enabled: boolean): void {
  if (!enabled) return;
  try { cache.restore(JSON.parse(localStorage.getItem(savedKey(machineId)) ?? "null")); } catch { /* unavailable or malformed storage: read git instead */ }
}

export function saveForkBranches(cache: WorkspaceBranchCache, machineId: string, enabled: boolean): void {
  if (!enabled) return;
  try { localStorage.setItem(savedKey(machineId), JSON.stringify(cache.saved())); } catch { /* storage full or off: the next start reads git first */ }
}
