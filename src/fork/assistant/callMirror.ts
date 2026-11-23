import { callNative, hasNativePlugin, onNativeEvent } from "../../lib/nativeApp.ts";

export const ASSISTANT_PLUGIN = "OvisAssistant";

export interface CallNotice { title: string; body: string; mute: string; unmute: string }
export interface CallMirror {
  state(snapshot: { status: string; phase: string; muted: boolean; notice?: string; input: number; output: number }): void;
  release(): void;
  // The assistant window has no Capacitor bridge; its native host keeps the same notification.
  notice?(notice: CallNotice): void;
  muted?(muted: boolean): void;
  transcript?(): void;
}

const call = (method: string, options?: Record<string, unknown>) => { void callNative(ASSISTANT_PLUGIN, method, options).catch(() => undefined); };
let listening = false;

/** Claim Android's single microphone/call owner before getting media in this Ovis window. */
export async function claimAppCall(command: (action: string) => void): Promise<CallMirror | null> {
  const { claimed } = await callNative<{ claimed: boolean }>(ASSISTANT_PLUGIN, "claimCall");
  if (!claimed) return null;
  if (!listening) {
    onNativeEvent(ASSISTANT_PLUGIN, "assistantCall", (data) => {
      const action = (data as { action?: unknown } | undefined)?.action;
      if (typeof action === "string") command(action);
    });
    listening = true;
  }
  return { state: (state) => call("callState", state), release: () => call("releaseCall") };
}

export function appCallReady(): void { call("callReady"); }
export function hasAssistantPlugin(): boolean { return hasNativePlugin(ASSISTANT_PLUGIN); }
