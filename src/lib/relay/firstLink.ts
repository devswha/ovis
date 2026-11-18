/**
 * The refusals of a device's first link that the failure screen names: the account
 * service's, of the admission a device posts before it pairs with a code that carries the mark, and the PC's, of the
 * link itself.
 */
import { AccountPcError } from "../account/join.ts";
import type { RelayFailure } from "./shellState.ts";

/**
 * A pairing with a marked code (`admission: 1`) stopped before it reached the PC, so the code was not used: no sign-in
 * to vouch with, the PC could not be listed in the account, or the account service did not take the admission (the
 * account does not list the PC, its ten in ten minutes are used up, it did not answer, or it refused this device).
 * `new-key`: after the pairing, the account key changed and the account service did not take the new one, so no link
 * was sent.
 */
export class AdmissionRefusedError extends Error {
  constructor(readonly why: "sign-in" | "listing" | "unlisted" | "busy" | "unanswered" | "refused" | "new-key") {
    super(`The pairing stopped before it reached the PC (${why})`);
    this.name = "AdmissionRefusedError";
  }
}

/** What the failure screen says for a refusal of a first link, before the pairing or at the link; null for any other failure. */
export function refusalOf(error: unknown): RelayFailure | null {
  if (error instanceof AdmissionRefusedError) {
    switch (error.why) {
      case "sign-in": return "sign-in-first";
      case "listing": return "account-list-failed";
      case "unlisted": return "account-unlisted";
      case "busy": return "account-busy";
      case "unanswered": return "admission-unanswered";
      case "refused": return "admission-failed";
      case "new-key": return "new-key-unvouched";
      default: return error.why satisfies never;
    }
  }
  if (!(error instanceof AccountPcError)) return null;
  switch (error.code) {
    case "link_required": return "link-required";
    case "account_mismatch": return "account-mismatch";
    case "unverified_device": return "unverified-device";
    default: return null;
  }
}
