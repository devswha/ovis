import { SERVER_ID_PATTERN } from "../../shared/relay-id.ts";

export type ShellMode = "relay" | null;

export function shellModeOf(document: { querySelector(selector: string): { getAttribute(name: string): string | null } | null }): ShellMode {
  return document.querySelector('meta[name="ovis-shell"]')?.getAttribute("content") === "relay" ? "relay" : null;
}

export function shellMode(): ShellMode {
  return typeof document === "undefined" ? null : shellModeOf(document);
}

export function serverScopePath(serverId: string): string {
  return `/s/${serverId}/`;
}

export function serverIdOfPath(pathname: string): string | null {
  const id = /^\/s\/([^/]+)(?:\/|$)/.exec(pathname)?.[1];
  return id !== undefined && SERVER_ID_PATTERN.test(id) ? id : null;
}

export function shellServiceWorker(pathname: string): { script: string; scope: string } | null {
  const serverId = serverIdOfPath(pathname);
  if (serverId === null) return null;
  const scope = serverScopePath(serverId);
  return { script: `${scope}sw.js`, scope };
}

export async function requestFreshShell(storage: Pick<CacheStorage, "open">, serverId: string): Promise<void> {
  await (await storage.open("ovis-files-v1")).put(`/__ovis-fresh-shell/${serverId}`, new Response("1"));
}
