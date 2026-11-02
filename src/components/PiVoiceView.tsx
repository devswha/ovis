import { Hourglass, Mic, MicOff, PhoneOff } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";

import { useT } from "../lib/i18n.ts";
import { storedOrbPlace, useOrbPlacement, type OrbPlace } from "../lib/orbPlace.ts";
import { endPiVoice, formatPiVoiceTime, piVoiceLevels, resumePiVoice, setPiVoiceMuted, usePiVoice, type PiVoiceEnd, type PiVoiceState } from "../lib/piVoiceSession.ts";
import { VoiceOrb } from "./VoiceOrb.tsx";
import "./PiVoiceView.css";

/**
 * The live voice call with a Pi pane: a small orb that floats over the app, after Android's chat
 * bubbles and Messenger's chat heads. A drag carries it anywhere and it snaps to the nearer side,
 * where this device keeps it; a tap slides out Mute and End, which tuck away again on their own.
 * The call stays on the pane it started in whatever is selected (piVoiceSession.ts); once it has
 * stopped, the orb dims and says why for a moment. While Pi has parked the call for a long task the
 * orb sleeps, dim, with End in reach and a note that the voice returns with the result; a tap on
 * it asks for the voice back now. The controls show the time the call has billed.
 * Mounted once in App.
 */
export function PiVoiceView() {
  const voice = usePiVoice();
  const shown = voice.status !== "idle";
  const leaving = useOrbExit(shown, voice);
  if (shown) return <PiVoiceFloat voice={voice} />;
  return leaving ? <PiVoiceFloat voice={leaving} leaving /> : null;
}

/** How long the orb takes to shrink away once the call is put away: the agents app's exit wait. */
const ORB_EXIT_MS = 280;

/** The call as the orb last showed it, for the moment it shrinks away after End. */
function useOrbExit(shown: boolean, voice: PiVoiceState): PiVoiceState | null {
  const last = useRef<PiVoiceState | null>(null);
  const [leaving, setLeaving] = useState<PiVoiceState | null>(null);
  useLayoutEffect(() => {
    if (shown) last.current = voice;
  });
  useLayoutEffect(() => {
    if (shown) {
      setLeaving(null);
      return;
    }
    const was = last.current;
    last.current = null;
    if (!was) return;
    setLeaving(was);
    const timer = setTimeout(() => setLeaving(null), ORB_EXIT_MS);
    return () => clearTimeout(timer);
  }, [shown]); // eslint-disable-line react-hooks/exhaustive-deps
  return leaving;
}

/** How long the opened Mute and End wait untouched before they tuck away again. */
const CONTROLS_IDLE_MS = 4000;

export function PiVoiceFloat({ voice, leaving = false }: { voice: PiVoiceState; leaving?: boolean }) {
  const t = useT();
  const controlsId = useId();
  const [place, setPlace] = useState<OrbPlace>(storedOrbPlace);
  const [open, setOpen] = useState(false);
  const surface = useRef<HTMLDivElement>(null);
  const orb = useRef<HTMLButtonElement>(null);
  useOrbPlacement(orb, surface, setPlace);
  useControlsTuck(open, surface, setOpen);
  const ended = voice.status === "ended";
  const parked = voice.status === "live" && voice.phase === "parked";
  // the call keeps its own pane whatever is selected, so the orb says which one that is
  const orbName = parked ? t("Talk now") : t("Call controls");
  const callName = voice.label ? `${orbName} · ${voice.label}` : orbName;
  // the controls open away from the nearer edge, so neither they nor the orb leave the screen
  const classes = ["pi-voice-float", `is-${place.side}`, place.y > 0.5 ? "opens-up" : "opens-down", open && "is-open",
    ended && "is-ended", parked && "is-parked", voice.muted && "is-muted", !leaving && "is-entering", leaving && "is-leaving"].filter(Boolean).join(" ");
  return (
    <div className={classes} ref={surface} role="group" aria-label={t("Live voice")} aria-hidden={leaving || undefined}
      style={{ "--pi-voice-y": place.y } as CSSProperties}>
      <span className="visually-hidden" aria-live="polite">{ended || parked ? "" : phaseText(voice, t)}</span>
      <button type="button" className={`pi-voice-float-orb is-${voice.phase}`} ref={orb} aria-label={callName}
        title={callName} aria-expanded={parked ? undefined : open} aria-controls={parked ? undefined : controlsId}
        onClick={parked ? resumePiVoice : () => setOpen((now) => !now)}>
        <VoiceOrb phase={ended ? "ended" : voice.phase} levels={piVoiceLevels} />
        {parked
          ? <span className="pi-voice-float-badge" aria-hidden="true"><Hourglass /></span>
          : voice.muted && <span className="pi-voice-float-badge" aria-hidden="true"><MicOff /></span>}
      </button>
      <div className="pi-voice-float-controls" id={controlsId} inert={!open && !parked}>
        {voice.usage !== null && <span className="pi-voice-float-usage" role="timer" aria-label={t("Voice time used")} title={t("Voice time used")}>{formatPiVoiceTime(voice.usage)}</span>}
        {!parked && (
          <button type="button" className="pi-voice-button" aria-pressed={voice.muted} aria-label={voice.muted ? t("Unmute") : t("Mute")}
            title={voice.muted ? t("Unmute") : t("Mute")} disabled={voice.status !== "live"} onClick={() => setPiVoiceMuted(!voice.muted)}>
            {voice.muted ? <MicOff aria-hidden="true" /> : <Mic aria-hidden="true" />}
          </button>
        )}
        <button type="button" className="pi-voice-button is-end" aria-label={t("End call")} title={t("End call")} onClick={endPiVoice}>
          <PhoneOff aria-hidden="true" />
        </button>
      </div>
      {parked && <p className="pi-voice-float-note is-lasting" role="status">{t("Task running. The voice returns with the result.")}</p>}
      {/* keyed by what it says, so a new reason shows again before it fades */}
      {ended && voice.end && <p key={endText(voice.end, t)} className="pi-voice-float-note" role="alert">{endText(voice.end, t)}</p>}
    </div>
  );
}

/** Opened controls tuck away after a while untouched, on a press outside the orb, or on Escape. */
function useControlsTuck(open: boolean, surface: RefObject<HTMLElement | null>, setOpen: (open: boolean) => void) {
  useEffect(() => {
    if (!open) return;
    let timer = setTimeout(() => setOpen(false), CONTROLS_IDLE_MS);
    const touched = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setOpen(false), CONTROLS_IDLE_MS);
    };
    const outside = (event: PointerEvent) => {
      if (!surface.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const node = surface.current;
    node?.addEventListener("pointerdown", touched);
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape);
    return () => {
      clearTimeout(timer);
      node?.removeEventListener("pointerdown", touched);
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape);
    };
  }, [open, surface, setOpen]);
}

function phaseText(voice: PiVoiceState, t: ReturnType<typeof useT>): string {
  if (voice.status === "starting") return t("Connecting…");
  switch (voice.phase) {
    case "listening": return t("Listening");
    case "working": return t("Working on it");
    case "speaking": return t("Speaking");
    case "muted": return t("Muted");
    default: return t("Connecting…");
  }
}

function endText(end: PiVoiceEnd, t: ReturnType<typeof useT>): string {
  switch (end.kind) {
    case "error": return end.message;
    case "denied": return t("Microphone access was denied.");
    case "no_mic": return t("No microphone found");
    case "unsupported": return t("This browser cannot make a voice call.");
    case "failed": return t("The call stopped working.");
    case "not_pi": return t("This pane is not running Pi.");
    case "unavailable": return t("Pi did not answer in this pane. Run /reload in Pi and try again.");
    case "busy": return t("A call is already on in this pane.");
    default: return t("The call was cut off.");
  }
}
