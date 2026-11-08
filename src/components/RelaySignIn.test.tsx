import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { FakeAccountService } from "../../shared/account-service-fake.ts";
import type { RelayStatus } from "../../shared/protocol.ts";
import { indexedAccountStore } from "../lib/account/store.ts";
import { fakeIndexedDB } from "../lib/indexedDB.fake.ts";
import { SettingsProvider } from "../lib/settings.ts";
import type { RelayState } from "../lib/useRelay.ts";
import { RelayTab } from "./ConnectPhoneDialog.tsx";

// The relay tab's Sign in starts the sign-in on the Ovis link page in a new tab, never Settings, and
// this tab comes back signed in once the person confirms there.
const SERVICE = "https://account.ovis.example";
const ONLINE: RelayStatus = { phase: "online", relay: "wss://relay.ovis.example", app: "https://app.ovis.example", sessions: 0, blocked: null, error: null };
const relay: RelayState = { status: ONLINE, unsupported: false, pending: false, request: async () => ONLINE };

interface FakeTab { opener: unknown; closed: boolean; location: { href: string }; close(): void }

describe("the relay tab's Sign in", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let fake: FakeAccountService;
  /** what window.open answers: a tab, or null for a blocked popup */
  let popupBlocked: boolean;
  let opened: string[];
  let tab: FakeTab | null;
  /** settles with the address the new tab is sent to */
  let navigated: Promise<string>;
  /** the link page's code, approved there as the first poll comes in */
  let approveOnPoll: boolean;
  let userCode: string | null;
  let polls: AbortSignal[];
  let firstPoll: Promise<void>;
  let settings: string[];

  beforeEach(() => {
    fake = new FakeAccountService();
    fake.offerLinkPage(["github", "google"]);
    popupBlocked = false;
    opened = [];
    tab = null;
    approveOnPoll = false;
    userCode = null;
    polls = [];
    settings = [];
    const sent = Promise.withResolvers<string>();
    navigated = sent.promise;
    const polled = Promise.withResolvers<void>();
    firstPoll = polled.promise;
    for (const key of ["window", "document", "navigator", "indexedDB", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: fakeIndexedDB().factory });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36", maxTouchPoints: 0 } });
    const events = new EventTarget();
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      isSecureContext: true,
      location: { href: "https://workstation.example.ts.net/" },
      open: (url: string) => {
        opened.push(url);
        if (popupBlocked) return null;
        let href = url;
        tab = {
          opener: "ovis", closed: false, close() { this.closed = true; },
          location: { get href() { return href; }, set href(next: string) { href = next; sent.resolve(next); } },
        };
        return tab;
      },
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
      setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
      querySelector: (selector: string) => selector === 'meta[name="ovis-pc-account-service"]' ? { getAttribute: () => SERVICE } : null,
    } });
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.origin !== SERVICE) return Response.json({ error: { code: "not_found", message: "no" } }, { status: 404 });
      if (url.pathname === "/v1/token") {
        if (init?.signal) polls.push(init.signal);
        if (approveOnPoll && userCode !== null) fake.approveOnLinkPage(userCode, "acct_one", "github");
        polled.resolve();
      }
      const answer = await fake.fetch(input, init);
      if (url.pathname !== "/v1/signin/ovis/device" || !answer.ok) return answer;
      const started = await answer.json() as Record<string, unknown>;
      userCode = String(started["user_code"]);
      // the first poll comes at once rather than after the service's five seconds
      return Response.json({ ...started, interval: 0.001 });
    };
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(fetch, { preconnect: globalThis.fetch.preconnect }));
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    mock.restore();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  const text = (node: ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : text(child)).join("");
  const mount = async (onSignedIn: () => void = () => undefined) => {
    const account = { service: SERVICE, onOpen: () => { settings.push("account"); }, onSignedIn };
    await act(async () => {
      renderer = create(<SettingsProvider><RelayTab relay={relay} closesGate={false} signedIn={false} joinBySignIn={false} account={account} phone={false} /></SettingsProvider>);
    });
  };
  const signIn = async () => {
    const found = renderer!.root.findAll((node) => node.type === "button" && text(node).trim() === "Sign in to Ovis");
    expect(found).toHaveLength(1);
    await act(async () => { found[0]!.props.onClick(); });
  };

  it("opens the link page with its code filled in, in a new tab, and comes back signed in here", async () => {
    approveOnPoll = true;
    const signedIn = Promise.withResolvers<void>();
    await mount(() => signedIn.resolve());
    await signIn();
    // the tab opens in the click itself, so no popup blocker takes it
    expect(opened).toEqual(["about:blank"]);
    const page = await navigated;
    expect(page).toBe(`${SERVICE}/link?code=${userCode}`);
    expect(tab!.opener).toBeNull();
    expect(settings).toEqual([]);
    await act(async () => { await signedIn.promise; });
    expect((await indexedAccountStore.get("session"))?.account).toBe("acct_one");
    expect(text(renderer!.root)).toContain("Signed in with GitHub");
  });

  it("shows the link page and its code here when the browser blocks the new tab", async () => {
    popupBlocked = true;
    await mount();
    await signIn();
    await act(async () => { await firstPoll; });
    const links = renderer!.root.findAll((node) => node.type === "a" && node.props.href === `${SERVICE}/link?code=${userCode}`);
    expect(links.map((link) => text(link))).toEqual(["Open the sign-in page"]);
    expect(text(renderer!.root)).toContain(userCode!);
    expect(settings).toEqual([]);
  });

  it("ends the waiting sign-in when the sheet closes, keeping no session", async () => {
    await mount();
    await signIn();
    await act(async () => { await firstPoll; });
    expect(polls.map((signal) => signal.aborted)).toEqual([false]);
    await act(async () => { renderer!.unmount(); });
    renderer = undefined;
    expect(polls[0]!.aborted).toBe(true);
    fake.approveOnLinkPage(userCode!, "acct_one", "github");
    expect(await indexedAccountStore.get("session")).toBeUndefined();
  });
});
