import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ReactElement } from "react";
import { FakeAccountService } from "../../../shared/account-service-fake.ts";
import { exportPublicKey, generateKeyPair } from "../../../shared/relay-e2ee.ts";
import { encodeOffer, type RelayOffer } from "../../../shared/relay-offer.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { RelayShell, type RelayShellProps } from "../../components/RelayShell.tsx";
import { SIGN_IN_MS } from "../account/signin.ts";
import { memoryAccountStore, type AccountStore } from "../account/store.ts";
import type { RelayDevice, ShellDeviceStore } from "./device.ts";
import { mountRelayShell } from "./shell.tsx";
import { createShellTestPage } from "./shell.test.tsx";

const SERVICE = "https://account.ovis.sh";

let waiting: (() => void)[] = [];
const changed = (): void => { for (const wake of waiting.splice(0)) wake(); };
async function until(holds: () => boolean): Promise<void> {
  for (;;) {
    const next = new Promise<void>((resolve) => { waiting.push(resolve); });
    if (holds()) return;
    await next;
  }
}

interface NativeAuth { readonly asked: string[]; release: () => void }

// A marked code (`admission: 1`) scanned on a device with no sign-in stops before the pairing, and its failure screen
// signs in right there: the sign-in's return asks about the same pairing again, and nothing pairs until it is pressed.
describe("signing in from a marked pairing's failure screen", () => {
  let browser: ReturnType<typeof createShellTestPage>;
  beforeEach(() => { browser = createShellTestPage(); });
  const realFetch = globalThis.fetch;
  afterEach(() => { Reflect.deleteProperty(globalThis, "Capacitor"); globalThis.fetch = realFetch; browser.dispose(); waiting = []; });

  /**
   * The phone app's sign-in sheet: it answers the URL it was given through the fake service, once the test releases it.
   * The app trades the code with the page's own fetch (account/native.ts), so that fetch is the fake service's too.
   */
  function nativeApp(fake: FakeAccountService): NativeAuth {
    globalThis.fetch = fake.fetch as typeof fetch;
    const auth: NativeAuth = { asked: [], release: () => {} };
    const gate = new Promise<void>((resolve) => { auth.release = resolve; });
    Object.defineProperty(globalThis, "Capacitor", { configurable: true, value: {
      isNativePlatform: () => true, PluginHeaders: [{ name: "OvisAuth" }],
      nativePromise: async (_plugin: string, _method: string, options: { url: string }) => {
        auth.asked.push(options.url); changed();
        await gate;
        return { url: (await fake.fetch(options.url)).headers.get("location") };
      },
    } });
    return auth;
  }

  function page(entryUrl: string, accountStore: AccountStore, fake: FakeAccountService, opened: RelayOffer[], signIns: string[]) {
    let props: RelayShellProps | undefined;
    const devices: RelayDevice[] = [];
    const store: ShellDeviceStore = {
      get: async (id) => devices.find((device) => device.server_id === id), list: async () => [...devices],
      remove: async () => {}, removeRow: async () => false, update: async (_id, change) => change(undefined),
    };
    const find = (node: ReactElement): RelayShellProps => node.type === RelayShell ? node.props as RelayShellProps : find((node.props as { children: ReactElement }).children);
    const mounted = mountRelayShell({
      container: {} as HTMLElement, entryUrl, shellVersion: "0.0.0-test", label: "Test phone", store, accountStore, accountService: SERVICE, accountFetch: fake.fetch,
      renderApp: () => { throw new Error("the app is not expected here"); },
      createRoot: () => ({ render(element: ReactElement) { props = find(element); changed(); }, unmount() {} }),
      open: async (offer) => { opened.push(offer); changed(); throw new Error("stopped after the pairing began"); },
      openSignIn: (url) => { signIns.push(url); changed(); },
      checkPc: async () => ({ kind: "offline", reason: "relay" }), reload: async () => {}, navigate() {},
    });
    const current = (): RelayShellProps => { if (!props) throw new TypeError("not rendered"); return props; };
    const failure = (): string | null => { const { state } = current(); return state.kind === "failed" ? state.failure : null; };
    return { mounted, current, failure };
  }

  async function stoppedForSignIn(options: { native?: boolean } = {}) {
    const identity = generateKeyPair();
    const offer: RelayOffer = { v: 1, server_id: deriveServerId(identity.publicKey), server_public_key: exportPublicKey(identity.publicKey), relay: "wss://relay.ovis.sh", name: "Desk", code: "123456", admission: 1 };
    const fake = new FakeAccountService();
    fake.offerSignIns(["github", "google"], ["github", "google"]);
    fake.signInAs("google", "acct_1");
    const native = options.native ? nativeApp(fake) : null;
    const accountStore = memoryAccountStore();
    const opened: RelayOffer[] = [], signIns: string[] = [];
    const first = page(encodeOffer(offer, "https://app.ovis.sh"), accountStore, fake, opened, signIns);
    await first.mounted;
    await until(() => first.current().state.kind === "confirm" && !("account" in first.current().state));
    first.current().onPair();
    await until(() => first.failure() === "sign-in-first");
    // the page's build names GitHub alone: Google comes from the account service's own list
    await until(() => first.current().accountProviders?.join() === "github,google");
    first.current().onSignIn?.("google");
    await until(() => signIns.length === 1 || (native?.asked.length ?? 0) === 1);
    const started = signIns[0] ?? native?.asked[0] ?? "";
    const state = new URL(started).searchParams.get("state") ?? "";
    const returnUrl = async () => (await fake.fetch(started)).headers.get("location") ?? "";
    return { offer, fake, accountStore, opened, first, native, state, returnUrl, back: (url: string, signIns: string[] = []) => page(url, accountStore, fake, opened, signIns) };
  }

  it("carries the offer in the web sign-in's own record, asks about the same pairing on its return, and pairs only on Add and pair", async () => {
    const { offer, accountStore, opened, first, state, returnUrl, back } = await stoppedForSignIn();
    expect(first.current().state).toMatchObject({ kind: "failed", failure: "sign-in-first", account: { kind: "signing-in", provider: "google" } });
    expect((await accountStore.get("pending"))?.[state]?.pairing?.offer).toEqual(offer);
    expect([...browser.sessionStore.keys()]).toEqual([]);
    expect(opened).toEqual([]);
    const returned = back(await returnUrl());
    await returned.mounted;
    await until(() => { const { state: now } = returned.current(); return now.kind === "confirm" && now.account === "unlisted"; });
    expect(returned.current().state).toMatchObject({ kind: "confirm", offer });
    expect(await accountStore.get("pending")).toEqual({});
    expect(opened).toEqual([]);
    returned.current().onPair();
    await until(() => opened.length === 1);
    expect(opened[0]).toMatchObject({ server_id: offer.server_id, code: "123456" });
  });

  it("keeps the failure screen with the reason when the web sign-in is denied, and a second try counts from the first", async () => {
    const { accountStore, opened, state, back } = await stoppedForSignIn();
    const at = (await accountStore.get("pending"))?.[state]?.pairing?.at;
    const signIns: string[] = [];
    const returned = back(`https://app.ovis.sh/#error=access_denied&state=${state}`, signIns);
    await returned.mounted;
    await until(() => { const { state: now } = returned.current(); return now.kind === "failed" && now.account?.kind === "signed-out"; });
    expect(returned.current().state).toMatchObject({ failure: "sign-in-first", account: { error: "The sign-in was cancelled." } });
    expect(await accountStore.get("pending")).toEqual({});
    returned.current().onSignIn?.("github");
    await until(() => signIns.length === 1);
    const again = new URL(signIns[0]!).searchParams.get("state") ?? "";
    expect((await accountStore.get("pending"))?.[again]?.pairing?.at).toBe(at!);
    expect(opened).toEqual([]);
  });

  it("asks for a new scan when the sign-in took longer than the code is good for", async () => {
    const { offer, accountStore, opened, state, returnUrl, back } = await stoppedForSignIn();
    await accountStore.update("pending", (current) => {
      const pending = current![state]!;
      return { ...current, [state]: { ...pending, pairing: { ...pending.pairing!, at: pending.pairing!.at - SIGN_IN_MS - 1 } } };
    });
    const returned = back(await returnUrl());
    await returned.mounted;
    await until(() => returned.failure() === "scan-expired");
    expect(returned.current().state).toMatchObject({ server_id: offer.server_id, name: "Desk" });
    expect(opened).toEqual([]);
  });

  it("asks about the same pairing in place once the app's sign-in sheet answers", async () => {
    const { offer, accountStore, opened, first, native } = await stoppedForSignIn({ native: true });
    expect(first.current().state).toMatchObject({ failure: "sign-in-first", account: { kind: "signing-in", provider: "google" } });
    native!.release();
    await until(() => { const { state } = first.current(); return state.kind === "confirm" && state.account === "unlisted"; });
    expect(first.current().state).toMatchObject({ offer });
    expect(await accountStore.get("pending")).toEqual({});
    expect(opened).toEqual([]);
  });
});
