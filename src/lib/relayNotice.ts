import { useCallback, useEffect, useState } from "react";
import type { RelayStatus } from "../../shared/protocol.ts";
import { GLOBAL_RELAY, REGIONAL_RELAYS } from "../../shared/relay-regions.ts";
import type { HealthInfo } from "./api.ts";

/**
 * Whether the Ovis relay notice banner (components/RelayNotice.tsx) was dismissed in this browser.
 * Follows the same scoped-key pattern as useDirectNotice (lib/directNotice.ts): one dismissal
 * covers one PC and one notice state, and clears when the relay is off or the state is resolved.
 */
const KEY = "ovis:relay-notice-dismissed";

export type RelayNoticeKind = "sign-in-grace" | "sign-in-required" | "not-listed" | "pc-limit" | "data-limit";

export interface RelayNoticeInfo {
  readonly kind: RelayNoticeKind;
  readonly enforceAt: string | null;
}

const entry = (scope: string, kind: RelayNoticeKind) => `${scope} ${kind}`;

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
  } catch { /* storage blocked: the dismissal lasts until the page reloads */ }
}

function isOvisHostedRelay(relay: string): boolean {
  return relay === GLOBAL_RELAY || (REGIONAL_RELAYS as readonly string[]).includes(relay);
}

/**
 * Derives the relay notice state from a health or relay status answer:
 * - undefined before a known answer arrives (so stored dismissals are kept)
 * - null when the relay is off, not Ovis-hosted, or needs no notice
 * - RelayNoticeInfo when this PC uses the Ovis-hosted relay and needs sign-in or hit a limit
 */
export function relayNoticeFromStatus(relay: RelayStatus | null | undefined, signedIn = false): RelayNoticeInfo | null | undefined {
  if (relay === undefined) return undefined;
  if (relay === null || relay.phase === "off" || relay.blocked !== null) return null;
  const pass = relay.pass;
  if (pass === undefined) {
    if (!isOvisHostedRelay(relay.relay) || signedIn) return null;
    return { kind: "sign-in-grace", enforceAt: null };
  }
  if (pass.new_sessions === false) {
    return { kind: "data-limit", enforceAt: null };
  }
  if (pass.state === "limit") {
    return { kind: "pc-limit", enforceAt: null };
  }
  if (pass.state === "not_listed") {
    return { kind: "not-listed", enforceAt: null };
  }
  if (pass.state === "no_account") {
    if (pass.refused && relay.phase === "error") {
      return { kind: "sign-in-required", enforceAt: null };
    }
    if ((pass.relay !== null && pass.relay !== "ok") || !signedIn) {
      return { kind: "sign-in-grace", enforceAt: pass.enforce_at };
    }
  }
  return null;
}

export function relayNoticeOf(health: Pick<HealthInfo, "auth" | "relay"> | null, signedIn = false): RelayNoticeInfo | null | undefined {
  if (health === null || health.auth?.required === true) return undefined;
  return relayNoticeFromStatus(health.relay ?? null, signedIn);
}

export function useRelayNotice(scope: string, notice: RelayNoticeInfo | null | undefined): { dismissed: boolean; dismiss: () => void } {
  const kind = notice === undefined ? undefined : notice?.kind ?? null;
  const [dismissed, setDismissed] = useState(readDismissed);
  useEffect(() => {
    if (kind === undefined) return;
    const stored = readDismissed();
    const kept = stored.filter((item) => !item.startsWith(`${scope} `) || (kind !== null && item === entry(scope, kind)));
    if (kept.length !== stored.length) writeDismissed(kept);
    setDismissed(kept);
  }, [scope, kind]);
  const dismiss = useCallback(() => {
    if (kind == null) return;
    const next = [...readDismissed().filter((item) => item !== entry(scope, kind)), entry(scope, kind)];
    setDismissed(next);
    writeDismissed(next);
  }, [scope, kind]);
  return { dismissed: kind != null && dismissed.includes(entry(scope, kind)), dismiss };
}
