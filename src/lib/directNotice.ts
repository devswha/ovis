import { useCallback, useEffect, useState } from "react";

import type { HealthInfo } from "./api.ts";

const KEY = "ovis:direct-notice-dismissed";

const entry = (scope: string, host: string) => `${scope} ${host}`;

function readDismissed(): string[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch { return []; }
}

function writeDismissed(dismissed: readonly string[]): void {
  try {
    if (dismissed.length) window.localStorage.setItem(KEY, JSON.stringify(dismissed));
    else window.localStorage.removeItem(KEY);
  } catch {}
}

export function directHostOf(health: Pick<HealthInfo, "auth" | "lan_exposure" | "direct_exposure"> | null): string | null | undefined {
  if (health === null || health.auth?.required === true) return undefined;
  if (health.lan_exposure) return health.lan_exposure.direct === true ? health.lan_exposure.host : null;
  return health.direct_exposure?.host ?? null;
}

export function useDirectNotice(scope: string, host: string | null | undefined): { dismissed: boolean; dismiss: () => void } {
  const [dismissed, setDismissed] = useState(readDismissed);
  useEffect(() => {
    if (host === undefined) return;
    const stored = readDismissed();
    const kept = stored.filter((item) => !item.startsWith(`${scope} `) || (host !== null && item === entry(scope, host)));
    if (kept.length !== stored.length) writeDismissed(kept);
    setDismissed(kept);
  }, [scope, host]);
  const dismiss = useCallback(() => {
    if (host == null) return;
    const next = [...readDismissed().filter((item) => item !== entry(scope, host)), entry(scope, host)];
    setDismissed(next);
    writeDismissed(next);
  }, [scope, host]);
  return { dismissed: host != null && dismissed.includes(entry(scope, host)), dismiss };
}
