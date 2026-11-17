import { BlockList, isIP } from "node:net";
import { PORTAL_SIGN_INS } from "../shared/portal.ts";
import type { AccessRefusal, AccessVia, BindScope, DeviceRole, ObservedIngress, PortalLogin } from "../shared/protocol.ts";
import type { DeviceMatch } from "./devices.ts";

export interface AccessInput {
  relayPeer?: DeviceMatch;
  loopback: boolean;
  forwarded: boolean;
  /** Tailscale-Funnel-Request: the request came from the public internet through Funnel */
  funnel: boolean;
  /** Tailscale-User-Login: set by tailscale serve for a person's device, absent for tagged nodes */
  tailscaleLogin: string | null;
  /** X-Forwarded-For: Serve replaces this with one source address, never a proxy chain */
  forwardedFor?: string | null;
  host: string | null;
  tokenMatched: boolean;
  device: DeviceMatch | null;
  owner: string | null;
  tagged: boolean;
  soleLogin: string | null;
  dnsName: string | null;
  tailnetIp: string | null;
  serveOnly: boolean;
  tokenConfigured: boolean;
  gated: boolean;
  portal?: {
    proven: boolean;
    user: string | null;
    auth: string | null;
    role?: DeviceRole;
  };
}

export type Access =
  | { level: "full"; via: AccessVia; role: DeviceRole; device?: DeviceMatch; login?: string; portal?: PortalLogin }
  | { level: "none"; reason: AccessRefusal };

export function isLoopbackAddress(address: string): boolean {
  return address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

export function isLoopbackBind(hostname: string): boolean {
  const name = hostname.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
  const literal = /^[\d.]+$/.test(name) || name.includes(":");
  return name === "localhost" || name.endsWith(".localhost") || (literal && isLoopbackAddress(name));
}

export function lanExposed(input: { hostname: string; tokenConfigured: boolean; gated: boolean }): boolean {
  return bindScope(input.hostname) === "other" && !input.tokenConfigured && !input.gated;
}

export function bindScope(hostname: string): BindScope {
  if (isLoopbackBind(hostname)) return "loopback";
  const address = hostname.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
  const family = isIP(address);
  return (family === 4 ? tailnetIpv4.check(address, "ipv4") : family === 6 && tailnetIpv6.check(address, "ipv6")) ? "tailnet" : "other";
}

export const inTailnet = (address: string | null | undefined): boolean => {
  const family = isIP(address ?? "");
  return family === 4 ? tailnetIpv4.check(address!, "ipv4") : family === 6 && tailnetIpv6.check(address!, "ipv6");
};

export function observedIngress(input: Pick<AccessInput, "loopback" | "forwarded" | "funnel" | "tailscaleLogin" | "forwardedFor" | "owner" | "tagged" | "serveOnly"> & {
  peerKnown: boolean;
  forwardingHeaders: boolean;
}): Exclude<ObservedIngress, "relay" | "portal"> {
  if (!input.peerKnown) return "unknown";
  const tailscaleHere = input.owner !== null || input.tagged;
  const throughServe = input.serveOnly && input.loopback && tailscaleHere;
  const fromTailscale = throughServe && inTailnet(input.forwardedFor ?? null);
  if (input.funnel) return throughServe ? "funnel" : "unknown";
  if (input.tailscaleLogin !== null) return fromTailscale ? "tailscale" : "unknown";
  if (fromTailscale && input.forwarded) return "tailscale";
  if (input.forwardingHeaders) return "proxy";
  return input.loopback && input.forwarded ? "proxy" : "direct";
}

export function forwardingHeaders(headers: Headers): boolean {
  return PROXY_HEADERS.some((name) => headers.has(name)) || headers.has("tailscale-funnel-request");
}

export function machineForwardingHeaders(headers: Headers): boolean {
  return forwardingHeaders(headers) || MACHINE_PROXY_HEADERS.some((name) => headers.has(name));
}
const MACHINE_PROXY_HEADERS = ["x-forwarded-port", "x-forwarded-server", "x-forwarded-scheme", "x-original-forwarded-for", "cf-connecting-ip",
  "true-client-ip", "x-client-ip", "fly-client-ip", "x-envoy-external-address", "cdn-loop"];

const PROXY_HEADERS = ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "forwarded", "via", "tailscale-user-login"];

/**
 * The name a Host header addresses, lower-cased, without its port or its DNS root dot. It is read
 * as a bare authority, a name or a bracketed address with an optional port, and nothing else:
 * handed to a URL parser, `public.example@localhost` and `localhost/x@public.example` both came
 * out as localhost.
 */
export function hostName(host: string): string | null {
  const authority = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/i.exec(host);
  return authority ? authority[1]!.toLowerCase().replace(/\.$/, "") : null;
}

export function isLoopbackHost(host: string): boolean {
  const name = hostName(host);
  return name !== null && (name === "localhost" || name.endsWith(".localhost") || name === "[::1]"
    || /^127(?:\.\d{1,3}){3}$/.test(name) || /^\[::ffff:127(?:\.\d{1,3}){3}\]$/.test(name));
}

export function cameThroughProxy(headers: Headers): boolean {
  if (PROXY_HEADERS.some((name) => headers.has(name))) return true;
  // no Host at all is not how a browser or a CLI on this PC asks (HTTP/1.0 through a proxy is)
  const host = headers.get("host");
  return host === null || !isLoopbackHost(host);
}

export function addressesNode(input: Pick<AccessInput, "host" | "dnsName" | "tailnetIp">): boolean {
  const name = input.host === null ? null : hostName(input.host);
  if (name === null) return false;
  return (input.dnsName !== null && name === input.dnsName.toLowerCase()) || (input.tailnetIp !== null && name === input.tailnetIp);
}

/**
 * Is the Host one a request from this PC carries other than through a rebound name: a loopback name,
 * or this PC's tailnet name or address (tailscale serve keeps the device's Host: serve.go
 * `r.Out.Host = r.In.Host`)? A web page whose own name was rebound to 127.0.0.1 reaches a loopback
 * server from loopback, and its Host and Origin are still that name. No Host at all is no browser's.
 */
export function knownAuthority(input: Pick<AccessInput, "host" | "dnsName" | "tailnetIp">): boolean {
  return input.host === null || isLoopbackHost(input.host) || addressesNode(input);
}

export function isServeOwnerRequest(input: Pick<AccessInput, "serveOnly" | "loopback" | "forwarded" | "funnel" | "tailscaleLogin">): boolean {
  return input.serveOnly && input.loopback && input.forwarded && !input.funnel && input.tailscaleLogin === null;
}

// Tailscale v1.102.3: ipn/ipnlocal/serve.go:1068-1106 replaces XFF and strips incoming identity.
// net/tsaddr/tsaddr.go defines the assigned address ranges. This filters ordinary forwarding
// proxies, not a raw tunnel whose sender can forge both the login and the address.
const tailnetIpv4 = new BlockList();
tailnetIpv4.addSubnet("100.64.0.0", 10, "ipv4");
const tailnetIpv6 = new BlockList();
tailnetIpv6.addSubnet("fd7a:115c:a1e0::", 48, "ipv6");

/**
 * Who Portal's sign-in let in. A header proves nothing by itself: any other way to this port
 * (`tailscale serve`, another proxy, a local client) lets a visitor type X-Portal-User and
 * X-Portal-Auth. So Portal also sends X-Portal-Proof, a secret made for each of its launches that
 * only this server and that Portal have (it is in the Portal's environment), and drops a visitor's
 * copy; the identity counts only with it (`portal.proven`). Without it, or with a wrong one, the
 * headers are ignored and the request meets the token rules like any other. The values must also be
 * shaped as Portal makes them.
 */
export function portalLogin(input: Pick<AccessInput, "portal">): PortalLogin | null {
  const { portal } = input;
  if (portal === undefined || !portal.proven) return null;
  const { user, auth } = portal;
  const method = PORTAL_SIGN_INS.find((candidate) => candidate === auth);
  if (user === null || method === undefined || !/^[\x20-\x7e]{1,260}$/.test(user) || user !== user.trim()) return null;
  // a wallet is its address; an OIDC account is an email or sub:<id>; a link is whatever its name is
  if (method === "siwe" ? !/^0x[0-9a-f]{40}$/i.test(user) : method === "oidc" && !user.startsWith("sub:") && !user.includes("@")) return null;
  return { user, method };
}

export function ownerAccess(access: Access): boolean {
  return access.level === "full" && access.role === "drive" && access.via !== "open" && access.via !== "portal";
}

export function decideMachineAccess(input: { relayPeer?: DeviceMatch; ownerSocket: boolean; host: string | null; forwarded: boolean }): Access {
  if (input.relayPeer !== undefined) return { level: "full", via: "relay", role: input.relayPeer.role, device: input.relayPeer };
  if (input.ownerSocket && input.host === "localhost" && !input.forwarded) return { level: "full", via: "local", role: "drive" };
  return { level: "none", reason: "pairing_required" };
}

export function decideAccess(input: AccessInput): Access {
  if (input.relayPeer !== undefined) return { level: "full", via: "relay", role: input.relayPeer.role, device: input.relayPeer };
  if (input.tokenMatched) return { level: "full", via: "token", role: "drive" };
  if (input.device !== null) return { level: "full", via: "device", role: input.device.role, device: input.device };
  const portal = portalLogin(input);
  if (portal !== null) return { level: "full", via: "portal", role: input.portal?.role ?? "watch", portal };
  if (input.tokenConfigured) return { level: "none", reason: "token_required" };
  if (input.loopback && input.tailscaleLogin !== null && input.owner !== null) {
    const address = input.forwardedFor ?? "";
    const family = isIP(address);
    if (!(family === 4 ? tailnetIpv4.check(address, "ipv4") : family === 6 && tailnetIpv6.check(address, "ipv6"))) {
      return { level: "none", reason: "pairing_required" };
    }
    if (!knownAuthority(input)) return { level: "none", reason: "pairing_required" };
    if (input.tailscaleLogin.toLowerCase() === input.owner.toLowerCase()) return { level: "full", via: "tailscale", role: "drive", login: input.tailscaleLogin };
    return { level: "none", reason: "other_user" };
  }
  const sole = input.soleLogin;
  if (sole !== null && input.owner?.toLowerCase() === sole.toLowerCase() && isServeOwnerRequest(input) && addressesNode(input)) {
    return { level: "full", via: "tailscale", role: "drive", login: sole };
  }
  if (input.loopback && !input.forwarded) return { level: "full", via: "local", role: "drive" };
  if (input.loopback && input.forwarded && (input.owner !== null || input.tagged || input.serveOnly)) return { level: "none", reason: "pairing_required" };
  if (input.loopback && !knownAuthority(input)) return { level: "none", reason: "pairing_required" };
  if (!input.gated && !input.funnel) return { level: "full", via: "open", role: "drive" };
  return { level: "none", reason: "pairing_required" };
}
