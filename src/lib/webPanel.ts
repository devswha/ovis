import { createContext, useCallback } from "react";
import { LOCAL_MACHINE, type Machine } from "../../shared/machines.ts";
import { openExternal } from "./externalLink.ts";

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

/**
 * Only a page served
 * by the PC this app runs on is framed, on another port than the app's: the app's policy
 * (server/static.ts) frames that host alone, and most other sites refuse to be framed anyway.
 * A loopback name means that PC, so it is reached under the host the browser used for the app:
 * from another computer, `localhost:5173` would be that computer's own. An https app cannot
 * frame an http page (mixed content), so that one opens in a tab too.
 */
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

/**
 * `uri` on the SSH host of the remote PC whose pane named it, when it names a loopback address:
 * a dev server there prints `localhost:3000`, which from the browser's device would be its own.
 * Null when it names another host, or the PC has no SSH host.
 */
export function remotePcUrl(uri: string, destination: string | undefined): string | null {
  const host = destination?.trim().replace(/^[^@]*@/, "");
  if (!host || !/^https?:\/\//i.test(uri)) return null;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (!LOOPBACK.test(url.hostname)) return null;
  url.hostname = host.includes(":") ? `[${host}]` : host;
  return url.href;
}

/** A pane's link opener: a remote PC's localhost link opens on that PC's SSH host, in a tab; the panel frames only this app's own PC. */
export function usePaneLinkOpener(machines: readonly Pick<Machine, "id" | "target">[], openWebPage: WebPanelOpener): WebPanelOpener {
  return useCallback<WebPanelOpener>((uri, shiftKey, machineId) => {
    const remote = machineId === LOCAL_MACHINE ? null : remotePcUrl(uri, machines.find((item) => item.id === machineId)?.target?.destination);
    if (remote === null) return openWebPage(uri, shiftKey, machineId);
    openExternal(remote, "link", false);
    return true;
  }, [machines, openWebPage]);
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
  // the pattern lets an octet past 255 through (`127.999.0.1`), which no URL holds
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
