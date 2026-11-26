import { useSyncExternalStore } from "react";

import { HELPERS_OPEN_KEY, loadOpenHelpers } from "../../components/AgentSidebar.tsx";

const listeners = new Set<() => void>();
let held: { raw: string | null; open: readonly string[] } | null = null;

const storedRaw = (): string | null => {
  try { return window.localStorage.getItem(HELPERS_OPEN_KEY); } catch { return null; }
};

/** The stored choice as it is now, so a view drawn again sees what the Agents list or another tab chose since it mounted. */
function openNow(): readonly string[] {
  const raw = storedRaw();
  if (held?.raw !== raw) held = { raw, open: loadOpenHelpers() };
  return held.open;
}

function subscribe(changed: () => void): () => void {
  listeners.add(changed);
  window.addEventListener("storage", changed);
  return () => {
    listeners.delete(changed);
    window.removeEventListener("storage", changed);
  };
}

/**
 * The agents whose helpers the agent inbox and the workspace tree keep unfolded: the sidebar's own choice on this
 * device (AgentSidebar.tsx), so an agent opened in one list is open in the others.
 */
export function useForkOpenHelpers(): { open: readonly string[]; toggle(key: string): void } {
  const open = useSyncExternalStore(subscribe, openNow, openNow);
  const toggle = (key: string): void => {
    // read anew, so another list's or tab's choices are kept; the sidebar prunes the agents that are gone
    const stored = openNow();
    const next = stored.includes(key) ? stored.filter((kept) => kept !== key) : [...stored, key];
    try { window.localStorage.setItem(HELPERS_OPEN_KEY, JSON.stringify(next)); } catch { /* private mode: this page keeps it */ }
    held = { raw: storedRaw(), open: next };
    for (const changed of listeners) changed();
  };
  return { open, toggle };
}
