import type { ReactNode } from "react";
import { Bot, type LucideIcon } from "lucide-react";
import type { AgentStatus, HerdrPane } from "../../../shared/protocol.ts";
import { useSettings } from "../../lib/settings.ts";
import "./agent-role.css";

export type AgentRole = NonNullable<HerdrPane["agent_role"]>;

/** A job agent's icon, whatever its role (the runner's `role` label): tab chips, sidebar and inbox rows. */
export const SUB_AGENT_ICON: LucideIcon = Bot;

/** A job agent's role while Agent friends is on (the setting the folded tab chips follow too); otherwise none. */
export function useForkRole(role: AgentRole | undefined): AgentRole | undefined {
  const { settings } = useSettings();
  return settings.agentFriends ? role : undefined;
}

/** A job agent's picture: the sub-agent icon in its state's color; no friend (its parent row wears that). */
export function RoleIcon({ status }: { status?: AgentStatus | "waiting" }) {
  return <SUB_AGENT_ICON className="fork-role-icon" data-status={status} aria-hidden="true" />;
}

/** The sidebar row's picture: the role icon for a job agent, else the row's own picture (children). */
export function ForkRolePicture({ role, status, children }: { role: AgentRole | undefined; status?: AgentStatus; children: ReactNode }) {
  const shown = useForkRole(role);
  return shown ? <RoleIcon status={status} /> : <>{children}</>;
}
