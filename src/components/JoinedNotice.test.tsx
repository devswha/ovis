import { afterEach, beforeEach, expect, it, mock, spyOn } from "bun:test";
import { act } from "react";
import { FakeAccountService, METHOD_SETTLE_MS, WEB_REDIRECT } from "../../shared/account-service-fake.ts";
import { keepShellAccount, type ShellAccount } from "../lib/account/hostedSignIn.ts";
import { AccountService } from "../lib/account/service.ts";
import { beginSignIn, finishSignIn, signInReturn } from "../lib/account/signin.ts";
import { indexedAccountStore, memoryAccountStore, memoryLock, type AccountProvider, type AccountStore } from "../lib/account/store.ts";
import { openPage, type Page } from "../lib/page.fixture.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { JoinedNotice } from "./JoinedNotice.tsx";

const SERVICE = "https://account.example";
const globals = new Map<string, PropertyDescriptor | undefined>();
let page: Page;
let fake: FakeAccountService;
let store: AccountStore;
let ahead: number;
const spies: { mockRestore(): void }[] = [];

async function signIn(provider: AccountProvider, into: AccountStore = store) {
  const start = await beginSignIn(provider, { store: into, service: SERVICE, redirectUri: WEB_REDIRECT });
  const returned = signInReturn(new URL((await fake.fetch(start)).headers.get("location") ?? "").hash);
  if (returned === null) throw new Error("no sign-in came back");
  return finishSignIn(returned, { store: into, fetch: fake.fetch });
}

beforeEach(() => {
  page = openPage(WEB_REDIRECT);
  for (const [key, value] of Object.entries({ localStorage: page.window.localStorage, Event: page.window.Event })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  ahead = 0;
  fake = new FakeAccountService(() => Date.now() + ahead);
  fake.emailLink = true;
  fake.signInAs("github", "acct_made");
  fake.signInAs("google", "acct_new");
  fake.emailHolders = { google: "acct_made" };
  store = memoryAccountStore();
  spies.push(spyOn(indexedAccountStore, "get").mockImplementation(store.get), spyOn(indexedAccountStore, "update").mockImplementation(store.update),
    spyOn(indexedAccountStore, "updateMany").mockImplementation(store.updateMany), spyOn(globalThis, "fetch").mockImplementation(Object.assign(fake.fetch, { preconnect: () => {} })));
});

afterEach(async () => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  for (const [key, value] of globals) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Object.defineProperty(globalThis, key, value);
  }
  globals.clear();
  await page.close();
});

const show = async (): Promise<void> => {
  await page.render(null);
  await page.render(<SettingsProvider><JoinedNotice /></SettingsProvider>);
};
const notice = (): Element | null => page.container.querySelector('[data-testid="joined-notice"]');

it.each([
  { hint: "d***@example.com", says: "Signed in to the account made with GitHub (d***@example.com)" },
  { hint: null, says: "Signed in to the account made with GitHub" },
])("tells a sign-in joined to an account by its email which account it is in (hint: $hint)", async ({ hint, says }) => {
  await signIn("github", memoryAccountStore());
  if (hint !== null) fake.emailHints = { acct_made: hint };
  await signIn("google");
  await show();
  expect(notice()?.querySelector(".device-notice-text > span")?.textContent).toBe(says);
});

it("tells it once: closed, it is not told again", async () => {
  await signIn("github", memoryAccountStore());
  await signIn("google");
  await show();
  await act(async () => { page.one<HTMLElement>('[data-testid="joined-notice"] [data-action="close"]').click(); });
  expect(notice()).toBeNull();
  await show();
  expect(notice()).toBeNull();
});

it("tells nothing to a sign-in with the account's own method", async () => {
  await signIn("github");
  await show();
  expect(notice()).toBeNull();
});

it("Not my account takes this method out of that account and signs this device out", async () => {
  const own = memoryAccountStore();
  await signIn("github", own);
  await signIn("google");
  await show();
  await act(async () => { page.one<HTMLElement>('[data-testid="joined-notice"] [data-action="not-my-account"]').click(); });
  expect(await store.get("session")).toBeUndefined();
  expect(notice()).toBeNull();
  const owner = new AccountService({ store: own, fetch: fake.fetch, lock: memoryLock() });
  expect((await owner.identities()).identities.map(({ provider }) => provider)).toEqual(["github"]);
  expect(fake.denied("acct_made", "google")).toBe(true);
});

it("Not my account, left open past the 24 hours, takes the method out the ordinary way, then signs this device out", async () => {
  const own = memoryAccountStore();
  await signIn("github", own);
  fake.addedByEmail("acct_made", "google");
  // signed in again with it a minute before it settles: recent enough for the ordinary removal
  ahead = METHOD_SETTLE_MS - 60_000;
  const token = fake.issueToken("acct_made", { provider: "google" });
  await store.set("session", { service: SERVICE, account: "acct_made", provider: "google", sign_in_id: "again", access_token: token, refresh_token: "r", expires_at: Date.now() + 3_600_000 });
  await show();
  expect(notice()).not.toBeNull();
  ahead = METHOD_SETTLE_MS + 60_000;
  await act(async () => { page.one<HTMLElement>('[data-testid="joined-notice"] [data-action="not-my-account"]').click(); });
  expect(notice()).toBeNull();
  expect(await store.get("session")).toBeUndefined();
  const owner = new AccountService({ store: own, fetch: fake.fetch, lock: memoryLock() });
  expect((await owner.identities()).identities.map(({ provider }) => provider)).toEqual(["github"]);
  expect(fake.denied("acct_made", "google")).toBe(true);
});

it("Not my account signs the hosted shell out of the account the notice named", async () => {
  await signIn("github", memoryAccountStore());
  await signIn("google");
  const signOut = mock((_shown?: Parameters<ShellAccount["signOut"]>[0]) => {});
  keepShellAccount({ signOut, leave: async () => ({ left: true, message: null }), deleteAccount: async () => null, signOutEverywhere: async () => null });
  try {
    await show();
    await act(async () => { page.one<HTMLElement>('[data-testid="joined-notice"] [data-action="not-my-account"]').click(); });
    expect(signOut.mock.calls).toEqual([[{ account: "acct_made", scope: null }]]);
  } finally { keepShellAccount(null); }
});
