/**
 * The enrollment notice of this page (components/EnrollmentNotice.tsx): set by the enrollment that runs here
 * (shell.tsx), read by the open PC. A wait counts down here, once a second, so a notice drawn again (another
 * layout, a remount) shows the seconds that are left. Kept in memory only, so a page loaded again shows none.
 */
import { useSyncExternalStore } from "react";
import type { EnrollmentNoticeState } from "../../components/EnrollmentNotice.tsx";

let current: EnrollmentNoticeState | null = null;
/** whose notice `current` is: only the one that set it may take it away (showEnrollmentNotice's return) */
let owner: object | null = null;
let ticking: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();

function publish(state: EnrollmentNoticeState | null): void {
  current = state;
  for (const listener of listeners) listener();
}

/**
 * Shows `state` from now on (null: none); a `waiting` one then counts its seconds down to 0. Returns what takes this
 * notice away again, which does nothing once another notice has been shown since.
 */
export function showEnrollmentNotice(state: EnrollmentNoticeState | null): () => void {
  clearInterval(ticking);
  ticking = undefined;
  const mine = {};
  owner = state === null ? null : mine;
  publish(state);
  if (state?.kind === "waiting") {
    let left = state.seconds;
    // fixed wait: one second of the countdown shown, not a pause of any work
    ticking = setInterval(() => {
      left = Math.max(0, left - 1);
      publish({ kind: "waiting", seconds: left });
      if (left === 0) { clearInterval(ticking); ticking = undefined; }
    }, 1000);
  }
  return () => { if (owner === mine) showEnrollmentNotice(null); };
}

export function useEnrollmentNotice(): EnrollmentNoticeState | null {
  const read = (): EnrollmentNoticeState | null => current;
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, read, read);
}
