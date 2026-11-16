import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { friendKey, friendPicturePath } from "../../../shared/friends.ts";
import type { Machine } from "../../../shared/machines.ts";
import { paneNotificationTag } from "../../../shared/notify-policy.ts";
import { nativeAlerts, nativeAlertsState, requestNativeAlerts, showNativeAlert } from "../../lib/nativeApp.ts";
import type { NotificationState } from "../../lib/notifications.ts";
import { useSettings } from "../../lib/settings.ts";
import { paneFriend } from "./friends.ts";

let nativeState: NotificationState = "default";
let agentPanes = new Set<string>();
const notificationFriend = (machineId: string, paneId: string) => agentPanes.has(friendKey(machineId, paneId)) ? paneFriend(machineId, paneId) : undefined;
export const forkNotificationState = (): NotificationState => nativeState;
export async function refreshForkNotificationState(): Promise<void> {
  if (nativeAlerts()) nativeState = await nativeAlertsState();
}
export async function requestForkNotificationPermission(): Promise<NotificationState> {
  return nativeState = await requestNativeAlerts();
}
export function forkNotificationIcon(machineId: string, paneId: string): string {
  const friend = notificationFriend(machineId, paneId);
  return friend ? friendPicturePath(friend) : "/icons/icon-192.png?v=sheep1";
}

/** Native taps return through notificationTarget, just like service-worker taps. */
export async function forkAlert(paneId: string, title: string, body: string, machineId: string, workspaceId?: string): Promise<boolean> {
  if (!nativeAlerts()) return false;
  const friend = notificationFriend(machineId, paneId);
  if (nativeState === "granted" && document.hidden) await showNativeAlert({ title, body, tag: paneNotificationTag(paneId, machineId), pane_id: paneId, machine_id: machineId, ...(workspaceId ? { workspace_id: workspaceId } : {}), ...(friend ? { friend } : {}) }).catch(() => {});
  return true;
}

/** A shell without push asks once on load when the saved Alerts switch is on. */
export function useForkNotificationState(notifications: NotificationState, setNotifications: Dispatch<SetStateAction<NotificationState>>, machines: readonly Machine[]): void {
  const { settings: { alertsOn } } = useSettings();
  // Callers used to pass a friend only for a pane still running an agent. An old assignment
  // may survive until /api/friends replies, so keep that eligibility check here too.
  useEffect(() => {
    agentPanes = new Set(machines.flatMap((machine) => machine.snapshot?.panes.filter((pane) => pane.agent).map((pane) => friendKey(machine.id, pane.pane_id)) ?? []));
  }, [machines]);
  const asked = useRef(false);
  useEffect(() => {
    if (!alertsOn || notifications !== "default" || !nativeAlerts() || asked.current) return;
    asked.current = true;
    void requestForkNotificationPermission().then(setNotifications);
  }, [alertsOn, notifications, setNotifications]);
}
