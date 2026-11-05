/**
 * Signing in from the desktop app (app/electron/src/accountSignIn.ts): the app names the account
 * service and carries the provider's return from the system browser over its loopback server; the
 * page finishes the sign-in itself with the PKCE verifier it kept, as a browser tab does.
 */
import { beginSignIn, finishOwnSignIn } from "./signin.ts";
import type { AccountProvider, AccountSession, AccountStore } from "./store.ts";

/** What the desktop app's preload offers its server's pages, when it names an account service. */
export interface DesktopAccountBridge {
  readonly service: string;
  /** a loopback redirect for one sign-in */
  start(): Promise<string>;
  /** opens the sign-in in the system browser; resolves with the callback's query */
  open(url: string): Promise<string>;
}

export function desktopAccount(): DesktopAccountBridge | null {
  const bridge = typeof window === "undefined" ? undefined : (window as Window & { ovisAccount?: Partial<DesktopAccountBridge> }).ovisAccount;
  return bridge && typeof bridge.service === "string" && typeof bridge.start === "function" && typeof bridge.open === "function"
    ? bridge as DesktopAccountBridge : null;
}

export async function desktopSignIn(provider: AccountProvider, bridge: DesktopAccountBridge, store: AccountStore): Promise<AccountSession> {
  const redirectUri = await bridge.start();
  const url = await beginSignIn(provider, { store, service: bridge.service, redirectUri });
  return finishOwnSignIn(url, await bridge.open(url), { store });
}
