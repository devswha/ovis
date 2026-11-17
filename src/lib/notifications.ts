import type { AgentStatus } from "../../shared/protocol.ts";
import { ENDED_NOTIFICATION_BODY, paneNotificationTag, statusNotificationBody } from "../../shared/notify-policy.ts";
import { callNative, hasNativePlugin, PUSH_PLUGIN } from "./nativeApp.ts";

/**
 * Tab alerts: Web Notifications for pane status transitions while this page is open
 * but hidden. A device with a push subscription (lib/push.ts) gets the same alerts from
 * the server instead, and App skips these. Notification exists only in secure contexts
 * (https or localhost) - a plain-http LAN deployment reports "unsupported", and the bell
 * there switches only the in-app alerts.
 *
 * The phone app's web view has no Notification either: there the permission is the app's, asked
 * through its push plugin (lib/nativeApp.ts), and the app shows the server's pushes itself.
 */

export { alertPcAllowed, alertStatus, alertsAllow, paneAlertsMuted, shouldNotifyStatus } from "../../shared/notify-policy.ts";

export type NotificationState = "unsupported" | "default" | "granted" | "denied";

let appPermission: NotificationState = "default";
let turns = 0;
let answeredTurn = 0;

export function notificationState(): NotificationState {
  if (hasNativePlugin(PUSH_PLUGIN)) return appPermission;
  if (typeof globalThis.Notification === "undefined") return "unsupported";
  return globalThis.Notification.permission;
}

/**
 * Capacitor's permission states as the app's push plugin answers them; Android's "prompt-with-rationale"
 * may still ask. Resolves to the newest permission known, which an answer that overtook this one set.
 */
async function askApp(method: "checkPermissions" | "requestPermissions"): Promise<NotificationState> {
  const asked = method === "checkPermissions" ? ++turns : 0;
  const { notifications } = await callNative<{ notifications?: string }>(PUSH_PLUGIN, method);
  const turn = method === "requestPermissions" ? ++turns : asked;
  if (turn > answeredTurn) {
    answeredTurn = turn;
    appPermission = notifications === "granted" ? "granted" : notifications === "denied" ? "denied" : "default";
  }
  return appPermission;
}

export async function refreshNotificationState(): Promise<NotificationState> {
  return hasNativePlugin(PUSH_PLUGIN) ? askApp("checkPermissions") : notificationState();
}

export async function requestNotificationPermission(): Promise<NotificationState> {
  if (hasNativePlugin(PUSH_PLUGIN)) return askApp("requestPermissions");
  if (typeof globalThis.Notification === "undefined") return "unsupported";
  const permission = await globalThis.Notification.requestPermission();
  return permission === "granted" ? "granted" : permission === "denied" ? "denied" : "default";
}

/**
 * Shown through the service worker when there is one: Android Chrome has no
 * `new Notification()`, and the worker's notificationclick (public/sw.js) selects the
 * pane. The constructor is the fallback for a page without a worker.
 */
async function show(paneId: string, title: string, body: string, onClick?: () => void, machineId = "local", workspaceId?: string): Promise<void> {
  if (typeof globalThis.Notification === "undefined") return;
  if (globalThis.Notification.permission !== "granted") return;
  if (typeof document !== "undefined" && !document.hidden) return;
  const tag = paneNotificationTag(paneId, machineId);
  const alertId = crypto.randomUUID();
  const options: NotificationOptions = { body, tag, data: { pane_id: paneId, machine_id: machineId, ...(workspaceId ? { workspace_id: workspaceId } : {}), alert_id: alertId }, icon: "/icons/icon-192.png?v=sheep1" };
  try {
    const registration = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
    if (registration?.active) {
      // iOS keeps the pane's earlier alerts despite the tag: close them as a push does (public/sw.js),
      // only the ones up before this alert, so one shown meanwhile stays
      const listed = async (): Promise<Notification[]> => {
        try {
          return await registration.getNotifications({ tag });
        } catch {
          return [];
        }
      };
      const alertIdOf = (alert: Notification) => (alert.data as { alert_id?: string } | null)?.alert_id;
      const earlier = new Set((await listed()).map(alertIdOf));
      await registration.showNotification(title, options);
      for (const alert of earlier.size ? await listed() : []) {
        if (earlier.has(alertIdOf(alert))) alert.close();
      }
      return;
    }
    const notification = new globalThis.Notification(title, options);
    notification.addEventListener("click", () => {
      window.focus();
      onClick?.();
    });
  } catch {
  }
}

export function pageNotifications(): boolean {
  return !hasNativePlugin(PUSH_PLUGIN) && typeof globalThis.Notification !== "undefined";
}

export async function showTestNotification(title: string, body: string): Promise<boolean> {
  if (typeof globalThis.Notification === "undefined" || globalThis.Notification.permission !== "granted") return false;
  const options: NotificationOptions = { body, tag: "ovis-test", icon: "/icons/icon-192.png?v=sheep1" };
  try {
    const registration = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
    if (registration?.active) await registration.showNotification(title, options);
    else new globalThis.Notification(title, options);
    return true;
  } catch {
    return false;
  }
}

export function showPaneStatusNotification(paneId: string, title: string, status: AgentStatus, onClick?: () => void, machineId = "local", workspaceId?: string): Promise<void> {
  return show(paneId, title, statusNotificationBody(status), onClick, machineId, workspaceId);
}

export function showPaneEndedNotification(paneId: string, title: string, onClick?: () => void, machineId = "local", workspaceId?: string): Promise<void> {
  return show(paneId, title, ENDED_NOTIFICATION_BODY, onClick, machineId, workspaceId);
}
