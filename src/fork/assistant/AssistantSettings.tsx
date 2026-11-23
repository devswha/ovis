import { Smartphone } from "lucide-react";
import { useEffect, useState } from "react";

import type { Machine } from "../../../shared/machines.ts";
import { SettingsRow, SettingsSelect } from "../../components/SettingsControls.tsx";
import { useT } from "../../lib/i18n.ts";
import { callNative } from "../../lib/nativeApp.ts";
import { useSettings } from "../../lib/settings.ts";
import { ASSISTANT_PLUGIN, hasAssistantPlugin } from "./callMirror.ts";
import { assistantTargets } from "./targets.ts";

interface Choice {
  available: boolean;
  enabled: boolean;
  role: boolean;
  machineId?: string;
  paneId?: string;
  label?: string;
}

const chooseKey = (target: { machineId?: string; paneId?: string }) => JSON.stringify([target.machineId, target.paneId]);

export function AssistantSettings({ machines }: { machines: readonly Machine[] }) {
  const t = useT();
  const { settings } = useSettings();
  const [choice, setChoice] = useState<Choice>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<"microphone" | "settings">();
  const refresh = () => callNative<Choice>(ASSISTANT_PLUGIN, "state").then(setChoice, () => undefined);
  useEffect(() => {
    if (!hasAssistantPlugin()) return;
    void refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);
  if (!choice?.available) return null;
  const targets = assistantTargets(machines);
  const selected = choice.enabled ? chooseKey(choice) : "";
  const choose = async (value: string) => {
    const target = targets.find((item) => chooseKey(item) === value);
    setPending(true);
    setError(undefined);
    try {
      await callNative(ASSISTANT_PLUGIN, "choose", target ? { ...target, voice: settings.liveVoice } : {});
      await refresh();
    } catch (error) {
      setError((error as { code?: string })?.code === "microphone" ? "microphone" : "settings");
    } finally { setPending(false); }
  };
  return <>
    <SettingsRow icon={Smartphone} label={t("Side-button assistant")} description={t("Hold the phone’s side button to talk to this Pi agent over any app.")} htmlFor="settings-assistant">
      <SettingsSelect id="settings-assistant" value={selected} disabled={pending} onChange={(event) => void choose(event.target.value)}>
        <option value="">{t("Off")}</option>
        {choice.enabled && !targets.some((target) => chooseKey(target) === selected) && <option value={selected} disabled>{choice.label}</option>}
        {targets.map((target) => <option key={chooseKey(target)} value={chooseKey(target)}>{target.label} · {target.machineName}</option>)}
      </SettingsSelect>
    </SettingsRow>
    {choice.enabled && !choice.role && <SettingsRow label={t("Digital assistant app")} description={t("Choose Ovis as the digital assistant app in Android settings.")}>
      <button type="button" className="btn" onClick={() => void callNative(ASSISTANT_PLUGIN, "openSettings").catch(() => setError("settings"))}>{t("Open Android settings")}</button>
    </SettingsRow>}
    {error && <p className="settings-item settings-hint" role="alert">{error === "microphone" ? t("Microphone access was denied.") : t("Could not change the side-button assistant.")}</p>}
  </>;
}
