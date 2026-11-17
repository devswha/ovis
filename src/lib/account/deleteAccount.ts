import { sameSignIn, type AccountService } from "./service.ts";
import type { AccountSession, AccountStore } from "./store.ts";

export async function deleteAccount(options: { service: AccountService; accountStore: AccountStore; session: AccountSession }): Promise<void> {
  await options.service.forSignIn(options.session).deleteAccount();
  await options.accountStore.clear(undefined, { only: (current) => current === undefined || sameSignIn(current, options.session), spare: ["pending"] });
}

export function holdingSessionStore(store: AccountStore): AccountStore {
  return { ...store, set: (async (name, value) => { if (name !== "session") await store.set(name, value as never); }) as AccountStore["set"] };
}

export async function installSignInAgain(store: AccountStore, from: AccountSession, again: AccountSession, stillOn: () => boolean): Promise<boolean> {
  let installed = false;
  await store.update("session", (current) => {
    if (!stillOn() || current === undefined || !sameSignIn(current, from)) return current;
    installed = true;
    return again;
  });
  return installed;
}
