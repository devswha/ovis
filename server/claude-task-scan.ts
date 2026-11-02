import type { OmoTask } from "../shared/protocol.ts";
import { type ClaudeSubagentStatus } from "./claude-subagents.ts";
import { waitCommandHistory } from "./claude-command-history.ts";
import { claudeTaskHistory } from "./claude-task-history.ts";
import { sameTranscriptVersion } from "./transcript-version.ts";
import { foldClaudeTasks, type ClaudeTaskSnapshot } from "./claude-task-state.ts";
import { FileBusyError, fileTask } from "./file-pool.ts";

/** Only scans still under way are shared; the next request after one finishes reads again. */
interface Scan { promise: Promise<OmoTask[]>; waiters: number; abort: AbortController }
const scans = new Map<string, Scan>();

/**
 * The task-list route's filesystem work runs on a file thread, with the pool's bounded queue
 * and long-task deadline. Identical overlapping requests share that scan. Cancelling one
 * request stops only its wait, not another client's scan. No result enters the status tracker
 * or the queued-input path, whose file-version checks remain independent.
 */
export function scanClaudeTasks(session: NonNullable<ReturnType<ClaudeSubagentStatus["sessionOf"]>>, signal?: AbortSignal): Promise<OmoTask[]> {
  if (signal?.aborted) return Promise.reject(new FileBusyError("the request was cancelled"));
  const { path, live, startedAt: since, read } = session;
  // A replacement process can resume the same path with an unknown start: it cannot join an older read.
  const key = JSON.stringify([path, live, since, read]);
  let scan = scans.get(key);
  if (scan?.abort.signal.aborted) scan = undefined;
  if (scan === undefined) {
    const abort = new AbortController();
    const promise = (async () => {
      const snapshot = await fileTask<ClaudeTaskSnapshot>({ op: "claude-tasks", path, live, since }, abort.signal);
      const initial = foldClaudeTasks(snapshot);
      if (!initial.historyNeeded) return initial.tasks;
      const history = await waitCommandHistory(path, snapshot.parent!.limit, 10_000, abort.signal);
      if (abort.signal.aborted) throw new FileBusyError("the request was cancelled");
      // Preserve the original second stage: after up to ten seconds of prefix work, local
      // parsing and small terminal proofs have their own bounded budget. Reparse at most twice
      // when a proof observes that its local snapshot changed. A final local-only pass supplies
      // the safe partial answer if storage keeps changing; it never applies old history to it.
      const finalDeadline = Date.now() + 10_000;
      for (let attempt = 0; attempt < 2; attempt++) {
        const fresh = await fileTask<ClaudeTaskSnapshot>({ op: "claude-tasks", path, live, since, until: finalDeadline }, abort.signal);
        if (Date.now() >= finalDeadline) return foldClaudeTasks(fresh).tasks;
        let observed = fresh.parent?.version ?? null;
        const proof = await claudeTaskHistory(path, fresh, { history, signal: abort.signal, deadline: finalDeadline, observed: (version) => { observed = version; } });
        if (abort.signal.aborted) throw new FileBusyError("the request was cancelled");
        if (fresh.parent === null || (observed !== null && sameTranscriptVersion(fresh.parent.version, observed))) return foldClaudeTasks(fresh, proof).tasks;
        if (Date.now() >= finalDeadline) break;
      }
      const latest = await fileTask<ClaudeTaskSnapshot>({ op: "claude-tasks", path, live, since, until: Date.now() }, abort.signal);
      return foldClaudeTasks(latest).tasks;
    })();
    scan = { promise, waiters: 0, abort };
    scans.set(key, scan);
    const started = scan;
    const done = () => { if (scans.get(key) === started) scans.delete(key); };
    void promise.then(done, done);
  }
  const shared = scan;
  shared.waiters++;
  return new Promise((resolve, reject) => {
    let finished = false;
    const release = () => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", cancel);
      if (--shared.waiters === 0) shared.abort.abort();
    };
    const cancel = () => { release(); reject(new FileBusyError("the request was cancelled")); };
    signal?.addEventListener("abort", cancel, { once: true });
    void shared.promise.then((tasks) => { release(); resolve(tasks); }, (error) => { release(); reject(error); });
  });
}
