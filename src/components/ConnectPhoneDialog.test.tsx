import { afterEach, beforeEach, describe, expect, it, jest, mock, spyOn } from "bun:test";
import type { ReactNode } from "react";
import * as ReactDom from "react-dom";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { exportPublicKey, generateKeyPair } from "../../shared/relay-e2ee.ts";
import { decodeOffer, encodeOffer } from "../../shared/relay-offer.ts";
import type { PairedDevice, RelayStatus } from "../../shared/protocol.ts";
import { SettingsProvider } from "../lib/settings.ts";
import type { RelayState } from "../lib/useRelay.ts";
import type { Machine } from "../../shared/machines.ts";
import type { AddPcPreset } from "../lib/actions.ts";
import { PhonePanel } from "./PhonePanel.tsx";
import { RelayPairing } from "./RelayPanel.tsx";
import { QrCode } from "./QrCode.tsx";

// the confirmation before Revoke all is a portal on document.body, which this renderer has none of
await mock.module("react-dom", () => ({ ...ReactDom, createPortal: (node: ReactNode) => node }));
const { ACCOUNT_QR_HIDDEN_MS, ACCOUNT_QR_MAX_MS, CodeRoute, connectTabs, RelayRoute, RelayTab, sameNameRelayDevice, SshTab } = await import("./ConnectPhoneDialog.tsx");
const { ConfirmDialog } = await import("./ConfirmDialog.tsx");
const { ACCOUNT_QR_ALONE_MS, ACCOUNT_QR_LATE_MS, ACCOUNT_QR_POLL_MS, accountQrNoticeWaiting, newestRelayDevice, accountQrPending, resetAccountQrWatch } = await import("../lib/accountQrWatch.ts");

// Connect a phone on the phone itself: the QR codes wait behind Show QR code, a phone online with
// the relay pairs itself in one tap through its own offer, and the desktop keeps its QR codes.
const SERVER_ID = "0123456789abcdef0123456789abcdef";
const APP = "https://app.ovis.example";
const OFFER_URL = encodeOffer({ v: 1, server_id: SERVER_ID, server_public_key: exportPublicKey(generateKeyPair().publicKey), relay: "wss://relay.ovis.example", code: "482913", name: "Workstation" }, APP);
const ONLINE: RelayStatus = { phase: "online", relay: "wss://relay.ovis.example", app: APP, sessions: 0, blocked: null, error: null };
const relayState = (status: RelayStatus = ONLINE): RelayState => ({ status, unsupported: false, pending: false, request: async () => status });

describe("Connect a phone on a phone", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let requests: string[];
  let assigned: string[];
  let shellMeta: boolean;
  /** GET /api/machines/tailnet answers once this settles, with winvm older (`outdated`) or not */
  let tailnetAnswer: Promise<void>;
  let tailnetOutdated: boolean;
  /** more rows GET /api/machines/ssh-candidates answers */
  let extraCandidates: object[];
  /** the server's pending six-digit code; minting a typed code starts a new one, as server/relay/pair-code.ts does */
  let pending: string;
  /** the next answers of POST /api/devices/pair/start, each held until its gate opens (none: the pending code at once) */
  let pairStarts: { code: string; gate: Promise<void> }[];

  beforeEach(() => {
    pending = "482913";
    pairStarts = [];
    requests = [];
    assigned = [];
    shellMeta = false;
    tailnetAnswer = Promise.resolve();
    tailnetOutdated = true;
    extraCandidates = [];
    for (const key of ["window", "document", "navigator", "getComputedStyle", "Capacitor", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1", maxTouchPoints: 5 } });
    const events = new EventTarget();
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      location: { href: "https://workstation.example.ts.net/", assign: (url: string) => { assigned.push(url); } },
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
      setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
      querySelector: (selector: string) => shellMeta && selector.includes("ovis-shell") ? { getAttribute: () => "relay" } : null,
    } });
    const fetch = async (input: string | URL | Request) => {
      const path = new URL(String(input instanceof Request ? input.url : input), "https://workstation.example.ts.net").pathname;
      requests.push(path);
      const expires_at = new Date(Date.now() + 600_000).toISOString();
      if (path === "/api/relay/offer") return Response.json({ url: pending === "482913" ? OFFER_URL : encodeOffer({ ...decodeOffer(OFFER_URL)!, code: pending }, APP), expires_at });
      if (path === "/api/devices/pair/start") {
        const held = pairStarts.shift();
        if (held === undefined) return Response.json({ code: pending, expires_at });
        await held.gate;
        return Response.json({ code: held.code, expires_at });
      }
      if (path === "/api/machines/tailnet") { await tailnetAnswer; return Response.json({ pcs: [{ name: "winvm", url: "https://winvm.tail.ts.net:8443", relay: "online", outdated: tailnetOutdated }] }); }
      if (path === "/api/machines/ssh-candidates") return Response.json({ pcs: [
        { name: "nuc12", destination: "nuc12", detail: "rise@100.127.218.1", source: "ssh_config" },
        { name: "winvm", destination: "winvm.tail.ts.net", detail: "winvm.tail.ts.net", source: "tailscale", tailnet: "winvm.tail.ts.net" },
        ...extraCandidates,
      ] });
      if (path === "/api/relay/code") { pending = "777111"; return Response.json({ code: "7K3QD-M2XHA", expires_at, server_id: SERVER_ID }); }
      return Response.json({ error: { code: "not_found", message: "no" } }, { status: 404 });
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

  const mount = async (node: React.ReactNode) => { await act(async () => { renderer = create(<SettingsProvider>{node}</SettingsProvider>); }); };
  const qrCodes = () => renderer!.root.findAllByType(QrCode);
  const text = (node: ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : text(child)).join("");
  const button = (label: string) => {
    const found = renderer!.root.findAll((node) => node.type === "button" && text(node).trim() === label);
    expect(found.map(text)).toEqual([label]);
    return found[0]!;
  };
  const buttons = () => renderer!.root.findAll((node) => node.type === "button").map((node) => text(node).trim());

  it("shows the Tailscale address with Copy address and no QR code until Show QR code", async () => {
    await mount(<PhonePanel url="https://workstation.example.ts.net" phone />);
    expect(qrCodes()).toHaveLength(0);
    expect(buttons()).toContain("Copy address");
    await act(async () => { button("Show QR code").props.onClick(); });
    expect(qrCodes()).toHaveLength(1);
  });

  it("keeps the desktop's Tailscale QR code up front", async () => {
    await mount(<PhonePanel url="https://workstation.example.ts.net" />);
    expect(qrCodes()).toHaveLength(1);
    expect(buttons()).not.toContain("Show QR code");
  });

  it("shows a pairing code large, with its QR code behind Show QR code", async () => {
    await mount(<CodeRoute pairUrl="https://workstation.example.ts.net" startAtOnce phone />);
    expect(requests).toContain("/api/devices/pair/start");
    expect(qrCodes()).toHaveLength(0);
    const code = renderer!.root.findAll((node) => node.type === "p" && typeof node.props.className === "string" && node.props.className.includes("devices-code"));
    expect(code.map((node) => [node.props.className, text(node)])).toEqual([["devices-code devices-code-large", "482 913"]]);
    await act(async () => { button("Show QR code").props.onClick(); });
    expect(qrCodes()).toHaveLength(1);
  });

  it("a code asked for by a dialog closed meanwhile never replaces the newer code the reopened one shows", async () => {
    let answerOld: () => void = () => {};
    pairStarts = [{ code: "111111", gate: new Promise<void>((resolve) => { answerOld = resolve; }) }, { code: "222222", gate: Promise.resolve() }];
    const shown = () => renderer!.root.findAll((node) => node.type === "p" && typeof node.props.className === "string" && node.props.className.includes("devices-code")).map(text);
    // opened: its code request is still out when the dialog closes
    await mount(<CodeRoute pairUrl="https://workstation.example.ts.net" startAtOnce />);
    await act(async () => { renderer!.unmount(); });
    // reopened: the server's newer code (the one that pairs now) shows
    await mount(<CodeRoute pairUrl="https://workstation.example.ts.net" startAtOnce />);
    for (let flush = 0; flush < 3; flush += 1) await act(async () => {});
    expect(shown()).toEqual(["222 222"]);
    // the closed dialog's answer arrives last
    await act(async () => { answerOld(); });
    for (let flush = 0; flush < 3; flush += 1) await act(async () => {});
    expect(shown()).toEqual(["222 222"]);
  });

  it("keeps the desktop's pairing code QR code up front", async () => {
    await mount(<CodeRoute pairUrl="https://workstation.example.ts.net" startAtOnce />);
    expect(qrCodes()).toHaveLength(1);
  });

  it("keeps two relay QR codes on screen from replacing each other's code without end", async () => {
    // the setup guide's and Settings' relay QR codes can be up at once
    await mount(<><RelayPairing /><RelayPairing /></>);
    for (let flush = 0; flush < 5; flush += 1) await act(async () => {});
    // the server's offer reuses its pending code: both show it, and neither asks again for the other's
    expect(requests.filter((path) => path === "/api/relay/offer").length).toBeLessThanOrEqual(3);
    expect(qrCodes()).toHaveLength(2);
    expect(renderer!.root.findAll((node) => node.type === "p" && text(node).includes("This code expired."))).toHaveLength(0);
  });

  it("a code to type starts a new six-digit code, and the pairing code shown beside it follows", async () => {
    await mount(<><RelayPairing /><CodeRoute pairUrl="https://workstation.example.ts.net" startAtOnce={false} /></>);
    for (let flush = 0; flush < 3; flush += 1) await act(async () => {});
    const shown = () => renderer!.root.findAll((node) => node.type === "p" && typeof node.props.className === "string" && node.props.className.includes("devices-code")).map(text);
    expect(shown()).toEqual(["482 913"]);
    await act(async () => { await button("Show a code to type").props.onClick(); });
    for (let flush = 0; flush < 3; flush += 1) await act(async () => {});
    expect(shown()).toEqual(["777 111"]);
  });

  it("pairs this phone through the relay in one tap: its own offer opens in this browser", async () => {
    await mount(<RelayRoute relay={relayState()} readOnly={false} phone pairHere />);
    expect(qrCodes()).toHaveLength(0);
    expect(buttons()).toContain("Copy link");
    const offers = () => requests.filter((path) => path === "/api/relay/offer").length;
    const before = offers();
    await act(async () => { await button("Use the relay on this phone").props.onClick(); });
    expect(offers()).toBe(before + 1);
    expect(assigned).toEqual([OFFER_URL]);
    await act(async () => { button("Show QR code").props.onClick(); });
    expect(qrCodes()).toHaveLength(1);
  });

  it("opens its own offer as a PC of the app inside the native app", async () => {
    const calls: unknown[][] = [];
    Object.defineProperty(globalThis, "Capacitor", { configurable: true, value: {
      isNativePlatform: () => true,
      PluginHeaders: [{ name: "HerdrShell" }],
      nativePromise: async (...args: unknown[]) => { calls.push(args); },
    } });
    await mount(<RelayRoute relay={relayState()} readOnly={false} phone pairHere />);
    await act(async () => { await button("Use the relay on this phone").props.onClick(); });
    expect(calls).toEqual([["HerdrShell", "open", { url: OFFER_URL, scope: `${APP}/s/${SERVER_ID}/`, name: "Workstation" }]]);
    expect(assigned).toEqual([]);
  });

  it("only hints at a relay device with this phone's name, and still offers the relay", async () => {
    await mount(<RelayRoute relay={relayState()} readOnly={false} phone pairHere sameName="iPhone · Safari" />);
    const hints = renderer!.root.findAll((node) => node.type === "p" && node.props.className === "settings-hint").map(text);
    expect(hints.filter((hint) => hint.includes("iPhone · Safari"))).toHaveLength(1);
    expect(buttons()).toContain("Use the relay on this phone");
  });

  it("does not pair a PC whose window is only as narrow as a phone", async () => {
    await mount(<RelayRoute relay={relayState()} readOnly={false} phone />);
    expect(buttons()).not.toContain("Use the relay on this phone");
    expect(qrCodes()).toHaveLength(0);
  });

  it("offers only the ways this window can use: SSH where PCs are added from, the relay to its owner on a direct page", () => {
    const off = relayState({ ...ONLINE, phase: "off" });
    expect(connectTabs({ sshOffered: true, relay: off, readOnly: false })).toEqual(["ssh", "devices", "relay"]);
    expect(connectTabs({ sshOffered: false, relay: relayState(), readOnly: false })).toEqual(["devices", "relay"]);
    expect(connectTabs({ sshOffered: true, relay: { ...off, unsupported: true }, readOnly: false })).toEqual(["ssh", "devices"]);
    // a watching device or a Portal visitor cannot use the relay, and the hosted shell already is on it
    expect(connectTabs({ sshOffered: false, relay: relayState(), readOnly: true })).toEqual(["devices"]);
    shellMeta = true;
    expect(connectTabs({ sshOffered: false, relay: relayState(), readOnly: false })).toEqual(["devices"]);
  });

  it("lists the PCs found over SSH: Add opens Add PC with that address, an added one says so, a herdr PC connects", async () => {
    const added: (AddPcPreset | undefined)[] = [];
    const connected: string[] = [];
    const ssh = (destination: string, extra: Partial<Machine> = {}): Machine => ({ id: destination, name: destination, kind: "ssh", target: { destination }, enabled: true, state: "disconnected", error: null, snapshot: null, ...extra });
    const machines = [ssh("winvm.tail.ts.net", { state: "connected" }), ssh("build-box", { herdr_profile_id: "p1", action_required: "connect" })];
    await mount(<SshTab machines={machines} onAddPc={(preset) => { added.push(preset); }} onConnectMachine={(machine) => { connected.push(machine.id); }} />);
    expect(requests).toContain("/api/machines/ssh-candidates");
    expect(buttons()).toEqual(["Connect", "Add", "Add"]);
    expect(text(renderer!.root).includes("Added")).toBe(true);
    await act(async () => { renderer!.root.findByProps({ "aria-label": "Add nuc12" }).props.onClick(); });
    expect(added).toEqual([{ destination: "nuc12", name: "nuc12" }]);
    await act(async () => { button("Connect").props.onClick(); });
    expect(connected).toEqual(["build-box"]);
  });

  it("without the Ovis account here, the relay tab keeps the relay's own pairing: its switch, QR code and code to type", async () => {
    const tab = (relay: RelayState) => <RelayTab relay={relay} closesGate={false} signedIn={false} joinBySignIn={false} account={null} phone={false} />;
    await mount(tab(relayState()));
    for (let flush = 0; flush < 3; flush += 1) await act(async () => {});
    expect(renderer!.root.findAllByProps({ label: "Ovis relay", checked: true })).toHaveLength(1);
    expect(qrCodes()).toHaveLength(1);
    expect(text(renderer!.root)).toContain("7K3QD-M2XHA");
    expect(buttons()).not.toContain("Sign in to Ovis");
    // off, the switch turns it on
    await act(async () => { renderer!.update(<SettingsProvider>{tab(relayState({ ...ONLINE, phase: "off" }))}</SettingsProvider>); });
    expect(renderer!.root.findAllByProps({ label: "Ovis relay", checked: false })).toHaveLength(1);
  });

  it("holds a Tailscale PC's Add until its Ovis is known, so an older one is not added meanwhile", async () => {
    let answer = () => undefined as void;
    tailnetAnswer = new Promise((resolve) => { answer = resolve; });
    tailnetOutdated = false;
    await mount(<SshTab machines={[]} onAddPc={() => undefined} onConnectMachine={() => undefined} />);
    for (let flush = 0; flush < 3; flush += 1) await act(async () => {});
    expect(renderer!.root.findByProps({ "aria-label": "Add winvm" }).props.disabled).toBe(true);
    expect(renderer!.root.findByProps({ "aria-label": "Add nuc12" }).props.disabled).toBe(false);
    await act(async () => { answer(); });
    for (let flush = 0; flush < 3; flush += 1) await act(async () => {});
    expect(renderer!.root.findByProps({ "aria-label": "Add winvm" }).props.disabled).toBe(false);
  });

  it("tells an ssh config host that is an older-Ovis Tailscale PC to update it there too", async () => {
    extraCandidates = [{ name: "lab", destination: "lab", detail: "rise@winvm.tail.ts.net", source: "ssh_config", tailnet: "winvm.tail.ts.net" }];
    await mount(<SshTab machines={[]} onAddPc={() => undefined} onConnectMachine={() => undefined} />);
    for (let flush = 0; flush < 3; flush += 1) await act(async () => {});
    expect(renderer!.root.findAllByProps({ "aria-label": "Add lab" })).toHaveLength(0);
    expect(renderer!.root.findAll((node) => node.type === "span" && text(node) === "Update Ovis on that PC to 0.5 first.")).toHaveLength(2);
  });

  it("tells a Tailscale PC with an older Ovis to update it there, in one line, instead of offering Add", async () => {
    await mount(<SshTab machines={[]} onAddPc={() => undefined} onConnectMachine={() => undefined} />);
    for (let flush = 0; flush < 3; flush += 1) await act(async () => {});
    expect(renderer!.root.findAllByProps({ "aria-label": "Add winvm" })).toHaveLength(0);
    expect(renderer!.root.findAllByProps({ "aria-label": "Add nuc12" })).toHaveLength(1);
    expect(text(renderer!.root)).toContain("Update Ovis on that PC to 0.5 first.");
  });

  it("keeps the desktop's relay QR code up front, with no self-pairing", async () => {
    await mount(<RelayRoute relay={relayState()} readOnly={false} />);
    expect(qrCodes()).toHaveLength(1);
    expect(buttons()).not.toContain("Use the relay on this phone");
  });
});

describe("sameNameRelayDevice", () => {
  const device = (extra: Partial<PairedDevice>): PairedDevice => ({ id: "a", label: "iPhone · Safari", role: "drive", created_at: "2026-10-01T00:00:00Z", last_seen_at: null, current: false, ...extra });
  it("names a relay device under this phone's label, never this session's own or a direct one", () => {
    expect(sameNameRelayDevice([device({ via_relay: true })], "iPhone · Safari")).toBe("iPhone · Safari");
    expect(sameNameRelayDevice([device({})], "iPhone · Safari")).toBeNull();
    expect(sameNameRelayDevice([device({ via_relay: true, current: true })], "iPhone · Safari")).toBeNull();
    expect(sameNameRelayDevice([device({ via_relay: true, label: "Pixel 9" })], "iPhone · Safari")).toBeNull();
  });
});

// The relay tab where the page has an Ovis account: the relay's QR code behind a press. A signed-in device that scans
// it puts a PC in no account into its own, so nothing is minted before the press, the code is ended when the QR code
// comes down, and the tab then says which account the PC joined and by which device (docs/account.md, "Adding a PC").
describe("the relay tab's QR code behind a press", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const ACCOUNT_ID = "acct_0123456789abcdefgh";
  const SERVICE = { service: "https://account.ovis.example", onOpen: () => undefined, onSignedIn: () => undefined };
  let renderer: ReactTestRenderer | undefined;
  let requests: string[];
  /** the bodies POST /api/devices/pair/cancel got */
  let ended: unknown[];
  /** what GET /api/account/status and GET /api/devices answer */
  let pcAccount: string | null;
  let devices: PairedDevice[];
  /** whether the six-digit code the QR code carries is still pending on the PC */
  let codePending: boolean;
  let hidden: boolean;
  let visibility: EventTarget;
  let held: boolean[];
  let revokedAll: number;
  /** the requests sent to outlive the page */
  let keptAlive: string[];
  /** false: a PC from before POST /api/devices/pair/cancel */
  let endsPairings: boolean;
  /** GET /api/account/status answers once this settles */
  let statusGate: Promise<void>;

  const device = (extra: Partial<PairedDevice>): PairedDevice => ({ id: "a", label: "Laptop · Chrome", role: "drive", created_at: "2026-10-01T00:00:00Z", last_seen_at: null, current: false, ...extra });
  const phoneDevice = (extra: Partial<PairedDevice> = {}) => device({ id: "b", label: "iPhone · Safari", created_at: "2026-11-10T00:00:00Z", via_relay: true, ...extra });

  beforeEach(() => {
    jest.useFakeTimers();
    requests = [];
    ended = [];
    pcAccount = null;
    devices = [device({})];
    codePending = true;
    hidden = false;
    visibility = new EventTarget();
    held = [];
    revokedAll = 0;
    keptAlive = [];
    endsPairings = true;
    statusGate = Promise.resolve();
    for (const key of ["window", "document", "navigator", "getComputedStyle", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    // the confirmation's focus trap asks what an element is
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: class {} });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36", maxTouchPoints: 0 } });
    const events = new EventTarget();
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      isSecureContext: true,
      location: { href: "https://workstation.example.ts.net/" },
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
      // the fake clock's, installed above
      setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
      querySelector: () => null,
      querySelectorAll: () => [],
      activeElement: null,
      get hidden() { return hidden; },
      addEventListener: visibility.addEventListener.bind(visibility),
      removeEventListener: visibility.removeEventListener.bind(visibility),
    } });
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input instanceof Request ? input.url : input), "https://workstation.example.ts.net").pathname;
      requests.push(path);
      if (init?.keepalive === true) keptAlive.push(path);
      const expires_at = new Date(Date.now() + 600_000).toISOString();
      if (path === "/api/account/status") await statusGate;
      if (path === "/api/account/status") return Response.json({ account: pcAccount, unlinked: [], removals: [], adds: [], blocked: [] });
      if (path === "/api/devices") return Response.json({ devices });
      if (path === "/api/relay/code") return Response.json({ code: "7K3QD-M2XHA", expires_at, server_id: SERVER_ID });
      if (path === "/api/relay/offer") return Response.json({ url: OFFER_URL, expires_at });
      if (path === "/api/relay/code/cancel") return Response.json({ ok: true });
      if (path === "/api/devices/pair/cancel" && endsPairings) {
        ended.push(JSON.parse(String(init?.body)));
        const cancelled = codePending;
        codePending = false;
        return Response.json({ ok: true, cancelled });
      }
      if (path === "/api/devices/revoke-all") { devices = []; pcAccount = null; return Response.json({ revoked: 2 }); }
      return Response.json({ error: { code: "not_found", message: "no" } }, { status: 404 });
    };
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(fetch, { preconnect: globalThis.fetch.preconnect }));
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    resetAccountQrWatch();
    mock.restore();
    jest.useRealTimers();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  interface TabOptions { signedIn?: boolean; joinBySignIn?: boolean; relay?: RelayState; active?: boolean }
  const tab = ({ signedIn = true, joinBySignIn = false, relay = relayState(), active = true }: TabOptions = {}) => (
    <SettingsProvider>
      <RelayTab relay={relay} closesGate={false} signedIn={signedIn} joinBySignIn={joinBySignIn} account={SERVICE} phone={false} active={active}
        onPairingHeld={(next) => { held.push(next); }} onRevokedAll={() => { revokedAll += 1; }} />
    </SettingsProvider>
  );
  const flush = async () => { for (let round = 0; round < 6; round += 1) await act(async () => {}); };
  const mount = async (options?: TabOptions) => {
    await act(async () => { renderer = create(tab(options), { createNodeMock: () => ({ closest: () => null, querySelector: () => null, querySelectorAll: () => [], focus() {}, contains: () => false, addEventListener() {}, removeEventListener() {} }) }); });
    await flush();
  };
  const update = async (options?: TabOptions) => { await act(async () => { renderer!.update(tab(options)); }); await flush(); };
  const advance = async (ms: number) => { await act(async () => { jest.advanceTimersByTime(ms); }); await flush(); };
  const text = (node: ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : text(child)).join("");
  const section = () => renderer!.root.findByProps({ "data-testid": "connect-account-qr" });
  const buttons = () => section().findAll((node) => node.type === "button").map((node) => text(node).trim());
  const press = async (label: string) => {
    const found = section().findAll((node) => node.type === "button" && text(node).trim() === label);
    expect(found.map(text)).toEqual([label]);
    await act(async () => { found[0]!.props.onClick(); });
    await flush();
  };
  const qrCodes = () => renderer!.root.findAllByType(QrCode);
  const minted = () => requests.filter((path) => path === "/api/relay/code" || path === "/api/relay/offer" || path === "/api/devices/pair/start");
  const count = (path: string) => requests.filter((request) => request === path).length;

  for (const [name, options, heading, inAccount] of [
    ["signed out", { signedIn: false }, "Add with a QR code", false],
    ["signed in, with the PC in no account", { signedIn: true }, "Add with a QR code", false],
    ["signed in, with the PC in the account", { signedIn: true, joinBySignIn: true }, "Add a device with a QR code", true],
  ] as const) {
    it(`${name}: asks for no code or offer before the press, and draws the QR code after it`, async () => {
      if (inAccount) pcAccount = ACCOUNT_ID;
      await mount(options);
      expect(text(section())).toContain(heading);
      expect(text(section())).toContain(inAccount ? "Its other PCs still ask for one approval." : "this PC joins that account, with no number to type");
      expect(buttons()).toEqual(["Show the QR code"]);
      expect(qrCodes()).toHaveLength(0);
      expect(minted()).toEqual([]);
      await press("Show the QR code");
      expect(minted()).toEqual(["/api/relay/code", "/api/relay/offer"]);
      expect(qrCodes()).toHaveLength(1);
      expect(text(section())).toContain("7K3QD-M2XHA");
      expect(buttons()).not.toContain("Show the QR code");
    });
  }

  it("with the relay off, shows the relay's switch and no button; signed in, the switch above is the only one", async () => {
    const off = relayState({ ...ONLINE, phase: "off" });
    await mount({ signedIn: false, relay: off });
    expect(section().findAllByProps({ label: "Ovis relay", checked: false })).toHaveLength(1);
    expect(buttons()).not.toContain("Show the QR code");
    expect(text(section())).toContain("Off. Nothing goes through the relay.");
    await update({ signedIn: true, relay: off });
    expect(renderer!.root.findAllByProps({ label: "Ovis relay", checked: false })).toHaveLength(1);
    expect(section().findAllByProps({ label: "Ovis relay" })).toHaveLength(0);
    expect(buttons()).not.toContain("Show the QR code");
    expect(minted()).toEqual([]);
  });

  it("signed out on a relay that refused this PC for its pass, says to sign in first", async () => {
    const refused = relayState({ ...ONLINE, phase: "error", error: "pass", pass: { state: "no_account", relay: "missing", enforce_at: null, refused: true } });
    await mount({ signedIn: false, relay: refused });
    expect(text(section())).toContain("Sign in above first; then this PC can show its QR code.");
    expect(buttons()).not.toContain("Show the QR code");
  });

  it("takes the QR code down 30 minutes after the press and ends its code, leaving Show a new code", async () => {
    await mount();
    await press("Show the QR code");
    await advance(ACCOUNT_QR_MAX_MS - 1000);
    expect(qrCodes()).toHaveLength(1);
    expect(ended).toEqual([]);
    await advance(1000);
    expect(qrCodes()).toHaveLength(0);
    expect(buttons()).toEqual(["Show a new code"]);
    // the six-digit code's end takes the typed code bound to it along (server/devices.ts endPairing)
    expect(count("/api/relay/code/cancel")).toBe(0);
    expect(ended).toEqual([{ code: "482913" }]);
    // nothing renews it afterwards
    const before = minted().length;
    await advance(ACCOUNT_QR_MAX_MS);
    expect(minted()).toHaveLength(before);
  });

  it("takes the QR code down once the page was hidden for a minute, not before, and not when it came back in time", async () => {
    await mount();
    await press("Show the QR code");
    hidden = true;
    await act(async () => { visibility.dispatchEvent(new Event("visibilitychange")); });
    await advance(ACCOUNT_QR_HIDDEN_MS - 1000);
    hidden = false;
    await act(async () => { visibility.dispatchEvent(new Event("visibilitychange")); });
    await advance(ACCOUNT_QR_HIDDEN_MS);
    expect(qrCodes()).toHaveLength(1);
    hidden = true;
    await act(async () => { visibility.dispatchEvent(new Event("visibilitychange")); });
    await advance(ACCOUNT_QR_HIDDEN_MS);
    expect(qrCodes()).toHaveLength(0);
    expect(buttons()).toEqual(["Show a new code"]);
    expect(ended).toEqual([{ code: "482913" }]);
  });

  it("takes the QR code down when the page comes back after a sleep that ran no timer", async () => {
    await mount();
    await press("Show the QR code");
    hidden = true;
    await act(async () => { visibility.dispatchEvent(new Event("visibilitychange")); });
    // the device slept: the clock moved, no timer ran
    const now = Date.now();
    spyOn(Date, "now").mockImplementation(() => now + ACCOUNT_QR_HIDDEN_MS);
    hidden = false;
    await act(async () => { visibility.dispatchEvent(new Event("visibilitychange")); });
    await flush();
    expect(qrCodes()).toHaveLength(0);
    expect(buttons()).toEqual(["Show a new code"]);
  });

  it("takes the QR code down and ends its code when another tab opens, and when the dialog closes", async () => {
    await mount();
    await press("Show the QR code");
    await update({ active: false });
    expect(qrCodes()).toHaveLength(0);
    expect(ended).toEqual([{ code: "482913" }]);
    await update({ active: true });
    expect(buttons()).toEqual(["Show a new code"]);
    codePending = true;
    await press("Show a new code");
    expect(qrCodes()).toHaveLength(1);
    await act(async () => { renderer!.unmount(); });
    renderer = undefined;
    await act(async () => {});
    expect(ended).toEqual([{ code: "482913" }, { code: "482913" }]);
    expect(count("/api/relay/code/cancel")).toBe(0);
  });

  it("ends the code with a request that outlives the page when the page goes: a reload, a closed tab", async () => {
    await mount();
    await press("Show the QR code");
    await act(async () => { window.dispatchEvent(new Event("pagehide")); });
    await flush();
    expect(ended).toEqual([{ code: "482913" }]);
    expect(keptAlive).toEqual(["/api/devices/pair/cancel"]);
    // a page kept for Back comes back without its QR code, and ends nothing twice
    expect(qrCodes()).toHaveLength(0);
    expect(buttons()).toEqual(["Show a new code"]);
    expect(count("/api/devices/pair/cancel")).toBe(1);
    // with no QR code up, a page that goes sends nothing
    await act(async () => { window.dispatchEvent(new Event("pagehide")); });
    await flush();
    expect(count("/api/devices/pair/cancel")).toBe(1);
  });

  it("leaves another window's typed code alone when its own code was replaced, and ends the typed code itself on a PC that cannot end pairings", async () => {
    await mount();
    await press("Show the QR code");
    // another window asked for a QR code meanwhile: this one's six-digit code is not the pending one any more
    codePending = false;
    await update({ active: false });
    expect(ended).toEqual([{ code: "482913" }]);
    expect(count("/api/relay/code/cancel")).toBe(0);
    await update({ active: true });
    endsPairings = false;
    await press("Show a new code");
    await update({ active: false });
    expect(count("/api/relay/code/cancel")).toBe(1);
  });

  it("takes the QR code down and ends its code when the relay stops being online", async () => {
    await mount();
    await press("Show the QR code");
    await update({ relay: relayState({ ...ONLINE, phase: "error", error: "lost" }) });
    expect(qrCodes()).toHaveLength(0);
    expect(ended).toEqual([{ code: "482913" }]);
    expect(buttons()).not.toContain("Show the QR code");
    await update();
    expect(buttons()).toEqual(["Show a new code"]);
  });

  it("asks for no code when another tab opens while the press still reads the PC", async () => {
    await mount();
    let answer = () => undefined as void;
    statusGate = new Promise((resolve) => { answer = resolve; });
    await press("Show the QR code");
    expect(section().findAll((node) => node.type === "button")[0]!.props.disabled).toBe(true);
    await update({ active: false });
    await act(async () => { answer(); });
    await flush();
    await update({ active: true });
    expect(minted()).toEqual([]);
    expect(qrCodes()).toHaveLength(0);
    expect(buttons()).toEqual(["Show a new code"]);
  });

  it("takes the QR code down by the clock when the device slept with the page in sight", async () => {
    await mount();
    await press("Show the QR code");
    // the device slept: the clock moved, no timer ran, and no visibility change came
    const now = Date.now();
    spyOn(Date, "now").mockImplementation(() => now + ACCOUNT_QR_MAX_MS);
    await advance(ACCOUNT_QR_POLL_MS);
    expect(qrCodes()).toHaveLength(0);
    expect(buttons()).toEqual(["Show a new code"]);
    expect(ended).toEqual([{ code: "482913" }]);
  });

  // a device that took the code just before the QR code came down links only seconds later
  for (const [name, down] of [
    ["another tab opened", async () => { await update({ active: false }); }],
    ["the page was hidden for a minute", async () => {
      hidden = true;
      await act(async () => { visibility.dispatchEvent(new Event("visibilitychange")); });
      await advance(ACCOUNT_QR_HIDDEN_MS);
    }],
  ] as const) {
    it(`still says which account the PC joined when ${name} between a pairing and its link`, async () => {
      await mount();
      await press("Show the QR code");
      devices = [...devices, phoneDevice()];
      codePending = false;
      await down();
      expect(qrCodes()).toHaveLength(0);
      expect(renderer!.root.findAllByProps({ "data-testid": "connect-account-joined" })).toHaveLength(0);
      // the dialog stays open for what may still come
      expect(held.at(-1)).toBe(true);
      devices = [devices[0]!, phoneDevice({ account: ACCOUNT_ID })];
      pcAccount = ACCOUNT_ID;
      await advance(ACCOUNT_QR_POLL_MS);
      const notice = renderer!.root.findByProps({ "data-testid": "connect-account-joined" });
      expect(text(notice)).toContain("This PC joined an Ovis account (acct_0123456).");
      expect(text(notice)).toContain("Added by iPhone · Safari.");
      expect(buttons()).toEqual(["Done", "Not me: revoke every device"]);
      expect(held.at(-1)).toBe(true);
      expect(accountQrNoticeWaiting()).toBe(false);
    });
  }

  it("keeps watching after the dialog closed between a pairing and its link, and says it when the dialog is back", async () => {
    await mount();
    await press("Show the QR code");
    devices = [...devices, phoneDevice()];
    codePending = false;
    await act(async () => { renderer!.unmount(); });
    renderer = undefined;
    await flush();
    expect(accountQrPending()).toBe(true);
    devices = [devices[0]!, phoneDevice({ account: ACCOUNT_ID })];
    pcAccount = ACCOUNT_ID;
    let noticed = 0;
    window.addEventListener("ovis:account-qr-watch", (event) => { if ((event as CustomEvent<{ notice: boolean }>).detail.notice) noticed += 1; });
    await advance(ACCOUNT_QR_POLL_MS);
    // Devices and PCs opens Add a connection again on this
    expect(noticed).toBe(1);
    expect(accountQrNoticeWaiting()).toBe(true);
    expect(accountQrPending()).toBe(false);
    await mount();
    const notice = renderer!.root.findByProps({ "data-testid": "connect-account-joined" });
    expect(text(notice)).toContain("Added by iPhone · Safari.");
    expect(buttons()).toEqual(["Done", "Not me: revoke every device"]);
    expect(accountQrNoticeWaiting()).toBe(false);
    expect(minted().filter((path) => path === "/api/relay/offer")).toHaveLength(1);
  });

  it("stops watching with the first read after the code was ended that finds no new device", async () => {
    await mount();
    await press("Show the QR code");
    await update({ active: false });
    expect(accountQrPending()).toBe(false);
    expect(held.at(-1)).toBe(false);
    const asked = count("/api/account/status");
    await advance(ACCOUNT_QR_POLL_MS * 4);
    expect(count("/api/account/status")).toBe(asked);
  });

  it("watches as long as the code can live when the PC did not answer its end, then stops", async () => {
    endsPairings = false;
    await mount();
    await press("Show the QR code");
    await update({ active: false });
    expect(accountQrPending()).toBe(true);
    const asked = count("/api/account/status");
    await advance(ACCOUNT_QR_POLL_MS);
    await advance(ACCOUNT_QR_POLL_MS);
    expect(count("/api/account/status")).toBe(asked + 2);
    await advance(ACCOUNT_QR_LATE_MS);
    expect(accountQrPending()).toBe(false);
    expect(held.at(-1)).toBe(false);
  });

  it("names a device that paired just before the QR code came down and joined no account", async () => {
    await mount();
    await press("Show the QR code");
    devices = [...devices, phoneDevice()];
    codePending = false;
    await update({ active: false });
    await update({ active: true });
    await advance(ACCOUNT_QR_ALONE_MS + ACCOUNT_QR_POLL_MS);
    expect(text(renderer!.root.findByProps({ "data-testid": "connect-account-alone" }))).toContain("iPhone · Safari is paired with this PC alone so far");
    // Done leaves the watch on: it signs in later
    await press("Done");
    expect(buttons()).toEqual(["Show a new code"]);
    expect(held.at(-1)).toBe(false);
    devices = [devices[0]!, phoneDevice({ account: ACCOUNT_ID })];
    pcAccount = ACCOUNT_ID;
    await advance(ACCOUNT_QR_POLL_MS);
    expect(text(renderer!.root.findByProps({ "data-testid": "connect-account-joined" }))).toContain("Added by iPhone · Safari.");
  });

  it("a new press while the PC is still watched tells a join it finds instead of showing a QR code", async () => {
    await mount();
    await press("Show the QR code");
    devices = [...devices, phoneDevice()];
    codePending = false;
    await update({ active: false });
    await update({ active: true });
    devices = [devices[0]!, phoneDevice({ account: ACCOUNT_ID })];
    pcAccount = ACCOUNT_ID;
    const before = minted().length;
    await press("Show a new code");
    expect(text(renderer!.root.findByProps({ "data-testid": "connect-account-joined" }))).toContain("Added by iPhone · Safari.");
    expect(minted()).toHaveLength(before);
    expect(accountQrPending()).toBe(false);
  });

  it("tells the page's other places that the ended code ran out, only when it was still pending", async () => {
    const announced: string[] = [];
    await mount();
    window.addEventListener("ovis:pairing-code", (event) => { announced.push((event as CustomEvent<{ expires_at: string }>).detail.expires_at); });
    await press("Show the QR code");
    await update({ active: false });
    expect(announced.at(-1)).toBe(new Date(0).toISOString());
    // a code a device used up is not pending: nothing is announced, so the list's "Paired" line stays
    await update({ active: true });
    await press("Show a new code");
    const before = announced.length;
    await update({ active: false });
    expect(announced.slice(before).filter((expires) => expires === new Date(0).toISOString())).toEqual([]);
  });

  it("says which account the PC joined and which device added it, and holds the dialog open for it", async () => {
    await mount();
    expect(held.at(-1)).toBe(false);
    await press("Show the QR code");
    expect(held.at(-1)).toBe(true);
    devices = [...devices, phoneDevice({ account: ACCOUNT_ID })];
    pcAccount = ACCOUNT_ID;
    await advance(ACCOUNT_QR_POLL_MS);
    expect(qrCodes()).toHaveLength(0);
    const notice = renderer!.root.findByProps({ "data-testid": "connect-account-joined" });
    expect(text(notice)).toContain("This PC joined an Ovis account (acct_0123456).");
    expect(text(notice)).toContain("Added by iPhone · Safari.");
    expect(buttons()).toEqual(["Done", "Not me: revoke every device"]);
    expect(held.at(-1)).toBe(true);
    // the PC is in an account now: what the QR code does from here on
    expect(text(section())).toContain("Add a device with a QR code");
    await press("Done");
    expect(buttons()).toEqual(["Show a new code"]);
    expect(held.at(-1)).toBe(false);
  });

  it("Not me asks before it revokes, and revokes every device once", async () => {
    await mount();
    await press("Show the QR code");
    devices = [...devices, phoneDevice({ account: ACCOUNT_ID })];
    pcAccount = ACCOUNT_ID;
    await advance(ACCOUNT_QR_POLL_MS);
    await press("Not me: revoke every device");
    expect(count("/api/devices/revoke-all")).toBe(0);
    const confirm = renderer!.root.findByType(ConfirmDialog);
    expect(confirm.props.body).toContain("this PC leaves that account");
    await act(async () => { await confirm.props.onConfirm(); });
    await flush();
    expect(count("/api/devices/revoke-all")).toBe(1);
    expect(revokedAll).toBe(1);
    expect(renderer!.root.findAllByType(ConfirmDialog)).toHaveLength(0);
    expect(text(section())).toContain("Every paired device was revoked.");
    expect(text(section())).toContain("Add with a QR code");
    expect(buttons()).toEqual(["Show a new code"]);
  });

  it("names a device that paired without an account as paired with this PC alone, after ten seconds, and still tells a later join", async () => {
    await mount();
    await press("Show the QR code");
    devices = [...devices, phoneDevice()];
    await advance(ACCOUNT_QR_POLL_MS);
    expect(renderer!.root.findAllByProps({ "data-testid": "connect-account-alone" })).toHaveLength(0);
    await advance(ACCOUNT_QR_ALONE_MS);
    const notice = renderer!.root.findByProps({ "data-testid": "connect-account-alone" });
    // it may be signed in and still on its way into the account: nothing says it is not
    expect(text(notice)).toBe("iPhone · Safari is paired with this PC alone so far: it has not added this PC to an account. Sign in on it to add this PC to your account.Done");
    expect(qrCodes()).toHaveLength(0);
    expect(held.at(-1)).toBe(true);
    // it signed in after all
    devices = [devices[0]!, phoneDevice({ account: ACCOUNT_ID })];
    pcAccount = ACCOUNT_ID;
    await advance(ACCOUNT_QR_POLL_MS);
    expect(text(renderer!.root.findByProps({ "data-testid": "connect-account-joined" }))).toContain("Added by iPhone · Safari.");
  });

  it("on a PC already in an account, a device that pairs is named and the dialog is not held", async () => {
    pcAccount = ACCOUNT_ID;
    await mount({ joinBySignIn: true });
    await press("Show the QR code");
    expect(held).not.toContain(true);
    devices = [...devices, phoneDevice()];
    await advance(ACCOUNT_QR_POLL_MS);
    expect(qrCodes()).toHaveLength(0);
    expect(text(section())).toContain("Paired: iPhone · Safari.");
    expect(renderer!.root.findAllByProps({ "data-testid": "connect-account-joined" })).toHaveLength(0);
    expect(buttons()).toEqual(["Show a new code"]);
  });

  it("picks the newest relay device the press did not know", () => {
    const known = new Set(["a"]);
    expect(newestRelayDevice([device({ via_relay: true })], known)).toBeNull();
    expect(newestRelayDevice([device({ id: "c" })], known)).toBeNull();
    expect(newestRelayDevice([phoneDevice({ id: "c", label: "old", created_at: "2026-11-09T00:00:00Z" }), phoneDevice()], known)?.label).toBe("iPhone · Safari");
  });
});
