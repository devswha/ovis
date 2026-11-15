import { isPiVoice, PI_VOICES } from "../../shared/pi-voice.ts";
import { SPEECH_VOICES, type SpeechVoice } from "../../shared/speech.ts";
import { useT } from "../lib/i18n.ts";
import { useSettings } from "../lib/settings.ts";
import { SettingsGroup, SettingsRow, SettingsSelect, Toggle } from "../components/SettingsControls.tsx";

/** Settings rows only this fork has, kept apart from SettingsDialog.tsx. */
export function ForkFeatures() {
  const { settings, update } = useSettings();
  const t = useT();
  const choices = [
    ["squareCorners", t("Square corners")],
    ["moreViewToggle", t("View toggle in More")],
    ["agentNamedTabs", t("Agent names on tabs")],
    ["agentFriends", t("Agent friends")],
    ["composerExtras", t("Composer extras")],
    ["compactWorkRuns", t("Compact work runs")],
    ["chatMotion", t("Animated replies")],
    ["piLiveVoice", t("Pi live voice")],
    ["computerView", t("Computer view")],
    ["pullRequests", t("Pull requests")],
    ["readAloud", t("Read aloud")],
    ["steadyKeyboardTabs", t("Keep tabs while keyboard opens")],
  ] as const;
  return <SettingsGroup title={t("Fork features")} section="fork-features">
    {choices.map(([key, label]) => <SettingsRow key={key} label={label} reset={[key]}>
      <Toggle label={label} checked={settings[key]} onChange={(checked) => update({ [key]: checked })} />
    </SettingsRow>)}
  </SettingsGroup>;
}

/**
 * Settings → Appearance → Follow Omarchy: offered on a device whose theme-set hook sent its Omarchy
 * theme (lib/omarchyTheme.ts), and kept while it is on, so it can be turned off again.
 */
export function OmarchyRow() {
  const { settings, omarchyTheme, update } = useSettings();
  const t = useT();
  if (omarchyTheme === null && !settings.followOmarchy) return null;
  // as `omarchy theme current` names it: "catppuccin-latte" is Catppuccin Latte
  const name = omarchyTheme?.name.replace(/(^|-)([a-z])/g, (_, dash: string, letter: string) => `${dash}${letter.toUpperCase()}`).replace(/-/g, " ") ?? "";
  const description = omarchyTheme === null
    ? t("This device has not sent its Omarchy theme. Its theme-set hook (scripts/omarchy-theme-hook.sh) sends it whenever the theme changes.")
    : t("Draws this device in its Omarchy theme, {name}, and changes with it. Only on this device: the themes above stay for the others.", { name });
  return (
    <SettingsRow label={t("Follow Omarchy")} description={description}>
      <Toggle label={t("Follow Omarchy")} checked={settings.followOmarchy} onChange={(followOmarchy) => update({ followOmarchy })} />
    </SettingsRow>
  );
}

export function ContextCircleRow() {
  const { settings, update } = useSettings();
  const t = useT();
  return (
    <SettingsRow label={t("Context circle")} description={t("A ring beside the model shows how full its context is. Tap it for the numbers.")}>
      <Toggle label={t("Context circle")} checked={settings.contextCircle} onChange={(contextCircle) => update({ contextCircle })} />
    </SettingsRow>
  );
}

export function ReadAloudVoiceRow() {
  const { settings, update } = useSettings();
  const t = useT();
  return (
    <SettingsRow label={t("Voice")} description={t("The speaker button under a reply reads it on this device. Kokoro speaks on the server, free and offline; the first time it takes a few minutes to set up.")} htmlFor="settings-speech-voice">
      <SettingsSelect id="settings-speech-voice" value={settings.speechVoice} onChange={(event) => update({ speechVoice: event.target.value as SpeechVoice })}>
        {SPEECH_VOICES.map((voice) => <option key={voice} value={voice}>{`${voice.charAt(3).toUpperCase()}${voice.slice(4)} · ${voice.startsWith("a") ? t("American") : t("British")}`}</option>)}
      </SettingsSelect>
    </SettingsRow>
  );
}

export function LiveVoiceRow() {
  const { settings, update } = useSettings();
  const t = useT();
  return (
    <SettingsRow label={t("Voice")} description={t("The voice of a live call with a Pi pane, from the next call on. Same as Pi uses the voice set in Pi's /openai-settings.")} htmlFor="settings-live-voice">
      <SettingsSelect id="settings-live-voice" value={settings.liveVoice} onChange={(event) => update({ liveVoice: isPiVoice(event.target.value) ? event.target.value : "pi" })}>
        <option value="pi">{t("Same as Pi")}</option>
        {PI_VOICES.map((voice) => <option key={voice} value={voice}>{`${voice.charAt(0).toUpperCase()}${voice.slice(1)}`}</option>)}
      </SettingsSelect>
    </SettingsRow>
  );
}

export function OpenLiveWorkRow() {
  const { settings, update } = useSettings();
  const t = useT();
  return (
    <SettingsRow label={t("Open work while the agent runs")} description={t("Off, a running turn shows only its Working… row until tapped")}>
      <Toggle label={t("Open work while the agent runs")} checked={settings.openLiveWork} onChange={(openLiveWork) => update({ openLiveWork })} />
    </SettingsRow>
  );
}
