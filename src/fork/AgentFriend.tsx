import type { Friend } from "../../shared/friends.ts";
import type { AgentStatus } from "../../shared/protocol.ts";
import { AgentMark } from "../components/AgentMark.tsx";
import "./AgentFriend.css";

// Vite bundles each of the folder's pictures for this pattern
const picture = (friend: Friend) => new URL(`../assets/friends/${friend}.png`, import.meta.url).href;

/**
 * An agent's friend (agents-app's friends), in place of its agent's mark: it bounces while
 * the agent works, hops and then waves while a finish waits to be read, and keeps the agent's mark
 * as a badge on its corner. An offline row dims it (AgentFriend.css).
 */
export function AgentFriend({ friend, agent, status }: { friend: Friend; agent: string; status?: AgentStatus }) {
  const mood = status === "working" ? "is-working" : status === "done" ? "is-done" : status === "blocked" ? "is-blocked" : "";
  return <span className={`agent-friend ${mood}`}>
    <img src={picture(friend)} alt="" draggable={false} />
    <span className="agent-friend-badge"><AgentMark agent={agent} size={9} /></span>
  </span>;
}
