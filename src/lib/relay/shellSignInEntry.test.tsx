import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ReactElement } from "react";
import { FakeAccountService, WEB_REDIRECT } from "../../../shared/account-service-fake.ts";
import { RelayShell, type RelayShellProps } from "../../components/RelayShell.tsx";
import { beginSignIn, finishSignIn, signInReturn } from "../account/signin.ts";
import { memoryAccountStore, type AccountStore } from "../account/store.ts";
import { takeEntryUrl } from "./boot.ts";
import type { ShellDeviceStore } from "./device.ts";
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
const providerOf = async (accountStore: AccountStore, url: string): Promise<string | undefined> => (await accountStore.get("pending"))?.[new URL(url).searchParams.get("state") ?? ""]?.provider;
const ORIGIN = "https://app.ovis.sh";

/** A browser's address bar: `replaceState` changes the address a reload then loads. */
function addressBar(url: string) {
  const at = new URL(url);
  const location = { href: at.href, pathname: at.pathname, search: at.search, hash: at.hash };
  const replaced: string[] = [];
  const history = { replaceState(_data: unknown, _unused: string, next: string) {
    replaced.push(next);
    const moved = new URL(next, at.origin);
    Object.assign(location, { href: moved.href, pathname: moved.pathname, search: moved.search, hash: moved.hash });
  } };
  return { location, history, replaced };
}

describe("a link that opens the hosted shell on a provider's sign-in (#sign-in=<provider>)", () => {
  let browser: ReturnType<typeof createShellTestPage>;
  beforeEach(() => { browser = createShellTestPage(); });
  afterEach(() => { browser.dispose(); waiting = []; });

  function service(offered: readonly ("github" | "google")[] = ["github", "google"]): FakeAccountService {
    const fake = new FakeAccountService();
    fake.offerSignIns([...offered], [...offered]);
    fake.signInAs("github", "acct_1");
    return fake;
  }

  /** Loads the address in `bar` as the browser would: boot takes the entry URL, then the shell mounts on it. */
  async function load(bar: ReturnType<typeof addressBar>, fake: FakeAccountService, accountStore: AccountStore, signIns: string[]) {
    let props: RelayShellProps | undefined;
    const store: ShellDeviceStore = { get: async () => undefined, list: async () => [], remove: async () => {}, removeRow: async () => false, update: async (_id, change) => change(undefined) };
    const find = (node: ReactElement): RelayShellProps => node.type === RelayShell ? node.props as RelayShellProps : find((node.props as { children: ReactElement }).children);
    await mountRelayShell({
      container: {} as HTMLElement, entryUrl: takeEntryUrl(bar), shellVersion: "0.0.0-test", label: "Test phone", store, accountStore,
      accountService: SERVICE, accountFetch: fake.fetch, accountProviders: ["github"],
      renderApp: () => { throw new Error("the app is not expected here"); },
      createRoot: () => ({ render(element: ReactElement) { props = find(element); }, unmount() {} }),
      open: async () => { throw new Error("no pairing is expected here"); },
      openSignIn: (url) => { signIns.push(url); changed(); },
      navigate: () => {}, checkPc: async () => ({ kind: "offline", reason: "relay" }), reload: async () => {},
    });
    return () => { if (!props) throw new TypeError("not rendered"); return props; };
  }

  it("starts a provider's sign-in once, on the same path as its button: one pending record, PKCE and its state", async () => {
    const fake = service();
    const accountStore = memoryAccountStore();
    const signIns: string[] = [];
    await load(addressBar(`${ORIGIN}/#sign-in=google`), fake, accountStore, signIns);
    await until(() => signIns.length === 1);
    const started = new URL(signIns[0]!);
    const state = started.searchParams.get("state") ?? "";
    expect(started.searchParams.get("code_challenge_method")).toBe("S256");
    const pending = await accountStore.get("pending");
    expect(Object.keys(pending ?? {})).toEqual([state]);
    expect(pending?.[state]).toMatchObject({ provider: "google" });
    expect(pending?.[state]).not.toHaveProperty("pairing");
  });

  it("does nothing for a provider the account service does not offer, and starts one it does", async () => {
    const fake = service(["github"]);
    const accountStore = memoryAccountStore();
    const signIns: string[] = [];
    await load(addressBar(`${ORIGIN}/#sign-in=google`), fake, accountStore, signIns);
    await load(addressBar(`${ORIGIN}/#sign-in=gitlab`), fake, accountStore, signIns);
    await load(addressBar(`${ORIGIN}/#sign-in=`), fake, accountStore, signIns);
    // the one that is offered, loaded last: by the time its sign-in opens, none started above did
    await load(addressBar(`${ORIGIN}/#sign-in=github`), fake, accountStore, signIns);
    await until(() => signIns.length > 0);
    expect(signIns).toHaveLength(1);
    expect(await providerOf(accountStore, signIns[0]!)).toBe("github");
    expect(Object.keys((await accountStore.get("pending")) ?? {})).toHaveLength(1);
  });

  it("takes the entry off the address before the shell runs, and keeps any other fragment", async () => {
    const bar = addressBar(`${ORIGIN}/#sign-in=github`);
    expect(takeEntryUrl(bar)).toBe(`${ORIGIN}/#sign-in=github`);
    expect(bar.replaced).toEqual(["/"]);
    expect(bar.location.hash).toBe("");
    const other = addressBar(`${ORIGIN}/#pane=w1:p1`);
    takeEntryUrl(other);
    expect(other.replaced).toEqual([]);
  });

  it("does nothing on a page already signed in, where a signed-out one starts it", async () => {
    const fake = service();
    const signedIn = memoryAccountStore();
    const begun = await beginSignIn("github", { store: signedIn, service: SERVICE, redirectUri: WEB_REDIRECT });
    await finishSignIn(signInReturn(new URL((await fake.fetch(begun)).headers.get("location") ?? "").hash)!, { store: signedIn, fetch: fake.fetch });
    const signIns: string[] = [];
    await load(addressBar(`${ORIGIN}/#sign-in=github`), fake, signedIn, signIns);
    const signedOut = memoryAccountStore();
    await load(addressBar(`${ORIGIN}/#sign-in=github`), fake, signedOut, signIns);
    await until(() => signIns.length > 0);
    expect(signIns).toHaveLength(1);
    expect(await providerOf(signedOut, signIns[0]!)).toBe("github");
    expect(Object.keys((await signedIn.get("pending")) ?? {})).toEqual([]);
  });

  it("starts nothing again when the page is reloaded", async () => {
    const fake = service();
    const accountStore = memoryAccountStore();
    const signIns: string[] = [];
    const bar = addressBar(`${ORIGIN}/#sign-in=github`);
    await load(bar, fake, accountStore, signIns);
    await until(() => signIns.length === 1);
    await load(bar, fake, accountStore, signIns);
    // another page that does ask for a sign-in, loaded after the reload: its sign-in is the only one that opens
    await load(addressBar(`${ORIGIN}/#sign-in=google`), fake, accountStore, signIns);
    await until(() => signIns.length > 1);
    expect(signIns).toHaveLength(2);
    expect(await providerOf(accountStore, signIns[1]!)).toBe("google");
  });
});
