import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { recordConfirmation } from "./pushConfirm.ts";
import type { AlertPrefs } from "../../shared/notify-policy.ts";
import type { Settings } from "./settings.ts";
import { ApiError, sendTestPush } from "./api.ts";
import { notificationState, refreshNotificationState, requestNotificationPermission, type NotificationState } from "./notifications.ts";
import { ensurePushSubscription, pushSupported, registeredPushEndpoint, removePushSubscription } from "./push.ts";
import { refreshPushHealth, resetPushHealth, runPushAction, type PushActionOutcome, type PushActionResult } from "./pushHealth.ts";
import { hasNativePlugin, PUSH_PLUGIN } from "./nativeApp.ts";

export function subscribeFailure(error: unknown): PushActionResult {
  if (error instanceof ApiError) return error.code === "subscription_gone" ? "gone" : "unregistered";
  return error instanceof TypeError ? "unregistered" : "refused";
}

export function repairOutcome(result: PushActionResult): PushActionOutcome {
  return result === "sent" ? { result, endpoint: registeredPushEndpoint() } : { result };
}

export function useNotificationState() {
  const [notifications, setNotifications] = useState<NotificationState>(() => notificationState());
  useEffect(() => {
    const native = hasNativePlugin(PUSH_PLUGIN);
    let current = true;
    const taken = (): void => {
      const next = notificationState();
      setNotifications((known) => next !== "granted" ? next : known === "denied" ? "default" : known);
    };
    const read = () => {
      if (!native) { taken(); return; }
      refreshNotificationState().then(() => { if (current) setNotifications(notificationState()); }, (err) => console.warn("could not read the notification permission", err));
    };
    const onVisible = () => { if (document.visibilityState === "visible") read(); };
    if (native) read();
    document.addEventListener("visibilitychange", onVisible);
    let permissionStatus: PermissionStatus | null = null;
    if (!native && typeof navigator !== "undefined" && navigator.permissions?.query) {
      try {
        navigator.permissions.query({ name: "notifications" }).then((status) => {
          if (!current) return;
          permissionStatus = status;
          status.addEventListener("change", taken);
        }, () => { });
      } catch { }
    }
    return () => {
      current = false;
      permissionStatus?.removeEventListener("change", taken);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  const [pushOn, setPushOn] = useState(false);
  const pushOnRef = useRef(pushOn);
  pushOnRef.current = pushOn;
  return { notifications, setNotifications, pushOn, setPushOn, pushOnRef };
}

export interface NotificationSwitchParams {
  updateSettings: (patch: Partial<Settings>) => void;
  locked: boolean | null;
  notifications: NotificationState;
  setNotifications: Dispatch<SetStateAction<NotificationState>>;
  alerts: AlertPrefs;
  alertsRef: RefObject<AlertPrefs>;
  alertsOn: boolean;
  setPushOn: Dispatch<SetStateAction<boolean>>;
}

export function useNotificationSwitch({ updateSettings, locked, notifications, setNotifications, alerts, alertsRef, alertsOn, setPushOn }: NotificationSwitchParams) {
  const alertsOnRef = useRef(alertsOn);
  alertsOnRef.current = alertsOn;
  const enableNotifications = useCallback(async (): Promise<PushActionResult> => {
    updateSettings({ alertsOn: true });
    const current = notificationState();
    const next = current === "default" ? await requestNotificationPermission() : current;
    setNotifications(next);
    if (next !== "granted") return "permission";
    try {
      let endpoint: string | null;
      try {
        endpoint = await ensurePushSubscription(alertsRef.current);
      } catch (err) {
        console.warn("web push unavailable, alerts stay tab-only", err);
        return subscribeFailure(err);
      }
      setPushOn(endpoint !== null);
      if (endpoint === null) return pushSupported() ? "no-worker" : "unsupported";
      try {
        await sendTestPush(endpoint);
        recordConfirmation(endpoint, true);
      } catch (err) {
        recordConfirmation(endpoint, false);
        console.warn("the confirmation push failed", err);
        return "failed";
      }
      return "sent";
    } finally {
      void refreshPushHealth(alertsOnRef.current);
    }
  }, [updateSettings]);

  // The browser's permission cannot be taken back from the page: turning alerts off drops
  // this device's push subscription (the server forgets it) and silences the tab's own.
  const disableNotifications = useCallback(async () => {
    updateSettings({ alertsOn: false });
    setPushOn(false);
    resetPushHealth();
    await removePushSubscription().catch((err) => console.warn("could not drop the push subscription", err));
  }, [updateSettings]);

  const repairNotifications = useCallback(() => {
    void runPushAction("repair", async () => repairOutcome(await enableNotifications()), () => alertsOnRef.current);
  }, [enableNotifications]);

  useEffect(() => {
    if (locked !== false || alertsOn || !hasNativePlugin(PUSH_PLUGIN)) return;
    const retry = () => {
      if (alertsOnRef.current) return;
      removePushSubscription().catch((err) => console.warn("could not drop the push subscription", err));
    };
    const onVisible = () => { if (document.visibilityState === "visible") retry(); };
    retry();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [locked, alertsOn]);

  useEffect(() => {
    if (locked !== false || !alertsOn) return;
    if (notifications !== "granted" || !pushSupported()) {
      void refreshPushHealth(true);
      return;
    }
    let cancelled = false;
    ensurePushSubscription(alerts)
      .then((endpoint) => {
        if (!cancelled) setPushOn(endpoint !== null);
      })
      .catch(() => {
        if (!cancelled) setPushOn(false);
      })
      .finally(() => {
        if (!cancelled) void refreshPushHealth(true);
      });
    return () => {
      cancelled = true;
    };
  }, [locked, notifications, alerts, alertsOn]);

  useEffect(() => {
    if (locked !== false || !alertsOn) return;
    const onVisible = (): void => {
      if (document.visibilityState === "visible" && alertsOnRef.current) void refreshPushHealth(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [locked, alertsOn]);
  return { enableNotifications, disableNotifications, repairNotifications };
}
