import { friendKey, type Friend } from "../../shared/friends.ts";
import type { AgentStatus } from "../../shared/protocol.ts";
import { AgentMark } from "../components/AgentMark.tsx";
import { useMachineId } from "../lib/machineContext.tsx";
import type { KnownStatus } from "../lib/status.ts";
import { AgentFriend } from "./AgentFriend.tsx";
import { useFriends } from "./friends.ts";

/** a friend's mood for a pane's status: a pane waiting on background work still works, an unknown one rests */
export const friendMood = (status: KnownStatus | undefined): AgentStatus | undefined =>
  status === "waiting" ? "working" : status === "unknown" ? undefined : status;

/** a friend is drawn a little larger than the agent's mark it replaces, which has no frame of its own */
export const FRIEND_EXTRA = 4;

export interface AgentAvatarProps {
  agent: string;
  /** the mark's px size; the friend's is FRIEND_EXTRA more, or `friendSize` */
  size?: number;
  friendSize?: number | "fill";
  /** the running agent's pane: without it, or with no friend for it, the agent's mark is drawn */
  paneId?: string | null;
  /** the PC the pane is on: the context's when unset */
  machineId?: string;
  status?: KnownStatus;
}

/**
 * What stands for a running agent: its friend's picture alone, with no harness logo, when Agent
 * friends is on and the pane has one; else the agent's mark. A harness's own mark (the agent picker,
 * the settings, the usage meters) stays an AgentMark: it names a harness, not a running agent.
 */
export function AgentAvatar({ agent, size = 16, friendSize, paneId, machineId, status }: AgentAvatarProps) {
  const friends = useFriends();
  const context = useMachineId();
  const friend: Friend | undefined = paneId == null ? undefined : friends[friendKey(machineId ?? context, paneId)];
  return friend ? <AgentFriend friend={friend} size={friendSize ?? size + FRIEND_EXTRA} status={friendMood(status)} /> : <AgentMark agent={agent} size={size} />;
}
