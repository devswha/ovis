/**
 * The key a sign-in registers with the account service (device table T34, P18, P21): one per sign-in, apart from the
 * account key, since the service takes a key once per account and never again after its sign-in ends. The key is kept,
 * marked unregistered, before the service is asked, so a lost answer or a second call registers that same key and
 * never a second one. Its number in the account's order only fills a block's signer_no and decides whether "Not me" is
 * offered.
 */
import { newKey, type AccountStore, type SignInKey } from "./store.ts";
import { SignedOutError, type AccountService } from "./service.ts";

/** This sign-in's registered key; null when the service has no release (G5), and nothing is kept then. */
export async function signInKey(store: AccountStore, service: AccountService): Promise<(SignInKey & { readonly no: number }) | null> {
  const session = await service.session();
  if (session === undefined || session.sign_in_id === undefined) throw new SignedOutError();
  const ours = (kept: SignInKey | undefined): kept is SignInKey => kept !== undefined && kept.account === session.account && kept.sign_in_id === session.sign_in_id;
  const kept = await store.get("signin_key");
  if (ours(kept) && kept.no !== null) return kept as SignInKey & { readonly no: number };
  let pending: SignInKey = ours(kept) ? kept : { account: session.account, sign_in_id: session.sign_in_id, key: await newKey(), no: null };
  await store.update("signin_key", (current) => {
    if (ours(current)) { pending = current; return current; }
    return pending;
  });
  const registered = await service.forSignIn(session).registerDeviceKey(pending.key);
  if (registered === null) {
    await store.update("signin_key", (current) => ours(current) && current.no === null ? undefined : current);
    return null;
  }
  const done = { ...pending, no: registered.no };
  await store.update("signin_key", (current) => ours(current) && current.key.public_spki === done.key.public_spki ? done : current);
  return done;
}
