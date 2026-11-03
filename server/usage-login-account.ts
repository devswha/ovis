import { homeSignIn, type CredentialHome, type UsageContext } from "./usage.ts";

/** The credential home a followed sign-in's CLI writes, as its environment points it there. */
export interface LoginTarget {
  readonly provider: "claude" | "codex";
  readonly home: CredentialHome;
}

/** The account a followed sign-in signed in, as the list keys and names it; never a token or a path. */
export interface LoginAccount {
  readonly key: string;
  readonly label: string | null;
}

/**
 * What the login's home holds before its CLI starts: the digest of its sign-in, null when it holds none,
 * undefined when it could not be read (then no end of this login can be told from what was there).
 */
export async function homeBefore(ctx: UsageContext, target: LoginTarget): Promise<string | null | undefined> {
  try { return (await homeSignIn(ctx, target.provider, target.home))?.digest ?? null; }
  catch {
    // never put a credential reader's contents in an error
    console.warn("Could not read a credential home before its sign-in");
    return undefined;
  }
}

/**
 * The account a CLI that exited 0 signed in: its own home now holds a usable sign-in it wrote, one other
 * than the one there before it started. An exit code alone proves nothing (a PTY host reports 0 for a
 * CLI a signal ended), nor does a sign-in that was there already or one written in another home.
 */
export async function loginAccount(ctx: UsageContext, target: LoginTarget, before: string | null | undefined): Promise<LoginAccount | null> {
  if (before === undefined) return null;
  const after = await homeSignIn(ctx, target.provider, target.home);
  if (after === null || after.digest === before || (after.expiresAt !== null && after.expiresAt <= ctx.now())) return null;
  return { key: after.key, label: after.label };
}
