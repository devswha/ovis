import { friendKey } from "../../../shared/friends.ts";
import type { HerdrPane } from "../../../shared/protocol.ts";
import { InboxAvatar } from "../../components/InboxList.tsx";
import { paneStatus } from "../../lib/status.ts";
import { AgentAvatar } from "../friends/AgentAvatar.tsx";
import { RoleIcon, useForkRole } from "../friends/AgentRole.tsx";
import { useFriends } from "../friends/friends.ts";

/** Preserve the inbox's upstream face unless this agent has an assigned friend; a job agent shows only its role's icon. */
export function ForkInboxAvatar({ row }: { row: { mark: string | null; pane: HerdrPane; machine: { id: string } } }) {
  const friends = useFriends();
  const role = useForkRole(row.pane.agent_role);
  if (role) return <span className="inbox-avatar" aria-hidden="true"><span className="inbox-avatar-face fork-role-face"><RoleIcon role={role} status={paneStatus(row.pane)} /></span></span>;
  if (row.mark === null || !friends[friendKey(row.machine.id, row.pane.pane_id)]) return <InboxAvatar mark={row.mark} />;
  return <span className={`inbox-avatar${["claude", "omp", "omo"].includes(row.mark) ? " is-tile" : ""}`} aria-hidden="true">
    <span className="inbox-avatar-face"><AgentAvatar agent={row.mark} size={32} friendSize="fill" paneId={row.pane.pane_id} machineId={row.machine.id} status={paneStatus(row.pane)} /></span>
  </span>;
}
