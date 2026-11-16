import type { Friend } from "../../../shared/friends.ts";
import type { AgentStatus } from "../../../shared/protocol.ts";
import "./AgentFriend.css";

// Vite bundles each of the folder's pictures for this pattern
const picture = (friend: Friend) => new URL(`../../assets/friends/${friend}.png`, import.meta.url).href;

/**
 * An agent's friend (agents-app's friends), in place of its agent's mark, with no harness logo: it
 * bounces while the agent works, hops and then waves while a finish waits to be read. An offline row
 * dims it (AgentFriend.css). `size` is px, or "fill" to take its parent's box; unset, the CSS's 22px.
 */
export function AgentFriend({ friend, status, size }: { friend: Friend; status?: AgentStatus; size?: number | "fill" }) {
  const mood = status === "working" ? "is-working" : status === "done" ? "is-done" : status === "blocked" ? "is-blocked" : "";
  const box = size === undefined ? undefined : size === "fill" ? { width: "100%", height: "100%" } : { width: size, height: size };
  return <span className={`agent-friend ${mood}`} style={box}>
    <img src={picture(friend)} alt="" draggable={false} />
  </span>;
}
