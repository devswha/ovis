/**
 * The key a sign-in registers with the account service (device table T34, P18, P21): one per sign-in, apart from the
 * account key, since the service takes a key once per account and never again after its sign-in ends. Kept with its
 * number in the account's order, which only fills a block's signer_no and decides whether "Not me" is offered.
 */
import { newKey, type AccountStore, type SignInKey } from "./store.ts";
import { SignedOutError, type AccountService } from "./service.ts";

/** This sign-in's registered key; null when the service has no release (G5), and nothing is kept then. */
export async function signInKey(store: AccountStore, service: AccountService): Promise<SignInKey | null> {
  const session = await service.session();
  if (session === undefined || session.sign_in_id === undefined) throw new SignedOutError();
  const kept = await store.get("signin_key");
  if (kept !== undefined && kept.account === session.account && kept.sign_in_id === session.sign_in_id) return kept;
  const key = await newKey();
  const registered = await service.forSignIn(session).registerDeviceKey(key);
  if (registered === null) return null;
  const made: SignInKey = { account: session.account, sign_in_id: session.sign_in_id, key, no: registered.no };
  let won: SignInKey = made;
  await store.update("signin_key", (current) => {
    if (current !== undefined && current.account === made.account && current.sign_in_id === made.sign_in_id) { won = current; return current; }
    return made;
  });
  return won;
}
