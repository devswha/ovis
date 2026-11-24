import { Network, Users } from "lucide-react";

import type { AgentCatalogRow } from "../../shared/agent-catalog.ts";
import { ASK_EVERY_TIME_HARNESSES } from "../../shared/harness-tool.ts";
import { useT } from "../lib/i18n.ts";
import { useSettings } from "../lib/settings.ts";
import { ChipToggles, SettingsGroup, SettingsRow, Toggle } from "./SettingsControls.tsx";

/**
 * Whether an agent Ovis starts on this PC may start other agents and give them work (docs/harness-tool.md). Off, it may
 * only look. Only the installed agents it may start are offered, and turning it on with none chosen chooses them all.
 */
export function AgentCallsRows({ agents, watching }: { agents: readonly AgentCatalogRow[]; watching: boolean }) {
  const t = useT();
  const { settings, update } = useSettings();
  const setting = settings.agentHarnessTool;
  const on = setting.level === "start";
  const callable = agents.filter((agent) => agent.state.installed === true && ASK_EVERY_TIME_HARNESSES.includes(agent.id));
  const label = t("Let agents call other agents");
  const turn = (next: boolean): void => update({
    agentHarnessTool: next
      ? { ...setting, level: "start", harnesses: setting.harnesses.length > 0 ? setting.harnesses : callable.map((agent) => agent.id) }
      : { ...setting, level: "view" },
  });
  const choose = (id: string, chosen: boolean): void => update({
    agentHarnessTool: { ...setting, harnesses: chosen ? [...setting.harnesses, id] : setting.harnesses.filter((harness) => harness !== id) },
  });
  return (
    <SettingsGroup section="agent-calls">
      <SettingsRow icon={Network} label={label} description={t("On this PC only. You still answer every permission request.")}>
        <Toggle label={label} checked={on} disabled={watching} onChange={turn} />
      </SettingsRow>
      {on && callable.length > 0 && <SettingsRow icon={Users} label={t("Agents they may call")}>
        <ChipToggles label={t("Agents they may call")} chips={callable.map((agent) => ({ label: agent.name, on: setting.harnesses.includes(agent.id), onChange: (chosen) => choose(agent.id, chosen) }))} />
      </SettingsRow>}
    </SettingsGroup>
  );
}
