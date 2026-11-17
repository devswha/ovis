import type { UsageLoginPrompt } from "../../shared/usage-login.ts";

export type SignInOutcome =
  | { kind: "signed-in"; account: string | null }
  | { kind: "finished" }
  | { kind: "not-signed-in" };

export function followedOutcome(ended: Pick<UsageLoginPrompt, "succeeded" | "account">, before: readonly (string | null)[], after: readonly (string | null)[], again: boolean): SignInOutcome {
  if (ended.succeeded === undefined) return signInOutcome(before, after, again);
  return ended.succeeded ? { kind: "signed-in", account: ended.account ?? null } : { kind: "not-signed-in" };
}

export function signInOutcome(before: readonly (string | null)[], after: readonly (string | null)[], again: boolean): SignInOutcome {
  const known = new Set(before.map((account) => account ?? ""));
  const added = after.find((account) => !known.has(account ?? ""));
  if (added !== undefined) return { kind: "signed-in", account: added };
  if (after.length > before.length) return { kind: "signed-in", account: null };
  return again && after.length > 0 ? { kind: "finished" } : { kind: "not-signed-in" };
}
