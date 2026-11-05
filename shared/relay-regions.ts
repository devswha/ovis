/**
 * Ovis's own relay endpoints. A PC that names no relay of its own stays connected to the global
 * one and, when a regional one answers much faster, also to that one and puts it in new pairing
 * offers (server/relay/service.ts). A phone whose saved relay is one of the regional ones falls
 * back to the global one when it cannot get through (src/lib/relay/transport.ts). The browser
 * imports this file, so it reads no environment.
 */
export const GLOBAL_RELAY = "wss://relay.ovis.sh";

export const REGIONAL_RELAYS: readonly string[] = ["wss://relay-ap.ovis.sh"];

/** The relay to try when `relay` does not get through, or null: only Ovis's regional relays fall back. */
export function relayFallback(relay: string, regional: readonly string[] = REGIONAL_RELAYS): string | null {
  return regional.includes(relay) ? GLOBAL_RELAY : null;
}

/** The hosted app's address, and its copy served beside each regional relay (relay/shell-mirror.ts). */
export const GLOBAL_APP = "https://app.ovis.sh";
export const REGIONAL_APPS: Readonly<Record<string, string>> = { "wss://relay-ap.ovis.sh": "https://app-ap.ovis.sh" };

/**
 * Where a browser that opened a pairing link on `app.ovis.sh` should open it instead: the regional
 * copy of the app beside the regional relay the link names, or null. Only a link with a pairing
 * code moves, since a phone keeps a PC's key in the origin it paired on and a saved PC has none in
 * the other; the native apps, which allow `app.ovis.sh` only, stay. Run by the page's first
 * script, before the app's bundle loads (src/theme-bootstrap.ts), so it parses no more than it needs.
 */
export function regionalAppUrl(location: { origin: string; pathname: string; hash: string }, nativeApp: boolean): string | null {
  if (nativeApp || location.origin !== GLOBAL_APP || !location.hash.startsWith("#offer=") || !/^\/s\/[0-9a-f]{32}\/$/.test(location.pathname)) return null;
  try {
    const offer: unknown = JSON.parse(atob(location.hash.slice("#offer=".length).replace(/-/g, "+").replace(/_/g, "/")));
    if (typeof offer !== "object" || offer === null) return null;
    const { relay, code } = offer as { relay?: unknown; code?: unknown };
    const app = typeof relay === "string" && typeof code === "string" ? REGIONAL_APPS[relay] : undefined;
    return app === undefined ? null : app + location.pathname + location.hash;
  } catch { return null; }
}
