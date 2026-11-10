import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { exportPublicKey, generateKeyPair, importPublicKey } from "../../shared/relay-e2ee.ts";
import { encodeOffer } from "../../shared/relay-offer.ts";
import { deriveServerId } from "../../shared/relay-server-proof.ts";
import { AccountService } from "../lib/account/service.ts";
import { indexedAccountStore } from "../lib/account/store.ts";
import { fakeIndexedDB } from "../lib/indexedDB.fake.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { nativeTransport, setTransport } from "../lib/transport.ts";
import { AccountSection } from "./AccountSection.tsx";

// Signing in on a PC's own page adds the PC in the same step (docs/account.md, "Adding a PC"): the sign-in
// that finishes on this screen lists the PC and waits; one that was already there only offers the button.
const SERVICE = "https://account.ovis.example";
const ACCOUNT = "acct_one";
const MARKER = "ovis-add-pc-waiting";
const publicKey = exportPublicKey(generateKeyPair().publicKey);
const SERVER = deriveServerId(importPublicKey(publicKey));
const OFFER = encodeOffer({ v: 1, server_id: SERVER, server_public_key: publicKey, relay: "wss://relay.ovis.example", name: "desk" }, "https://app.ovis.example");

describe("signing in on a PC's own page", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let fake: FakeAccountService;
  /** the account this PC is in; null while it is in none */
  let pcAccount: string | null;
  /** every request to the PC: its path, and whether it asked for an approve-here window */
  let asked: { path: string; localOnly: boolean }[];
  let tab: Map<string, string>;
  let userCode: string | null;
  /** who approves the next sign-in's code, and with which provider */
  let approveWith: "github" | "google";
  /** how far the account service's clock runs ahead of this one */
  let ahead: number;

  beforeEach(() => {
    ahead = 0;
    approveWith = "github";
    fake = new FakeAccountService(() => Date.now() + ahead);
    fake.offerLinkPage(["github", "google"]);
    pcAccount = null;
    asked = [];
    tab = new Map();
    userCode = null;
    for (const key of ["window", "document", "navigator", "indexedDB", "getComputedStyle", "location", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: fakeIndexedDB().factory });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36", maxTouchPoints: 0 } });
    Object.defineProperty(globalThis, "location", { configurable: true, writable: true, value: { pathname: "/", origin: "https://workstation.example.ts.net" } });
    const storage = { getItem: (key: string) => tab.get(key) ?? null, setItem: (key: string, value: string) => { tab.set(key, value); }, removeItem: (key: string) => { tab.delete(key); } };
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      isSecureContext: true,
      location: { href: "https://workstation.example.ts.net/" },
      sessionStorage: storage,
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, key: () => null, length: 0 },
      addEventListener: () => {}, removeEventListener: () => {},
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      hidden: false,
      documentElement: { lang: "", dataset: {}, style: { setProperty() {}, removeProperty() {}, getPropertyValue: () => "" } },
      querySelector: (selector: string) => selector === 'meta[name="ovis-pc-account-service"]' ? { getAttribute: () => SERVICE } : null,
      addEventListener: () => {}, removeEventListener: () => {},
    } });
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input instanceof Request ? input.url : input), "https://workstation.example.ts.net");
      if (url.origin !== SERVICE) {
        asked.push({ path: url.pathname, localOnly: new Headers(input instanceof Request ? input.headers : init?.headers).get("x-ovis-local-only") === "1" });
        if (url.pathname === "/api/account/status") return Response.json({ account: pcAccount, unlinked: [], removals: [], adds: [], blocked: [] });
        if (url.pathname === "/api/relay/link") return Response.json({ url: OFFER });
        if (url.pathname === "/api/relay/link/close") return Response.json({ ok: true });
        return Response.json({ error: { code: "not_found", message: "no such route" } }, { status: 404 });
      }
      // the link page's code is approved there as this page's first poll comes in
      // (a provider's own device page, which a sign-in again goes to, likewise)
      if (url.pathname === "/v1/token" && userCode !== null) { fake.approveOnLinkPage(userCode, ACCOUNT, approveWith); fake.approveDevice(userCode, ACCOUNT); userCode = null; }
      const answer = await fake.fetch(input, init);
      if (!url.pathname.startsWith("/v1/signin/") || !answer.ok) return answer;
      const started = await answer.json() as Record<string, unknown>;
      userCode = String(started["user_code"]);
      // the first poll comes at once rather than after the service's five seconds
      return Response.json({ ...started, interval: 0.001 });
    };
    setTransport({ ...nativeTransport, fetch: fetch as typeof nativeTransport.fetch });
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(fetch, { preconnect: globalThis.fetch.preconnect }));
    spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    setTransport(nativeTransport);
    mock.restore();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  const text = (node: ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : text(child)).join("");
  const buttons = (): string[] => renderer!.root.findAll((node) => node.type === "button").map(text);
  /** waits, in real time, until the screen shows what is asked for */
  const until = async (shown: () => boolean): Promise<void> => {
    for (let turn = 0; turn < 400 && !shown(); turn++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    expect(shown()).toBe(true);
  };
  const mount = async (): Promise<void> => {
    await act(async () => { renderer = create(<SettingsProvider><AccountSection /></SettingsProvider>); });
  };
  const press = async (label: string): Promise<void> => {
    const found = renderer!.root.findAll((node) => node.type === "button" && text(node) === label);
    expect(found).toHaveLength(1);
    await act(async () => { (found[0]!.props as { onClick: () => void }).onClick(); });
  };
  const links = (): { path: string; localOnly: boolean }[] => asked.filter((request) => request.path === "/api/relay/link");

  it("lists the PC and waits once the sign-in finishes, with no second press, and only then", async () => {
    await mount();
    // the one button says what it leads to on a PC in no account
    await until(() => buttons().includes("Sign in and add this PC"));
    expect(links()).toHaveLength(0);
    await press("Sign in and add this PC");
    await until(() => buttons().includes("Stop waiting"));
    expect((await indexedAccountStore.get("session"))?.account).toBe(ACCOUNT);
    expect(text(renderer!.root)).toContain("Signed in. Adding this PC to your account…");
    expect(text(renderer!.root)).toContain("choose Add on desk.");
    // listed once in the account's directory, behind a window only this PC approves; the relay was not asked to start
    expect(links()).toEqual([{ path: "/api/relay/link", localOnly: true }]);
    expect(asked.some((request) => request.path === "/api/relay/start")).toBe(false);
    expect((await new AccountService({ store: indexedAccountStore }).listPcs()).map((pc) => pc.server_id)).toEqual([SERVER]);
    expect(JSON.parse(tab.get(MARKER)!)).toMatchObject({ name: "desk", serverId: SERVER, account: ACCOUNT });

    // Stop waiting closes the window on the PC
    await press("Stop waiting");
    await until(() => asked.some((request) => request.path === "/api/relay/link/close"));
    expect(buttons()).toContain("Add this PC to my account");

    // the same sign-in, now one that was already there when the screen opened: the offer, and nothing listed or opened
    await act(async () => { renderer?.unmount(); });
    const before = asked.length;
    await mount();
    await until(() => buttons().includes("Add this PC to my account"));
    expect(text(renderer!.root)).not.toContain("Signed in. Adding this PC to your account…");
    expect(asked.slice(before).map((request) => request.path).filter((path) => path !== "/api/account/status")).toEqual([]);
  });

  it("a sign-in again for the same account, to change its sign-in methods, lists nothing by itself", async () => {
    await mount();
    await until(() => buttons().includes("Sign in and add this PC"));
    await press("Sign in and add this PC");
    await until(() => buttons().includes("Stop waiting"));
    await press("Stop waiting");
    // the account gets a second way in: the same person signs in with Google on the link page
    await press("Sign out of GitHub");
    await until(() => buttons().includes("Sign in and add this PC"));
    approveWith = "google";
    await press("Sign in and add this PC");
    await until(() => buttons().includes("Stop waiting"));
    await press("Stop waiting");
    await until(() => buttons().includes("Remove GitHub"));

    // later than the service takes a sign-in for recent: removing a method asks for a sign-in again
    ahead = 11 * 60_000;
    await press("Remove GitHub");
    await until(() => buttons().includes("Sign in again"));
    const before = asked.length;
    await press("Sign in again");
    await until(() => !buttons().includes("Remove GitHub") && buttons().includes("Add this PC to my account"));
    // fixed wait: proves that nothing is listed or opened after the sign-in again
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(buttons()).not.toContain("Stop waiting");
    expect(text(renderer!.root)).not.toContain("Signed in. Adding this PC to your account…");
    expect(asked.slice(before).map((request) => request.path).filter((path) => path !== "/api/account/status")).toEqual([]);
  });

  it("says only Sign in on a PC already in an account, and adds nothing after it", async () => {
    pcAccount = "acct_other";
    await mount();
    await until(() => buttons().includes("Sign in"));
    expect(buttons()).not.toContain("Sign in and add this PC");
    await press("Sign in");
    await until(() => text(renderer!.root).includes("Signed in with GitHub"));
    // fixed wait: proves that nothing is listed or opened after the sign-in
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(links()).toHaveLength(0);
    expect(buttons()).not.toContain("Stop waiting");
    expect(buttons()).not.toContain("Add this PC to my account");
  });
});
