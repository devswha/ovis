import { describe, expect, it } from "bun:test";
import { FakeAccountService, LIMIT_WINDOW_MS, WEB_REDIRECT } from "../../../shared/account-service-fake.ts";
import { desktopSignIn } from "./desktop.ts";
import { startDeviceSignIn } from "./deviceSignIn.ts";
import { AccountService, endSignIn, offeredProviders, requestToken, SignedOutError } from "./service.ts";
import { beginSignIn, finishSignIn, signInReturn } from "./signin.ts";
import type { AccountProvider, AccountStore } from "./store.ts";
import { memoryAccountStore, memoryLock } from "./store.ts";

const SERVICE = "https://account.example";

async function redirectSignIn(fake: FakeAccountService, provider: AccountProvider, store: AccountStore, link?: { linkToken: string; bearer?: string }) {
  const start = await beginSignIn(provider, { store, service: SERVICE, redirectUri: WEB_REDIRECT, ...(link ? { linkToken: link.linkToken } : {}) });
  const returned = signInReturn(new URL((await fake.fetch(start)).headers.get("location") ?? "").hash);
  if (returned === null) throw new Error("no sign-in came back");
  return finishSignIn(returned, { store, fetch: fake.fetch, ...(link?.bearer ? { bearer: link.bearer } : {}) });
}

async function linkToken(fake: FakeAccountService, bearer: string, provider: AccountProvider): Promise<string> {
  const answer = await fake.fetch(new Request(`${SERVICE}/v1/identities/link`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: JSON.stringify({ provider }) }));
  return (await answer.json() as { link_token: string }).link_token;
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
    const after = await service.addMethod("google", (linkToken, bearer) => redirectSignIn(fake, "google", store, { linkToken, bearer }));
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
    await expect(service.addMethod("google", (linkToken, bearer) => redirectSignIn(fake, "google", store, { linkToken, bearer }))).rejects.toMatchObject({ code: "in_use" });
    expect((await service.identities()).map((identity) => identity.provider)).toEqual(["github"]);
    expect((await store.get("session"))?.account).toBe("acct_1");
  });

  it("removes a method while another remains, and refuses to remove the last one", async () => {
    const fake = new FakeAccountService();
    fake.signInAs("github", "acct_1");
    const store = memoryAccountStore();
    await redirectSignIn(fake, "github", store);
    const service = new AccountService({ store, fetch: fake.fetch, lock: memoryLock() });
    await service.addMethod("google", (linkToken, bearer) => redirectSignIn(fake, "google", store, { linkToken, bearer }));
    await service.removeIdentity("github");
    expect((await service.identities()).map((identity) => identity.provider)).toEqual(["google"]);
    await expect(service.removeIdentity("google")).rejects.toMatchObject({ status: 409, code: "last_identity" });
  });

  it("links nothing until the link's own account redeems the code, so a link token in someone else's sign-in adds nobody", async () => {
    const fake = new FakeAccountService();
    fake.signInAs("github", "acct_attacker");
    const attacker = memoryAccountStore();
    const session = await redirectSignIn(fake, "github", attacker);
    const token = await linkToken(fake, session.access_token, "google");
    // the victim opens the attacker's link URL: their own Google identity, their own client, no attacker token
    fake.signInAs("google", "acct_victim");
    const victim = memoryAccountStore();
    await expect(redirectSignIn(fake, "google", victim, { linkToken: token })).rejects.toMatchObject({ code: "invalid_grant" });
    const service = new AccountService({ store: attacker, fetch: fake.fetch, lock: memoryLock() });
    expect((await service.identities()).map((identity) => identity.provider)).toEqual(["github"]);
    // the victim's own Google sign-in still lands in their own account
    expect((await redirectSignIn(fake, "google", memoryAccountStore())).account).toBe("acct_victim");
  });

  it("refuses a spent link token instead of signing in plainly, and keeps the session and the account", async () => {
    const fake = new FakeAccountService();
    fake.signInAs("github", "acct_1");
    const store = memoryAccountStore();
    const before = await redirectSignIn(fake, "github", store);
    const service = new AccountService({ store, fetch: fake.fetch, lock: memoryLock() });
    await expect(service.addMethod("google", async (token, bearer) => {
      await redirectSignIn(fake, "google", memoryAccountStore(), { linkToken: token, bearer });
      return redirectSignIn(fake, "google", store, { linkToken: token, bearer });
    })).rejects.toMatchObject({ code: "expired" });
    expect(await store.get("session")).toEqual(before);
  });

  it("ends and refuses an answer for another account, keeping the session it had", async () => {
    const fake = new FakeAccountService();
    fake.signInAs("github", "acct_1");
    fake.signInAs("google", "acct_other");
    const store = memoryAccountStore();
    const before = await redirectSignIn(fake, "github", store);
    const service = new AccountService({ store, fetch: fake.fetch, lock: memoryLock() });
    await expect(service.addMethod("google", () => redirectSignIn(fake, "google", memoryAccountStore()))).rejects.toMatchObject({ code: "invalid_answer" });
    expect(await store.get("session")).toEqual(before);
    expect(fake.requests.filter((request) => request === "POST /v1/signout")).toHaveLength(1);
  });

  it("adds a method from the desktop app through its loopback return, redeemed with the account's token", async () => {
    const fake = new FakeAccountService();
    fake.signInAs("github", "acct_1");
    const store = memoryAccountStore();
    const bridge = {
      service: SERVICE,
      start: async () => "http://127.0.0.1:4567/callback",
      open: async (url: string) => new URL((await fake.fetch(url)).headers.get("location") ?? "").search.slice(1),
    };
    // the page redeems with the browser's fetch, as the desktop app's page does
    const real = globalThis.fetch;
    globalThis.fetch = Object.assign(fake.fetch, { preconnect: real.preconnect });
    try {
      await desktopSignIn("github", bridge, store);
      const service = new AccountService({ store, fetch: fake.fetch, lock: memoryLock() });
      const after = await service.addMethod("google", (token, bearer) => desktopSignIn("google", bridge, store, { linkToken: token, bearer }));
      expect(after).toMatchObject({ account: "acct_1", provider: "google" });
    } finally {
      globalThis.fetch = real;
    }
  });


  it("redeems a link only with the very sign-in that asked for it, not another sign-in of the same account", async () => {
    const fake = new FakeAccountService();
    fake.signInAs("github", "acct_1");
    const asking = await redirectSignIn(fake, "github", memoryAccountStore());
    const other = await redirectSignIn(fake, "github", memoryAccountStore());
    const token = await linkToken(fake, asking.access_token, "google");
    await expect(redirectSignIn(fake, "google", memoryAccountStore(), { linkToken: token, bearer: other.access_token })).rejects.toMatchObject({ code: "invalid_grant" });
  });

  it("asks for a fresh sign-in to add or remove a method once the sign-in is over ten minutes old, and lists methods with no name", async () => {
    let now = Date.now();
    const fake = new FakeAccountService(() => now);
    fake.signInAs("github", "acct_1");
    const store = memoryAccountStore();
    await redirectSignIn(fake, "github", store);
    const service = new AccountService({ store, fetch: fake.fetch, lock: memoryLock(), now: () => now });
    await service.addMethod("google", (token, bearer) => redirectSignIn(fake, "google", store, { linkToken: token, bearer }));
    expect(await service.identities()).toEqual([{ provider: "github", added_at: expect.any(String) }, { provider: "google", added_at: expect.any(String) }]);
    now += 11 * 60_000;
    await expect(service.removeIdentity("github")).rejects.toMatchObject({ status: 403, code: "reauth_required" });
    await expect(service.addMethod("apple", async () => { throw new Error("no sign-in should start"); })).rejects.toMatchObject({ code: "reauth_required" });
    await redirectSignIn(fake, "google", store);
    await service.removeIdentity("github");
    expect((await service.identities()).map((identity) => identity.provider)).toEqual(["google"]);
  });

  it("stores nothing and ends the new sign-in when the account was signed out while the link finished", async () => {
    const fake = new FakeAccountService();
    fake.signInAs("github", "acct_1");
    const store = memoryAccountStore();
    await redirectSignIn(fake, "github", store);
    const lock = memoryLock();
    const service = new AccountService({ store, fetch: fake.fetch, lock });
    let linked: Awaited<ReturnType<typeof redirectSignIn>> | undefined;
    await expect(service.addMethod("google", async (token, bearer) => {
      linked = await redirectSignIn(fake, "google", store, { linkToken: token, bearer });
      // another tab signs out while the token answer is still on its way
      await new AccountService({ store, fetch: fake.fetch, lock }).signOut();
      return linked;
    })).rejects.toBeInstanceOf(SignedOutError);
    expect(await store.get("session")).toBeUndefined();
    expect((await fake.fetch(new Request(`${SERVICE}/v1/pcs`, { headers: { authorization: `Bearer ${linked?.access_token}` } }))).status).toBe(401);
  });

  it("keeps trying to end a link's sign-in after a sign-out when the service refuses the first try", async () => {
    let now = Date.now();
    const fake = new FakeAccountService(() => now);
    fake.signInAs("github", "acct_1");
    const store = memoryAccountStore();
    await redirectSignIn(fake, "github", store);
    const lock = memoryLock();
    const service = new AccountService({ store, fetch: fake.fetch, lock, now: () => now });
    let linked: Awaited<ReturnType<typeof redirectSignIn>> | undefined;
    await expect(service.addMethod("google", async (token, bearer) => {
      linked = await redirectSignIn(fake, "google", store, { linkToken: token, bearer });
      await new AccountService({ store, fetch: fake.fetch, lock, now: () => now }).signOut();
      // the account's request limit runs out before the answer arrives: ending it answers 429
      while ((await fake.fetch(new Request(`${SERVICE}/v1/pcs`, { headers: { authorization: `Bearer ${linked.access_token}` } }))).status !== 429);
      return linked;
    })).rejects.toBeInstanceOf(SignedOutError);
    expect(await store.get("session")).toBeUndefined();
    now += LIMIT_WINDOW_MS;
    await service.endLeftovers();
    await expect(requestToken(SERVICE, { grant_type: "refresh_token", refresh_token: linked?.refresh_token ?? "" }, { fetch: fake.fetch })).rejects.toMatchObject({ status: 400 });
  });
});

describe("signing out while a sign-in is on its way", () => {
  it("ends a sign-in again that comes back after a sign-out, so a method change waiting on it finds no session", async () => {
    const fake = new FakeAccountService();
    fake.signInAs("github", "acct_1");
    const store = memoryAccountStore();
    await redirectSignIn(fake, "github", store);
    // Sign in again starts, and another tab signs out before it comes back
    const start = await beginSignIn("github", { store, service: SERVICE, redirectUri: WEB_REDIRECT });
    const returned = signInReturn(new URL((await fake.fetch(start)).headers.get("location") ?? "").hash);
    if (returned === null) throw new Error("no sign-in came back");
    const lock = memoryLock();
    await new AccountService({ store, fetch: fake.fetch, lock }).signOut();
    await expect(finishSignIn(returned, { store, fetch: fake.fetch })).rejects.toBeInstanceOf(SignedOutError);
    expect(await store.get("session")).toBeUndefined();
    // its code is never redeemed, so no session of it exists at the service
    expect(fake.requests.filter((request) => request === "POST /v1/token")).toHaveLength(1);
    await expect(new AccountService({ store, fetch: fake.fetch, lock }).removeIdentity("google")).rejects.toBeInstanceOf(SignedOutError);
  });

  it("ends a device sign-in that is approved after a sign-out instead of storing it", async () => {
    const fake = new FakeAccountService();
    fake.signInAs("github", "acct_1");
    const store = memoryAccountStore();
    await redirectSignIn(fake, "github", store);
    const lock = memoryLock();
    const started = await startDeviceSignIn({ service: SERVICE, store, fetch: fake.fetch, provider: "github", wait: async () => undefined, lock });
    await new AccountService({ store, fetch: fake.fetch, lock }).signOut();
    fake.approveDevice(started.userCode, "acct_1");
    await expect(started.finish(new AbortController().signal)).rejects.toBeInstanceOf(SignedOutError);
    expect(await store.get("session")).toBeUndefined();
    expect(fake.requests.filter((request) => request === "POST /v1/signout")).toHaveLength(2);
  });

  it("ends a desktop sign-in whose sign-out came while the app was still opening its loopback", async () => {
    const fake = new FakeAccountService();
    fake.signInAs("github", "acct_1");
    const store = memoryAccountStore();
    await redirectSignIn(fake, "github", store);
    let opened: () => void = () => undefined;
    const bridge = {
      service: SERVICE,
      start: () => new Promise<string>((resolve) => { opened = () => resolve("http://127.0.0.1:4567/callback"); }),
      open: async (url: string) => new URL((await fake.fetch(url)).headers.get("location") ?? "").search.slice(1),
    };
    const real = globalThis.fetch;
    globalThis.fetch = Object.assign(fake.fetch, { preconnect: real.preconnect });
    try {
      const signingIn = desktopSignIn("github", bridge, store);
      await new AccountService({ store, fetch: fake.fetch, lock: memoryLock() }).signOut();
      opened();
      await expect(signingIn).rejects.toBeInstanceOf(SignedOutError);
    } finally {
      globalThis.fetch = real;
    }
    expect(await store.get("session")).toBeUndefined();
  });
});

describe("ending a sign-in at the service", () => {
  const refreshes = (fake: FakeAccountService, refreshToken: string) => requestToken(SERVICE, { grant_type: "refresh_token", refresh_token: refreshToken }, { fetch: fake.fetch });

  it("does not take a 401 to the sign-out as the end of the sign-in, and ends it with its refresh token", async () => {
    const fake = new FakeAccountService();
    fake.signInAs("github", "acct_1");
    const store = memoryAccountStore();
    const session = await redirectSignIn(fake, "github", store);
    let refused = false;
    // the access token ran out on the way: the first sign-out is answered 401 without ending anything
    const fetch = async (input: Request | string | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (!refused && new URL(request.url).pathname === "/v1/signout") { refused = true; return Response.json({ error: { code: "unauthorized" } }, { status: 401 }); }
      return fake.fetch(request);
    };
    await new AccountService({ store, fetch, lock: memoryLock() }).signOut();
    await expect(refreshes(fake, session.refresh_token)).rejects.toMatchObject({ status: 400 });
  });

  it("keeps a sign-out the service refused through leaving the account, and ends it later", async () => {
    const fake = new FakeAccountService();
    fake.signInAs("github", "acct_1");
    const store = memoryAccountStore();
    const session = await redirectSignIn(fake, "github", store);
    const down = async (input: Request | string | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      return new URL(request.url).pathname === "/v1/signout" ? new Response("", { status: 503 }) : fake.fetch(request);
    };
    await expect(new AccountService({ store, fetch: down, lock: memoryLock() }).signOut()).rejects.toMatchObject({ status: 503 });
    await store.clear();
    await new AccountService({ store, fetch: fake.fetch, lock: memoryLock() }).endLeftovers();
    await expect(refreshes(fake, session.refresh_token)).rejects.toMatchObject({ status: 400 });
    expect(await store.get("ending")).toBeUndefined();
  });

  it("has the sign-in in the list to end before its sign-out is answered, so closing the page then loses nothing", async () => {
    const fake = new FakeAccountService();
    fake.signInAs("github", "acct_1");
    const store = memoryAccountStore();
    const session = await redirectSignIn(fake, "github", store);
    let arrived: () => void = () => undefined;
    const waiting = new Promise<void>((resolve) => { arrived = resolve; });
    // the page closes while the sign-out is on its way: it is never answered
    const hangs = async (input: Request | string | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (new URL(request.url).pathname === "/v1/signout") { arrived(); return new Promise<Response>(() => undefined); }
      return fake.fetch(request);
    };
    void new AccountService({ store, fetch: hangs, lock: memoryLock() }).signOut();
    await waiting;
    expect(await store.get("session")).toBeUndefined();
    await new AccountService({ store, fetch: fake.fetch, lock: memoryLock() }).endLeftovers();
    await expect(refreshes(fake, session.refresh_token)).rejects.toMatchObject({ status: 400 });
  });

  it("never drops a sign-in it could not end, however many there are", async () => {
    const fake = new FakeAccountService();
    fake.signInAs("github", "acct_1");
    const store = memoryAccountStore();
    const down = async () => new Response("", { status: 503 });
    for (let count = 0; count < 20; count++) await endSignIn(await redirectSignIn(fake, "github", memoryAccountStore()), "a test sign-in", { store, fetch: down });
    expect(await store.get("ending")).toHaveLength(20);
  });

  it("ends the sign-in a new sign-in replaces, as Sign in again does", async () => {
    const fake = new FakeAccountService();
    fake.signInAs("github", "acct_1");
    const store = memoryAccountStore();
    const previous = await redirectSignIn(fake, "github", store);
    await redirectSignIn(fake, "github", store);
    await expect(refreshes(fake, previous.refresh_token)).rejects.toMatchObject({ status: 400 });
  });

  it("does not keep a link across a sign-out, even when the same account signed in again after it", async () => {
    const fake = new FakeAccountService();
    fake.signInAs("github", "acct_1");
    const store = memoryAccountStore();
    await redirectSignIn(fake, "github", store);
    const lock = memoryLock();
    let linked: Awaited<ReturnType<typeof redirectSignIn>> | undefined;
    await expect(new AccountService({ store, fetch: fake.fetch, lock }).addMethod("google", async (token, bearer) => {
      linked = await redirectSignIn(fake, "google", store, { linkToken: token, bearer });
      await new AccountService({ store, fetch: fake.fetch, lock }).signOut();
      await redirectSignIn(fake, "github", store);
      return linked;
    })).rejects.toBeInstanceOf(SignedOutError);
    await expect(refreshes(fake, linked?.refresh_token ?? "")).rejects.toMatchObject({ status: 400 });
  });

  it("ends a refresh whose answer comes after another sign-in took its place", async () => {
    let now = Date.now();
    const fake = new FakeAccountService(() => now);
    fake.signInAs("github", "acct_1");
    const store = memoryAccountStore();
    await redirectSignIn(fake, "github", store);
    now += 2 * 60 * 60_000;
    let release: () => void = () => undefined;
    let arrived: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const waiting = new Promise<void>((resolve) => { arrived = resolve; });
    let rotated = "";
    const delayed = async (input: Request | string | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const answer = await fake.fetch(request);
      if (rotated === "" && new URL(request.url).pathname === "/v1/token") {
        rotated = (await answer.clone().json() as { refresh_token: string }).refresh_token;
        arrived();
        await gate;
      }
      return answer;
    };
    const reading = new AccountService({ store, fetch: delayed, lock: memoryLock(), now: () => now }).identities();
    await waiting;
    await redirectSignIn(fake, "github", store);
    release();
    await expect(reading).rejects.toBeInstanceOf(SignedOutError);
    await expect(refreshes(fake, rotated)).rejects.toMatchObject({ status: 400 });
  });

  it("ends the sign-in a device sign-in replaces", async () => {
    const fake = new FakeAccountService();
    fake.signInAs("github", "acct_1");
    const store = memoryAccountStore();
    const previous = await redirectSignIn(fake, "github", store);
    const started = await startDeviceSignIn({ service: SERVICE, store, fetch: fake.fetch, provider: "github", wait: async () => undefined, lock: memoryLock() });
    fake.approveDevice(started.userCode, "acct_1");
    await started.finish(new AbortController().signal);
    await expect(refreshes(fake, previous.refresh_token)).rejects.toMatchObject({ status: 400 });
  });

  it("never repeats a request refused for the replaced sign-in with another account's sign-in", async () => {
    const fake = new FakeAccountService();
    fake.signInAs("github", "acct_a");
    const store = memoryAccountStore();
    await redirectSignIn(fake, "github", store);
    let release: () => void = () => undefined;
    let arrived: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const waiting = new Promise<void>((resolve) => { arrived = resolve; });
    let held = false;
    const delayed = async (input: Request | string | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (!held && new URL(request.url).pathname === "/v1/identities") { held = true; arrived(); await gate; }
      return fake.fetch(request);
    };
    const reading = new AccountService({ store, fetch: delayed, lock: memoryLock() }).identities();
    await waiting;
    // account B signs in here while the request is on its way; the sign-in it replaced ends
    fake.signInAs("github", "acct_b");
    await redirectSignIn(fake, "github", store);
    release();
    await expect(reading).rejects.toBeInstanceOf(SignedOutError);
    expect((await store.get("session"))?.account).toBe("acct_b");
  });

  it("never repeats a method removal with a sign-in made after a sign-out, even of the same account", async () => {
    const fake = new FakeAccountService();
    fake.signInAs("github", "acct_1");
    const store = memoryAccountStore();
    await redirectSignIn(fake, "github", store);
    const lock = memoryLock();
    await new AccountService({ store, fetch: fake.fetch, lock }).addMethod("google", (token, bearer) => redirectSignIn(fake, "google", store, { linkToken: token, bearer }));
    let release: () => void = () => undefined;
    let arrived: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const waiting = new Promise<void>((resolve) => { arrived = resolve; });
    let held = false;
    const delayed = async (input: Request | string | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (!held && request.method === "DELETE") { held = true; arrived(); await gate; }
      return fake.fetch(request);
    };
    const removing = new AccountService({ store, fetch: delayed, lock }).removeIdentity("github");
    await waiting;
    await new AccountService({ store, fetch: fake.fetch, lock }).signOut();
    await redirectSignIn(fake, "github", store);
    release();
    await expect(removing).rejects.toBeInstanceOf(SignedOutError);
    expect((await new AccountService({ store, fetch: fake.fetch, lock }).identities()).map((identity) => identity.provider).sort()).toEqual(["github", "google"]);
  });

  it("does not redeem a link that comes back after a sign-out whose revoke the service refused", async () => {
    const fake = new FakeAccountService();
    fake.signInAs("github", "acct_1");
    const store = memoryAccountStore();
    const session = await redirectSignIn(fake, "github", store);
    const token = await linkToken(fake, session.access_token, "google");
    const start = await beginSignIn("google", { store, service: SERVICE, redirectUri: WEB_REDIRECT, linkToken: token });
    const returned = signInReturn(new URL((await fake.fetch(start)).headers.get("location") ?? "").hash);
    if (returned === null) throw new Error("no sign-in came back");
    const down = async (input: Request | string | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      return new URL(request.url).pathname === "/v1/signout" ? new Response("", { status: 503 }) : fake.fetch(request);
    };
    await expect(new AccountService({ store, fetch: down, lock: memoryLock() }).signOut()).rejects.toMatchObject({ status: 503 });
    await expect(finishSignIn(returned, { store, fetch: fake.fetch, bearer: session.access_token })).rejects.toBeInstanceOf(SignedOutError);
    const listed = await fake.fetch(new Request(`${SERVICE}/v1/identities`, { headers: { authorization: `Bearer ${session.access_token}` } }));
    expect((await listed.json() as { identities: { provider: string }[] }).identities.map((identity) => identity.provider)).toEqual(["github"]);
  });
});
