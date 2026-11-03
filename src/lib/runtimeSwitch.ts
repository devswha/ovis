/**
 * After a runtime switch (Settings → About → Terminals), the server restarts on the chosen runtime.
 * The wait for the restarted one lives here, for the page's lifetime, so neither closing Settings
 * nor anything else the page does stops it: it asks the server's boot id until another one answers
 * and is the one that stays (its whole health answers, or it outlasted the launcher's check), then
 * tells the app (`onBack`), which reads the new server's facts as after any restart; no reload.
 * A server that has not come back by the deadline is reported once (the `lost` state). Each ask is
 * bounded too, so one request that never settles cannot hold the deadline off.
 */
export interface FollowRestartOptions {
  /** the boot id that answered before the switch: any other one is the restarted server */
  from: string | null;
  /** the bridge's boot id now, and whether its whole health answer came too; null while none answers */
  boot: () => Promise<{ id: string; ready: boolean } | null>;
  onBack: () => void;
  onLost: () => void;
  pollMs?: number;
  waitMs?: number;
  /** the longest one ask is waited for */
  askMs?: number;
  /** how long a new bridge must stay to count without its whole health answer: past the launcher's check, which rolls back a start that fails it */
  settleMs?: number;
  now?: () => number;
  schedule?: (run: () => void, ms: number) => void;
  /** settles with null after `ms`: what bounds one ask */
  limit?: (ms: number) => Promise<null>;
}

export const RESTART_POLL_MS = 1000;
/** the launcher's startup health check gives a new bridge 20 s (server/supervisor.ts): one still there after this is the one that stays */
export const RESTART_SETTLE_MS = 25_000;
export const RESTART_WAIT_MS = 90_000;
const RESTART_ASK_MS = 5000;

export function followRestart(options: FollowRestartOptions): void {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? ((run, ms) => { setTimeout(run, ms); });
  const limit = options.limit ?? ((ms) => new Promise<null>((resolve) => { setTimeout(() => resolve(null), ms); }));
  const deadline = now() + (options.waitMs ?? RESTART_WAIT_MS);
  // a new bridge and when it first answered: one that is still being checked may yet be rolled back
  let seen: { id: string; at: number } | null = null;
  const ask = async (): Promise<void> => {
    const bound = Math.max(0, Math.min(options.askMs ?? RESTART_ASK_MS, deadline - now()));
    const boot = await Promise.race([options.boot().catch(() => null), limit(bound)]);
    if (boot !== null && boot.id !== options.from) {
      if (seen?.id !== boot.id) seen = { id: boot.id, at: now() };
      if (boot.ready || now() - seen.at >= (options.settleMs ?? RESTART_SETTLE_MS)) { options.onBack(); return; }
    }
    if (now() > deadline) { options.onLost(); return; }
    schedule(() => void ask(), options.pollMs ?? RESTART_POLL_MS);
  };
  void ask();
}

/** The switch the page waits on: which runtime, and whether the server stayed away past the deadline. */
export type RestartState = { to: "herdr" | "herdr-core"; lost: boolean } | null;

let state: RestartState = null;
const listeners = new Set<() => void>();
const set = (next: RestartState) => { state = next; for (const listener of listeners) listener(); };

export function restartState(): RestartState {
  return state;
}

export function subscribeRestart(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Starts waiting for the server a switch to `to` restarts, for the page's lifetime. */
export function awaitRestart(to: "herdr" | "herdr-core", options: Omit<FollowRestartOptions, "onLost">): void {
  set({ to, lost: false });
  followRestart({
    ...options,
    onBack: () => { set(null); options.onBack(); },
    onLost: () => set({ to, lost: true }),
  });
}
