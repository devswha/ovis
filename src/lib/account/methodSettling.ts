import { useEffect, useState } from "react";

import type { Translate } from "../i18n.ts";

/**
 * What a `403 method_settling` says: the way in this sign-in used was just added because it has the account's email,
 * and what it was refused is available from `until`, when it has settled.
 */
export function availableFrom(t: Translate, locale: string, until: string): string {
  return t("Changes available from {time}", { time: new Date(until).toLocaleString(locale, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) });
}

/** When the way in `current` settles, while it is still settling (`deniable_until` ahead); null once it has, or for one made by hand. */
export function settlingUntil(methods: readonly { readonly provider: string; readonly deniable_until?: string }[], current: string, now: number): string | null {
  const until = methods.find((method) => method.provider === current)?.deniable_until;
  return until !== undefined && Date.parse(until) > now ? until : null;
}

/**
 * Renders the caller again when the earliest `deniable_until` of `methods` still ahead passes: what a settling way in
 * hides, and the Not me a joined one offers, change then with no other event to show it.
 */
export function useSettlingDeadline(methods: readonly { readonly deniable_until?: string }[] | undefined): void {
  const [passed, setPassed] = useState(0);
  const now = Date.now();
  const next = Math.min(...(methods ?? []).map(({ deniable_until }) => deniable_until === undefined ? Number.NaN : Date.parse(deniable_until)).filter((at) => at > now));
  useEffect(() => {
    if (!Number.isFinite(next)) return;
    // a timer that fires a moment early renders the same deadline again, and this waits for it once more
    const timer = setTimeout(() => setPassed((count) => count + 1), Math.max(0, next - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [next, passed]);
}
