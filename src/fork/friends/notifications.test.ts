import { afterEach, beforeEach, expect, it } from "bun:test";
import { notificationState, refreshNotificationState, requestNotificationPermission, showPaneStatusNotification } from "../../lib/notifications.ts";

const originals = new Map<string, PropertyDescriptor | undefined>();
const calls: { method: string; options?: Record<string, unknown> }[] = [];
let permission = "default";
let hidden = true;

beforeEach(() => {
  calls.length = 0;
  permission = "default";
  hidden = true;
  for (const key of ["Capacitor", "Notification", "document"]) originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, "Notification", { configurable: true, value: undefined });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { get hidden() { return hidden; } } });
  Object.defineProperty(globalThis, "Capacitor", { configurable: true, value: {
    isNativePlatform: () => true, getPlatform: () => "android", PluginHeaders: [],
    nativePromise: async (_plugin: string, method: string, options?: Record<string, unknown>) => {
      calls.push({ method, options });
      if (method === "requestAlerts") permission = "granted";
      return { state: permission };
    },
  } });
});
afterEach(() => {
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  originals.clear();
});

it("uses Android's permission and alerts without Web Notifications", async () => {
  expect(await refreshNotificationState()).toBe("default");
  await showPaneStatusNotification("p1", "Pi", "done", undefined, "m1", "w1");
  expect(calls.filter((call) => call.method === "alert")).toHaveLength(0);
  expect(await requestNotificationPermission()).toBe("granted");
  expect(notificationState()).toBe("granted");
  await showPaneStatusNotification("p1", "Pi", "done", undefined, "m1", "w1");
  expect(calls.find((call) => call.method === "alert")?.options).toMatchObject({ title: "Pi", pane_id: "p1", machine_id: "m1", workspace_id: "w1" });
  hidden = false;
  await showPaneStatusNotification("p1", "Pi", "done", undefined, "m1", "w1");
  expect(calls.filter((call) => call.method === "alert")).toHaveLength(1);
  permission = "denied";
  expect(await refreshNotificationState()).toBe("denied");
  expect(notificationState()).toBe("denied");
});
