import { homeSignIn, type CredentialHome, type UsageContext } from "./usage.ts";

export interface LoginTarget {
  readonly provider: "claude" | "codex";
  readonly home: CredentialHome;
}

export interface LoginAccount {
  readonly key: string;
  readonly label: string | null;
}

export async function homeBefore(ctx: UsageContext, target: LoginTarget): Promise<readonly string[] | undefined> {
  try {
    const found = await homeSignIn(ctx, target.provider, target.home);
    return found === "unknown" ? undefined : found?.digests ?? [];
  } catch {
    console.warn("Could not read a credential home before its sign-in");
    return undefined;
  }
}

export async function loginAccount(ctx: UsageContext, target: LoginTarget, before: readonly string[] | undefined): Promise<LoginAccount | null> {
  if (before === undefined) return null;
  const after = await homeSignIn(ctx, target.provider, target.home);
  if (after === null || after === "unknown" || before.includes(after.digest) || (after.expiresAt !== null && after.expiresAt <= ctx.now())) return null;
  return { key: after.key, label: after.label };
}
