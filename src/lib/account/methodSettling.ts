import type { Translate } from "../i18n.ts";

/**
 * What a `403 method_settling` says: the way in this sign-in used was just added because it has the account's email,
 * and what it was refused is available from `until`, when it has settled.
 */
export function availableFrom(t: Translate, locale: string, until: string): string {
  return t("Available from {time}", { time: new Date(until).toLocaleString(locale, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) });
}

/** When the way in `current` settles, while it is still settling (`deniable_until` ahead); null once it has, or for one made by hand. */
export function settlingUntil(methods: readonly { readonly provider: string; readonly deniable_until?: string }[], current: string, now: number): string | null {
  const until = methods.find((method) => method.provider === current)?.deniable_until;
  return until !== undefined && Date.parse(until) > now ? until : null;
}
