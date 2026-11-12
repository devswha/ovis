/**
 * DEMO ONLY (lane agents-list-polish, #3505): which draft of the Agents list the address asks for,
 * `?agents=a|b|c`, and where draft c puts a row's place on a touch screen, `?place=none|short`.
 * Both are kept for the tab, so a reload after the app rewrote its address shows the same draft.
 * Removed with the drafts not chosen before the PR.
 */
export type AgentsListVariant = "a" | "b" | "c";
/** on a touch screen: no place on the row, or the place's first parts, each whole, where the title leaves room */
export type AgentsListPlace = "none" | "short";

function asked<T extends string>(name: string, values: readonly T[], fallback: T): T {
  const known = (value: string | null): value is T => values.some((candidate) => candidate === value);
  const key = `ovis:demo-agents-${name}`;
  try {
    const named = new URLSearchParams(window.location.search).get(name);
    if (known(named)) {
      window.sessionStorage.setItem(key, named);
      return named;
    }
    const kept = window.sessionStorage.getItem(key);
    if (known(kept)) return kept;
  } catch { /* no window or no storage: the recommended draft */ }
  return fallback;
}

export const AGENTS_LIST_VARIANT: AgentsListVariant = asked("agents", ["a", "b", "c"], "c");
export const AGENTS_LIST_PLACE: AgentsListPlace = asked("place", ["none", "short"], "none");
