/**
 * This device's place in its account's signed list when it goes (docs/account-list.md, "Putting a member out"): a
 * device that signs out or leaves puts itself out of the list first, and a device the list shows out, by its own
 * act or another member's, forgets its account key and its copy of the list. Its key never comes back: signing in
 * again makes a new one, which a member allows anew.
 *
 * And the tidying a device of power `full` does by itself while it reads the list: what is over its time goes.
 */
import type { AccountList, AccountListView } from "./accountList.ts";
import { removeFromList, removeSelf, tidyList, type RemoveOutcome } from "./listRemoveDevice.ts";
import { sameSignIn } from "./service.ts";
import type { AccountSession, AccountStore } from "./store.ts";

/** Whether this device follows the account's list and is in it, as the view says. */
export function inList(view: AccountListView, account: string): boolean {
  return view.account === account && view.status.at === "following" && view.status.standing === "in";
}

/**
 * A device that signs out of `account`, or leaves it, puts itself out of the account's list while its sign-in still
 * stands. Null for a device that its list, as last read, does not show in it: nothing is asked of the list, and its
 * sign-out is what it always was. The list is read at once whenever a sign-in is read, so a page that shows a
 * sign-out has read it.
 */
export async function leaveList(list: AccountList, account: string, options: { readonly wait?: (ms: number) => Promise<void> } = {}): Promise<RemoveOutcome | null> {
  if (!inList(list.view(), account)) return null;
  return removeSelf(list, options);
}

/**
 * Sign out every device, on an account whose list this device is in: every other device the list holds leaves it
 * first, in one request with the epoch after it, since a device that is only signed out still holds a key that opens
 * the account's PCs. This device stays. Null for a device that is in no list of that account.
 */
export async function removeOthers(list: AccountList, account: string, options: { readonly wait?: (ms: number) => Promise<void> } = {}): Promise<RemoveOutcome | null> {
  const view = list.view();
  if (!inList(view, account)) return null;
  const keys = view.devices.filter((device) => !device.self).map((device) => device.key);
  return keys.length === 0 ? { removed: true } : removeFromList(list, { keys, pcs: [] }, options);
}

/**
 * Forgets what made this device a member of `session`'s account: its account key (and its encryption key with it),
 * the sign-in, and its copy of the list. A sign-in made meanwhile stays, and so do the blocks the account service has
 * not confirmed (store.ts, clear).
 */
export async function forgetMembership(accountStore: AccountStore, list: AccountList, session: AccountSession): Promise<void> {
  await accountStore.clear((current) => !sameSignIn(current, session), { unsent: () => true });
  await list.forget(session.account);
}

/**
 * Hears, once for each time it happens, that the list shows this device out of `account`: another member removed
 * it, or it removed itself on another page.
 */
export function watchRemoval(list: AccountList, onOut: (account: string) => void): () => void {
  let told: string | null = null;
  return list.subscribe((view) => {
    const out = view.account !== null && view.status.at === "following" && view.status.standing === "out" ? view.account : null;
    if (out === null) { told = null; return; }
    if (out === told) return;
    told = out;
    onOut(out);
  });
}

/**
 * Tidies the list after each read that reached the account service and finds this device in it (listRemoveDevice.ts,
 * tidyList): quietly, one round at a time, each key tried once by this page.
 */
export function tidyOnRead(list: AccountList): () => void {
  const tried = new Set<string>();
  let running = false;
  let again = false;
  const run = async (): Promise<void> => {
    if (running) { again = true; return; }
    running = true;
    try {
      do {
        again = false;
        const outcome = await tidyList(list, tried);
        if (outcome !== null && !outcome.removed) console.info(`Ovis: what is over its time stays in the account's list for now (${outcome.why})`);
      } while (again);
    } finally { running = false; }
  };
  return list.subscribe((view) => {
    if (!view.reached || view.account === null || !inList(view, view.account)) return;
    void run().catch((error: unknown) => console.warn("Ovis: the account's list was not tidied", error instanceof Error ? error.name : error));
  });
}
