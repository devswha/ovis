import { createContext } from "react";

export const WEB_LINK_TARGETS = ["tab", "panel"] as const;
export type WebLinkTarget = (typeof WEB_LINK_TARGETS)[number];

export interface AppLocation {
  protocol: string;
  hostname: string;
  origin: string;
}

export type WebPanelOpener = (uri: string, shiftKey: boolean, machineId: string) => boolean;

export function shouldOpenWebPage(
  event: Pick<MouseEvent, "button" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  uri: string,
  openWebPage: WebPanelOpener | null,
  machineId: string,
): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.altKey
    && (openWebPage?.(uri, event.shiftKey, machineId) ?? false);
}

const LOOPBACK = /^(?:localhost|[^.]+(?:\.[^.]+)*\.localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1?\])$/i;

export function panelUrl(uri: string, app: AppLocation): string | null {
  if (!/^https?:\/\//i.test(uri)) return null;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (LOOPBACK.test(url.hostname)) url.hostname = app.hostname;
  else if (url.hostname.toLowerCase() !== app.hostname.toLowerCase()) return null;
  if (url.origin === app.origin) return null;
  if (app.protocol === "https:" && url.protocol === "http:") return null;
  return url.href;
}

const LOCAL_PAGE = /^(?:(https?):\/\/)?(localhost|127(?:\.\d{1,3}){3}|\[::1\])?:(\d{1,5})([/?#]\S*)?$/i;

/**
 * The page a palette query names on this PC, or null for any other query. Only a loopback name
 * with a port is read, so a search is never taken for an address. Without a scheme it takes the
 * app's own: an https app frames only https pages, such as a port `tailscale serve` fronts.
 */
export function localPageAddress(query: string, app: Pick<AppLocation, "protocol">): string | null {
  const match = LOCAL_PAGE.exec(query.trim());
  if (match === null) return null;
  const [, scheme = app.protocol.slice(0, -1), host = "localhost", port = "", rest = "/"] = match;
  const number = Number(port);
  if (number < 1 || number > 65535) return null;
  try {
    return new URL(`${scheme.toLowerCase()}://${host}:${port}${rest}`).href;
  } catch {
    return null;
  }
}

export function wantsPanel(target: WebLinkTarget, shiftKey: boolean): boolean {
  return (target === "panel") !== shiftKey;
}

export const WebPanelContext = createContext<WebPanelOpener | null>(null);
