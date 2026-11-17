import { beginSignIn, finishOwnSignIn } from "./signin.ts";
import { ACCOUNT_PROVIDERS } from "./store.ts";
import type { AccountProvider, AccountSession, AccountStore } from "./store.ts";

export interface DesktopAccountBridge {
  readonly service: string;
  readonly providers?: readonly string[];
  start(): Promise<string>;
  open(url: string): Promise<string>;
}

export function desktopAccount(): DesktopAccountBridge | null {
  const bridge = typeof window === "undefined" ? undefined : (window as Window & { ovisAccount?: Partial<DesktopAccountBridge> }).ovisAccount;
  return bridge && typeof bridge.service === "string" && typeof bridge.start === "function" && typeof bridge.open === "function"
    ? bridge as DesktopAccountBridge : null;
}

export function desktopProviders(bridge: DesktopAccountBridge): AccountProvider[] {
  const offered = ACCOUNT_PROVIDERS.filter((provider) => bridge.providers?.includes(provider));
  return offered.length > 0 ? offered : ["github"];
}

export async function desktopSignIn(provider: AccountProvider, bridge: DesktopAccountBridge, store: AccountStore, link?: { linkToken: string; bearer: string }): Promise<AccountSession> {
  const redirectUri = await bridge.start();
  const url = await beginSignIn(provider, { store, service: bridge.service, redirectUri, ...(link ? { linkToken: link.linkToken } : {}) });
  return finishOwnSignIn(url, await bridge.open(url), { store, ...(link ? { bearer: link.bearer } : {}) });
}
