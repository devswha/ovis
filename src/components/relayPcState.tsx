import type { MyPcState } from "../lib/account/myPcs.ts";
import type { Translate } from "../lib/i18n.ts";
import { lastSeen } from "../lib/lastSeen.ts";
import type { PcStatus } from "../lib/relay/pcStatus.ts";

/** `unreachable`: this device's own check reached no relay, so it knows nothing of the PC itself (Could not reach this machine) */
export type PcReachState = MyPcState | "unchecked" | "unreachable";

export type OutOfReach = Extract<PcReachState, "offline" | "unreachable">;

export function relayHost(origin: string): string {
  try { return new URL(origin).host; } catch { return origin; }
}

export function outOfReachWord(state: OutOfReach, t: Translate): string {
  switch (state) {
    case "offline": return t("Machine offline");
    case "unreachable": return t("Could not reach this machine");
  }
}

export function outOfReachReason(pc: { readonly displayState: PcReachState; readonly last_seen_at: string | null; readonly check?: PcStatus | null }, t: Translate, now?: number): string | null {
  switch (pc.displayState) {
    case "offline": {
      const cause = t("It is off, has no network, or Ovis is not running on it.");
      return pc.last_seen_at === null ? cause : `${t("Last seen {when}.", { when: lastSeen(pc.last_seen_at, now) })} ${cause}`;
    }
    case "unreachable": {
      const found = pc.check?.kind === "checking" ? pc.check.previous : pc.check;
      return found?.kind === "offline" && found.reason === "refused" ? t("The relay turned this device away. Wait a minute, then check again.")
        : t("This device could not reach the relay. Check this device's network.");
    }
    case "paired": case "unchecked": case "needs-approval": case "needs-update": return null;
  }
}

/**
 * It names the button it sits next to and the only two ways in: a connected device of the account approves, or
 * someone types the number the PC's own screen shows. The directory cannot say whether such a device exists now
 * (Revoke all keeps the row seen), so neither is claimed.
 */
export function askToJoinReason(pc: { readonly added_at: string | null; readonly join?: unknown }, t: Translate): string | null {
  if (pc.added_at === null || pc.join === undefined) return null;
  return t("Join · approve on a connected device of your account, or type the number the PC shows");
}

export function routeText(check: PcStatus | null, t: Translate): string {
  if (check === null) return t("Not checked");
  if (check.kind === "checking") return t("Checking…");
  if (check.kind === "offline") return t("No answer");
  const way = check.route === "lan" ? t("Same network") : check.route === "tailscale" ? "Tailscale" : check.relay === undefined ? t("Relay") : relayHost(check.relay);
  return `${way} · ${t("{n} ms", { n: check.rttMs })}`;
}
