import type { Translate } from "../lib/i18n.ts";
import type { RelayFailure } from "../lib/relay/shellState.ts";

/**
 * What a failed connection says (shellState.ts failureOf), on the shell's own screen and in the
 * Add-a-PC sheet alike: its title, the sentence under it, and whether Try again can help.
 */
export function relayFailureText(t: Translate, failure: RelayFailure, name: string): { title: string; copy: string; retry: boolean } {
  switch (failure) {
    case "pair-declined": return { title: t("{name} did not approve this phone", { name }), copy: t("It was declined on the PC, or not approved in time. Open the link again to compare new numbers."), retry: false };
    case "pair-unavailable": return { title: t("{name} is not taking new phones right now", { name }), copy: t("Its link may have run out (it works for 10 minutes), or it may be paused after too many tries or busy with other phones. Copy a new link on the PC, or wait a few minutes."), retry: false };
    case "not-added-yet": return { title: t("{name} has not added this device yet", { name }), copy: t("It adds the devices of your account a few minutes after they join. Try again in a moment."), retry: true };
    case "pc-offline": return { title: t("{name} is offline", { name }), copy: t("Its Ovis is not connected to the relay right now. Start Ovis on the PC, or check its connection, then try again."), retry: true };
    case "pc-unresponsive": return { title: t("{name} did not finish connecting", { name }), copy: t("The PC answered through the relay but did not complete the connection. Try again; if it keeps happening, restart Ovis on the PC."), retry: true };
    case "relay-unreachable": return { title: t("The relay could not be reached"), copy: t("Check this phone's connection, then try again."), retry: true };
    case "needs-update": return { title: t("Update needed"), copy: t("{name} and this app speak different versions of the relay protocol. Update Ovis on the PC, then try again.", { name }), retry: true };
    case "revoked": return { title: t("This phone was removed from {name}", { name }), copy: t("Its pairing was revoked on the PC, so this phone's key for it is gone. To pair again, scan a new QR code on the PC."), retry: false };
    case "identity-changed": return { title: t("{name} has a new identity", { name }), copy: t("The PC's relay key is not the one this phone paired with, so the saved pairing cannot be trusted. Forget it, then pair again from a new QR code on the PC."), retry: false };
    case "code-expired": return { title: t("That pairing code no longer works"), copy: t("The code was wrong, used up or expired. Scan a new QR code on the PC."), retry: false };
    case "bad-offer": return { title: t("This pairing link is damaged"), copy: t("Part of the link is missing or changed. Scan the QR code on the PC again, or copy its link whole."), retry: false };
  }
}
