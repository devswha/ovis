import { Globe, Monitor, Network, RadioTower, Wifi, type LucideIcon } from "lucide-react";

import type { ObservedIngress } from "../../shared/protocol.ts";
import { connectionRoute } from "../lib/connectionRoute.ts";
import { useT } from "../lib/i18n.ts";
import { inRelayShell } from "../lib/useRelay.ts";

/**
 * How this device reaches the Ovis it shows (lib/connectionRoute.ts), in the header at all times:
 * one glyph and one short word, the route said in its title whatever the connection's state (the
 * chip beside it tells that). It is about the page's own connection, which every PC the sidebar
 * lists shares, so it sits with the chip, not on a PC. Tailscale and LAN are names, the same in
 * every language. Nothing in the phone app's demo, which reaches no PC.
 */
export function ConnectionRouteMark({ portal, ingress }: { portal: boolean; ingress: ObservedIngress | null }) {
  const t = useT();
  const route = connectionRoute({ relay: inRelayShell(), portal, funnel: ingress === "funnel", protocol: window.location.protocol, hostname: window.location.hostname });
  if (route === null) return null;
  const [Icon, word, title]: [LucideIcon, string, string] =
    route === "relay" ? [RadioTower, t("relay"), t("Via the Ovis relay")]
    : route === "portal" ? [RadioTower, t("relay"), t("Via the Portal relay")]
    : route === "tailscale" ? [Network, "Tailscale", t("Via Tailscale")]
    : route === "lan" ? [Wifi, "LAN", t("Via the local network")]
    : route === "direct" ? [Globe, t("direct"), t("Straight to this address")]
    : [Monitor, t("local"), t("Via a loopback address: this PC, or a tunnel to it")];
  return (
    <span className="conn-route" data-route={route} title={title}>
      <Icon aria-hidden="true" />
      <span className="conn-route-word" aria-hidden="true">{word}</span>
      <span className="visually-hidden">{title}</span>
    </span>
  );
}
