/**
 * How this device reaches the Ovis it shows, from facts the page owns: the hosted shell's relay
 * transport, or the address the browser loaded the app from. Nothing here asks the server or
 * guesses what lies behind a name: an address that is none of the known kinds is "direct".
 */
import { isLoopbackHost } from "./phone.ts";

export type ConnectionRoute = "relay" | "local" | "tailscale" | "lan" | "direct";

/** Tailscale's address ranges: 100.64.0.0/10 and fd7a:115c:a1e0::/48, and its MagicDNS names */
function tailnetHost(host: string): boolean {
  if (host.endsWith(".ts.net")) return true;
  const v4 = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (v4 !== null) { const second = Number(v4[1]); return second >= 64 && second <= 127; }
  return host.startsWith("fd7a:115c:a1e0:");
}

/** A private network's addresses (RFC 1918, link-local, IPv6 unique-local) and its local names */
function lanHost(host: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (v4 !== null) {
    const [first, second] = [Number(v4[1]), Number(v4[2])];
    return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168) || (first === 169 && second === 254);
  }
  if (host.includes(":")) return /^f[cd]/.test(host) || host.startsWith("fe80:");
  // a bare machine name or a name only a local network answers
  return !host.includes(".") || host.endsWith(".local") || host.endsWith(".lan") || host.endsWith(".home.arpa");
}

export function connectionRoute(page: { relay: boolean; hostname: string }): ConnectionRoute {
  if (page.relay) return "relay";
  const host = page.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isLoopbackHost(host) || host === "::1") return "local";
  if (tailnetHost(host)) return "tailscale";
  if (lanHost(host)) return "lan";
  return "direct";
}
