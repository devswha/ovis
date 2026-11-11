import { createShellTestPage } from "./shell.test.tsx";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ReactElement } from "react";

import { FakeAccountService } from "../../../shared/account-service-fake.ts";
import { RelayShell, type RelayShellProps } from "../../components/RelayShell.tsx";
import { memoryAccountStore } from "../account/store.ts";
import type { RelayDeviceStore } from "./device.ts";
import { mountRelayShell, type RelayShellMount } from "./shell.tsx";

const SERVICE = "https://account.ovis.sh";
const ACCOUNT = "acct-test";

/** Spins the microtask queue until `holds`, or fails naming `what`: the shell's reads are promises alone, so no clock takes part. */
async function until(holds: () => boolean, what: string): Promise<void> {
  for (let turn = 0; turn < 10_000; turn++) { if (holds()) return; await Promise.resolve(); }
  throw new Error(`gave up waiting for ${what}`);
}

describe("deleting the account from the hosted shell", () => {
  let browser: ReturnType<typeof createShellTestPage>;
  let rendered: ReactElement[];
  beforeEach(() => { browser = createShellTestPage(); rendered = []; });
  afterEach(() => { browser.dispose(); });

  const noDevices: RelayDeviceStore = {
    async get() { return undefined; }, async list() { return []; }, async remove() {},
    async update(_serverId, change) { return change(undefined); },
  };
  const shellProps = (element: ReactElement): RelayShellProps => {
    let node = element;
    while (node.type !== RelayShell) node = (node.props as { children: ReactElement }).children;
    return node.props as RelayShellProps;
  };
  const last = (): RelayShellProps => shellProps(rendered.at(-1)!);
  const accountView = () => { const { state } = last(); return state.kind === "list" || state.kind === "empty" ? state.account ?? null : null; };

  async function signedInShell(clock: () => number = Date.now) {
    const fake = new FakeAccountService(clock);
    const accountStore = memoryAccountStore();
    await accountStore.set("session", { service: SERVICE, account: ACCOUNT, provider: "github", access_token: fake.issueToken(ACCOUNT), refresh_token: "refresh", expires_at: clock() + 3_600_000 });
    const mount: RelayShellMount = {
      container: {} as HTMLElement, entryUrl: "https://app.ovis.sh/", shellVersion: "0.0.0-test", label: "Test phone",
      renderApp: () => { throw new Error("the app is not expected here"); },
      createRoot: () => ({ render(element: ReactElement) { rendered.push(element); }, unmount() {} }),
      open: () => Promise.reject(new Error("no connection is expected here")),
      checkPc: async () => ({ kind: "offline", reason: "relay" }),
      reload: async () => {},
      accountService: SERVICE, accountProviders: ["github"], accountStore, store: noDevices, accountFetch: fake.fetch,
    };
    await mountRelayShell(mount);
    await until(() => accountView()?.kind === "signed-in", "the signed-in front page");
    return { fake, accountStore };
  }

  it("deletes the account at the service, signs this device out and says so", async () => {
    const { fake, accountStore } = await signedInShell();
    last().onDeleteAccount?.();
    await until(() => accountView()?.kind === "signed-out", "the signed-out front page");
    expect(fake.deleted(ACCOUNT)).toBe(true);
    expect(accountView()).toEqual({ kind: "signed-out", error: null, notice: "Your account was deleted." });
    expect(await accountStore.get("session")).toBeUndefined();
  });

  it("asks for a fresh sign-in in a browser when this one is over ten minutes old, and deletes nothing", async () => {
    let now = Date.now();
    const { fake, accountStore } = await signedInShell(() => now);
    now += 11 * 60_000;
    last().onDeleteAccount?.();
    await until(() => { const view = accountView(); return view?.kind === "signed-in" && view.error !== null; }, "the refusal");
    expect(fake.deleted(ACCOUNT)).toBe(false);
    expect(accountView()).toMatchObject({ kind: "signed-in", error: "To delete your account, sign out, sign in again, then delete it within ten minutes." });
    expect(await accountStore.get("session")).toBeDefined();
  });

  it("says to cancel a subscription that still renews first", async () => {
    const { fake } = await signedInShell();
    fake.subscribe(ACCOUNT);
    last().onDeleteAccount?.();
    await until(() => { const view = accountView(); return view?.kind === "signed-in" && view.error !== null; }, "the refusal");
    expect(fake.deleted(ACCOUNT)).toBe(false);
    expect(accountView()).toMatchObject({ kind: "signed-in", error: "Cancel your subscription first, then delete the account." });
  });
});
