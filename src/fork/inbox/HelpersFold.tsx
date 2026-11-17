import { useState } from "react";

import { HELPERS_OPEN_KEY, loadOpenHelpers } from "../../components/AgentSidebar.tsx";

/**
 * The agents whose helpers the agent inbox keeps unfolded: the sidebar's own choice on this device
 * (AgentSidebar.tsx), so an agent opened in one list is open in the other.
 */
export function useForkOpenHelpers(): { open: readonly string[]; toggle(key: string): void } {
  const [open, setOpen] = useState(loadOpenHelpers);
  const toggle = (key: string): void => {
    // read anew, so another list's or tab's choices are kept; the sidebar prunes the agents that are gone
    const stored = loadOpenHelpers();
    const next = stored.includes(key) ? stored.filter((held) => held !== key) : [...stored, key];
    setOpen(next);
    try { window.localStorage.setItem(HELPERS_OPEN_KEY, JSON.stringify(next)); } catch { /* private mode: this page keeps it */ }
  };
  return { open, toggle };
}
