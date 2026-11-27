import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { FakeAccountService, LINK_TOKEN_TTL_S, WEB_REDIRECT } from "../../../shared/account-service-fake.ts";
import { keepShellAccount, shellAccountActions } from "../account/hostedSignIn.ts";
import { AccountService } from "../account/service.ts";
import { beginSignIn, finishOwnSignIn, signInReturn } from "../account/signin.ts";
import { memoryAccountStore, type AccountProvider } from "../account/store.ts";
import { createAccountController } from "./accountController.ts";
import type { ShellDeviceStore } from "./device.ts";
import { createShellTestPage } from "./shell.test.tsx";
import { mountRelayShell } from "./shell.tsx";

const SERVICE = "https://account.example";
const PC = "a".repeat(32);
const noDevices: ShellDeviceStore = {
  async get() { return undefined; }, async list() { return []; }, async remove() {}, async removeRow() { return false; },
  async update(_id, change) { return change(undefined); },
};

async function setup(now: () => number = Date.now) {
  const fake = new FakeAccountService(now);
  fake.signInAs("github", "acct_1");
  const store = memoryAccountStore();
  const service = new AccountService({ store, fetch: fake.fetch });
  const start = (provider: AccountProvider) => beginSignIn(provider, { store, service: SERVICE, redirectUri: WEB_REDIRECT });
  const callback = async (url: string) => new URL((await fake.fetch(url)).headers.get("location") ?? "").hash;
  const signIn = async (provider: AccountProvider) => {
    const url = await start(provider);
    return finishOwnSignIn(url, await callback(url), { store, fetch: fake.fetch });
  };
  const before = await signIn("github");
  const controller = (openSignIn?: (url: string) => void) => createAccountController({
    container: Object.create(null), entryUrl: WEB_REDIRECT, label: "Test phone", store: noDevices, accountStore: store,
    accountService: SERVICE, accountFetch: fake.fetch, renderApp: () => ({ render() {}, unmount() {} }),
    ...(openSignIn ? { openSignIn } : {}),
  }, { active: () => false, changed: async () => {}, outdated: () => new Set() });
  // Drive a real OAuth return independently of the controller's start, so these cases can
  // distinguish sending a redemption from refusing one before it reaches the service.
  const pendingLink = async () => {
    if (before.sign_in_id === undefined) throw new Error("the sign-in has no id");
    const answer = await fake.fetch(`${SERVICE}/v1/identities/link`, {
      method: "POST", headers: { authorization: `Bearer ${before.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ provider: "google" }),
    });
    const { link_token } = await answer.json();
    if (typeof link_token !== "string") throw new Error("the service issued no link token");
    const url = await beginSignIn("google", {
      store, service: SERVICE, redirectUri: WEB_REDIRECT, linkToken: link_token,
      link: { account: before.account, sign_in_id: before.sign_in_id },
    });
    return signInReturn(await callback(url));
  };
  return { fake, store, service, before, controller, signIn, callback, pendingLink };
}

describe("linking sign-in methods in the hosted shell", () => {
  let browser: ReturnType<typeof createShellTestPage>;
  beforeEach(() => { browser = createShellTestPage(); });
  afterEach(() => browser.dispose());

  it("finishes a web link after reload, resumes its PC and does not register a sign-in key", async () => {
    const { fake, store, before, controller, callback } = await setup();
    const key = await store.key();
    if (before.sign_in_id === undefined) throw new Error("the sign-in has no id");
    const signInKey = { account: before.account, sign_in_id: before.sign_in_id, key, no: 1 };
    await store.set("signin_key", signInKey);
    let went: string | undefined;
    const first = controller((url) => { went = url; });
    await first.load(null);
    await first.addMethod("google", PC);
    first.dispose();
    if (went === undefined) throw new Error("the browser did not start the link");
    const state = new URL(went).searchParams.get("state") ?? "";
    expect((await store.get("pending"))?.[state]).toMatchObject({ pc: PC, link: { account: before.account, sign_in_id: before.sign_in_id } });
    const returned = signInReturn(await callback(went));
    const second = controller();
    let resumed: string | undefined;
    await second.load(returned, undefined, (outcome) => expect(outcome?.refused).toBeNull(), (id) => { resumed = id; });

    expect(resumed).toBe(PC);
    expect(second.methodsChange).toEqual({ provider: "google", error: null });
    expect(await store.get("session")).toMatchObject({ account: before.account, provider: "google" });
    expect((await store.get("session"))?.access_token).not.toBe(before.access_token);
    expect(await store.get("signin_key")).toEqual(signInKey);
    expect(fake.requests).not.toContain("POST /v1/devices/challenge");
    const { identities, history } = await second.methods();
    expect(identities.map(({ provider }) => provider).sort()).toEqual(["github", "google"]);
    expect(history).toEqual([{ kind: "add", provider: "google", at: expect.any(String), device_no: null }]);
  });

  it.each(["signed out", "another account", "another sign-in of the same account"])("never redeems a web link after %s replaces its sign-in", async (change) => {
    const { fake, store, service, signIn, controller, pendingLink } = await setup();
    const returned = await pendingLink();
    if (change === "signed out") await service.signOut();
    else if (change === "another account") {
      fake.signInAs("apple", "acct_other");
      await signIn("apple");
    } else await signIn("github");
    const replacement = await store.get("session");
    const requests = fake.requests.length;

    const reloaded = controller();
    await reloaded.load(returned);

    expect(fake.requests.slice(requests)).not.toContain("POST /v1/token");
    expect(await store.get("session")).toEqual(replacement);
    expect(reloaded.methodsChange).toEqual({ provider: "google", error: "signed_out" });
  });

  it("reports a web link's in_use refusal and keeps the existing account and methods", async () => {
    const { fake, store, before, service, signIn, controller, pendingLink } = await setup();
    fake.signInAs("google", "acct_other");
    await signIn("google");
    await store.set("session", before);
    const returned = await pendingLink();

    const reloaded = controller();
    await reloaded.load(returned);

    expect(reloaded.methodsChange).toEqual({ provider: "google", error: "in_use" });
    expect(await store.get("session")).toEqual(before);
    expect(await service.identities()).toMatchObject({ identities: [{ provider: "github" }], history: [] });
  });

  it.each(["identity_exists", "reauth_required"])("reports %s without leaving the page", async (error) => {
    let now = Date.now();
    const { before, store, controller } = await setup(() => now);
    if (error === "reauth_required") now += 11 * 60_000;
    const opened: string[] = [];
    const page = controller((url) => { opened.push(url); });
    const provider = error === "identity_exists" ? "github" : "google";

    await page.addMethod(provider);

    expect(page.methodsChange).toEqual({ provider, error });
    expect(opened).toEqual([]);
    expect(await store.get("session")).toEqual(before);
  });

  it("reports an expired web link without replacing the existing session", async () => {
    let now = Date.now();
    const { before, store, controller, callback } = await setup(() => now);
    let went: string | undefined;
    await controller((url) => { went = url; }).addMethod("google");
    if (went === undefined) throw new Error("the browser did not start the link");
    now += LINK_TOKEN_TTL_S * 1000;
    const reloaded = controller();

    await reloaded.load(signInReturn(await callback(went)));

    expect(reloaded.methodsChange).toEqual({ provider: "google", error: "expired" });
    expect(await store.get("session")).toEqual(before);
  });

  it("hands the page the shell opens the providers the account service offers, not the build's own list", async () => {
    const { fake, store } = await setup();
    try {
      await mountRelayShell({
        container: Object.create(null), entryUrl: WEB_REDIRECT, shellVersion: "0.0.0-test", label: "Test phone", store: noDevices,
        renderApp: () => ({ render() {}, unmount() {} }), createRoot: () => ({ render() {}, unmount() {} }),
        open: () => Promise.reject(new Error("no connection is expected here")), checkPc: async () => ({ kind: "offline", reason: "relay" }), reload: async () => {},
        accountService: SERVICE, accountProviders: ["github"], accountStore: store, accountFetch: fake.fetch,
      });
      expect(await shellAccountActions()?.offered?.()).toEqual(["github", "google", "apple"]);
    } finally {
      keepShellAccount(null);
    }
  });
});
