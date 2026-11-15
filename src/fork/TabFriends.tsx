import type { ReactNode } from "react";
import type { HerdrPane, PaneInfo } from "../../shared/protocol.ts";
import { friendKey } from "../../shared/friends.ts";
import { useMachineId } from "../lib/machineContext.tsx";
import { useSettings } from "../lib/settings.ts";
import { paneStatus } from "../lib/status.ts";
import { AgentMark } from "../components/AgentMark.tsx";
import { AgentFriend } from "./AgentFriend.tsx";
import { useFriends } from "./friends.ts";

/** A split's two friends replace the ordinary status/agent marks only when enabled. */
export function TabFriends({ panes, children }: { panes: PaneInfo[]; children: ReactNode }) {
  const enabled = useSettings().settings.agentFriends;
  const friends = useFriends();
  const machineId = useMachineId();
  if (!enabled || !panes.some((pane) => pane.agent)) return children;
  const agents = panes.filter((pane) => pane.agent);
  return <span className={`tab-strip-faces${agents.length > 1 ? " is-split" : ""}`} aria-hidden="true">
    {agents.slice(0, 2).map((pane) => {
      const friend = friends[friendKey(machineId, pane.pane_id)];
      const status = paneStatus(pane as HerdrPane);
      return friend ? <AgentFriend key={pane.pane_id} friend={friend} status={status === "waiting" ? "working" : status === "unknown" ? undefined : status} />
        : <AgentMark key={pane.pane_id} agent={pane.agent!} size={16} />;
    })}
  </span>;
}
