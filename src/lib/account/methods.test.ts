import { describe, expect, it } from "bun:test";
import { FakeAccountService, WEB_REDIRECT } from "../../../shared/account-service-fake.ts";
import { startDeviceSignIn } from "./deviceSignIn.ts";
import { AccountService, offeredProviders } from "./service.ts";
import { beginSignIn, finishSignIn, signInReturn } from "./signin.ts";
import type { AccountProvider, AccountStore } from "./store.ts";
import { memoryAccountStore, memoryLock } from "./store.ts";

const SERVICE = "https://account.example";

async function redirectSignIn(fake: FakeAccountService, provider: AccountProvider, store: AccountStore, linkToken?: string) {
  const start = await beginSignIn(provider, { store, service: SERVICE, redirectUri: WEB_REDIRECT, ...(linkToken ? { linkToken } : {}) });
  const returned = signInReturn(new URL((await fake.fetch(start)).headers.get("location") ?? "").hash);
  if (returned === null) throw new Error("no sign-in came back");
  return finishSignIn(returned, { store, fetch: fake.fetch });
}

describe("the sign-ins a service offers", () => {
  it("lists Google only when the service says it is set up for it, and a PC's page only the device ones", async () => {
    const fake = new FakeAccountService();
    fake.offer(["github", "google"], ["github"]);
    expect(await offeredProviders(SERVICE, ["github"], { fetch: fake.fetch })).toEqual({ providers: ["github", "google"], device: ["github"] });
    fake.offer(["github"], ["github"]);
    expect(await offeredProviders(SERVICE, ["github"], { fetch: fake.fetch })).toEqual({ providers: ["github"], device: ["github"] });
  });

  it("keeps the build's own list when the service cannot say, so no Google button leads nowhere", async () => {
    const down = async () => new Response("", { status: 404 });
    expect(await offeredProviders(SERVICE, ["github", "apple"], { fetch: down })).toEqual({ providers: ["github", "apple"], device: ["github"] });
    const offline = async (): Promise<Response> => { throw new TypeError("offline"); };
    expect(await offeredProviders(SERVICE, ["github"], { fetch: offline })).toEqual({ providers: ["github"], device: ["github"] });
    const odd = async () => Response.json({ providers: ["gitlab"], device: "google" });
    expect(await offeredProviders(SERVICE, ["github"], { fetch: odd })).toEqual({ providers: ["github"], device: ["github"] });
  });
});

describe("signing in with Google", () => {
  it("signs in through the redirect with PKCE, as GitHub does", async () => {
    const fake = new FakeAccountService();
    fake.signInAs("google", "acct_g");
    const session = await redirectSignIn(fake, "google", memoryAccountStore());
    expect(session).toMatchObject({ account: "acct_g", provider: "google" });
  });

  it("signs in a PC's own page with Google's device flow and links only to Google's device page", async () => {
    const fake = new FakeAccountService();
    const store = memoryAccountStore();
    const started = await startDeviceSignIn({ service: SERVICE, store, fetch: fake.fetch, provider: "google", wait: async () => undefined, lock: memoryLock() });
    expect(started.verificationUri).toBe("https://www.google.com/device");
    fake.approveDevice(started.userCode, "acct_g");
    expect(await started.finish(new AbortController().signal)).toMatchObject({ account: "acct_g", provider: "google" });
    expect(fake.requests).toContain("POST /v1/signin/google/device");
  });
});

describe("sign-in methods", () => {
  it("adds Google to the signed-in account on purpose, keeps the account, and ends the sign-in it replaced", async () => {
    const fake = new FakeAccountService();
    fake.signInAs("github", "acct_1");
    const store = memoryAccountStore();
    const before = await redirectSignIn(fake, "github", store);
    const service = new AccountService({ store, fetch: fake.fetch, lock: memoryLock() });
    const after = await service.addMethod("google", (linkToken) => redirectSignIn(fake, "google", store, linkToken));
    expect(after).toMatchObject({ account: "acct_1", provider: "google" });
    expect((await service.identities()).map((identity) => identity.provider).sort()).toEqual(["github", "google"]);
    expect(fake.requests).toContain("POST /v1/signout");
    // the replaced sign-in's tokens are over
    expect((await fake.fetch(new Request(`${SERVICE}/v1/pcs`, { headers: { authorization: `Bearer ${before.access_token}` } }))).status).toBe(401);
  });

  it("never joins a Google identity another account already has, and leaves both accounts as they were", async () => {
    const fake = new FakeAccountService();
    fake.signInAs("google", "acct_other");
    await redirectSignIn(fake, "google", memoryAccountStore());
    fake.signInAs("github", "acct_1");
    const store = memoryAccountStore();
    await redirectSignIn(fake, "github", store);
    const service = new AccountService({ store, fetch: fake.fetch, lock: memoryLock() });
    await expect(service.addMethod("google", (linkToken) => redirectSignIn(fake, "google", store, linkToken))).rejects.toMatchObject({ code: "in_use" });
    expect((await service.identities()).map((identity) => identity.provider)).toEqual(["github"]);
    expect((await store.get("session"))?.account).toBe("acct_1");
  });

  it("removes a method while another remains, and refuses to remove the last one", async () => {
    const fake = new FakeAccountService();
    fake.signInAs("github", "acct_1");
    const store = memoryAccountStore();
    await redirectSignIn(fake, "github", store);
    const service = new AccountService({ store, fetch: fake.fetch, lock: memoryLock() });
    await service.addMethod("google", (linkToken) => redirectSignIn(fake, "google", store, linkToken));
    await service.removeIdentity("github");
    expect((await service.identities()).map((identity) => identity.provider)).toEqual(["google"]);
    await expect(service.removeIdentity("google")).rejects.toMatchObject({ status: 409, code: "last_identity" });
  });
});
