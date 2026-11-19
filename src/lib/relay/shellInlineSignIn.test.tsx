import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import type { ReactElement } from "react";
import { FakeAccountService } from "../../../shared/account-service-fake.ts";
import { exportPublicKey, generateKeyPair } from "../../../shared/relay-e2ee.ts";
import { decodeOffer, encodeOffer, type RelayOffer } from "../../../shared/relay-offer.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { RelayShell, type RelayShellProps } from "../../components/RelayShell.tsx";
import { SIGN_IN_MS } from "../account/signin.ts";
import { memoryAccountStore, type AccountStore } from "../account/store.ts";
import type { RelayDevice, ShellDeviceStore } from "./device.ts";
import { mountRelayShell } from "./shell.tsx";
import { createShellTestPage } from "./shell.test.tsx";

const SERVICE = "https://account.ovis.sh";
const ORIGIN = "https://app.ovis.sh";

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
// signs in right there. The pairing goes on on the PC's own page, as after a scan, and nothing pairs until it is pressed.
describe("signing in from a marked pairing's failure screen", () => {
  let browser: ReturnType<typeof createShellTestPage>;
  const realFetch = globalThis.fetch;
  beforeEach(() => { browser = createShellTestPage(); });
  afterEach(() => { Reflect.deleteProperty(globalThis, "Capacitor"); globalThis.fetch = realFetch; setSystemTime(); browser.dispose(); waiting = []; });

  /**
   * The phone app's sign-in sheet: it answers the URL it was given through the fake service, or refuses it, once the test
   * releases it. The app trades the code with the page's own fetch (account/native.ts), so that fetch is the fake's too.
   */
  function nativeApp(fake: FakeAccountService, refuse = false): NativeAuth {
    globalThis.fetch = fake.fetch as typeof fetch;
    const auth: NativeAuth = { asked: [], release: () => {} };
    const gate = new Promise<void>((resolve) => { auth.release = resolve; });
    Object.defineProperty(globalThis, "Capacitor", { configurable: true, value: {
      isNativePlatform: () => true, PluginHeaders: [{ name: "OvisAuth" }],
      nativePromise: async (_plugin: string, _method: string, options: { url: string }) => {
        auth.asked.push(options.url); changed();
        await gate;
        if (refuse) return { url: `ovis://account/callback?error=access_denied&state=${new URL(options.url).searchParams.get("state")}` };
        return { url: (await fake.fetch(options.url)).headers.get("location") };
      },
    } });
    return auth;
  }

  function page(entryUrl: string, accountStore: AccountStore, fake: FakeAccountService, opened: RelayOffer[], signIns: string[], navigated: string[] = []) {
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
      navigate: (path) => { navigated.push(path); changed(); },
      checkPc: async () => ({ kind: "offline", reason: "relay" }), reload: async () => {},
    });
    const current = (): RelayShellProps => { if (!props) throw new TypeError("not rendered"); return props; };
    const failure = (): string | null => { const { state } = current(); return state.kind === "failed" ? state.failure : null; };
    return { mounted, current, failure, navigated };
  }

  async function stoppedForSignIn(options: { native?: boolean; refuse?: boolean; beforeSignIn?: () => void } = {}) {
    const identity = generateKeyPair();
    const scannedOffer: RelayOffer = { v: 1, server_id: deriveServerId(identity.publicKey), server_public_key: exportPublicKey(identity.publicKey), relay: "wss://relay.ovis.sh", name: "Desk", code: "123456", admission: 1 };
    const fake = new FakeAccountService();
    fake.offerSignIns(["github", "google"], ["github", "google"]);
    fake.signInAs("google", "acct_1");
    const native = options.native ? nativeApp(fake, options.refuse) : null;
    const accountStore = memoryAccountStore();
    const opened: RelayOffer[] = [], signIns: string[] = [];
    const scannedAt = Date.now();
    const first = page(encodeOffer(scannedOffer, ORIGIN), accountStore, fake, opened, signIns);
    await first.mounted;
    await until(() => first.current().state.kind === "confirm" && !("account" in first.current().state));
    first.current().onPair();
    await until(() => first.failure() === "sign-in-first");
    // the page's build names GitHub alone: Google comes from the account service's own list
    await until(() => first.current().accountProviders?.join() === "github,google");
    options.beforeSignIn?.();
    first.current().onSignIn?.("google");
    await until(() => signIns.length === 1 || (native?.asked.length ?? 0) === 1);
    const started = signIns[0] ?? native?.asked[0] ?? "";
    const state = new URL(started).searchParams.get("state") ?? "";
    const returnUrl = async () => (await fake.fetch(started)).headers.get("location") ?? "";
    /** The front page the account service sends the browser back to, and the PC's page it goes on to. */
    const comeBack = async (url: string) => {
      const front = page(url, accountStore, fake, opened, []);
      await front.mounted;
      await until(() => front.navigated.length === 1);
      const pcSignIns: string[] = [];
      const pcPage = page(new URL(front.navigated[0]!, ORIGIN).href, accountStore, fake, opened, pcSignIns);
      await pcPage.mounted;
      return { front, pcPage, pcSignIns };
    };
    return { offer: scannedOffer, scannedAt, fake, accountStore, opened, first, native, state, returnUrl, comeBack };
  }

  it("goes on with the pairing on the PC's own page after a web sign-in, and pairs only on Add and pair", async () => {
    const { offer, accountStore, opened, first, state, returnUrl, comeBack } = await stoppedForSignIn();
    expect(first.current().state).toMatchObject({ kind: "failed", failure: "sign-in-first", account: { kind: "signing-in", provider: "google" } });
    expect((await accountStore.get("pending"))?.[state]?.pairing?.offer).toEqual(offer);
    expect([...browser.sessionStore.keys()]).toEqual([]);
    const { front, pcPage } = await comeBack(await returnUrl());
    // the front page, where the service sends a browser back, only hands the pairing on
    expect(front.current().state.kind).not.toBe("confirm");
    const link = new URL(front.navigated[0]!, ORIGIN);
    expect(link.pathname).toBe(`/s/${offer.server_id}/`);
    expect(decodeOffer(link.href)).toEqual(offer);
    await until(() => { const { state: now } = pcPage.current(); return now.kind === "confirm" && now.account === "unlisted"; });
    expect(pcPage.current().scoped).toBe(true);
    expect(pcPage.current().state).toMatchObject({ kind: "confirm", offer, resumed: true });
    expect(await accountStore.get("pending")).toEqual({});
    expect(opened).toEqual([]);
    pcPage.current().onPair();
    await until(() => opened.length === 1);
    expect(opened[0]).toMatchObject({ server_id: offer.server_id, code: "123456" });
  });

  it("brings a refused web sign-in to the PC's own page with its reason and a way back, and a second try keeps the scan's time", async () => {
    const { accountStore, opened, state, comeBack, scannedAt } = await stoppedForSignIn();
    const at = (await accountStore.get("pending"))?.[state]?.pairing?.at;
    expect(at).toBeGreaterThanOrEqual(scannedAt);
    const { pcPage, pcSignIns } = await comeBack(`${ORIGIN}/#error=access_denied&state=${state}`);
    await until(() => { const { state: now } = pcPage.current(); return now.kind === "failed" && now.account?.kind === "signed-out" && now.account.error !== null; });
    expect(pcPage.current().state).toMatchObject({ failure: "sign-in-first" });
    expect(pcPage.current().scoped).toBe(true);
    expect(await accountStore.get("pending")).toEqual({});
    pcPage.current().onSignIn?.("github");
    await until(() => pcSignIns.length === 1);
    const again = new URL(pcSignIns[0]!).searchParams.get("state") ?? "";
    expect((await accountStore.get("pending"))?.[again]?.pairing?.at).toBe(at!);
    expect(opened).toEqual([]);
  });

  it("asks for a new scan on the PC's own page when the sign-in took longer than the code is good for", async () => {
    const { offer, accountStore, opened, state, returnUrl, comeBack } = await stoppedForSignIn();
    await accountStore.update("pending", (current) => {
      const pending = current![state]!;
      return { ...current, [state]: { ...pending, pairing: { ...pending.pairing!, at: pending.pairing!.at - SIGN_IN_MS - 1 } } };
    });
    const { pcPage } = await comeBack(await returnUrl());
    await until(() => pcPage.failure() === "scan-expired");
    expect(pcPage.current().state).toMatchObject({ server_id: offer.server_id, name: "Desk" });
    expect(pcPage.current().scoped).toBe(true);
    expect(opened).toEqual([]);
  });

  it("refuses an offer in the record that is not its PC's, on that PC's page, as a scanned one is", async () => {
    const { accountStore, opened, state, returnUrl, comeBack } = await stoppedForSignIn();
    const other = exportPublicKey(generateKeyPair().publicKey);
    await accountStore.update("pending", (current) => {
      const pending = current![state]!;
      return { ...current, [state]: { ...pending, pairing: { ...pending.pairing!, offer: { ...pending.pairing!.offer, server_public_key: other } } } };
    });
    const { pcPage } = await comeBack(await returnUrl());
    await until(() => pcPage.current().state.kind === "forged");
    expect(opened).toEqual([]);
  });

  it("counts the code's time from the scan, not from the press of a provider", async () => {
    let pressedAt = 0;
    const { accountStore, state, scannedAt } = await stoppedForSignIn({ beforeSignIn: () => { pressedAt = Date.now() + 5 * 60_000; setSystemTime(new Date(pressedAt)); } });
    const at = (await accountStore.get("pending"))?.[state]?.pairing?.at ?? 0;
    expect(at).toBeGreaterThanOrEqual(scannedAt);
    expect(at).toBeLessThan(pressedAt);
  });

  it("asks about the same pairing in place once the app's sign-in sheet answers", async () => {
    const { offer, accountStore, opened, first, native } = await stoppedForSignIn({ native: true });
    expect(first.current().state).toMatchObject({ failure: "sign-in-first", account: { kind: "signing-in", provider: "google" } });
    native!.release();
    await until(() => { const { state } = first.current(); return state.kind === "confirm" && state.account === "unlisted"; });
    expect(first.current().state).toMatchObject({ offer, resumed: true });
    expect(first.current().scoped).toBe(true);
    expect(await accountStore.get("pending")).toEqual({});
    expect(opened).toEqual([]);
  });

  it("asks for a new scan when the app's sign-in sheet is refused after the code's time", async () => {
    const { first, native, opened } = await stoppedForSignIn({ native: true, refuse: true });
    setSystemTime(new Date(Date.now() + SIGN_IN_MS + 1));
    native!.release();
    await until(() => first.failure() === "scan-expired");
    expect(opened).toEqual([]);
  });
});
