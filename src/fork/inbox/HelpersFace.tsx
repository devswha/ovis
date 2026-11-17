import { ChevronDown, ChevronRight } from "lucide-react";

import { useT } from "../../lib/i18n.ts";

/**
 * Settings → Fold helpers under their agent, the way a workspace folds its worktrees (Sidebar.tsx): the agent's
 * picture is the fold, a button over it that shows its caret under a pointer, and its row says how many helpers
 * the fold hides (`ForkFoldCount`). The sidebar's and the agent inbox's agent rows.
 */
export function ForkHelpersFace({ open, agentTitle, onToggle }: { open: boolean; agentTitle: string; onToggle(): void }) {
  const t = useT();
  const label = t("Helpers of {title}|fork", { title: agentTitle });
  return <button type="button" className="fork-helpers-face" aria-expanded={open} aria-label={label} title={label} onClick={onToggle}>
    {open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
  </button>;
}

/** How many helpers a folded agent hides, after its title: a folded workspace's +N. */
export function ForkFoldCount({ count }: { count: number }) {
  return count > 0 ? <span className="workspace-fold-count" aria-hidden="true">+{count}</span> : null;
}
