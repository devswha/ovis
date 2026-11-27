import { useEffect, useRef, useState } from "react";
import { Compass } from "lucide-react";

import { BUILT_IN_LINK_BROWSER } from "../../shared/browser-policy.ts";
import { linkBrowsers, type LinkBrowserChoices } from "../lib/externalLink.ts";
import { useDesktopBrowser } from "../lib/desktopBrowser.ts";
import { useT } from "../lib/i18n.ts";
import { SettingsRow, SettingsSelect } from "./SettingsControls.tsx";

const SYSTEM_DEFAULT = "";

/** Settings → Chat → Files in the desktop and Mac apps: the browser a web link opens in. Elsewhere the browser itself shows the link, so there is no row. */
export function LinkBrowserRow() {
  const t = useT();
  const [bridge] = useState(linkBrowsers);
  const [choices, setChoices] = useState<LinkBrowserChoices | null>(null);
  // what the app has saved, and the latest choice asked for: a failed save shows the saved one again, unless a later choice came since
  const saved = useRef<string | null>(null);
  const asked = useRef(0);
  // the built-in browser is listed only while it is on: listed again once main says it turned on or off
  const builtIn = useDesktopBrowser() !== null;
  useEffect(() => {
    let current = true;
    const since = asked.current;
    void bridge?.list().then((listed) => {
      if (!current) return;
      // a choice made while the list was on its way is newer than the one the list read
      if (listed === null || asked.current === since) {
        saved.current = listed?.chosen ?? null;
        setChoices(listed);
      } else setChoices((shown) => ({ ...listed, chosen: shown?.chosen ?? listed.chosen }));
    }).catch(() => {});
    return () => { current = false; };
  }, [bridge, builtIn]);
  if (bridge === null || choices === null) return null;
  const chosen = choices.chosen !== null && choices.browsers.some((browser) => browser.id === choices.chosen) ? choices.chosen : SYSTEM_DEFAULT;
  const choose = (id: string) => {
    const next = id === SYSTEM_DEFAULT ? null : id;
    const request = ++asked.current;
    setChoices({ ...choices, chosen: next });
    bridge.choose(next).then(() => { saved.current = next; }, () => {
      if (request === asked.current) setChoices((shown) => shown && { ...shown, chosen: saved.current });
    });
  };
  return (
    <SettingsRow icon={Compass} label={t("Browser for links")} htmlFor="settings-link-browser"
      description={t("The browser a web link you click in Ovis opens in, on this computer. Sign-in pages always open in the system's default browser.")}
      onReset={chosen === SYSTEM_DEFAULT ? undefined : () => choose(SYSTEM_DEFAULT)}>
      <SettingsSelect id="settings-link-browser" value={chosen} onChange={(event) => choose(event.target.value)}>
        <option value={SYSTEM_DEFAULT}>{choices.systemDefault === null ? t("System default") : t("System default ({name})", { name: choices.systemDefault })}</option>
        {choices.browsers.map((browser) => <option key={browser.id} value={browser.id}>{browser.id === BUILT_IN_LINK_BROWSER ? t("Built-in browser") : browser.name}</option>)}
      </SettingsSelect>
    </SettingsRow>
  );
}
