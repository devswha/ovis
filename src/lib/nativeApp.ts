/**
 * The iOS app (app/) opens this client as its WebView's first page and puts Capacitor's bridge
 * on it. Only what the client needs of the app is here, through `window.Capacitor` as the app
 * injects it, so the browser build carries no Capacitor code.
 */
import type { Friend } from "../../shared/friends.ts";
interface CapacitorBridge {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  nativePromise?: (plugin: string, method: string, options?: Record<string, unknown>) => Promise<unknown>;
  nativeCallback?: (plugin: string, method: string, options: Record<string, unknown>, callback: (data: unknown) => void) => string;
  /** the app's native plugins, announced to the page before its first script runs */
  PluginHeaders?: ReadonlyArray<{ name?: unknown }>;
}

export const PUSH_PLUGIN = "OvisPush";

function bridge(): CapacitorBridge | undefined {
  return (globalThis as { Capacitor?: CapacitorBridge }).Capacitor;
}

export function inNativeApp(): boolean {
  return bridge()?.isNativePlatform?.() === true;
}

export function inMacApp(): boolean {
  return typeof navigator !== "undefined" && /\bOvisMac\//.test(navigator.userAgent);
}

/** Whether this page runs inside the Android app, whose WebView draws no menu of its own for a long-pressed link. */
export function inAndroidApp(): boolean {
  return inNativeApp() && bridge()?.getPlatform?.() === "android";
}

/**
 * Whether the app around this page has the native plugin `name`. An app built before the plugin
 * existed has not, and on iOS a call to a plugin the app lacks never settles.
 */
export function hasNativePlugin(name: string): boolean {
  return inNativeApp() && (bridge()?.PluginHeaders ?? []).some((header) => header.name === name);
}

/** Calls `method` of the app's plugin `plugin`; a refusal rejects with the plugin's `code` on the error. */
export async function callNative<T>(plugin: string, method: string, options: Record<string, unknown> = {}): Promise<T> {
  const call = bridge()?.nativePromise;
  if (!call) throw new Error(`this page has no ${plugin} plugin`);
  return await call(plugin, method, options) as T;
}

export function onNativeEvent(plugin: string, eventName: string, listener: (data: unknown) => void): void {
  bridge()?.nativeCallback?.(plugin, "addListener", { eventName }, listener);
}

export async function changePc(): Promise<void> {
  await bridge()?.nativePromise?.("HerdrShell", "disconnect", {});
}

/**
 * The Android app makes a live call Android's own phone call (TelecomCall.java), which silences the
 * WebView's media sound: the reply plays as the call's sound instead, never through Web Audio.
 */
export function nativeCallAudio(): boolean {
  return inAndroidApp();
}

/**
 * The Android app shows alerts itself (HerdrShellPlugin.java): its WebView has no Web Notifications.
 * An app built with the push plugin gets them by push instead.
 */
export function nativeAlerts(): boolean {
  return inAndroidApp() && !hasNativePlugin(PUSH_PLUGIN);
}

/**
 * Android stops a hidden app's microphone: the Android app keeps a live call going out of sight
 * under an ongoing notification (LiveCallService.java). An app without it stays as it was.
 */
export function nativeLiveCall(notice: { title: string; body: string; mute: string; unmute: string } | null): void {
  if (!inAndroidApp()) return;
  const answer = bridge()?.nativePromise?.("HerdrShell", notice ? "liveCallStarted" : "liveCallEnded", notice ?? {});
  void answer?.catch(() => undefined);
}

/** The call's notification shows Mute or Unmute as the call is. */
export function nativeLiveCallMuted(muted: boolean): void {
  if (!inAndroidApp()) return;
  void bridge()?.nativePromise?.("HerdrShell", "liveCallMuted", { muted })?.catch(() => undefined);
}

let liveCallActions = false;

/** Hang up or Mute tapped on the call's notification, the lock screen's included. Listens once. */
export function onNativeLiveCallAction(act: (action: "hangup" | "mute") => void): void {
  if (liveCallActions || !inAndroidApp() || !bridge()?.nativeCallback) return;
  liveCallActions = true;
  onNativeEvent("HerdrShell", "liveCallAction", (data) => {
    const action = (data as { action?: string } | undefined)?.action;
    if (action === "hangup" || action === "mute") act(action);
  });
}

export type NativeAlertsState = "granted" | "denied" | "default";

async function alertsCall(method: "alertsState" | "requestAlerts"): Promise<NativeAlertsState> {
  const answer = await bridge()?.nativePromise?.("HerdrShell", method, {}) as { state?: string } | undefined;
  return answer?.state === "granted" ? "granted" : answer?.state === "denied" ? "denied" : "default";
}

export const nativeAlertsState = (): Promise<NativeAlertsState> => alertsCall("alertsState");
export const requestNativeAlerts = (): Promise<NativeAlertsState> => alertsCall("requestAlerts");

/** `friend`: the pane's workspace's friend, the notification's picture (HerdrShellPlugin.alert). */
export interface NativeAlert { title: string; body: string; tag: string; pane_id: string; machine_id: string; workspace_id?: string; friend?: Friend }

export async function showNativeAlert(alert: NativeAlert): Promise<void> {
  await bridge()?.nativePromise?.("HerdrShell", "alert", { ...alert });
}

/** A tapped native alert as public/sw.js posts a tapped notification: a `select-pane` message (lib/notificationTarget.ts). */
export function nativeAlertTaps(): { addEventListener: (type: string, listener: (event: Event) => void) => void } | undefined {
  const callback = bridge()?.nativeCallback;
  if (!nativeAlerts() || !callback) return undefined;
  return {
    addEventListener: (_type, listener) => {
      onNativeEvent("HerdrShell", "alertTap", (data) => {
        listener(new MessageEvent("message", { data: { ...(data as object), type: "select-pane", view: "chat" } }));
      });
    },
  };
}
