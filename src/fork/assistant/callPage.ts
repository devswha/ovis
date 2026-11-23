import { isPiVoice } from "../../../shared/pi-voice.ts";
import { assistantCallCommand, piVoiceLevels, piVoiceState, startPiVoice } from "../voice/piVoiceSession.ts";
import type { CallMirror } from "./callMirror.ts";

const IDLE_MS = 5 * 60_000;

/** The side-button call ends after five quiet minutes, but not while Pi is working or parked. */
function quietCallLimit(): { speech(): void; stop(): void } {
  let lastSpeech = performance.now();
  const timer = setInterval(() => {
    const { status, phase, muted } = piVoiceState();
    const { input, output } = piVoiceLevels();
    const now = performance.now();
    if (status !== "live" || phase !== "listening" || (!muted && input >= 0.3) || output >= 0.015) lastSpeech = now;
    else if (now - lastSpeech >= IDLE_MS) assistantCallCommand("hangup");
  }, 250);
  return { speech: () => { lastSpeech = performance.now(); }, stop: () => clearInterval(timer) };
}

interface AssistantHost {
  postMessage(body: string): void;
  onmessage: ((message: MessageEvent<string>) => void) | null;
}

/** Only the assistant's own WebView installs this object. The regular browser page still boots Ovis. */
export function bootAssistantCall(): boolean {
  const host = (window as Window & { OvisAssistantHost?: AssistantHost }).OvisAssistantHost;
  if (!host) return false;
  const send = (event: string, payload?: object) => host.postMessage(JSON.stringify({ event, ...payload }));
  let idleLimit: ReturnType<typeof quietCallLimit> | undefined;
  const mirror: CallMirror = {
    state: (snapshot) => send("state", { snapshot }),
    notice: (notice) => send("notice", notice),
    muted: (muted) => send("muted", { muted }),
    transcript: () => idleLimit?.speech(),
    release: () => { idleLimit?.stop(); send("release"); },
  };
  host.onmessage = ({ data }) => {
    const { action, target, muted } = JSON.parse(data) as {
      action: string;
      muted?: boolean;
      target?: { machineId: string; paneId: string; label: string; voice?: string };
    };
    if (action === "start" && target) {
      idleLimit = quietCallLimit();
      startPiVoice({ ...target, voice: isPiVoice(target.voice) ? target.voice : undefined }, mirror, muted === true);
    } else assistantCallCommand(action);
  };
  send("ready");
  return true;
}
