import { useEffect } from "react";
import { LoaderCircle, Pause, Play, Square, Volume2, VolumeX } from "lucide-react";
import { useT } from "../lib/i18n.ts";
import { useSettings } from "../lib/settings.ts";
import { speak, stopSpeech, toggleSpeechPause, useSpeechStatus } from "./speech.ts";

/** Optional, device-local playback. Disabling the setting also stops any current reply. */
export function SpeakButton({ id, text }: { id: string; text: string }) {
  const t = useT();
  const { settings } = useSettings();
  const status = useSpeechStatus(id);
  useEffect(() => { if (!settings.readAloud) stopSpeech(); }, [settings.readAloud]);
  const started = status === "playing" || status === "paused";
  const busy = started || status === "loading";
  const label = status === "loading" ? t("Preparing the voice…") : status === "playing" ? t("Pause reading") : status === "paused" ? t("Resume reading") : status === "failed" ? t("Couldn't read this aloud. Tap to try again.") : t("Read aloud");
  const tap = () => (started ? toggleSpeechPause() : status === "loading" ? stopSpeech() : speak(id, text, settings.speechVoice));
  if (!settings.readAloud) return null;
  return <>
    <button type="button" className={busy ? "chat-meta-btn chat-speak is-active" : "chat-meta-btn chat-speak"} aria-label={label} title={label} aria-pressed={busy} onClick={tap}>
      {status === "loading" ? <LoaderCircle className="chat-speak-progress" aria-hidden="true" /> : status === "playing" ? <Pause aria-hidden="true" /> : status === "paused" ? <Play aria-hidden="true" /> : status === "failed" ? <VolumeX aria-hidden="true" /> : <Volume2 aria-hidden="true" />}
    </button>
    {started && <button type="button" className="chat-meta-btn chat-speak" aria-label={t("Stop reading")} title={t("Stop reading")} onClick={stopSpeech}><Square aria-hidden="true" /></button>}
  </>;
}
