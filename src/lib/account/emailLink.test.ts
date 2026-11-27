import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { FakeAccountService, METHOD_SETTLE_MS, WEB_REDIRECT } from "../../../shared/account-service-fake.ts";
import { setup } from "../relay/accountController.methods.test-helpers.ts";
import { accountMethods } from "../relay/accountMethods.ts";
import { openPage } from "../page.fixture.ts";
import { startDeviceSignIn } from "./deviceSignIn.ts";
import { nativeSignIn } from "./native.ts";
import { AccountService, offeredProviders, SignedOutError } from "./service.ts";
import { beginSignIn, finishSignIn, signInReturn } from "./signin.ts";
import { memoryAccountStore, memoryLock, type AccountProvider, type AccountSession, type AccountStore } from "./store.ts";

const SERVICE = "https://account.example";
const HOUR = 60 * 60_000;

/** A service with email linking on: the GitHub-made account `acct_made` holds the verified email a new Google or Apple sign-in has. */
function world({ emailLink = true as boolean | null } = {}) {
  let now = Date.parse("2026-11-20T12:00:00Z");
  const fake = new FakeAccountService(() => now);
  fake.emailLink = emailLink;
  fake.signInAs("github", "acct_made");
  fake.signInAs("google", "acct_new");
  fake.emailHolders = { google: "acct_made", apple: "acct_made" };
  fake.emailHints = { acct_made: "d***@example.com" };
  const starts: Record<string, unknown>[] = [];
  const grants: Record<string, unknown>[] = [];
  const fetch = async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path.endsWith("/device")) starts.push(await request.clone().json() as Record<string, unknown>);
    if (request.method === "POST" && path === "/v1/token") grants.push(await request.clone().json() as Record<string, unknown>);
    return fake.fetch(request);
  };
  const redirect = async (provider: AccountProvider, store: AccountStore, options: Partial<Parameters<typeof beginSignIn>[1]> = {}) => {
    const start = await beginSignIn(provider, { store, service: SERVICE, redirectUri: WEB_REDIRECT, ...options } as Parameters<typeof beginSignIn>[1]);
    const returned = signInReturn(new URL((await fake.fetch(start)).headers.get("location") ?? "").hash);
    if (returned === null) throw new Error("no sign-in came back");
    return { start: new URL(start), finish: () => finishSignIn(returned, { store, fetch }) };
  };
  const signIn = async (provider: AccountProvider, store = memoryAccountStore()) => {
    const session = await (await redirect(provider, store)).finish();
    return { session, store, service: new AccountService({ store, fetch, lock: memoryLock(), now: () => now }) };
  };
  return { fake, fetch, starts, grants, redirect, signIn, advance: (ms: number) => { now += ms; }, now: () => now };
}

describe("a first sign-in is linked by its verified email", () => {
  it.each(["github", "google", "apple"] as const)("asks for link=auto on a signed-out %s sign-in, which a service with linking on answers by the email and not with a hint", async (provider) => {
    const { redirect, signIn, fake } = world();
    await signIn("github");
    fake.emailMatches = { google: "github" };
    const { start, finish } = await redirect(provider, memoryAccountStore(), provider === "apple" ? {} : { create: "ask" });
    expect(start.searchParams.get("link")).toBe("auto");
    expect(await finish()).toMatchObject({ account: "acct_made", provider });
  });

  it("asks for neither on a sign-in again or a start that adds a method", async () => {
    const { redirect, signIn, fake } = world();
    const { store, service } = await signIn("github");
    const again = await redirect("github", store, { create: "ask" });
    expect(again.start.searchParams.has("link")).toBe(false);
    expect(again.start.searchParams.has("create")).toBe(false);
    const { linkToken } = await service.startMethodLink("google");
    const adding = await redirect("google", store, { linkToken });
    expect(adding.start.searchParams.has("link")).toBe(false);
    expect(fake.denied("acct_made", "google")).toBe(false);
  });

  it("joins a new Google sign-in to the account that holds its email, as a method still settling", async () => {
    const { signIn, now } = world();
    const made = await signIn("github");
    const { session } = await signIn("google");
    expect(session).toMatchObject({ account: "acct_made", provider: "google" });
    const list = await made.service.identities();
    expect(list.identities).toEqual([
      expect.objectContaining({ provider: "github" }),
      { provider: "google", added_at: new Date(now()).toISOString(), how: "email", deniable_until: new Date(now() + METHOD_SETTLE_MS).toISOString() },
    ]);
    expect(list.history[0]).toEqual({ kind: "add", provider: "google", at: new Date(now()).toISOString(), device_no: null, how: "email" });
  });

  it("says, to the sign-in that was joined, which account it is in; and nothing to the account's own method", async () => {
    const { signIn, now } = world();
    const made = await signIn("github");
    const joined = await signIn("google");
    expect(await joined.service.joined()).toEqual({
      how: "email", at: new Date(now()).toISOString(), settlesAt: new Date(now() + METHOD_SETTLE_MS).toISOString(),
      methods: ["github", "google"], emailHint: "d***@example.com",
    });
    expect(await made.service.joined()).toBeNull();
  });

  it("leaves an account that keeps a signed list alone: the sign-in makes an account of its own", async () => {
    const { signIn, fake } = world();
    const made = await signIn("github");
    await fake.forgeBirth("acct_made");
    expect((await signIn("google")).session.account).toBe("acct_new");
    expect((await made.service.identities()).identities.map(({ provider }) => provider)).toEqual(["github"]);
  });
});

describe("the device flow and the link page", () => {
  it("say whether the service links by email", async () => {
    expect((await offeredProviders(SERVICE, ["github"], { fetch: world().fake.fetch })).emailLink).toBe(true);
    expect((await offeredProviders(SERVICE, ["github"], { fetch: world({ emailLink: false }).fake.fetch })).emailLink).toBeUndefined();
    expect((await offeredProviders(SERVICE, ["github"], { fetch: world({ emailLink: null }).fake.fetch })).emailLink).toBeUndefined();
  });

  it.each([true, false])("send link only when the service offers it (offered: %p), to a service that refuses what it does not know", async (offered) => {
    const { fake, fetch, starts, signIn } = world({ emailLink: offered ? true : null });
    await signIn("github");
    starts.length = 0;
    fake.offerLinkPage(["github", "google"]);
    const options = { service: SERVICE, fetch, wait: async () => undefined, lock: memoryLock(), emailLink: offered };
    const device = await startDeviceSignIn({ ...options, store: memoryAccountStore(), provider: "google" });
    fake.approveDevice(device.userCode, "acct_new");
    const page = await startDeviceSignIn({ ...options, store: memoryAccountStore(), provider: "ovis" });
    fake.approveOnLinkPage(page.userCode, "acct_new", "google");
    expect(starts.map((body) => body.link ?? null)).toEqual(offered ? ["auto", "auto"] : [null, null]);
    const account = offered ? "acct_made" : "acct_new";
    expect(await device.finish(new AbortController().signal)).toMatchObject({ account, provider: "google" });
  });

  it("sends no link from a device that is already signed in", async () => {
    const { fetch, starts, signIn } = world();
    const { store } = await signIn("github");
    await startDeviceSignIn({ service: SERVICE, fetch, store, wait: async () => undefined, lock: memoryLock(), emailLink: true, provider: "github" });
    expect(starts).toEqual([expect.not.objectContaining({ link: expect.anything() })]);
  });
});

describe("a service that could not check the email", () => {
  it("is a sign-in to try again, from the provider's pages and from the device flow", async () => {
    const { fake, fetch, redirect } = world();
    fake.emailUnavailable.add("google");
    const back = await redirect("google", memoryAccountStore(), { create: "ask" });
    await expect(back.finish()).rejects.toMatchObject({ name: "SignInError", code: "email_unavailable" });
    const started = await startDeviceSignIn({ service: SERVICE, fetch, store: memoryAccountStore(), wait: async () => undefined, lock: memoryLock(), emailLink: true, provider: "google" });
    fake.approveDevice(started.userCode, "acct_new");
    await expect(started.finish(new AbortController().signal)).rejects.toMatchObject({ name: "SignInError", code: "email_unavailable" });
  });
});

describe("the hosted app's sign-in", () => {
  it("says the email could not be checked, as a sign-in to try again", async () => {
    const browser = openPage(WEB_REDIRECT);
    const fixture = await setup();
    await fixture.store.set("session", undefined);
    fixture.fake.emailLink = true;
    fixture.fake.emailUnavailable.add("google");
    const opened = Promise.withResolvers<string>();
    const first = fixture.controller(opened.resolve);
    const second = fixture.controller();
    try {
      first.signIn("google");
      const back = await fixture.callback(await opened.promise);
      await second.load(signInReturn(back));
      expect(second.state).toMatchObject({ kind: "signed-out", error: "Could not check your email. Try again." });
    } finally {
      first.dispose();
      second.dispose();
      await browser.close();
    }
  });
});

describe("a method that is still settling", () => {
  it("is refused what reshapes the account, with when it may", async () => {
    const { signIn, now } = world();
    await signIn("github");
    const joined = await signIn("google");
    const until = new Date(now() + METHOD_SETTLE_MS).toISOString();
    await expect(joined.service.removeIdentity("github")).rejects.toMatchObject({ status: 403, code: "method_settling", until });
    await expect(joined.service.signOutEverywhere()).rejects.toMatchObject({ status: 403, code: "method_settling", until });
  });
});

describe("Not me", () => {
  it("takes a method added by email back out of the account, and it is not linked again", async () => {
    const { signIn, fake } = world();
    const made = await signIn("github");
    const joined = await signIn("google");
    await made.service.notMe("google");
    const list = await made.service.identities();
    expect(list.identities.map(({ provider }) => provider)).toEqual(["github"]);
    expect(list.history[0]).toMatchObject({ kind: "remove", provider: "google", how: "not_me" });
    await expect(joined.service.identities()).rejects.toBeInstanceOf(SignedOutError);
    expect(fake.denied("acct_made", "google")).toBe(true);
    expect((await signIn("google")).session.account).toBe("acct_new");
  });

  it("takes the method's sign-in code not yet redeemed with it, which brings it back no more", async () => {
    const { signIn, redirect } = world();
    const made = await signIn("github");
    const pending = await redirect("google", memoryAccountStore());
    await made.service.notMe("google");
    await expect(pending.finish()).rejects.toThrow();
    expect((await made.service.identities()).identities.map(({ provider }) => provider)).toEqual(["github"]);
  });

  it.each([
    { case: "a method made by hand", target: "github", status: 409, code: "not_auto" },
    { case: "a method past its 24 hours", target: "google", late: true, status: 409, code: "settled" },
    { case: "a device code's sign-in", target: "google", device: true, status: 403, code: "web_sign_in_required" },
  ] as const)("is refused for $case", async ({ target, status, code, ...rest }) => {
    const { signIn, fake, advance, fetch } = world();
    await signIn("github");
    await signIn("google");
    if ("late" in rest) advance(METHOD_SETTLE_MS + HOUR);
    const caller = "device" in rest ? await deviceService(fake.issueToken("acct_made", { device: true }), fetch) : (await signIn("github")).service;
    await expect(caller.notMe(target)).rejects.toMatchObject({ status, code });
  });

  it("falls back to the ordinary removal once the method has settled", async () => {
    const { signIn, advance, fake } = world();
    await signIn("github");
    await signIn("google");
    advance(METHOD_SETTLE_MS + HOUR);
    const made = await signIn("github");
    const methods = accountMethods(made.service, { store: made.store, service: SERVICE, open: () => {}, changed: async () => {}, refresh: async () => {}, register: async () => {} });
    await methods.notMe("google", made.session);
    expect(methods.last).toMatchObject({ account: "acct_made", provider: "google", error: null });
    const list = await made.service.identities();
    expect(list.identities.map(({ provider }) => provider)).toEqual(["github"]);
    expect(list.history[0]).toEqual(expect.not.objectContaining({ how: expect.anything() }));
    expect(fake.denied("acct_made", "google")).toBe(true);
  });
});

describe("Sign in with Apple in the iOS app", () => {
  const capacitor = Object.getOwnPropertyDescriptor(globalThis, "Capacitor");
  afterEach(() => {
    if (capacitor === undefined) Reflect.deleteProperty(globalThis, "Capacitor");
    else Object.defineProperty(globalThis, "Capacitor", capacitor);
  });

  it("asks the grant to be linked and names no email: the service reads it from the signed token", async () => {
    const { fake, fetch, grants, signIn } = world();
    await signIn("github");
    grants.length = 0;
    Object.defineProperty(globalThis, "Capacitor", { configurable: true, value: {
      isNativePlatform: () => true, getPlatform: () => "ios", PluginHeaders: [{ name: "OvisAuth" }],
      nativePromise: async (_plugin: string, _method: string, { nonce }: { nonce: string }) => ({ idToken: fake.appleIdToken("acct_apple", nonce) }),
    } });
    const send = spyOn(globalThis, "fetch").mockImplementation(Object.assign(fetch, { preconnect: () => {} }));
    try {
      const session = await nativeSignIn("apple", { store: memoryAccountStore(), service: SERVICE });
      expect(grants).toEqual([{ grant_type: "apple_id_token", id_token: expect.any(String), nonce: expect.any(String), link: "auto" }]);
      expect(session).toMatchObject({ account: "acct_made", provider: "apple" });
    } finally { send.mockRestore(); }
  });

  it("keeps Apple as a way in of the account it made, which a later sign-in by the same email joins", async () => {
    const { fake, fetch, signIn } = world();
    fake.emailHolders = { google: "acct_apple" };
    Object.defineProperty(globalThis, "Capacitor", { configurable: true, value: {
      isNativePlatform: () => true, getPlatform: () => "ios", PluginHeaders: [{ name: "OvisAuth" }],
      nativePromise: async (_plugin: string, _method: string, { nonce }: { nonce: string }) => ({ idToken: fake.appleIdToken("acct_apple", nonce) }),
    } });
    const send = spyOn(globalThis, "fetch").mockImplementation(Object.assign(fetch, { preconnect: () => {} }));
    try {
      expect(await nativeSignIn("apple", { store: memoryAccountStore(), service: SERVICE })).toMatchObject({ account: "acct_apple", provider: "apple" });
    } finally { send.mockRestore(); }
    expect((await signIn("google")).session).toMatchObject({ account: "acct_apple", provider: "google" });
  });
});

/** The service as a device code's sign-in to `acct_made` (a PC's) calls it. */
async function deviceService(token: string, fetch: (input: Request | string | URL, init?: RequestInit) => Promise<Response>): Promise<AccountService> {
  const store = memoryAccountStore();
  const session: AccountSession = { service: SERVICE, account: "acct_made", provider: "github", sign_in_id: "device", access_token: token, refresh_token: "r", expires_at: Date.now() + HOUR };
  await store.set("session", session);
  return new AccountService({ store, fetch, lock: memoryLock() });
}
