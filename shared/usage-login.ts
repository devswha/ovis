import type { UsageProviderId } from "./protocol.ts";

export type LocalUsageProvider = Exclude<UsageProviderId, "antigravity">;

/** Local account sign-in never accepts a command or a credential path from the browser. */
export type UsageLoginRequest =
  | { readonly provider: "claude" | "codex"; readonly name: string }
  | { readonly provider: Exclude<LocalUsageProvider, "claude" | "codex">; readonly replace?: true }
  /** Signs in again to an account GET /api/usage lists, by its key: the server finds its credential home. */
  | { readonly provider: "claude" | "codex"; readonly account: string }
  /** A first sign-in in the CLI's own home, the one its plain command reads; `replace` once the PC has a sign-in. */
  | { readonly provider: "claude" | "codex"; readonly default: true; readonly replace?: true };

/** Local PATH and credential discovery only, never a provider usage request or a credential. */
export interface UsageLoginProvider {
  readonly id: UsageProviderId;
  readonly cli: string;
  readonly installed: boolean;
  readonly local: boolean;
  readonly separate_home: boolean;
}

export interface UsageLoginAccounts {
  readonly accounts: readonly (string | null)[];
}

/** What a login pane asks of its user, read from its screen: never a token, only what the CLI shows to type or open. */
export interface UsageLoginPromptText {
  /** the sign-in page to open, on the provider's own host; null until the CLI prints it */
  readonly url: string | null;
  /** the one-time code to enter on that page (Codex's device code) */
  readonly user_code: string | null;
  /** the CLI waits for the code the page shows to be pasted back (Claude Code) */
  readonly wants_code: boolean;
}

/** GET /api/usage/login/prompt?pane=: a login this server launched, as its pane shows it. */
export interface UsageLoginPrompt extends UsageLoginPromptText {
  readonly provider: "claude" | "codex";
  /** the CLI has exited: whether it signed in, the accounts (GET /api/usage) tell */
  readonly ended: boolean;
}

/** POST /api/usage/login/code: the code a sign-in page showed, typed into that login's pane. */
export interface UsageLoginCode {
  readonly pane: string;
  readonly code: string;
}

export interface UsageLoginStarted {
  readonly pane_id: string;
  readonly workspace_id: string;
  readonly manual: boolean;
  readonly device_auth: boolean;
}
