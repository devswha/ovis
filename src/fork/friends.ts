import { useEffect, useSyncExternalStore } from "react";

import { useSettings, loadSettings } from "../lib/settings.ts";
import { friendKey, type Friend, type FriendsResponse } from "../../shared/friends.ts";
import type { Machine } from "../../shared/machines.ts";

// The friend each agent pane wears, as this server's /api/friends answered (server/friends.ts).
let friends: Record<string, Friend> = {};
const listeners = new Set<() => void>();
let asked = "";

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const current = () => friends;

/** The friends as this browser last heard, for a reader that leaves the asking to App (useAgentFriends). */
const NO_FRIENDS: Record<string, Friend> = {};
export function useFriends(): Record<string, Friend> {
  const enabled = useSettings().settings.agentFriends;
  const value = useSyncExternalStore(subscribe, current, current);
  return enabled ? value : NO_FRIENDS;
}

/** The friend an agent pane wears, as this browser last heard: for alerts raised in App's event handlers. */
export const paneFriend = (machineId: string, paneId: string): Friend | undefined => loadSettings().agentFriends ? friends[friendKey(machineId, paneId)] : undefined;

/**
 * The friends of the agent panes on the PCs this browser has: told to the server whenever they
 * change, which gives a new one a friend and takes a closed one's back. A server
 * that predates it or a watching device answers nothing, and the rows keep their agents' marks.
 */
export function useAgentFriends(machines: readonly Machine[]): Record<string, Friend> {
  const enabled = useSettings().settings.agentFriends;
  const known = machines.filter((machine) => machine.state === "connected" && machine.snapshot);
  const live = known.flatMap((machine) => machine.snapshot!.panes.filter((pane) => pane.agent).map((pane) => friendKey(machine.id, pane.pane_id))).sort();
  const ids = known.map((machine) => machine.id).sort();
  const request = JSON.stringify({ live, machines: ids });
  useEffect(() => {
    if (!enabled || request === asked || ids.length === 0) return;
    asked = request;
    void fetch("/api/friends", { method: "POST", headers: { "content-type": "application/json" }, body: request })
      .then(async (response) => {
        if (!response.ok) return;
        friends = ((await response.json()) as FriendsResponse).friends;
        for (const listener of [...listeners]) listener();
      })
      .catch(() => { if (asked === request) asked = ""; });
  }, [enabled, request, ids.length]);
  return useFriends();
}
