/**
 * How each saved PC answers now, for the front page's list (components/RelayShell.tsx): the phone
 * probes it the way it would connect (its direct carriers in the apps, then its relay), with no
 * session, and names the first way the PC answered on with that handshake's round trip.
 */
import type { DeviceRoute } from "../../../shared/access.ts";
import { probePc } from "../../../shared/relay-channel.ts";
import type { PcProbe, RelaySocket } from "../../../shared/relay-channel.ts";
import type { RelayDevice } from "../../../shared/relay-device.ts";
import type { RelayOffer } from "../../../shared/relay-offer.ts";
import { relayFallback } from "../../../shared/relay-regions.ts";

export type PcStatus =
  | { readonly kind: "checking" }
  | { readonly kind: "connected"; readonly route: DeviceRoute; readonly relay?: string; readonly rttMs: number }
  /** `pc`: the relay has nobody for it (off, or Ovis not running); `relay`: no relay answered this device */
  | { readonly kind: "offline"; readonly reason: "pc" | "relay" };

/** Every direct carrier together gets this long, as a connection gives them (transport.ts DIRECT_BUDGET_MS). */
export const DIRECT_PROBE_MS = 1_500;
/** The relay's turn: past it with no answer from the PC, the PC is called offline. */
export const RELAY_PROBE_MS = 8_000;

export interface PcCheckSockets {
  /** a WebSocket to the relay */
  readonly relay: (url: string) => RelaySocket;
  /** the phone apps' socket to a direct carrier; a browser has none */
  readonly direct?: (url: string) => RelaySocket;
}

/** A direct carrier on Tailscale's address range (100.64.0.0/10), told apart from one on the local network. */
function tailnetCarrier(carrier: string): boolean {
  const [first, second] = new URL(carrier).hostname.split(".").map(Number);
  return first === 100 && second !== undefined && second >= 64 && second < 128;
}

export async function checkPc(device: RelayDevice, sockets: PcCheckSockets, probe: typeof probePc = probePc): Promise<Exclude<PcStatus, { kind: "checking" }>> {
  const offer: RelayOffer = { v: 1, server_id: device.server_id, server_public_key: device.server_public_key, relay: device.relay };
  const carriers = sockets.direct ? device.direct ?? [] : [];
  for (const direct of carriers) {
    const found = await probe(offer, { direct }, sockets.direct!, DIRECT_PROBE_MS / carriers.length);
    if (found.kind === "answered") return { kind: "connected", route: tailnetCarrier(direct) ? "tailscale" : "lan", rttMs: found.ms };
  }
  let relay = device.relay;
  let found: PcProbe = await probe(offer, { relay }, sockets.relay, RELAY_PROBE_MS);
  // a PC on one of Ovis's regional relays is always on the global one too, as a connection falls back
  const fallback = relayFallback(relay);
  if (found.kind === "unreachable" && fallback !== null) found = await probe(offer, { relay: (relay = fallback) }, sockets.relay, RELAY_PROBE_MS);
  return found.kind === "answered" ? { kind: "connected", route: "relay", relay, rttMs: found.ms }
    : { kind: "offline", reason: found.kind === "silent" ? "pc" : "relay" };
}
