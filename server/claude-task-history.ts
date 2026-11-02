import { commandHistory, historyVersion, sameHistory, vouchedEnds, waitCommandHistory, type HistoryEvidence, type HistoryResult, type HistoryVersion } from "./claude-command-history.ts";
import { foldClaudeTasks, type ClaudeTaskSnapshot } from "./claude-task-state.ts";

/** Main-process seam: file threads only parse; historical prefix and line proof I/O happens here. */
export async function claudeTaskHistory(path: string, snapshot: ClaudeTaskSnapshot, options: { wait?: boolean; signal?: AbortSignal; deadline?: number; history?: HistoryResult | null; observed?: (version: HistoryVersion | null) => void } = {}): Promise<HistoryEvidence | null> {
  const deadline = options.deadline ?? Date.now() + 10_000;
  if (options.signal?.aborted || Date.now() >= deadline) return null;
  const state = foldClaudeTasks(snapshot);
  if (!state.historyNeeded || snapshot.parent === null) return null;
  const { version, limit } = snapshot.parent;
  const needed = new Set(state.needed);
  const evidence = options.history !== undefined ? options.history
    : options.wait ? await waitCommandHistory(path, limit, Math.max(0, deadline - Date.now()), options.signal)
    : await commandHistory(path, limit, true, needed, { signal: options.signal, deadline });
  if (options.signal?.aborted || Date.now() >= deadline || evidence === null || evidence.version.id !== version.id) return null;
  // Supplied evidence crosses a worker/await boundary. Two captured versions agreeing is not a
  // current-file check: obtain metadata at the consumer, as the original parser did before use.
  const current = options.history !== undefined ? await historyVersion(path, { signal: options.signal, deadline }) : evidence.version;
  options.observed?.(current);
  if (current === null || !sameHistory(evidence.version, current) || current.id !== version.id) return null;
  // Supplied exact-version coverage includes every end, matching the original task-thread fold.
  // A changed generation vouches only unresolved IDs; default tracker reads already filter them.
  const exact = evidence.version.size === version.size && evidence.version.mtimeMs === version.mtimeMs && current.size === version.size && current.mtimeMs === version.mtimeMs;
  if (exact && evidence.unverified !== true) return evidence;
  const wanted = exact ? evidence.ends : evidence.ends.filter((end) => needed.has(end.id));
  if (wanted.length === 0) return { version: current, through: evidence.through, complete: evidence.complete, ends: [] };
  const proof = await vouchedEnds(path, version.id, wanted, options.signal, deadline, options.observed);
  return proof === null ? null : { version: proof.version, through: evidence.through, complete: evidence.complete, ends: proof.ends };
}
