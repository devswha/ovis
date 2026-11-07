import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { MyPc } from "../lib/account/myPcs.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { keyIdGroups } from "./KeyId.tsx";
import { RelayShell, type RelayShellProps } from "./RelayShell.tsx";

const EXPECTED = "0123456789abcdef0123456789abcdef";
/** the same id but for its third and last groups */
const RECEIVED = "01234567ffffcdef0123456789abeeee";
const none = () => {};
const props = (state: RelayShellProps["state"]): RelayShellProps => ({ state, scoped: true, iosTab: false, onPair: none, onRetry: none, onCancel: none, onBack: none, onForget: none, onUpdate: none, onMatch: none, onCodeStart: none, onCodeSubmit: none, onCodeMatch: none });
/** The dashboard's table row for the PC named `name`, as rendered. */
const rowOf = (html: string, name: string): string => {
  const row = [...html.matchAll(/<tr data-pc-state="[^"]+">[\s\S]*?<\/tr>/g)].map((m) => m[0]).find((r) => r.includes(`<b>${name}</b>`));
  if (row === undefined) throw new Error(`no row for ${name}`);
  return row;
};
/** The labels of the buttons and button-styled links in a piece of markup. */
const actionsOf = (html: string): string[] => [...html.matchAll(/<(?:a|button)[^>]*class="btn[^"]*"[^>]*>([\s\S]*?)<\/(?:a|button)>/g)].map(([, inner]) => inner!.replace(/<[^>]+>/g, ""));
const render = (shown: RelayShellProps): string => {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(RelayShell, shown) }));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
};
describe("the front page's account part", () => {
  const pc = (server_id: string, name: string, state: "paired" | "needs-approval" | "offline" | "needs-update", paired = state === "paired") => ({ server_id, name, state, last_seen_at: null, added_at: null, listed: true, paired, linked: paired });

  it("offers GitHub alone until the service is set up for Apple", () => {
    const html = render({ ...props({ kind: "empty", account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none });
    expect(html).toContain("Continue with GitHub");
    expect(html).not.toContain("Continue with Apple");
  });

  const saved = (server_id: string, name: string) => ({ server_id, server_public_key: "k", relay: "wss://relay.example", name, device_id: "0".repeat(16), label: "Phone" }) as unknown as Extract<RelayShellProps["state"], { kind: "list" }>["devices"][number];
  const links = (html: string) => [...html.matchAll(/<button type="button" class="account-link">([^<]+)</g)].map(([, label]) => label);

  it("opens on the sign-in alone: GitHub and Apple alike, under one title, with only the pairing link below", () => {
    const html = render({ ...props({ kind: "empty", account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none, accountProviders: ["github", "apple"] });
    expect(html).toContain('data-account-state="signed-out"');
    const buttons = [...html.matchAll(/<button type="button" class="([^"]+)">(?:<svg[\s\S]*?<\/svg>)?(Continue with [^<]+)</g)].map(([, kind, label]) => [kind, label]);
    expect(buttons).toEqual([["btn account-provider", "Continue with GitHub"], ["btn account-provider", "Continue with Apple"]]);
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(links(html)).toEqual(["Pair with a QR or code"]);
    expect(html.indexOf("Continue with Apple")).toBeLessThan(html.indexOf("Pair with a QR or code"));
    expect(html).not.toContain("relay-shell-pc");
    expect(html).not.toContain("Scan the QR code on your PC");
  });

  it("keeps saved PCs off the sign-in, one link away, counted", () => {
    const two = render({ ...props({ kind: "list", devices: [saved("a".repeat(32), "p620"), saved("b".repeat(32), "nuc")], account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none });
    expect(two).toContain("Continue with GitHub");
    expect(links(two)).toEqual(["Pair with a QR or code", "Continue without an account (2 PCs)"]);
    expect(two).not.toContain("relay-shell-pc");
    expect(two).not.toContain("p620");
    expect(two).not.toContain("<details");
    const one = render({ ...props({ kind: "list", devices: [saved("a".repeat(32), "p620")], account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none });
    expect(links(one)).toEqual(["Pair with a QR or code", "Continue without an account (1 PC)"]);
    // without an account service there is no sign-in: the saved PCs are the page itself
    expect(render({ ...props({ kind: "list", devices: [saved("a".repeat(32), "p620")] }), scoped: false })).toContain(`href="/s/${"a".repeat(32)}/"`);
  });

  it("returns to the sign-in after sign-out, the pairings kept behind its link", () => {
    const devices = [saved("a".repeat(32), "p620"), saved("b".repeat(32), "nuc")];
    const signedIn = render({ ...props({ kind: "list", devices, account: { kind: "signed-in", provider: "github", error: null, pcs: [pc("a".repeat(32), "p620", "paired")] } }), scoped: false, onSignIn: none, onSignOut: none });
    expect(signedIn).toContain("Sign out");
    // what shell.tsx's signOut shows: the same saved PCs, the account signed out
    const after = render({ ...props({ kind: "list", devices, account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none, onSignOut: none });
    expect(after).toContain("Sign in to Ovis");
    expect(after).not.toContain("Sign out");
    expect(after).not.toContain("relay-shell-pc");
    expect(links(after)).toEqual(["Pair with a QR or code", "Continue without an account (2 PCs)"]);
  });

  it("opens a pairing link straight into pairing, without the sign-in", () => {
    const html = render({ ...props({ kind: "confirm", offer: { v: 1, server_id: EXPECTED, server_public_key: "k", relay: "wss://relay.example", name: "Desk" } }), scoped: false, onSignIn: none, accountProviders: ["github", "apple"] });
    expect(html).toContain('data-relay-state="confirm"');
    expect(html).toContain("Pair with Desk?");
    expect(html).not.toContain("Continue with GitHub");
    expect(html).not.toContain("Sign in to Ovis");
  });

  it("says how each saved PC answered the latest check, with Check now above the list", () => {
    const device = (server_id: string, name: string) => ({ server_id, server_public_key: "k", relay: "wss://relay.example", name, device_id: "0".repeat(16), label: "Phone" }) as unknown as Extract<RelayShellProps["state"], { kind: "list" }>["devices"][number];
    const pcStatus = new Map([
      ["a".repeat(32), { kind: "answered", route: "lan", rttMs: 9 }],
      ["b".repeat(32), { kind: "answered", route: "relay", relay: "wss://relay-ap.ovis.sh", rttMs: 148 }],
      ["c".repeat(32), { kind: "offline", reason: "pc" }],
    ] as const);
    const html = render({ ...props({ kind: "list", devices: [device("a".repeat(32), "home"), device("b".repeat(32), "office"), device("c".repeat(32), "laptop")] }), scoped: false, pcStatus, onCheckPcs: none });
    const text = html.replace(/<[^>]+>/g, "");
    expect(text).toContain("homeAnswers · Same Wi-Fi, direct · 9 ms");
    expect(text).toContain("officeAnswers · Seoul relay · 148 ms");
    expect(html).toContain('<span class="connection-slow">148 ms</span>');
    expect(text).toContain("laptopOfflineThe PC is off, or Ovis is not running on it.");
    expect(html.indexOf("Check now")).toBeLessThan(html.indexOf("home"));
    // a check stops before signing in: the PC answering is all it knows, never that this device is connected
    expect(text).not.toContain("Connected");
    // signed in, the dashboard's row for the PC says the same in its State cell, in place of what the account's directory says of it
    const signedIn = render({ ...props({ kind: "list", devices: [], account: { kind: "signed-in", provider: "github", error: null, pcs: [pc("a".repeat(32), "home", "offline", true)] } }), scoped: false, onSignIn: none, pcStatus, onCheckPcs: none });
    const row = rowOf(signedIn, "home").replace(/<[^>]+>/g, "");
    expect(row).toContain("Answers · Same Wi-Fi, direct · 9 ms");
    expect(row).not.toContain("Offline");
    expect(signedIn).toContain("Check now");
  });

  it("offers Add for a PC new in the account, Join for an older one that has not approved this device, and nothing for one with no way to join", () => {
    const fresh = { ...pc("b".repeat(32), "desk2", "needs-approval"), added_at: new Date().toISOString(), join: { server_public_key: "k", relay: "wss://relay.example" } };
    const old = { ...fresh, server_id: "c".repeat(32), name: "nuc", added_at: new Date(Date.now() - 3_600_000).toISOString() };
    const { join: _join, ...waiting } = { ...old, server_id: "d".repeat(32), name: "attic" };
    const html = render({ ...props({ kind: "list", devices: [], account: { kind: "signed-in", provider: "github", error: null, pcs: [fresh, old, waiting] } }), scoped: false, onSignIn: none, onJoin: none });
    expect(actionsOf(rowOf(html, "desk2"))).toEqual(["Add"]);
    expect(rowOf(html, "desk2")).toContain("new in your account");
    expect(actionsOf(rowOf(html, "nuc"))).toEqual(["Join"]);
    expect(actionsOf(rowOf(html, "attic"))).toEqual([]);
    // the notice names the first PC waiting, with its own action
    const notice = /<div class="relay-dash-notice">[\s\S]*?<\/div>/.exec(html)![0];
    expect(notice.replace(/<[^>]+>/g, "")).toContain("desk2 is new in your account. Type the number it shows on its own screen to add it.");
    expect(actionsOf(notice)).toEqual(["Add"]);
    expect(html).not.toContain("Add desk2 to your account?");
  });

  it("asks for the number the new PC shows instead of showing one, and says so when it was wrong", () => {
    const typed = render(props({ kind: "compare", name: "desk2", digits: "123456", confirmed: false, typed: true }));
    expect(typed).toContain("Type the number desk2 shows");
    expect(typed).not.toContain("123 456");
    expect(typed).toContain('name="digits"');
    const wrong = render(props({ kind: "compare", name: "desk2", digits: "", confirmed: false, typed: true, wrong: true }));
    expect(wrong).toContain("That is not the number desk2 shows");
    expect(wrong).not.toContain('name="digits"');
  });

  it("opens a paired PC and leaves one that has not approved this device as a plain row", () => {
    const html = render({ ...props({ kind: "list", devices: [], account: { kind: "signed-in", provider: "github", error: null,
      pcs: [pc("a".repeat(32), "p620", "paired"), pc("b".repeat(32), "nuc", "needs-approval"), pc("c".repeat(32), "old-desktop", "offline", false), pc("d".repeat(32), "laptop", "offline", true)] } }), scoped: false, onSignIn: none });
    expect(html).toContain(`href="/s/${"a".repeat(32)}/"`);
    expect(html).not.toContain(`href="/s/${"b".repeat(32)}/"`);
    // offline says nothing about pairing: only the PC this device is paired with opens
    expect(html).not.toContain(`href="/s/${"c".repeat(32)}/"`);
    expect(html).toContain(`href="/s/${"d".repeat(32)}/"`);
    expect(html).toContain("Needs approval");
    expect(html).not.toContain("Continue with GitHub");
  });

});

describe("the dashboard", () => {
  const pc = (server_id: string, name: string, state: MyPc["state"], over: Partial<MyPc> = {}): MyPc => ({ server_id, name, state, last_seen_at: null, added_at: null, listed: true, paired: state === "paired", linked: true, ...over });
  const device = (server_id: string, name: string, relay: string) => ({ server_id, server_public_key: "k", relay, name, device_id: "0".repeat(16), label: "Phone" }) as unknown as Extract<RelayShellProps["state"], { kind: "list" }>["devices"][number];
  const AP = "wss://relay-ap.ovis.sh";
  const GLOBAL = "wss://relay.ovis.sh";
  const ids = { desk: "a".repeat(32), mac: "b".repeat(32), mini: "c".repeat(32), home: "d".repeat(32) };
  /** the mockup's four PCs: two ready on the Seoul relay (one paired by QR, not in the account), one waiting there, one offline on the global relay */
  const four = (): MyPc[] => [
    pc(ids.desk, "Desk PC", "paired", { last_seen_at: new Date().toISOString() }),
    pc(ids.mac, "MacBook", "paired", { listed: false, linked: false }),
    pc(ids.mini, "Mac mini", "needs-approval", { last_seen_at: new Date().toISOString(), added_at: new Date().toISOString(), join: { server_public_key: "k", relay: AP } }),
    pc(ids.home, "Home server", "offline", { paired: true, last_seen_at: new Date(Date.now() - 20 * 3_600_000).toISOString() }),
  ];
  const devices = () => [device(ids.desk, "Desk PC", AP), device(ids.mac, "MacBook", AP), device(ids.home, "Home server", GLOBAL)];
  const signedIn = (pcs: MyPc[] | null, extra: Partial<RelayShellProps> = {}): RelayShellProps => ({ ...props({ kind: "list", devices: devices(), account: { kind: "signed-in", provider: "github", error: null, pcs } }), scoped: false, onSignIn: none, onJoin: none, onSignOut: none, onLeave: none, ...extra });
  const text = (html: string) => html.replace(/<[^>]+>/g, "");

  it("sums the model into the strip: counts, relays in the map's order with their kind, and what needs attention", () => {
    const html = render(signedIn(four()));
    expect(html).toContain('data-dashboard-mode="account"');
    expect(html).toContain("4 PCs in your account");
    const counts = [...html.matchAll(/<li><span class="relay-dash-dot" data-pc-state="[^"]+" aria-hidden="true"><\/span>([^<]+)<b>(\d+)<\/b>/g)].map(([, label, n]) => [label, Number(n)]);
    expect(counts).toEqual([["Ready", 2], ["Needs you", 1], ["Offline", 1]]);
    const relays = [...html.matchAll(/<code class="relay-dash-host">([^<]+)<\/code><span>([^<]+)<\/span><span>([^<]+)<\/span>/g)].map(([, host, n, kind]) => [host, n, kind]);
    expect(relays).toEqual([["relay-ap.ovis.sh", "3 PCs", "regional"], ["relay.ovis.sh", "1 PC", "global"]]);
    expect(html).toContain("Needs attention · 2");
    const attention = [...html.matchAll(/<span class="relay-dash-attention-name">([^<]+)<\/span><small>([^<]+)<\/small>/g)].map(([, name, why]) => [name, why]);
    expect(attention).toEqual([["Mac mini", "Needs approval"], ["Home server", "Offline · 20 h ago"]]);
    // the map's slot waits for RelayMap; the nav counts the PCs
    expect(html).toContain('data-slot="relay-map"');
    expect(html).toContain('<span class="relay-dash-nav-count">4</span>');
  });

  it("gives each row its state, relay, last seen and the one action its state allows", () => {
    const html = render(signedIn(four()));
    expect(text(rowOf(html, "Desk PC"))).toContain("in your account");
    expect(text(rowOf(html, "Desk PC"))).toContain("just now");
    expect(actionsOf(rowOf(html, "Desk PC"))).toEqual(["Open"]);
    expect(rowOf(html, "Desk PC")).toContain(`href="/s/${ids.desk}/"`);
    expect(text(rowOf(html, "MacBook"))).toContain("paired by QR · not in the account yet");
    expect(text(rowOf(html, "MacBook"))).toContain("—");
    expect(actionsOf(rowOf(html, "Mac mini"))).toEqual(["Add"]);
    expect(rowOf(html, "Home server")).toContain('data-pc-state="offline"');
    expect(actionsOf(rowOf(html, "Home server"))).toEqual(["Details"]);
    expect(rowOf(html, "Home server")).toContain(`href="/s/${ids.home}/"`);
    expect(text(rowOf(html, "Home server"))).toContain("20 h ago");
    const hosts = [...html.matchAll(/<td class="relay-dash-relay">([^<]+)<\/td>/g)].map(([, host]) => host);
    expect(hosts).toEqual(["relay-ap.ovis.sh", "relay-ap.ovis.sh", "relay-ap.ovis.sh", "relay.ovis.sh"]);
    // an offline PC this device is not paired with has nothing to do, and the directory's relay wins over the pairing's
    const unpaired = render(signedIn([pc(ids.home, "Home server", "offline")], { directoryRelays: [{ server_id: ids.home, relay: AP }] }));
    expect(actionsOf(rowOf(unpaired, "Home server"))).toEqual([]);
    expect(rowOf(unpaired, "Home server")).toContain("relay-ap.ovis.sh");
  });

  it("says who is signed in at the sidebar's foot, with Sign out and the way out of the account", () => {
    const html = render(signedIn(four()));
    const foot = /<div class="relay-dash-foot"[\s\S]*?<\/aside>/.exec(html)![0];
    expect(text(foot)).toContain("Signed in with GitHub");
    expect([...foot.matchAll(/<button type="button" class="account-link[^"]*">([^<]+)</g)].map(([, label]) => label)).toEqual(["Sign out", "Remove this device from your account"]);
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain("Overview");
  });

  it("shows one sentence and Add a PC for an empty account, and waits while the directory loads", () => {
    const empty = render(signedIn([]));
    expect(text(empty)).toContain("No PCs yet. Sign in on a PC, or scan the QR code it shows, to see it here.");
    expect(actionsOf(empty)).toEqual(["Add a PC", "Add a PC"]);
    expect(empty).not.toContain("<table");
    expect(empty).not.toContain('data-slot="relay-map"');
    expect(empty).not.toContain("relay-dash-nav-count");
    const loading = render(signedIn(null));
    expect(loading).toContain("Loading your PCs…");
    expect(loading).not.toContain("<table");
  });

  describe("in a browser", () => {
    const descriptors = new Map<string, PropertyDescriptor | undefined>();
    let renderer: ReactTestRenderer | undefined;
    // the test renderer draws no DOM: a node stands in for every element, and the sheet portals into a body that holds them
    const node = () => ({ isConnected: true, focus() {}, contains: () => false, querySelectorAll: () => [], getClientRects: () => [], closest: () => null, addEventListener() {}, removeEventListener() {} });

    beforeEach(() => {
      for (const key of ["window", "document", "navigator", "localStorage", "getComputedStyle", "matchMedia", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      const events = new EventTarget();
      const store = new Map<string, string>();
      const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); }, key: () => null, length: 0, clear: () => store.clear() };
      const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      class HTMLElement { isConnected = true; focus(): void {} }
      Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
      Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: HTMLElement });
      Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Mozilla/5.0 (X11; Linux x86_64)", maxTouchPoints: 0 } });
      Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
      Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: matchMedia });
      Object.defineProperty(globalThis, "window", { configurable: true, value: {
        location: { href: "https://app.ovis.sh/", search: "", origin: "https://app.ovis.sh", pathname: "/" },
        history: { state: null, replaceState() {} },
        localStorage: storage, matchMedia, innerWidth: 1440,
        addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events),
        setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
      } });
      Object.defineProperty(globalThis, "document", { configurable: true, value: {
        documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
        activeElement: new HTMLElement(),
        body: { nodeType: 1, children: [], createNodeMock: node },
        querySelector: () => null, querySelectorAll: () => [],
        addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
      } });
    });

    afterEach(async () => {
      await act(async () => { renderer?.unmount(); });
      renderer = undefined;
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      descriptors.clear();
    });

    const mount = async (shown: RelayShellProps) => { await act(async () => { renderer = create(createElement(SettingsProvider, { children: createElement(RelayShell, shown) }), { createNodeMock: node }); }); };
    const dialogs = () => renderer!.root.findAll((instance) => instance.props.role === "dialog");
    const dialog = () => { const found = dialogs(); if (found.length !== 1) throw new Error(`${found.length} dialogs`); return found[0]!; };
    const textOf = (node: ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : textOf(child)).join("");
    const buttons = (label: string) => renderer!.root.findAll((node) => node.type === "button" && textOf(node).trim() === label);
    const button = (label: string) => { const found = buttons(label); if (found.length !== 1) throw new Error(`${found.length} buttons say ${label}`); return found[0]!; };
    const rows = () => renderer!.root.findAll((node) => node.type === "tr" && node.props["data-pc-state"] !== undefined).map((row) => textOf(row.find((node) => node.type === "b")));

    it("narrows the table: Needs you hides the ready and offline rows, Ready the others, All brings them back", async () => {
      await mount(signedIn(four()));
      expect(rows()).toEqual(["Desk PC", "MacBook", "Mac mini", "Home server"]);
      await act(async () => { button("Needs you").props.onClick(); });
      expect(rows()).toEqual(["Mac mini"]);
      expect(button("Needs you").props["aria-pressed"]).toBe(true);
      await act(async () => { button("Ready").props.onClick(); });
      expect(rows()).toEqual(["Desk PC", "MacBook"]);
      await act(async () => { button("All").props.onClick(); });
      expect(rows()).toEqual(["Desk PC", "MacBook", "Mac mini", "Home server"]);
    });

    it("opens the Add-a-PC sheet from Add and Join in the matching mode, whose own button starts the join and names the sheet", async () => {
      const old = pc("e".repeat(32), "nuc", "needs-approval", { added_at: new Date(Date.now() - 3_600_000).toISOString(), join: { server_public_key: "k", relay: AP } });
      const joined: [string, unknown][] = [];
      await mount(signedIn([...four(), old], { onJoin: (target, options) => { joined.push([target.name, options]); } }));
      expect(dialogs()).toHaveLength(0);
      // the notice offers Add for the first PC waiting, and its row again: both open the one sheet
      expect(buttons("Add")).toHaveLength(2);
      await act(async () => { buttons("Add")[1]!.props.onClick(); });
      expect(dialog().props["data-add-pc-mode"]).toBe("new");
      expect(dialog().props["data-add-pc-phase"]).toBe("start");
      expect(textOf(dialog())).toContain("Add Mac mini to your account");
      await act(async () => { button("Add this PC").props.onClick(); });
      expect(joined).toEqual([["Mac mini", { typed: true, sheet: "new" }]]);
      await act(async () => { button("Cancel").props.onClick(); });
      expect(dialogs()).toHaveLength(0);
      await act(async () => { buttons("Add")[0]!.props.onClick(); });
      expect(dialog().props["data-add-pc-mode"]).toBe("new");
      await act(async () => { button("Cancel").props.onClick(); });
      await act(async () => { button("Join").props.onClick(); });
      expect(dialog().props["data-add-pc-mode"]).toBe("join");
      expect(textOf(dialog())).toContain("Add this device to nuc");
      await act(async () => { button("Ask to join").props.onClick(); });
      expect(joined[1]).toEqual(["nuc", { sheet: "join" }]);
    });

    it("takes Add a PC to the sheet's add mode, its QR route to the pairing screen, and Back to the dashboard", async () => {
      await mount(signedIn(four()));
      await act(async () => { button("Add a PC").props.onClick(); });
      expect(dialog().props["data-add-pc-mode"]).toBe("add");
      await act(async () => { button("Pair with a QR or code").props.onClick(); });
      expect(dialogs()).toHaveLength(0);
      expect(textOf(renderer!.root.findByType("h1"))).toBe("Scan the QR code on your PC");
      expect(renderer!.root.findAll((instance) => instance.type === "table")).toHaveLength(0);
      await act(async () => { button("Back").props.onClick(); });
      expect(textOf(renderer!.root.findByType("h1"))).toBe("Overview");
      expect(rows()).toHaveLength(4);
    });

    it("goes on in the sheet over the PC's own page for the join it started: the link's question, then the digits; a plain visit keeps the screens", async () => {
      const offer = { v: 1 as const, server_id: ids.mini, server_public_key: "k", relay: AP, name: "Mac mini" };
      let paired = 0;
      await mount({ ...props({ kind: "confirm", offer }), onPair: () => { paired += 1; }, sheetJoin: { mode: "new", server_id: ids.mini } });
      expect(dialog().props["data-add-pc-phase"]).toBe("confirm");
      expect(renderer!.root.findAll((instance) => instance.type === "h1")).toHaveLength(0);
      await act(async () => { button("Pair").props.onClick(); });
      expect(paired).toBe(1);
      await act(async () => { renderer!.unmount(); });
      const typed: (string | undefined)[] = [];
      await mount({ ...props({ kind: "compare", name: "Mac mini", digits: "123456", confirmed: false, typed: true }), onMatch: (digits) => { typed.push(digits); }, sheetJoin: { mode: "new", server_id: ids.mini } });
      expect(dialog().props["data-add-pc-phase"]).toBe("compare");
      const form = dialog().findByType("form");
      await act(async () => { form.props.onSubmit({ preventDefault() {}, currentTarget: { elements: { namedItem: () => ({ value: "123 456" }) } } }); });
      expect(typed).toEqual(["123456"]);
      await act(async () => { renderer!.unmount(); });
      // the same screen without the sheet's join, or with another PC's: the shell's own screen, as before
      await mount({ ...props({ kind: "confirm", offer }), sheetJoin: { mode: "join", server_id: ids.desk } });
      expect(dialogs()).toHaveLength(0);
      expect(textOf(renderer!.root.findByType("h1"))).toBe("Pair with Mac mini?");
    });

    it("lists this device's own pairings behind Continue without an account, and offers the sign-in at the foot", async () => {
      await mount({ ...props({ kind: "list", devices: [device(ids.desk, "p620", AP), device(ids.mac, "nuc", GLOBAL)], account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none });
      await act(async () => { button("Continue without an account (2 PCs)").props.onClick(); });
      const main = renderer!.root.findByType("main");
      expect(main.props["data-account-state"]).toBe("signed-out");
      expect(renderer!.root.findByProps({ className: "relay-dash" }).props["data-dashboard-mode"]).toBe("local");
      expect(rows()).toEqual(["nuc", "p620"]);
      expect(renderer!.root.findAll((node) => node.type === "a" && node.props.className === "btn btn-primary").map((link) => link.props.href)).toEqual([`/s/${ids.mac}/`, `/s/${ids.desk}/`]);
      const foot = renderer!.root.findByProps({ className: "relay-dash-foot" });
      expect(textOf(foot)).toContain("Without an account");
      expect(textOf(foot)).not.toContain("Sign out");
      expect(textOf(renderer!.root.find((node) => node.type === "p" && node.props.className === "relay-dash-sub"))).toBe("2 PCs paired with this device");
      // the strip counts them ready, both on their own relays
      expect(renderer!.root.findAll((node) => node.type === "code").map(textOf)).toEqual(["relay-ap.ovis.sh", "relay.ovis.sh"]);
      await act(async () => { foot.find((node) => node.type === "button").props.onClick(); });
      expect(textOf(renderer!.root.findByType("h1"))).toBe("Sign in to Ovis");
    });
  });
});

const groupsOf = (html: string) => [...html.matchAll(/<span class="(key-id-group(?: key-id-differs)?)">([0-9a-f]{4})/g)].map(([, kind, group]) => [group, kind === "key-id-group key-id-differs"]);

describe("a key that is not the PC's", () => {
  it("splits an id into eight groups of four", () => {
    expect(keyIdGroups(EXPECTED)).toEqual(["0123", "4567", "89ab", "cdef", "0123", "4567", "89ab", "cdef"]);
  });

  for (const state of [
    { kind: "forged", name: "Desk", mismatch: { expected: EXPECTED, received: RECEIVED, from: "link" } },
    { kind: "failed", failure: "identity-changed", name: "Desk", detail: null, mismatch: { expected: EXPECTED, received: RECEIVED, from: "saved" } },
  ] as const) {
    it(`shows the PC's id and the other key's, marking the groups that differ (${state.kind})`, () => {
      const html = render(props(state));
      expect(html).toContain('data-relay-state="identity-changed"');
      const [pcGroups, receivedGroups] = [groupsOf(html).slice(0, 8), groupsOf(html).slice(8)];
      expect(pcGroups.every(([, differs]) => differs === false)).toBe(true);
      expect(receivedGroups).toEqual([["0123", false], ["4567", false], ["ffff", true], ["cdef", false], ["0123", false], ["4567", false], ["89ab", false], ["eeee", true]]);
      // a differing group is named for a screen reader, not told by colour alone
      expect(html.match(/visually-hidden">\s*differs</g)).toHaveLength(2);
    });
  }

  it("never calls an id the PC's: each is labelled by where it came from", () => {
    const forged = render(props({ kind: "forged", name: "Desk", mismatch: { expected: EXPECTED, received: RECEIVED, from: "link" } }));
    expect(forged).not.toContain("This PC&#x27;s ID");
    expect(forged).toContain("ID this link names");
    expect(forged).toContain("ID of the key this link carries");
    // a bad saved key under a genuine link is the saved key's, not the link's
    const changed = render(props({ kind: "failed", failure: "identity-changed", name: "Desk", detail: null, mismatch: { expected: EXPECTED, received: RECEIVED, from: "saved" } }));
    expect(changed).toContain("ID this phone paired with");
    expect(changed).toContain("ID of the key this phone saved");
    expect(changed).not.toContain("this link carries");
  });

  it("says a key that does not parse is not a valid key, and still shows the PC's id", () => {
    const html = render(props({ kind: "forged", name: null, mismatch: { expected: EXPECTED, received: null, from: "link" } }));
    expect(html).toContain("Not a valid key");
    expect(groupsOf(html)).toHaveLength(8);
  });
});

describe("pairing with a typed code", () => {
  it("shows every group of the ID a code found before anything is paired", () => {
    const html = render(props({ kind: "code-compare", offer: { v: 1, server_id: EXPECTED, server_public_key: "k", relay: "wss://relay.example", code: "123456", name: "Desk" } }));
    for (const group of keyIdGroups(EXPECTED)) expect(html).toContain(`>${group}<`);
    expect(html).toContain("It matches");
    expect(html).toContain('data-relay-state="code-compare"');
  });

  it("keeps the code in its field only, and says why the last one gave no PC", () => {
    const html = render(props({ kind: "code-entry", failure: "no-pc" }));
    expect(html).toMatch(/<input[^>]*name="code"/);
    expect(html).not.toMatch(/<input[^>]*name="code"[^>]*value=/);
    expect(html).toContain("No PC shows this code");
  });
});
