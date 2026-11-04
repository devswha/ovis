import { Globe, Monitor, Network, RadioTower, Wifi, type LucideIcon } from "lucide-react";

import { connectionRoute } from "../lib/connectionRoute.ts";
import { useT } from "../lib/i18n.ts";
import { inRelayShell } from "../lib/useRelay.ts";

/**
 * How this device reaches the Ovis it shows (lib/connectionRoute.ts), in the header at all times:
 * one glyph and one short word, the sentence in its title. It is about the page's own connection,
 * which every PC the sidebar lists shares, so it sits with the connection chip, not on a PC.
 * Tailscale and LAN are names, the same in every language.
 */
export function ConnectionRouteMark() {
  const t = useT();
  const route = connectionRoute({ relay: inRelayShell(), hostname: window.location.hostname });
  const [Icon, word, title]: [LucideIcon, string, string] =
    route === "relay" ? [RadioTower, t("relay"), t("Connected through the Ovis relay")]
    : route === "tailscale" ? [Network, "Tailscale", t("Connected over Tailscale")]
    : route === "lan" ? [Wifi, "LAN", t("Connected over the local network")]
    : route === "direct" ? [Globe, t("direct"), t("Connected straight to this address")]
    : [Monitor, t("on this PC"), t("Open on this PC")];
  return (
    <span className="conn-route" data-route={route} title={title}>
      <Icon aria-hidden="true" />
      <span className="conn-route-word">{word}</span>
      <span className="visually-hidden">{title}</span>
    </span>
  );
}
