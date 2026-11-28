import type { MyPcState } from "../lib/account/myPcs.ts";
import type { Translate } from "../lib/i18n.ts";
import { lastSeen } from "../lib/lastSeen.ts";
import type { PcStatus } from "../lib/relay/pcStatus.ts";

/** `unreachable`: this device's own check reached no relay, so it knows nothing of the PC itself (Could not reach this machine) */
export type PcReachState = MyPcState | "unchecked" | "unreachable";

export type OutOfReach = Extract<PcReachState, "offline" | "unreachable">;

export function outOfReachWord(state: OutOfReach, t: Translate): string {
  switch (state) {
    case "offline": return t("Machine offline");
    case "unreachable": return t("Could not reach this machine");
  }
}

/**
 * Why a PC is out of reach, in what was seen only: what this device's last check found and when, and when the PC was
 * last seen. A cause nobody saw (its power, its network, Ovis not running) is not guessed.
 */
export function outOfReachReason(pc: { readonly displayState: PcReachState; readonly last_seen_at: string | null; readonly check?: PcStatus | null }, t: Translate, now?: number): string | null {
  const found = pc.check?.kind === "checking" ? pc.check.previous : pc.check;
  const checked = found?.kind === "offline" && found.at !== undefined ? t("Checked {when}.", { when: lastSeen(new Date(found.at).toISOString(), now) }) : null;
  const said = (...parts: (string | null)[]): string | null => parts.filter((part) => part !== null).join(" ") || null;
  switch (pc.displayState) {
    case "offline": return said(
      found?.kind === "offline" && found.reason === "pc" ? t("The relay answered, but the PC did not.") : null,
      checked,
      pc.last_seen_at === null ? null : t("Last seen {when}.", { when: lastSeen(pc.last_seen_at, now) }),
    );
    case "unreachable": return said(
      found?.kind === "offline" && found.reason === "refused" ? t("The relay turned this device away. Wait a minute, then check again.")
        : t("This device could not reach the relay. Check this device's network."),
      checked,
    );
    case "paired": case "unchecked": case "needs-approval": case "needs-update": return null;
  }
}
