import type { Friend } from "../../../shared/friends.ts";
import type { AgentStatus } from "../../../shared/protocol.ts";
import "./AgentFriend.css";

// each picture named as a plain string, so Vite bundles it and scripts/ci-browser-parallel.ts can follow it
const PICTURES: Record<Friend, URL> = {
  hoshi: new URL("../../assets/friends/hoshi.png", import.meta.url),
  kokoro: new URL("../../assets/friends/kokoro.png", import.meta.url),
  kuma: new URL("../../assets/friends/kuma.png", import.meta.url),
  maru: new URL("../../assets/friends/maru.png", import.meta.url),
  mikan: new URL("../../assets/friends/mikan.png", import.meta.url),
  neko: new URL("../../assets/friends/neko.png", import.meta.url),
  sankaku: new URL("../../assets/friends/sankaku.png", import.meta.url),
  shikaku: new URL("../../assets/friends/shikaku.png", import.meta.url),
  usagi: new URL("../../assets/friends/usagi.png", import.meta.url),
};
const picture = (friend: Friend) => PICTURES[friend].href;

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
