import { afterEach, beforeEach, describe, expect, it, jest, mock, spyOn } from "bun:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { relayDevice, relayFixture } from "../../server/relay/test-helpers.ts";
import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { accountDeviceId, newRecordId, readAccountRecord } from "../../shared/account-records.ts";
import { exportPublicKey, generateKeyPair, importPublicKey } from "../../shared/relay-e2ee.ts";
import { encodeOffer } from "../../shared/relay-offer.ts";
import { deriveServerId } from "../../shared/relay-server-proof.ts";
import { handOverReturn } from "../lib/account/ownWindow.ts";
import { indexedAccountStore } from "../lib/account/store.ts";
import { fakeIndexedDB } from "../lib/indexedDB.fake.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { nativeTransport, setTransport } from "../lib/transport.ts";
import { AccountSection, ADDING_MS } from "./AccountSection.tsx";
import { DevicesPanel } from "./DevicesPanel.tsx";
import { RelayTab } from "./ConnectPhoneDialog.tsx";
import type { RelayState } from "../lib/useRelay.ts";
import type { RelayStatus } from "../../shared/protocol.ts";

// The PC's own window in a browser on the PC signs in at the provider and back (lib/account/ownWindow.ts).
const SERVICE = "https://account.ovis.example";
const PORT = 7317;
const publicKey = exportPublicKey(generateKeyPair().publicKey);
const SERVER = deriveServerId(importPublicKey(publicKey));
const OFFER = encodeOffer({ v: 1, server_id: SERVER, server_public_key: publicKey, relay: "wss://relay.ovis.example", name: "desk" }, "https://app.ovis.example");

describe("signing in on the PC's own window", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let fake: FakeAccountService;
  let popupBlocked: boolean;
  let sent: ReturnType<typeof Promise.withResolvers<string>>;
  let links: number;
  let relayPhase: "online" | "off";
  let pcAccount: string | null;
  let enrolling: boolean;
  let firstMember: "missing" | "available";
  let challenge: string;
  let enrollments: number;
  let lostClaimResponses: number;
  let loseGrantOnly: boolean;
  let pc: ReturnType<typeof relayFixture> | null;
  let claimRefusal: Response | null;
  let preClaim: { path: string; answer: () => Response | Promise<Response> } | null;
  let missingAccountAnswer: boolean;
  let statusAfterClaim: "fail" | "empty" | null;
  let loseEnrollAck: boolean;
  let memberKey: string;
  let challenges: number;
  let membershipReadsBeforeHealthFailure: number | null;
  /** what the failing bridge health read answers: a 503, a 200 shaped as an error, or an own_window without its port */
  let healthFailure: "503" | "error-200" | "no-port";
  /** holds the code's exchange until released, and says when it was asked */
  let exchange: { asked: ReturnType<typeof Promise.withResolvers<void>>; release: ReturnType<typeof Promise.withResolvers<void>> } | null;

  beforeEach(() => {
    fake = new FakeAccountService(() => Date.now());
    fake.offerLinkPage(["google"]);
    popupBlocked = false;
    sent = Promise.withResolvers<string>();
    links = 0;
    relayPhase = "online";
    pcAccount = null;
    enrolling = false;
    firstMember = "missing";
    enrollments = 0;
    lostClaimResponses = 0;
    loseGrantOnly = false;
    pc = null;
    claimRefusal = null;
    preClaim = null;
    missingAccountAnswer = false;
    statusAfterClaim = null;
    loseEnrollAck = false;
    memberKey = "";
    challenges = 0;
    membershipReadsBeforeHealthFailure = null;
    healthFailure = "503";
    exchange = null;
    for (const key of ["window", "document", "navigator", "indexedDB", "getComputedStyle", "location", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: fakeIndexedDB().factory });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0", maxTouchPoints: 0 } });
    const here = { href: `http://127.0.0.1:${PORT}/`, protocol: "http:", hostname: "127.0.0.1", port: String(PORT), pathname: "/", origin: `http://127.0.0.1:${PORT}` };
    Object.defineProperty(globalThis, "location", { configurable: true, writable: true, value: here });
    const tab = new Map<string, string>();
    Object.defineProperty(globalThis, "window", { configurable: true, value: Object.assign(new EventTarget(), {
      isSecureContext: true,
      location: here,
      sessionStorage: { getItem: (key: string) => tab.get(key) ?? null, setItem: (key: string, value: string) => { tab.set(key, value); }, removeItem: (key: string) => { tab.delete(key); } },
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, key: () => null, length: 0 },
      open: () => {
        if (popupBlocked) return null;
        let href = "about:blank";
        return { opener: "ovis", closed: false, close() {}, location: { get href() { return href; }, set href(next: string) { href = next; sent.resolve(next); } } };
      },
      setInterval, clearInterval,
    }) });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      hidden: false,
      documentElement: { lang: "", dataset: {}, style: { setProperty() {}, removeProperty() {}, getPropertyValue: () => "" } },
      querySelector: (selector: string) => selector === 'meta[name="ovis-pc-account-service"]' ? { getAttribute: () => SERVICE } : null,
      addEventListener: () => {}, removeEventListener: () => {},
    } });
    const network = globalThis.fetch;
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input instanceof Request ? input.url : input), `http://127.0.0.1:${PORT}`);
      if (url.origin !== SERVICE) {
        if (preClaim && url.pathname === preClaim.path && (url.pathname !== "/api/relay/link" || init?.method !== "POST")) return preClaim.answer();
        if (pc && (url.pathname === "/api/account/first-member/challenge" || url.pathname === "/api/account/status" || (url.pathname === "/api/relay/link" && init?.method !== "POST"))) {
          const origin = `http://127.0.0.1:${pc.app.port}`;
          const headers = new Headers(init?.headers);
          headers.set("origin", origin);
          return network(origin + url.pathname, { ...init, headers });
        }
        if (firstMember === "available" && url.pathname === "/api/account/first-member/challenge") {
          challenges++;
          if (pcAccount && !enrolling) return Response.json({ error: { code: "in_account" } }, { status: 409 });
          challenge = newRecordId();
          return Response.json({ challenge });
        }
        if (firstMember === "available" && url.pathname === "/api/account/first-member") {
          if (claimRefusal) return claimRefusal;
          const body = JSON.parse(String(init?.body));
          const proof = await (await fake.fetch(SERVICE + "/v1/session", { headers: { authorization: `Bearer ${body.token}` } })).json();
          const lost = lostClaimResponses > 0;
          if (lost) lostClaimResponses--;
          if (proof.own_sign_in !== true || proof.account !== body.account || Date.now() - Date.parse(proof.signed_in_at) > 600_000) {
            if (lost) throw new TypeError("claim response lost");
            return Response.json({ error: { code: "own_sign_in_required" } }, { status: 403 });
          }
          const record = await readAccountRecord(body.record);
          const key = await indexedAccountStore.key();
          if (record?.kind !== "link" || record.id !== challenge || record.server_id !== SERVER || record.signer !== key.public_spki) return new Response(null, { status: 400 });
          pcAccount = record.account;
          memberKey = key.public_spki;
          enrolling = true;
          if (lost && !loseGrantOnly) throw new TypeError("claim response lost");
          return Response.json({ device: { id: accountDeviceId(SERVER, key.public_spki), label: "Linux · Chrome", role: "drive" } }, { headers: lost ? {} : { "x-ovis-first-enroll": "for-this-window" } });
        }
        if (url.pathname === "/api/account/enroll" && enrolling && new Headers(init?.headers).get("x-ovis-first-enroll") === "for-this-window") {
          enrollments++; enrolling = false;
          if (loseEnrollAck) throw new TypeError("last enrollment response lost");
          return Response.json({ results: [] });
        }
        if (url.pathname === "/api/relay/link" && init?.method !== "POST") return Response.json({ url: OFFER });
        if (url.pathname === "/api/health") {
          if (membershipReadsBeforeHealthFailure !== null && membershipReadsBeforeHealthFailure >= 2 && url.searchParams.get("scope") === "bridge") {
            membershipReadsBeforeHealthFailure = null;
            if (healthFailure === "error-200") return Response.json({ error: { code: "unavailable" } });
            if (healthFailure === "no-port") return Response.json({ ok: true, bridge_protocol: 1, own_window: {}, auth: { required: false, authenticated: true, via: "local", role: "drive" } });
            return Response.json({ error: { code: "unavailable" } }, { status: 503 });
          }
          return Response.json({ ok: true, bridge_protocol: 1, ...(membershipReadsBeforeHealthFailure === null && { own_window: { port: PORT } }), auth: { required: false, authenticated: true, via: "local", role: "drive" } });
        }
        if (url.pathname === "/api/relay") return Response.json({ phase: relayPhase, relay: "wss://relay.ovis.example", app: "https://app.ovis.example", sessions: 0, blocked: null, error: null });
        if (url.pathname === "/api/account/status") {
          if (membershipReadsBeforeHealthFailure !== null) membershipReadsBeforeHealthFailure++;
          if (claimRefusal?.bodyUsed && missingAccountAnswer) return Response.json({});
          const issue = pcAccount && statusAfterClaim;
          if (issue) statusAfterClaim = null;
          if (issue === "fail") throw new TypeError("membership response lost");
          return Response.json({ account: issue === "empty" ? null : pcAccount, enrolling, unlinked: [], removals: [], adds: [], blocked: [] });
        }
        if (url.pathname === "/api/devices") return Response.json({ devices: pcAccount ? [{ id: accountDeviceId(SERVER, memberKey), account: pcAccount, account_key: memberKey, label: "Study browser", role: "drive", current: false }] : [] });
        if (url.pathname === "/api/relay/link") { links++; return Response.json({ url: OFFER }); }
        if (url.pathname === "/api/relay/link/close") return Response.json({ ok: true });
        return Response.json({ error: { code: "not_found", message: "no such route" } }, { status: 404 });
      }
      if (url.pathname === "/v1/token" && exchange !== null) { exchange.asked.resolve(); await exchange.release.promise; }
      return fake.fetch(input, init);
    };
    setTransport({ ...nativeTransport, fetch: fetch as typeof nativeTransport.fetch });
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(fetch, { preconnect: globalThis.fetch.preconnect }));
    spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    pc?.close();
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
  const buttons = (): string[] => renderer!.root.findAll((node) => node.type === "button").map((node) => text(node).trim());
  const words = (): string => text(renderer!.root);
  const until = async (shown: () => boolean): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (!shown()) {
      if (Date.now() > deadline) throw new Error("the screen never showed it");
      await Bun.sleep(5);
      await act(async () => {});
    }
  };
  const press = async (label: string): Promise<void> => {
    const found = renderer!.root.findAll((node) => node.type === "button" && text(node).trim() === label);
    expect(found).toHaveLength(1);
    await act(async () => { (found[0]!.props as { onClick: () => void }).onClick(); });
  };
  const back = async (start: string): Promise<string> => new URL((await fake.fetch(start)).headers.get("location") ?? "").search;

  it("adds and enrolls from an own redirect without opening the digit window", async () => {
    firstMember = "available";
    await act(async () => { renderer = create(<SettingsProvider><AccountSection /><DevicesPanel auth={null} /></SettingsProvider>); });
    await until(() => buttons().includes("Continue with Google"));
    expect(words()).toContain("No devices paired yet.");
    await press("Continue with Google");
    const stop = handOverReturn(await back(await sent.promise), () => undefined);
    try { await until(() => words().includes("This PC is in your account.") || buttons().includes("Stop waiting")); }
    finally { stop(); }
    expect(words()).toContain("This PC is in your account.");
    expect(links).toBe(0);
    expect(enrollments).toBe(1);
    expect(fake.pcs("acct_google").map(pc => pc.server_id)).toEqual([SERVER]);
    expect(words()).toContain("Study browser");
  });

  for (const loss of ["response", "grant header", "two responses"] as const) it(loss === "two responses"
    ? "returns Try again at the retry deadline and ignores the late membership reply"
    : `finishes after losing ${loss}, retrying by hand only if recovery failed`, async () => {
    firstMember = "available";
    lostClaimResponses = loss === "two responses" ? 2 : 1;
    loseGrantOnly = loss === "grant header";
    await act(async () => { renderer = create(<SettingsProvider><AccountSection /></SettingsProvider>); });
    await until(() => buttons().includes("Continue with Google"));
    await press("Continue with Google");
    const stop = handOverReturn(await back(await sent.promise), () => undefined);
    const done = () => words().includes("This PC is in your account.");
    try {
      await until(() => done() || buttons().includes("Try again") || words().includes("Not finished yet"));
      if (loss === "two responses") {
        expect(buttons()).toContain("Try again");
        expect(enrolling).toBe(true);
        expect(fake.pcs("acct_google")).toEqual([]);
        // A late membership read must not replace the next attempt's challenge.
        const asked = Promise.withResolvers<void>();
        const held = Promise.withResolvers<Response>();
        const issued = challenges;
        preClaim = { path: "/api/account/status", answer: () => { asked.resolve(); return held.promise; } };
        jest.useFakeTimers();
        try {
          await press("Try again");
          await asked.promise;
          expect(buttons()).not.toContain("Try again");
          await act(async () => { jest.advanceTimersByTime(ADDING_MS); });
          expect(buttons()).toContain("Try again");
          await act(async () => { held.resolve(Response.json({ account: pcAccount, enrolling: true })); });
          expect(challenges).toBe(issued);
          expect(buttons()).toContain("Try again");
        } finally {
          preClaim = null;
          jest.useRealTimers();
        }
        await press("Try again");
        await until(done);
      }
      expect(enrollments).toBe(1);
      expect(done()).toBe(true);
      expect(links).toBe(0);
      expect(fake.pcs("acct_google").map(pc => pc.server_id)).toEqual([SERVER]);
    } finally { stop(); }
  });

  it("does not admit or list the key while this browser is leaving the account", async () => {
    firstMember = "available";
    const key = await indexedAccountStore.key();
    await indexedAccountStore.set("leaving", { leave: key.public_spki });
    await act(async () => { renderer = create(<SettingsProvider><AccountSection /></SettingsProvider>); });
    await until(() => buttons().includes("Continue with Google"));
    await press("Continue with Google");
    const stop = handOverReturn(await back(await sent.promise), () => undefined);
    try { await until(() => buttons().includes("Add this PC to my account") || words().includes("This PC is in your account.")); }
    finally { stop(); }
    expect(pcAccount).toBeNull();
    expect(fake.pcs("acct_google")).toEqual([]);
  });

  for (const issue of ["failed read", "late membership", "lost enroll acknowledgment", "different member"] as const) it(`recovers a lost claim with ${issue}`, async () => {
    firstMember = "available";
    lostClaimResponses = 1;
    statusAfterClaim = issue === "failed read" ? "fail" : issue === "late membership" ? "empty" : null;
    loseEnrollAck = issue === "lost enroll acknowledgment" || issue === "different member";
    await act(async () => { renderer = create(<SettingsProvider><AccountSection /></SettingsProvider>); });
    await until(() => buttons().includes("Continue with Google"));
    await press("Continue with Google");
    const stop = handOverReturn(await back(await sent.promise), () => undefined);
    const done = () => words().includes("This PC is in your account.");
    try {
      await until(() => buttons().includes("Try again") || words().includes("This PC could not be listed"));
      const retry = issue === "late membership" ? "Add this PC to my account" : "Try again";
      expect(buttons()).toContain(retry);
      if (loseEnrollAck) {
        expect(enrolling).toBe(false);
        expect((await indexedAccountStore.get("enrolls"))?.[SERVER]?.account).toBe("acct_google");
      }
      if (issue === "different member") memberKey = publicKey;
      await press(retry);
      await until(() => done() || buttons().includes("Try again") || words().includes("Not finished yet"));
      if (issue === "different member") {
        expect(done()).toBe(false);
        expect((await indexedAccountStore.get("enrolls"))?.[SERVER]).toBeDefined();
      } else {
        expect(done()).toBe(true);
        expect(enrollments).toBe(1);
        expect((await indexedAccountStore.get("enrolls"))?.[SERVER]).toBeUndefined();
      }
      expect(challenges).toBe(2);
      expect(links).toBe(0);
    } finally { stop(); }
  });

  const storeDeviceSignIn = async () => {
    const codes = await (await fake.fetch(SERVICE + "/v1/signin/github/device", { method: "POST" })).json();
    fake.approveDevice(codes.user_code, "acct_device");
    const tokens = await (await fake.fetch(SERVICE + "/v1/token", { method: "POST", body: JSON.stringify({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: codes.device_code,
    }) })).json();
    await indexedAccountStore.set("session", { ...tokens, service: SERVICE, expires_at: Date.now() + 3600000 });
    return tokens;
  };

  for (const failure of ["503", "error-200", "no-port"] as const) for (const own of [true, false]) it(`lists nothing on an unreadable ownership read and checks again on retry (${failure}, own sign-in: ${own})`, async () => {
    firstMember = "available";
    healthFailure = failure;
    if (!own) { await storeDeviceSignIn(); membershipReadsBeforeHealthFailure = 0; }
    await act(async () => { renderer = create(<SettingsProvider><AccountSection /></SettingsProvider>); });
    let stop: (() => void) | undefined;
    if (own) {
      await until(() => words().includes("Signing in adds this PC to your account."));
      await press("Continue with Google");
      const returned = await back(await sent.promise);
      // The first bridge read after this own-window return gets one 503.
      membershipReadsBeforeHealthFailure = 2;
      stop = handOverReturn(returned, () => undefined);
    } else {
      await until(() => buttons().includes("Add this PC to my account"));
      await press("Add this PC to my account");
    }
    try {
      await until(() => buttons().includes("Add this PC to my account") || buttons().includes("Stop waiting"));
      expect({ listed: fake.pcs(own ? "acct_google" : "acct_device").length, links, enrollments }).toEqual({ listed: 0, links: 0, enrollments: 0 });
      expect(words()).toContain("This PC could not be listed in your account. Try again.");
      await press("Add this PC to my account");
      await until(() => own ? words().includes("This PC is in your account.") : buttons().includes("Continue on another device"));
      expect(enrollments).toBe(own ? 1 : 0);
      expect(links).toBe(0);
    } finally { stop?.(); }
  });

  for (const sameAccount of [true, false]) it(`asks for a fresh own sign-in when recovery proof expires (same account: ${sameAccount})`, async () => {
    firstMember = "available";
    lostClaimResponses = 2;
    await act(async () => { renderer = create(<SettingsProvider><AccountSection /></SettingsProvider>); });
    await until(() => buttons().includes("Continue with Google"));
    await press("Continue with Google");
    const stop = handOverReturn(await back(await sent.promise), () => undefined);
    try {
      await until(() => buttons().includes("Try again"));
      const clock = Date.now;
      spyOn(Date, "now").mockImplementation(() => clock() + 610_000);
      await press("Try again");
      await until(() => buttons().includes("Try again") || buttons().includes("Sign in again"));
      expect(buttons()).toContain("Sign in again");
      expect(buttons()).not.toContain("Try again");
      sent = Promise.withResolvers<string>();
      if (!sameAccount) fake.signInAs("google", "acct_other");
      await press("Sign in again");
      const end = handOverReturn(await back(await sent.promise), () => undefined);
      try {
        await until(() => sameAccount ? words().includes("This PC is in your account.") : words().includes("The sign-in did not finish. Try again."));
        expect((await indexedAccountStore.get("session"))?.account).toBe("acct_google");
        expect(enrollments).toBe(sameAccount ? 1 : 0);
        expect(links).toBe(0);
      } finally { end(); }
    } finally { stop(); }
  });

  for (const lost of [false, true]) it(`lists nothing after a device-code refusal (response lost: ${lost})`, async () => {
    firstMember = "available";
    lostClaimResponses = lost ? 1 : 0;
    const tokens = await storeDeviceSignIn();
    await act(async () => { renderer = create(<SettingsProvider><AccountSection /></SettingsProvider>); });
    await until(() => buttons().includes("Add this PC to my account"));
    await press("Add this PC to my account");
    await until(() => buttons().includes("Continue on another device") || buttons().includes("Stop waiting") || words().includes("This PC could not be listed"));
    expect(fake.pcs("acct_device")).toEqual([]);
    expect(links).toBe(0);
    for (const query of ["", "?include=unconfirmed"]) expect(await (await fake.fetch(SERVICE + "/v1/pcs" + query, { headers: { authorization: `Bearer ${tokens.access_token}` } })).json()).toEqual({ pcs: [] });
    expect(pcAccount).toBeNull();
    if (lost) {
      expect(words()).toContain("This PC could not be listed in your account. Try again.");
      expect(buttons()).toContain("Add this PC to my account");
      expect(buttons()).not.toContain("Continue on another device");
      return;
    }
    expect(words()).toContain("This sign-in can't add this PC directly. Confirm the number on another device.");
    await press("Continue on another device");
    await until(() => buttons().includes("Stop waiting"));
    expect(fake.pcs("acct_device").map(pc => pc.server_id)).toEqual([SERVER]);
    expect(words()).not.toContain("Signed in. Adding this PC to your account…");
  });

  it("offers the providers and lists after sign-in when the PC has no first-member route", async () => {
    await act(async () => { renderer = create(<SettingsProvider><AccountSection /></SettingsProvider>); });
    await until(() => words().includes("Signing in adds this PC to your account."));
    expect(buttons()).toContain("Continue with Google");
    expect(buttons()).not.toContain("Sign in and add this PC");
    await press("Continue with Google");
    const start = await sent.promise;
    expect(new URL(start).searchParams.get("redirect_uri")).toBe(`http://127.0.0.1:${PORT}/callback`);
    const stop = handOverReturn(await back(start), () => undefined);
    try { await until(() => words().includes("This PC could not be listed") || buttons().includes("Stop waiting")); }
    finally { stop(); }
    expect((await indexedAccountStore.get("session"))?.provider).toBe("google");
    expect(buttons()).toContain("Stop waiting");
    expect(fake.pcs("acct_google").map(pc => pc.server_id)).toEqual([SERVER]);
    expect(links).toBe(1);
  });

  const pressSignedInAdd = async () => {
    await indexedAccountStore.set("session", { account: "acct_existing", provider: "github", service: SERVICE,
      access_token: fake.issueToken("acct_existing"), refresh_token: "refresh", expires_at: Date.now() + 3_600_000 });
    await act(async () => { renderer = create(<SettingsProvider><AccountSection /></SettingsProvider>); });
    await until(() => buttons().includes("Add this PC to my account"));
    await press("Add this PC to my account");
    await until(() => buttons().includes("Stop waiting") || buttons().includes("Turn on the relay and add this PC") || words().includes("This PC could not be listed"));
  };

  for (const path of ["/api/account/first-member/challenge", "/api/relay/link"]) {
    for (const reply of ["503", "unreadable 409", "uncoded 409", "unknown 409", "network"] as const) it(`does not list after ${reply} from ${path}`, async () => {
      firstMember = "available";
      preClaim = { path, answer: () => {
        if (reply === "network") throw new TypeError("PC unreachable");
        if (reply === "503") return Response.json({ error: { code: "account_unavailable" } }, { status: 503 });
        if (reply === "unknown 409") return Response.json({ error: { code: "unknown_conflict" } }, { status: 409 });
        return new Response(reply === "uncoded 409" ? "{}" : "unreadable", { status: 409 });
      } };
      await pressSignedInAdd();
      expect({ directory: fake.pcs("acct_existing").map(row => row.server_id), pairingPosts: links }).toEqual({ directory: [], pairingPosts: 0 });
      expect(words()).toContain("This PC could not be listed in your account. Try again.");
      expect(buttons()).toContain("Add this PC to my account");
    });
  }

  for (const paired of [true, false]) it(paired ? "lists a paired PC in no account after its challenge is refused" : "offers to turn on the relay after GET /api/relay/link answers relay_off", async () => {
    pc = relayFixture(false, { accountOpensAll: false });
    if (paired) await relayDevice(pc);
    await pressSignedInAdd();
    expect(buttons()).toContain(paired ? "Stop waiting" : "Turn on the relay and add this PC");
    expect(links).toBe(paired ? 1 : 0);
    expect(fake.pcs("acct_existing").map(row => row.server_id)).toEqual(paired ? [SERVER] : []);
  });

  it("falls back to listing when only the PC knows its opens-all switch is on", async () => {
    pc = relayFixture(false, { accountOpensAll: true });
    await pressSignedInAdd();
    expect(buttons()).toContain("Stop waiting");
    expect(fake.pcs("acct_existing").map(row => row.server_id)).toEqual([SERVER]);
    expect(links).toBe(1);
  });

  for (const reply of ["coded 409", "unreadable 409", "coded 503", "409 then missing account field"] as const) it(`handles a ${reply} claim response with no account`, async () => {
    firstMember = "available";
    missingAccountAnswer = reply === "409 then missing account field";
    claimRefusal = reply === "unreadable 409" ? new Response("unreadable", { status: 409 })
      : Response.json({ error: { code: "in_account" } }, { status: reply === "coded 503" ? 503 : 409 });
    await pressSignedInAdd();
    const listed = reply === "coded 409";
    expect(buttons()).toContain(listed ? "Stop waiting" : "Add this PC to my account");
    expect(links).toBe(listed ? 1 : 0);
    expect(fake.pcs("acct_existing").map(row => row.server_id)).toEqual(listed ? [SERVER] : []);
  });

  it("offers the provider's page as a link when the tab was blocked, and keeps no sign-in cancelled while its code was exchanged", async () => {
    popupBlocked = true;
    exchange = { asked: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
    await act(async () => { renderer = create(<SettingsProvider><AccountSection /></SettingsProvider>); });
    await until(() => buttons().includes("Continue with Google"));
    await press("Continue with Google");
    await until(() => renderer!.root.findAll((node) => node.type === "a" && text(node) === "Open the sign-in page").length === 1);
    const link = renderer!.root.findAll((node) => node.type === "a" && text(node) === "Open the sign-in page")[0]!;
    const returned = await back(String(link.props.href));
    const stop = handOverReturn(returned, () => undefined);
    await act(async () => { await exchange!.asked.promise; });
    await press("Cancel");
    await act(async () => { exchange!.release.resolve(); });
    await until(() => buttons().includes("Continue with Google"));
    stop();
    expect(await indexedAccountStore.get("session")).toBeUndefined();
    expect(links).toBe(0);
  });
});

describe("the relay tab reopened already signed in", () => {
  const ACCOUNT = "acct_first";
  const status = (phase: "online" | "off"): RelayStatus => ({ phase, relay: "wss://relay.ovis.example", app: "https://app.ovis.example", sessions: 0, blocked: null, error: null });
  const relayOf = (phase: "online" | "off"): RelayState => ({ status: status(phase), unsupported: false, pending: false, request: async () => status("online"), reread: () => {} });
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let state: { relay: "online" | "off"; pcAccount: string | null; enrolling: boolean };
  let service: FakeAccountService;
  let linkGate: ReturnType<typeof Promise.withResolvers<void>> | null;
  let pressed: string[];

  beforeEach(async () => {
    state = { relay: "off", pcAccount: null, enrolling: false };
    service = new FakeAccountService();
    linkGate = null;
    pressed = [];
    for (const key of ["window", "document", "navigator", "indexedDB", "getComputedStyle", "location", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: fakeIndexedDB().factory });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0", maxTouchPoints: 0 } });
    const here = { href: `http://127.0.0.1:${PORT}/`, protocol: "http:", hostname: "127.0.0.1", port: String(PORT), pathname: "/", origin: `http://127.0.0.1:${PORT}` };
    Object.defineProperty(globalThis, "location", { configurable: true, writable: true, value: here });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      isSecureContext: true, location: here,
      sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, key: () => null, length: 0 },
      open: () => null, addEventListener: () => {}, removeEventListener: () => {},
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      hidden: false,
      documentElement: { lang: "", dataset: {}, style: { setProperty() {}, removeProperty() {}, getPropertyValue: () => "" } },
      querySelector: (selector: string) => selector === 'meta[name="ovis-pc-account-service"]' ? { getAttribute: () => SERVICE } : null,
      addEventListener: () => {}, removeEventListener: () => {},
    } });
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input instanceof Request ? input.url : input), `http://127.0.0.1:${PORT}`);
      if (url.pathname === "/api/account/first-member/challenge") { pressed.push(url.pathname); return Response.json({ challenge: newRecordId() }); }
      if (url.pathname === "/api/account/first-member") return Response.json({ error: { code: "own_sign_in_required" } }, { status: 403 });
      if (url.pathname === "/api/health") return Response.json({ ok: true, bridge_protocol: 1, own_window: { port: PORT }, auth: { required: false, authenticated: true, via: "local", role: "drive" }, security: { pairing_gate: "closed", token_configured: false } });
      if (url.pathname === "/api/relay") return Response.json(status(state.relay));
      if (url.pathname === "/api/relay/start") { state.relay = "online"; return Response.json(status("online")); }
      if (url.pathname === "/api/relay/link") { if (linkGate !== null) await linkGate.promise; return Response.json({ url: OFFER }); }
      if (url.pathname === "/api/relay/link/close" || url.pathname === "/api/account/relay-account") return Response.json({ ok: true });
      if (url.pathname === "/api/account/one-press") { pressed.push(url.pathname); state.pcAccount = ACCOUNT; return Response.json({ account: ACCOUNT }); }
      if (url.origin === SERVICE && /^\/v1\/pcs\/[0-9a-f]{32}\/admit$/.test(url.pathname)) { pressed.push("admit"); return Response.json({ server_id: url.pathname.split("/")[3], account: ACCOUNT, admitted_at: new Date().toISOString(), new_until: new Date(Date.now() + 86_400_000).toISOString() }); }
      if (url.pathname === "/api/account/status") return Response.json({ account: state.pcAccount, enrolling: state.enrolling, unlinked: [], removals: [], adds: [], blocked: [] });
      if (url.origin === SERVICE && url.pathname === "/v1/providers") return Response.json({ providers: ["google"], device: ["google"], device_page: ["google"] });
      if (url.origin === SERVICE) return service.fetch(input, init);
      return Response.json({ error: { code: "not_found", message: "no such route" } }, { status: 404 });
    };
    setTransport({ ...nativeTransport, fetch: fetch as typeof nativeTransport.fetch });
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(fetch, { preconnect: globalThis.fetch.preconnect }));
    spyOn(console, "warn").mockImplementation(() => {});
    await indexedAccountStore.set("session", { service: SERVICE, account: ACCOUNT, provider: "google", access_token: service.issueToken(ACCOUNT), refresh_token: "r", expires_at: Date.now() + 3_600_000 });
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
  const until = async (shown: () => boolean, within = 5_000): Promise<void> => {
    const deadline = Date.now() + within;
    while (!shown()) {
      if (Date.now() > deadline) throw new Error("the screen never showed it");
      await Bun.sleep(10);
      await act(async () => {});
    }
  };
  let opensAll = false;
  const account = { service: SERVICE, onOpen: () => undefined, onSignedIn: () => undefined, opensAll: () => opensAll };
  const tabAt = (phase: "online" | "off") => <SettingsProvider><RelayTab relay={relayOf(phase)} closesGate={false} signedIn accountId={ACCOUNT} joinBySignIn={false} account={account} phone={false} /></SettingsProvider>;
  const mount = async (phase: "online" | "off"): Promise<void> => {
    await act(async () => { renderer = create(tabAt(phase), { createNodeMock: () => ({ closest: () => null, querySelector: () => null, focus() {} }) }); });
  };
  const button = (label: string) => renderer!.root.findAll((node) => node.type === "button" && text(node) === label);
  const continueWithDigits = async () => {
    await until(() => button("Continue on another device").length === 1);
    await act(async () => { button("Continue on another device")[0]!.props.onClick(); });
    await until(() => button("Stop waiting").length === 1);
  };

  it("with the relay off, offers the relay's own add button rather than a plain Add that would fail", async () => {
    await mount("off");
    await until(() => renderer!.root.findAll((node) => node.type === "button" && text(node) === "Turn on the relay and add this PC").length === 1);
    expect(renderer!.root.findAll((node) => node.type === "button" && text(node) === "Add this PC to my account")).toHaveLength(0);
  });

  it("says the PC is not finished while its enrollment runs, and stops saying so once it ends", async () => {
    state = { relay: "online", pcAccount: ACCOUNT, enrolling: true };
    await mount("online");
    const pending = () => text(renderer!.root).includes("Not finished yet");
    await until(pending);
    state.enrolling = false;
    await until(() => !pending(), 10_000);
  });

  it("offers the add again when the PC left the account before its enrollment ended", async () => {
    state = { relay: "online", pcAccount: ACCOUNT, enrolling: true };
    await mount("online");
    await until(() => text(renderer!.root).includes("Not finished yet"));
    state = { relay: "online", pcAccount: null, enrolling: false };
    await until(() => renderer!.root.findAll((node) => node.type === "button" && text(node) === "Add this PC to my account").length === 1, 10_000);
    expect(text(renderer!.root)).not.toContain("This PC is in your Ovis account");
  });

  it("offers the plain add once the relay's switch turns it on", async () => {
    await mount("off");
    await until(() => button("Turn on the relay and add this PC").length === 1);
    await act(async () => { renderer!.update(tabAt("online")); });
    await until(() => button("Add this PC to my account").length === 1);
  });

  it("offers the relay start again when the switch turns off, then lets the owner continue with digits", async () => {
    state.relay = "online";
    await mount("online");
    await until(() => button("Add this PC to my account").length === 1);
    state.relay = "off";
    await act(async () => { renderer!.update(tabAt("off")); });
    await until(() => button("Turn on the relay and add this PC").length === 1);
    await act(async () => { button("Turn on the relay and add this PC")[0]!.props.onClick(); });
    await continueWithDigits();
  });

  it("goes on with a press of Turn on the relay and add this PC while the relay's state is read again", async () => {
    await mount("off");
    await until(() => button("Turn on the relay and add this PC").length === 1);
    linkGate = Promise.withResolvers<void>();
    await act(async () => { button("Turn on the relay and add this PC")[0]!.props.onClick(); });
    await act(async () => { renderer!.update(tabAt("online")); });
    linkGate.resolve();
    await continueWithDigits();
  });

  it("adds the PC in one press from the relay tab where the PC's step-2 switch is on, as Settings does", async () => {
    opensAll = true;
    state.relay = "online";
    try {
      await mount("online");
      await until(() => button("Add this PC to my account").length === 1);
      await act(async () => { button("Add this PC to my account")[0]!.props.onClick(); });
      await until(() => pressed.includes("/api/account/one-press"));
      expect(pressed).toEqual(["admit", "/api/account/one-press"]);
      expect(button("Stop waiting")).toHaveLength(0);
    } finally { opensAll = false; }
  });
});
