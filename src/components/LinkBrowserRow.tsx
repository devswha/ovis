import { useEffect, useState } from "react";
import { Compass } from "lucide-react";

import { linkBrowsers, type LinkBrowserChoices } from "../lib/externalLink.ts";
import { useT } from "../lib/i18n.ts";
import { SettingsRow, SettingsSelect } from "./SettingsControls.tsx";

const SYSTEM_DEFAULT = "";

/** Settings → Chat → Files in the desktop app: the browser a web link opens in. Elsewhere the browser itself shows the link, so there is no row. */
export function LinkBrowserRow() {
  const t = useT();
  const [bridge] = useState(linkBrowsers);
  const [choices, setChoices] = useState<LinkBrowserChoices | null>(null);
  useEffect(() => {
    let current = true;
    void bridge?.list().then((listed) => { if (current) setChoices(listed); }).catch(() => {});
    return () => { current = false; };
  }, [bridge]);
  if (bridge === null || choices === null) return null;
  const chosen = choices.chosen !== null && choices.browsers.some((browser) => browser.id === choices.chosen) ? choices.chosen : SYSTEM_DEFAULT;
  const choose = (id: string) => {
    const next = id === SYSTEM_DEFAULT ? null : id;
    setChoices({ ...choices, chosen: next });
    bridge.choose(next).catch(() => setChoices(choices));
  };
  return (
    <SettingsRow icon={Compass} label={t("Browser for links")} htmlFor="settings-link-browser"
      description={t("The browser a web link you click in Ovis opens in, on this computer. Sign-in pages always open in the system's default browser.")}
      onReset={chosen === SYSTEM_DEFAULT ? undefined : () => choose(SYSTEM_DEFAULT)}>
      <SettingsSelect id="settings-link-browser" value={chosen} onChange={(event) => choose(event.target.value)}>
        <option value={SYSTEM_DEFAULT}>{choices.systemDefault === null ? t("System default") : t("System default ({name})", { name: choices.systemDefault })}</option>
        {choices.browsers.map((browser) => <option key={browser.id} value={browser.id}>{browser.name}</option>)}
      </SettingsSelect>
    </SettingsRow>
  );
}
