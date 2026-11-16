import { Check, Hammer, Search, type LucideIcon } from "lucide-react";
import type { HerdrPane } from "../../shared/protocol.ts";
import { useSettings } from "../lib/settings.ts";
import "./agent-role.css";

export type AgentRole = NonNullable<HerdrPane["agent_role"]>;

/** The one place a job agent's role (the runner's `role` label) becomes its icon: the tab chips and the rows' badges. */
export const ROLE_ICONS: Record<AgentRole, LucideIcon> = { implement: Hammer, review: Check, explore: Search };

/**
 * A job agent's role, as a small disc on its picture's bottom-right corner: in the sidebar's rows and the agent
 * inbox's. Nothing for any other agent, or with Agent friends off (the setting the folded tab chips follow too).
 */
export function ForkRoleBadge({ role }: { role: AgentRole | undefined }) {
  const { settings } = useSettings();
  if (!settings.agentFriends || role === undefined) return null;
  const Icon = ROLE_ICONS[role];
  return <span className="fork-role-badge" aria-hidden="true"><Icon /></span>;
}
