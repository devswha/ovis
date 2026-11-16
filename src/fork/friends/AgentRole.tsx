import type { ReactNode } from "react";
import { Check, CodeXml, Search, type LucideIcon } from "lucide-react";
import type { AgentStatus, HerdrPane } from "../../../shared/protocol.ts";
import { useSettings } from "../../lib/settings.ts";
import "./agent-role.css";

export type AgentRole = NonNullable<HerdrPane["agent_role"]>;

/** The one place a job agent's role (the runner's `role` label) becomes its icon: tab chips, sidebar and inbox rows. */
export const ROLE_ICONS: Record<AgentRole, LucideIcon> = { implement: CodeXml, review: Check, explore: Search };

/** A job agent's role while Agent friends is on (the setting the folded tab chips follow too); otherwise none. */
export function useForkRole(role: AgentRole | undefined): AgentRole | undefined {
  const { settings } = useSettings();
  return settings.agentFriends ? role : undefined;
}

/** A job agent's picture: only its role's icon, in its state's color; no friend (its parent row wears that). */
export function RoleIcon({ role, status }: { role: AgentRole; status?: AgentStatus | "waiting" }) {
  const Icon = ROLE_ICONS[role];
  return <Icon className="fork-role-icon" data-status={status} aria-hidden="true" />;
}

/** The sidebar row's picture: the role icon for a job agent, else the row's own picture (children). */
export function ForkRolePicture({ role, status, children }: { role: AgentRole | undefined; status?: AgentStatus; children: ReactNode }) {
  const shown = useForkRole(role);
  return shown ? <RoleIcon role={shown} status={status} /> : <>{children}</>;
}
