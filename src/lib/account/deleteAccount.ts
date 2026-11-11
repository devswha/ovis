/**
 * Deleting the account (docs/account.md, "Deleting the account"): the account service erases the
 * account and everything it keeps under it, and this device forgets the sign-in and its account key.
 * Nothing is revoked on a PC: its own device list decides who gets in (rule 1), so every pairing,
 * this device's included, stays until it is revoked on that PC, as one made by QR code stays.
 */
import { sameSignIn, type AccountService } from "./service.ts";
import type { AccountSession, AccountStore } from "./store.ts";

/**
 * `session` is the sign-in the person deleted from, read when they asked: only that account is
 * deleted, and a sign-in made meanwhile is neither deleted nor forgotten (SignedOutError).
 */
export async function deleteAccount(options: { service: AccountService; accountStore: AccountStore; session: AccountSession }): Promise<void> {
  await options.service.forSignIn(options.session).deleteAccount();
  // the key belonged to the deleted account: a later sign-in gets a new one (a kept pairing holds its own copy)
  await options.accountStore.clear((current) => !sameSignIn(current, options.session));
}
