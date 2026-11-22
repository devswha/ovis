import { afterEach, beforeEach, expect, test } from "bun:test";
import { FakeAccountService, WEB_REDIRECT } from "../../../shared/account-service-fake.ts";
import { beginSignIn, finishSignIn, signInReturn } from "../account/signin.ts";
import { memoryAccountStore } from "../account/store.ts";
import { createAccountController } from "./accountController.ts";

const service = "https://account.ovis.sh";
const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
beforeEach(() => { Object.defineProperty(globalThis, "document", { value: new EventTarget(), configurable: true }); });
afterEach(() => { if (oldDocument) Object.defineProperty(globalThis, "document", oldDocument); else Reflect.deleteProperty(globalThis, "document"); });

function setup(fetch: FakeAccountService["fetch"]) {
  const store = memoryAccountStore();
  const controller = createAccountController({
    container: {} as HTMLElement, entryUrl: WEB_REDIRECT, label: "phone", renderApp: () => { throw new Error("unexpected mount"); },
    accountService: service, accountProviders: ["github"], accountStore: store, accountFetch: fetch,
    store: { async list() { return []; }, async get() { return undefined; }, async remove() {}, async removeRow() { return false; }, async update(_id, change) { return change(undefined); } },
  }, { active: () => false, changed: async () => {}, outdated: () => new Set() });
  return { store, controller };
}

test("a second browser OAuth return remains visible after the first account signs out everywhere", async () => {
  const fake = new FakeAccountService();
  const processed = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const { store, controller } = setup(async (input, init) => {
    const request = new Request(input, init);
    const response = await fake.fetch(request);
    if (new URL(request.url).pathname === "/v1/signout/all") { processed.resolve(); await release.promise; }
    return response;
  });
  const signIn = async (account: string) => {
    fake.signInAs("github", account);
    const start = await beginSignIn("github", { store, service, redirectUri: WEB_REDIRECT });
    const returned = signInReturn(new URL((await fake.fetch(start)).headers.get("location")!).hash)!;
    return finishSignIn(returned, { store, fetch: fake.fetch });
  };
  await signIn("acct_first");
  await controller.load(null);
  expect(controller.signedInAs?.account).toBe("acct_first");
  const pending = controller.signOutEverywhere();
  await processed.promise;
  const second = await signIn("acct_second");
  release.resolve();
  expect(await pending).toBeNull();
  expect((await store.get("session"))?.account).toBe("acct_second");
  expect((await fake.fetch(`${service}/v1/pcs`, { headers: { authorization: `Bearer ${second.access_token}` } })).status).toBe(200);
  expect(controller.signedInAs?.account, "sign-in shown after the earlier sign-out finished").toBe("acct_second");
});

test("a failed sign-out-all after the browser returns from reauthentication is visible", async () => {
  const fake = new FakeAccountService();
  fake.signInAs("github", "acct_first");
  let attempts = 0;
  const { store, controller } = setup(async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname === "/v1/signout/all") { attempts++; return Response.json({ error: { code: "unavailable", message: "retry" } }, { status: 503 }); }
    return fake.fetch(request);
  });
  const other = fake.issueToken("acct_first");
  const start = await beginSignIn("github", { store, service, redirectUri: WEB_REDIRECT, signOutEverywhere: "acct_first" });
  const returned = signInReturn(new URL((await fake.fetch(start)).headers.get("location")!).hash);
  expect(returned).not.toBeNull();
  await controller.load(returned);
  expect(attempts).toBe(1);
  expect((await fake.fetch(`${service}/v1/pcs`, { headers: { authorization: `Bearer ${other}` } })).status).toBe(200);
  expect(controller.state).toMatchObject({ kind: "signed-in" });
  expect(controller.state?.kind === "signed-in" && controller.state.error, "visible error after sign-out-all failed").toEqual(expect.any(String));
});
