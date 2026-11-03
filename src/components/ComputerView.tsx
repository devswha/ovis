import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Maximize2, Minimize2, Settings2 } from "lucide-react";
import { t } from "../lib/i18n.ts";
import { NO_STICKY_MODIFIERS, hasModifiers, type StickyModifiers } from "../lib/keys.ts";
import type { KeyBarKeyItem } from "../lib/keyBar.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { usePageVisible } from "../lib/visibility.ts";
import { useSettings } from "../lib/settings.ts";
import { keepComputerLogin, readComputerLogin, useComputerSettings, viewerOptions, type ComputerSettings } from "../lib/computerSettings.ts";
import { KeyBar } from "./KeyBar.tsx";
import { SettingsRow, Segmented, Toggle } from "./SettingsControls.tsx";
import "./ComputerView.css";

// src: the viewer's address, on this server or the PC's own (server/screen.ts), which then is another origin
type Screen = { src: string; origin: string } | { error: string } | null;

// The keyboard field always holds these, so Gboard's ⌫ has something to delete when nothing is typed yet.
const PAD = "        ";
// keys a hardware keyboard presses in the field that type nothing there
const KEYS = new Set(["Escape", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Delete", "Insert",
  "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12"]);

/**
 * The Computer view: the PC's desktop, live, over the pane's Chat or Terminal, which stay connected
 * under it. The server opens screen-here's bridge to that PC (server/screen.ts) and passes on its
 * viewer, which carries the desktop, its sound and a login when the PC asks for one. On a touch
 * screen the viewer works as a trackpad, and the Terminal's key bar and the phone's keyboard type
 * into the desktop through it. Its settings (computerSettings.ts) change the view live. `hidden`
 * keeps it connected out of sight.
 */
export function ComputerView({ machineId, machineName, hidden }: { machineId: string; machineName: string; hidden: boolean }) {
  const [screen, setScreen] = useState<Screen>(null);
  const [full, setFull] = useState(false);
  const [tuning, setTuning] = useState(false);
  // whether the PC's desktop follows the view's size, as the viewer says once it has loaded
  const [resizes, setResizes] = useState(false);
  // the round trip to the PC, in ms, as a viewer served by the PC itself measures it
  const [rtt, setRtt] = useState<number | null>(null);
  const originRef = useRef(location.origin);
  const [computer, setComputer] = useComputerSettings(machineId);
  const computerRef = useRef(computer);
  computerRef.current = computer;
  const tuningRef = useRef<HTMLDivElement | null>(null);
  const [typing, setTyping] = useState(false);
  // out of sight: under another view, or the whole page in the background (a phone's screen off), where the viewer stays quiet too
  const pageVisible = usePageVisible();
  const away = hidden || !pageVisible;
  const awayRef = useRef(away);
  awayRef.current = away;
  const [modifiers, setModifiers] = useState<StickyModifiers>(NO_STICKY_MODIFIERS);
  const modifiersRef = useRef(modifiers);
  modifiersRef.current = modifiers;
  const viewRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  const typedRef = useRef(PAD);
  const composingRef = useRef(false);
  const coarse = useMediaQuery("(pointer: coarse)");
  const { settings } = useSettings();

  useEffect(() => {
    let live = true;
    setScreen(null);
    setRtt(null);
    void fetch("/api/screen", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ machine_id: machineId }), credentials: "same-origin" })
      .then(async (response) => {
        const body = await response.json().catch(() => null) as { path?: string; url?: string; error?: { message?: string } } | null;
        if (!live) return;
        // the settings as they are now go in the address, with this page's origin, which only may talk to the viewer;
        // a change after goes to the loaded page (below)
        const options = encodeURIComponent(JSON.stringify({ ...viewerOptions(computerRef.current), parent: location.origin }));
        const address = response.ok ? body?.url ?? body?.path : undefined;
        if (!address) {
          setScreen({ error: body?.error?.message ?? t("This PC's desktop can't be shown.") });
          return;
        }
        const origin = new URL(address, location.href).origin;
        originRef.current = origin;
        setScreen({ src: `${address}#${options}`, origin });
      })
      .catch(() => { if (live) setScreen({ error: t("This PC's desktop can't be shown.") }); });
    return () => { live = false; };
  }, [machineId]);

  const post = useCallback((message: object) => frameRef.current?.contentWindow?.postMessage(message, originRef.current), []);
  /** One key to the desktop, with the held modifiers, which a key without its own chord then lets go of. */
  const send = useCallback((key: string, own?: StickyModifiers) => {
    post({ screen: "key", key, modifiers: own ?? modifiersRef.current });
    if (own === undefined && hasModifiers(modifiersRef.current)) setModifiers(NO_STICKY_MODIFIERS);
  }, [post]);

  useEffect(() => { post({ screen: "shown", shown: !away }); }, [away, post]);
  useEffect(() => {
    if (!hidden) return;
    fieldRef.current?.blur();
    setFull(false);
    setTuning(false);
  }, [hidden]);

  useEffect(() => post({ screen: "options", options: viewerOptions(computer) }), [computer, post]);
  useEffect(() => {
    const ready = ({ source, origin, data }: MessageEvent): void => {
      if (source !== frameRef.current?.contentWindow || origin !== originRef.current) return;
      if (data?.screen === "rtt" && typeof data.ms === "number") setRtt(data.ms);
      // a login the PC accepted, kept here, or one it refused (null), forgotten
      if (data?.screen === "login") keepComputerLogin(machineId, data.login ?? null);
      if (data?.screen !== "ready") return;
      setResizes(data.resizes === true);
      const login = readComputerLogin(machineId);
      if (login) post({ screen: "login", login });
      // the frame's load comes before the viewer listens: it hears whether it is hidden, and stays quiet, only now
      post({ screen: "shown", shown: !awayRef.current });
    };
    addEventListener("message", ready);
    return () => removeEventListener("message", ready);
  }, [machineId, post]);
  // The settings close on a press outside them; one on the desktop lands in its page, which this one hears as a blur
  useEffect(() => {
    if (!tuning) return;
    const outside = (event: PointerEvent): void => { if (!tuningRef.current?.contains(event.target as Node)) setTuning(false); };
    const away = (): void => setTuning(false);
    document.addEventListener("pointerdown", outside);
    addEventListener("blur", away);
    return () => {
      document.removeEventListener("pointerdown", outside);
      removeEventListener("blur", away);
    };
  }, [tuning]);

  // Full screen: the view covers the page, and the browser's own full screen hides the phone's bars where it may
  useEffect(() => {
    const view = viewRef.current;
    if (full) void view?.requestFullscreen?.().catch(() => {});
    else if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    const left = (): void => { if (!document.fullscreenElement) setFull(false); };
    document.addEventListener("fullscreenchange", left);
    return () => document.removeEventListener("fullscreenchange", left);
  }, [full]);

  // Sends what the keyboard changed in the field: ⌫ for each character it took back, then what it added.
  const typed = (event: FormEvent<HTMLTextAreaElement>): void => {
    const field = event.currentTarget;
    const before = [...typedRef.current];
    const after = [...field.value];
    let same = 0;
    while (same < before.length && same < after.length && before[same] === after[same]) same++;
    for (let index = same; index < before.length; index++) send("Backspace");
    for (const character of after.slice(same)) send(character === "\n" ? "Enter" : character);
    typedRef.current = field.value;
    if (!composingRef.current) refill(field);
  };
  // Back to just the padding once the padding is eaten into or a line is done, while no word is being composed
  const refill = (field: HTMLTextAreaElement): void => {
    if (field.value.startsWith(PAD) && !field.value.includes("\n") && field.value.length < 64) return;
    field.value = PAD;
    typedRef.current = PAD;
  };
  const pressed = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (composingRef.current || !KEYS.has(event.key)) return;
    event.preventDefault();
    send(event.key);
  };

  if (screen === null || "error" in screen) {
    return <div className={`computer-view is-message${hidden ? " is-hidden" : ""}`} role={screen ? "alert" : undefined}>{screen?.error ?? t("Connecting…")}</div>;
  }
  return (
    <div ref={viewRef} className={`computer-view${full ? " is-full" : ""}${hidden ? " is-hidden" : ""}`}>
      <div className="computer-view-desktop">
        <iframe ref={frameRef} src={screen.src} title={t("{name}'s desktop", { name: machineName })} allow="autoplay; clipboard-read; clipboard-write"
          onLoad={() => post({ screen: "shown", shown: !away })} />
        <div ref={tuningRef} className="computer-view-corner" onKeyDown={(event) => { if (event.key === "Escape" && tuning) { event.stopPropagation(); setTuning(false); } }}>
          <button type="button" className="computer-view-button" aria-label={t("View settings")} title={t("View settings")} aria-expanded={tuning}
            onClick={() => setTuning((value) => !value)}>
            <Settings2 aria-hidden="true" />
          </button>
          <button type="button" className="computer-view-button" aria-label={t(full ? "Exit full screen" : "Full screen")} title={t(full ? "Exit full screen" : "Full screen")}
            onClick={() => setFull((value) => !value)}>
            {full ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
          </button>
          {tuning && <ViewSettings settings={computer} onChange={setComputer} resizes={resizes} touch={coarse} rtt={rtt} />}
        </div>
      </div>
      {coarse && <>
        <textarea ref={fieldRef} className="computer-view-field" defaultValue={PAD} aria-label={t("Type on {name}", { name: machineName })}
          autoCapitalize="off" autoComplete="off" autoCorrect="off" spellCheck={false} enterKeyHint="enter"
          onFocus={() => { setTyping(true); post({ screen: "keyboard", open: true }); }}
          onBlur={() => { setTyping(false); post({ screen: "keyboard", open: false }); }} onInput={typed} onKeyDown={pressed}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={(event) => { composingRef.current = false; refill(event.currentTarget); }} />
        <KeyBar items={settings.keyBarItems} modifiers={modifiers}
          // Super tapped again while held is Super on its own: the desktop's app menu
          onToggleModifier={(modifier) => {
            if (modifier !== "super" || !modifiers.super) { setModifiers((held) => ({ ...held, [modifier]: !held[modifier] })); return; }
            send("Super", NO_STICKY_MODIFIERS);
            setModifiers(NO_STICKY_MODIFIERS);
          }}
          onKey={(item: KeyBarKeyItem) => send(item.key, item.modifiers)}
          keyboardOwner={`computer:${machineId}`}
          onToggleKeyboard={() => { if (typing) fieldRef.current?.blur(); else fieldRef.current?.focus(); }} />
      </>}
    </div>
  );
}

/** The Computer view's settings for this PC, on this device. */
function ViewSettings({ settings, onChange, resizes, touch, rtt }: { settings: ComputerSettings; onChange: (patch: Partial<ComputerSettings>) => void; resizes: boolean; touch: boolean; rtt: number | null }) {
  return (
    <div className="computer-view-settings" role="dialog" aria-label={t("View settings")}>
      <header className="computer-view-settings-head">{t("View on this device")}</header>
      <div className="settings-card">
        {resizes && <SettingsRow label={t("Fit")} wide>
          <Segmented label={t("Fit")} value={settings.fit} onChange={(fit) => onChange({ fit })}
            options={[{ value: "resize", label: t("Resize the PC") }, { value: "scale", label: t("Keep its size") }]} />
        </SettingsRow>}
        {resizes && settings.fit === "resize" && <SettingsRow label={t("Sharpness")} wide>
          <Segmented label={t("Sharpness")} value={settings.sharpness} onChange={(sharpness) => onChange({ sharpness })}
            options={[{ value: "1", label: "1×" }, { value: "1.5", label: "1.5×" }, { value: "2", label: "2×" }]} />
        </SettingsRow>}
        {resizes && settings.fit === "resize" && <SettingsRow label={t("Zoom")} description={t("Smaller shows more of the PC")} wide>
          <Segmented label={t("Zoom")} value={settings.zoom} onChange={(zoom) => onChange({ zoom })}
            options={[{ value: "100", label: "100%" }, { value: "75", label: "75%" }, { value: "50", label: "50%" }]} />
        </SettingsRow>}
        <SettingsRow label={t("Quality")} wide>
          <Segmented label={t("Quality")} value={settings.quality} onChange={(quality) => onChange({ quality })}
            options={[{ value: "low", label: t("Low") }, { value: "medium", label: t("Medium") }, { value: "high", label: t("High") }]} />
        </SettingsRow>
        {touch && <SettingsRow label={t("Touch")} wide>
          <Segmented label={t("Touch")} value={settings.cursor} onChange={(cursor) => onChange({ cursor })}
            options={[{ value: "trackpad", label: t("Trackpad") }, { value: "direct", label: t("Tap to click") }]} />
        </SettingsRow>}
        {touch && settings.cursor === "trackpad" && <SettingsRow label={t("Trackpad speed")} wide>
          <Segmented label={t("Trackpad speed")} value={settings.speed} onChange={(speed) => onChange({ speed })}
            options={[{ value: "slow", label: t("Slow") }, { value: "normal", label: t("Normal") }, { value: "fast", label: t("Fast") }]} />
        </SettingsRow>}
        <SettingsRow label={t("Keep connected")} description={t("After you switch to Chat or Terminal")} wide>
          <Segmented label={t("Keep connected")} value={settings.keep} onChange={(keep) => onChange({ keep })}
            options={[{ value: "0", label: t("Off") }, { value: "2", label: t("2 min") }, { value: "5", label: t("5 min") }, { value: "10", label: t("10 min") }]} />
        </SettingsRow>
        <SettingsRow label={t("Sound")}>
          <Toggle label={t("Sound")} checked={settings.sound} onChange={(sound) => onChange({ sound })} />
        </SettingsRow>
        {rtt !== null && <SettingsRow label={t("Round trip")} description={t("From this device to the PC")}>
          <span className="computer-view-rtt">{t("{ms} ms", { ms: rtt })}</span>
        </SettingsRow>}
      </div>
    </div>
  );
}
