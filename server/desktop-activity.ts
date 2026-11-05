/**
 * What the desktop app reads to keep its computer awake while an agent works (app/electron/src/awake.ts).
 * A server the app runs keeps `desktop-activity.json` in its state folder: `{ "working": n }`, how many of
 * this PC's panes have an agent working, as clients are shown it. It is read again shortly after a status
 * change and every minute, rewritten only when the count changes, and removed when the server stops.
 */
import { renameSync, rmSync, writeFileSync } from "node:fs";

export const DESKTOP_ACTIVITY_FILE = "desktop-activity.json";

/** a burst of status changes is read once, this long after its first */
const SETTLE_MS = 1_000;
/** a change the status frames missed (a resync, a pane gone quietly) is caught this often */
const REFRESH_MS = 60_000;

export interface DesktopActivity {
  /** a pane's status may have changed: read again soon */
  changed(): void;
  /** reads the count now and writes it when it changed */
  refresh(): Promise<void>;
  stop(): void;
}

export function trackDesktopActivity({ path, working }: { path: string; working: () => Promise<number> }): DesktopActivity {
  let written: number | null = null;
  let soon: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const refresh = async (): Promise<void> => {
    let count: number;
    try { count = await working(); }
    catch (error) {
      // the last count stands: the app lets go once the server stops, and the next read corrects it
      console.warn(`desktop activity: the panes could not be read (${error instanceof Error ? error.message : String(error)})`);
      return;
    }
    if (stopped || count === written) return;
    try {
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify({ working: count }));
      renameSync(temporary, path);
      written = count;
    } catch (error) {
      console.warn(`desktop activity: ${path} could not be written (${error instanceof Error ? error.message : String(error)})`);
    }
  };
  const every = setInterval(() => void refresh(), REFRESH_MS);
  every.unref?.();
  void refresh();
  return {
    changed() {
      if (soon !== null || stopped) return;
      soon = setTimeout(() => { soon = null; void refresh(); }, SETTLE_MS);
      soon.unref?.();
    },
    refresh,
    stop() {
      stopped = true;
      clearInterval(every);
      if (soon !== null) clearTimeout(soon);
      rmSync(path, { force: true });
    },
  };
}
