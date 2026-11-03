/**
 * After a runtime switch (Settings → About → Terminals), the server restarts on the chosen runtime.
 * The wait for the restarted one lives here, outside any component, so nothing the page does in the
 * meantime stops it: it asks the server's boot id until another one answers, then tells the app
 * (`onBack`), which reads the new server's facts as it does after any restart; no reload, so
 * Settings stays where the switch was made. A server that has not come back by the deadline is
 * reported once (`onLost`) and asked no more.
 */
export interface FollowRestartOptions {
  /** the boot id that answered before the switch: any other one is the restarted server */
  from: string | null;
  /** the boot id that answers now; null while none does */
  boot: () => Promise<string | null>;
  onBack: () => void;
  onLost: () => void;
  pollMs?: number;
  waitMs?: number;
  now?: () => number;
  schedule?: (run: () => void, ms: number) => void;
}

export const RESTART_POLL_MS = 1000;
export const RESTART_WAIT_MS = 90_000;

export function followRestart(options: FollowRestartOptions): void {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? ((run, ms) => { setTimeout(run, ms); });
  const deadline = now() + (options.waitMs ?? RESTART_WAIT_MS);
  const ask = async (): Promise<void> => {
    const boot = await options.boot().catch(() => null);
    if (boot !== null && boot !== options.from) { options.onBack(); return; }
    if (now() > deadline) { options.onLost(); return; }
    schedule(() => void ask(), options.pollMs ?? RESTART_POLL_MS);
  };
  void ask();
}
