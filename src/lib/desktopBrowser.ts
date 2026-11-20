/**
 * The desktop app's built-in browser as its bridge tells this page (app/electron/src/preload.ts,
 * `window.ovisBrowser`): the tabs main lists once their address was allowed, and what the browser
 * kept (downloads, an agent's screenshots). Null without the desktop app or while its setting is
 * off, where main answers null. Main is the authority on every field; this only reads them.
 */
import { useEffect, useState } from "react";

export type DesktopBrowserProfile = "mine" | "agent";

export interface DesktopBrowserTab {
  id: number;
  profile: DesktopBrowserProfile;
  /** the address without its query, as main shows it */
  address: string;
  title: string;
  loading: boolean;
  /** an agent tab a person holds: the agent's tools wait */
  held: boolean;
  /** the pane whose agent drives an agent tab, once main knows it */
  owner: { paneId: string; agent: string } | null;
}

export interface DesktopBrowserResult {
  id: string;
  kind: "download" | "screenshot";
  name: string;
  /** ms since the epoch */
  at: number;
  bytes: number | null;
  done: boolean;
  tab: number | null;
  profile: DesktopBrowserProfile;
}

export interface DesktopBrowser {
  tabs: DesktopBrowserTab[];
  results: DesktopBrowserResult[];
}

interface Bridge {
  current(): Promise<unknown>;
  onChange(listener: (browser: unknown) => void): () => void;
  close(id: number): void;
  preview?(id: number): Promise<unknown>;
  reveal?(id: string): void;
}

function bridge(): Bridge | undefined {
  const found = typeof window === "undefined" ? undefined : (window as Window & { ovisBrowser?: Partial<Bridge> }).ovisBrowser;
  return typeof found?.current === "function" && typeof found.onChange === "function" && typeof found.close === "function" ? found as Bridge : undefined;
}

const record = (value: unknown): Record<string, unknown> | null => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
const profile = (value: unknown): DesktopBrowserProfile | null => value === "mine" || value === "agent" ? value : null;

function tab(value: unknown): DesktopBrowserTab | null {
  const row = record(value);
  const kind = profile(row?.["profile"]);
  if (!row || kind === null || typeof row["id"] !== "number" || typeof row["address"] !== "string") return null;
  const owner = record(row["owner"]);
  return {
    id: row["id"],
    profile: kind,
    address: row["address"],
    title: typeof row["title"] === "string" ? row["title"] : "",
    loading: row["loading"] === true,
    held: row["held"] === true,
    owner: owner && typeof owner["paneId"] === "string" && typeof owner["agent"] === "string" ? { paneId: owner["paneId"], agent: owner["agent"] } : null,
  };
}

function result(value: unknown): DesktopBrowserResult | null {
  const row = record(value);
  const kind = row?.["kind"];
  const owner = profile(row?.["profile"]);
  if (!row || (kind !== "download" && kind !== "screenshot") || owner === null || typeof row["id"] !== "string" || typeof row["name"] !== "string" || typeof row["at"] !== "number") return null;
  return {
    id: row["id"],
    kind,
    name: row["name"],
    at: row["at"],
    bytes: typeof row["bytes"] === "number" ? row["bytes"] : null,
    done: row["done"] === true,
    tab: typeof row["tab"] === "number" ? row["tab"] : null,
    profile: owner,
  };
}

/** The bridge's view as this page reads it; a field main does not send yet reads as empty. */
export function desktopBrowserView(value: unknown): DesktopBrowser | null {
  const view = record(value);
  if (!view) return null;
  const list = <T,>(rows: unknown, read: (row: unknown) => T | null): T[] => Array.isArray(rows) ? rows.map(read).filter((row): row is T => row !== null) : [];
  return { tabs: list(view["tabs"], tab), results: list(view["results"], result) };
}

/** The built-in browser while the desktop app has it on, else null. */
export function useDesktopBrowser(): DesktopBrowser | null {
  const [browser, setBrowser] = useState<DesktopBrowser | null>(null);
  useEffect(() => {
    const found = bridge();
    if (!found) return;
    let alive = true;
    const stop = found.onChange((next) => { if (alive) setBrowser(desktopBrowserView(next)); });
    found.current().then((next) => { if (alive) setBrowser((heard) => heard ?? desktopBrowserView(next)); }, () => undefined);
    return () => { alive = false; stop(); };
  }, []);
  return browser;
}

export function closeBrowserTab(id: number): void {
  bridge()?.close(id);
}

/** shows a kept file in its folder (main never opens it); false where main has no way to */
export function revealBrowserResult(id: string): boolean {
  const reveal = bridge()?.reveal;
  if (typeof reveal !== "function") return false;
  reveal(id);
  return true;
}

/** A small picture of an allowed tab, taken by main when asked and kept nowhere, or null. */
export async function browserTabPreview(id: number): Promise<string | null> {
  const preview = bridge()?.preview;
  if (typeof preview !== "function") return null;
  const picture = await preview(id).catch(() => null);
  return typeof picture === "string" && picture.startsWith("data:image/") ? picture : null;
}
