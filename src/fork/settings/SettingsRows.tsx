import type { Machine } from "../../../shared/machines.ts";
import { isPiVoice, PI_VOICES } from "../../../shared/pi-voice.ts";
import { SPEECH_VOICES, type SpeechVoice } from "../../../shared/speech.ts";
import { useT } from "../../lib/i18n.ts";
import { useSettings } from "../../lib/settings.ts";
import { AudioLines, BellOff, Cpu, GitPullRequest, ListCollapse, Monitor, Notebook, PanelLeft, Smile, Sparkles, Square, SquareTerminal, Volume2, type LucideIcon } from "lucide-react";
import { Segmented, SettingsGroup, SettingsRow, SettingsSelect, Toggle } from "../../components/SettingsControls.tsx";
import { AssistantSettings } from "../assistant/AssistantSettings.tsx";
import { NAVIGATIONS, type ForkSettings } from "./settings.ts";

/** Settings → Fork: the rows only this fork has, by what they change, kept apart from SettingsDialog.tsx. */
export function ForkPage({ assistantMachines }: { assistantMachines?: readonly Machine[] }) {
  const { settings, update } = useSettings();
  const t = useT();
  const toggle = (key: ForkSwitch, label: string, icon: LucideIcon, description: string) => <SettingsRow icon={icon} label={label} description={description} reset={[key]}>
    <Toggle label={label} checked={settings[key]} onChange={(checked) => update({ [key]: checked })} />
  </SettingsRow>;
  return <>
    <SettingsGroup title={t("Places|fork")} section="fork-places">
      <SettingsRow icon={PanelLeft} label={t("Navigation|fork")} description={t("How a wide screen moves between the workspaces, the agent inbox, Pull requests and Notes: the rail in the inbox only, one footer in both, or the rail in both. A phone keeps them in its drawer's footer.")} wide reset={["navigation"]}>
        <Segmented label={t("Navigation|fork")} value={settings.navigation} onChange={(navigation) => update({ navigation })}
          options={NAVIGATIONS.map((navigation) => ({ value: navigation, label: t(navigation === "upstream" ? "Default|fork" : navigation === "footer" ? "Footer|fork" : "Rail|fork") }))} />
      </SettingsRow>
      {toggle("pullRequests", t("Pull requests"), GitPullRequest, t("Your pull requests and the ones waiting for your review, from every GitHub account gh is signed in to on this PC."))}
      {toggle("notes", t("Notes"), Notebook, t("Markdown notes in ~/Notes on this PC, for you and your agents."))}
    </SettingsGroup>
    <SettingsGroup title={t("Chat")} section="fork-chat">
      {toggle("chatMotion", t("Animated replies"), Sparkles, t("A reply's new words fade in as the agent writes them."))}
      <SettingsRow icon={ListCollapse} label={t("Open work while the agent runs")} description={t("Off, a running turn shows only its Working… row until tapped")} reset={["openLiveWork"]}>
        <Toggle label={t("Open work while the agent runs")} checked={settings.openLiveWork} onChange={(openLiveWork) => update({ openLiveWork })} />
      </SettingsRow>
      {toggle("readAloud", t("Read aloud"), Volume2, t("A speaker button under a reply reads it aloud."))}
      {settings.readAloud && <ReadAloudVoiceRow />}
      {toggle("piModelPicker", t("Pi model picker"), Cpu, t("A menu in a Pi pane's message box that switches its model."))}
      {toggle("piLiveVoice", t("Pi live voice"), AudioLines, t("A call button in a Pi pane, to talk with it live."))}
      {settings.piLiveVoice && <LiveVoiceRow />}
      {assistantMachines && <AssistantSettings machines={assistantMachines} />}
    </SettingsGroup>
    <SettingsGroup title={t("Agents")} section="fork-agents">
      {toggle("agentFriends", t("Agent friends"), Smile, t("Each agent has a friend's face and name in the lists and its alerts."))}
      {toggle("muteSubAgents", t("Mute sub-agents"), BellOff, t("Sub-agents send no alerts; the agent that started them still does. On every device."))}
    </SettingsGroup>
    <SettingsGroup title={t("Look|fork")} section="fork-look">
      {toggle("squareCorners", t("Square corners"), Square, t("Buttons, cards and panels with square corners."))}
      {toggle("moreViewToggle", t("View toggle in More"), SquareTerminal, t("Chat and terminal switch from the More menu, not from a button in the header."))}
      {toggle("computerView", t("Computer view"), Monitor, t("A PC's desktop in Ovis, opened from its screen button in the sidebar."))}
    </SettingsGroup>
  </>;
}

type ForkSwitch = { [K in keyof ForkSettings]: ForkSettings[K] extends boolean ? K : never }[keyof ForkSettings];

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

function ReadAloudVoiceRow() {
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

function LiveVoiceRow() {
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
