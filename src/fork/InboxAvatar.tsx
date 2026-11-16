import { friendKey } from "../../shared/friends.ts";
import type { HerdrPane } from "../../shared/protocol.ts";
import { InboxAvatar } from "../components/InboxList.tsx";
import { paneStatus } from "../lib/status.ts";
import { AgentAvatar } from "./AgentAvatar.tsx";
import { ForkRoleBadge } from "./AgentRole.tsx";
import { useFriends } from "./friends.ts";

/** Preserve the inbox's upstream face unless this agent has an assigned friend; a job agent wears its role's badge on either. */
export function ForkInboxAvatar({ row }: { row: { mark: string | null; pane: HerdrPane; machine: { id: string } } }) {
  const friends = useFriends();
  const badge = <ForkRoleBadge role={row.pane.agent_role} />;
  if (row.mark === null || !friends[friendKey(row.machine.id, row.pane.pane_id)]) return <InboxAvatar mark={row.mark}>{badge}</InboxAvatar>;
  return <span className={`inbox-avatar${["claude", "omp", "omo"].includes(row.mark) ? " is-tile" : ""}`} aria-hidden="true">
    <span className="inbox-avatar-face"><AgentAvatar agent={row.mark} size={32} friendSize="fill" paneId={row.pane.pane_id} machineId={row.machine.id} status={paneStatus(row.pane)} /></span>
    {badge}
  </span>;
}
