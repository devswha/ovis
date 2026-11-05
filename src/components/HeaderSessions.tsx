import type { SessionCounts } from "../lib/headerSessions.ts";
import { useT } from "../lib/i18n.ts";

/**
 * The PC's sessions at a glance, beside the connection route (lib/headerSessions.ts): a figure per
 * state that has any, in the sidebar's colours and marks (a dot that runs, a question mark that
 * waits, a dot that finished). Only the waiting figure is a button: it opens the next session that
 * waits for an answer, as a messenger's "next unread" does. Nothing at all while every session rests.
 */
export function HeaderSessions({ counts, onNextWaiting }: { counts: SessionCounts; onNextWaiting: (() => void) | null }) {
  const t = useT();
  if (counts.working + counts.waiting + counts.done === 0) return null;
  const waiting = t("{count} waiting for you", { count: counts.waiting });
  const next = t("Open the next session waiting for you");
  return (
    <span className="header-sessions" role="group" aria-label={t("Sessions on this PC")}>
      {counts.working > 0 && <Figure state="working" count={counts.working} label={t("{count} working", { count: counts.working })} />}
      {counts.waiting > 0 && (onNextWaiting
        ? <button type="button" className="header-session-count is-blocked" title={`${waiting} · ${next}`} aria-label={`${waiting} · ${next}`} onClick={onNextWaiting}>
          <span className="header-session-mark" aria-hidden="true">?</span>{counts.waiting}
        </button>
        : <Figure state="blocked" count={counts.waiting} label={waiting} />)}
      {counts.done > 0 && <Figure state="done" count={counts.done} label={t("{count} done", { count: counts.done })} />}
    </span>
  );
}

function Figure({ state, count, label }: { state: "working" | "blocked" | "done"; count: number; label: string }) {
  return (
    <span className={`header-session-count is-${state}`} title={label}>
      {state === "blocked" ? <span className="header-session-mark" aria-hidden="true">?</span> : <span className="header-session-dot" aria-hidden="true" />}
      <span aria-hidden="true">{count}</span>
      <span className="visually-hidden">{label}</span>
    </span>
  );
}
