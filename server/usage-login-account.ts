import { resolve } from "node:path";
import { accountKey, USAGE_PROVIDERS, type CredentialHome, type UsageContext } from "./usage.ts";

/** Identifies only the sign-in written in this login's home; never returns a token or a path. */
export async function loginAccount(ctx: UsageContext, target: { readonly provider: "claude" | "codex"; readonly home: CredentialHome }): Promise<string | null> {
  const provider = USAGE_PROVIDERS.find((provider) => provider.id === target.provider);
  if (!provider) return null;
  for (const found of await provider.signIns(ctx)) {
    if ("locked" in found || found.home === undefined) continue;
    const home = found.home;
    const matches = target.home.kind === "default" ? home.kind === "default"
      : home.kind === "dir" && resolve(home.dir) === resolve(target.home.dir);
    if (matches && (found.expiresAt === null || found.expiresAt > ctx.now())) return accountKey(target.provider, found.account, found.source);
  }
  return null;
}
