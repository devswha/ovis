import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act, createElement, type ReactNode } from "react";
import * as ReactDom from "react-dom";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { PairedDevice } from "../../shared/protocol.ts";
import * as Api from "../lib/api.ts";
import * as Leave from "../lib/account/leave.ts";
import * as Service from "../lib/account/service.ts";
import * as Store from "../lib/account/store.ts";
import { SettingsProvider } from "../lib/settings.ts";

const MY_KEY = "my-key";
const NOW = Date.now();
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();
const device = (id: string, extra: Partial<PairedDevice> = {}): PairedDevice => ({ id, label: id, role: "drive", created_at: "", last_seen_at: "", current: false, ...extra });

let devices: PairedDevice[] = [];
let pcs: Service.DirectoryPc[] = [];
const calls: string[] = [];
let deleteFails = false;
let readsFail = false;
let deviceReads = 0;
const SESSION = { account: "acct", provider: "github", service: "https://account.example", sign_in_id: "s", access_token: "a", refresh_token: "r", expires_at: NOW + 3_600_000 };

// the confirmation is a portal into document.body: drawn in place here, so the test renderer holds it
await mock.module("react-dom", () => ({ ...ReactDom, createPortal: (node: ReactNode) => node }));
await mock.module("../lib/api.ts", () => ({ ...Api, fetchDevices: async () => { deviceReads++; if (readsFail) throw new Error("503 from the PC"); return devices; } }));
await mock.module("../lib/account/leave.ts", () => ({ ...Leave, removeFromAccount: async (options: { key: string }) => { calls.push(`disconnect ${options.key}`); return { remove: {}, unconfirmed: [], queued: [] }; } }));
await mock.module("../lib/account/store.ts", () => ({ ...Store, indexedAccountStore: { ...Store.indexedAccountStore, key: async () => ({ public_spki: MY_KEY }), get: async (name: string) => name === "session" ? SESSION : undefined } }));
class FakeService {
  async listPcs() { if (readsFail) throw new Error("503 from the service"); return pcs; }
  async session() { return { account: "acct" }; }
  forSignIn() { return { deletePc: async (id: string) => { if (deleteFails) throw new Error("502 from the service"); calls.push(`remove ${id}`); } }; }
}
await mock.module("../lib/account/service.ts", () => ({ ...Service, AccountService: FakeService }));
const { AccountManageLists } = await import("./AccountManage.tsx");
const { HostedAccountGroup } = await import("./AccountHead.tsx");
const { RelayShell } = await import("./RelayShell.tsx");
const { keepShellAccount } = await import("../lib/account/hostedSignIn.ts");

const textOf = (node: ReactTestInstance): string => node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");

describe("Manage account's devices and PCs", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let warn: typeof console.warn;

  beforeEach(() => {
    warn = console.warn;
    console.warn = () => {};
    calls.length = 0;
    deleteFails = false;
    readsFail = false;
    deviceReads = 0;
    devices = [
      device("me", { current: true, account: "acct", account_key: MY_KEY, connection: { route: "relay", rtt_ms: 9 } as PairedDevice["connection"] }),
      device("Lost phone", { account: "acct", account_key: "phone-key" }),
      device("Other account", { account: "other", account_key: "x-key" }),
      device("Cookie browser"),
    ];
    pcs = [
      { server_id: "a".repeat(32), label: "Desk", public_key: null, relay: null, added_at: ago(60 * 24 * 300), last_seen_at: ago(2) },
      { server_id: "b".repeat(32), label: "Dead box", public_key: null, relay: null, added_at: ago(60), last_seen_at: ago(30) },
    ] as Service.DirectoryPc[];
    for (const key of ["window", "document", "navigator", "getComputedStyle", "matchMedia", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const events = new EventTarget();
    const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    class HTMLElement { isConnected = true; focus(): void {} }
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: HTMLElement });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Test", maxTouchPoints: 0 } });
    Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: matchMedia });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      location: { href: "https://pc.example/", search: "", origin: "https://pc.example", pathname: "/", protocol: "https:" },
      history: { state: null, replaceState() {} }, matchMedia, innerWidth: 1440,
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events),
      setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
      activeElement: new HTMLElement(), body: { nodeType: 1, children: [] },
      querySelector: () => null, querySelectorAll: () => [],
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
    } });
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    console.warn = warn;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  const mount = async (props: { watching?: boolean; onLeave?: () => Promise<void> } = {}): Promise<ReactTestInstance> => {
    await act(async () => {
      renderer = create(createElement(SettingsProvider, { children: createElement(AccountManageLists, { account: "acct", watching: props.watching ?? false, ...(props.onLeave ? { onLeave: props.onLeave } : {}) }) }), {
        createNodeMock: () => ({ isConnected: true, focus() {}, contains: () => false, querySelectorAll: () => [], getClientRects: () => [], closest: () => null, addEventListener() {}, removeEventListener() {} }),
      });
    });
    if (!renderer) throw new Error("not mounted");
    return renderer.root;
  };
  const rows = (root: ReactTestInstance, list: string) => root.find((node) => node.props["data-testid"] === list).findAll((node) => node.type === "li").map(textOf);
  const action = (root: ReactTestInstance, name: string) => root.find((node) => node.type === "button" && node.props["data-action"] === name);
  const dialog = (root: ReactTestInstance) => root.find((node) => node.props.role === "alertdialog");
  const press = (root: ReactTestInstance, label: string) => dialog(root).find((node) => node.type === "button" && textOf(node) === label).props.onClick();

  it("lists the account's other devices on this PC, one line each, and disconnects one after a single confirm", async () => {
    const root = await mount();
    expect(rows(root, "account-devices")).toEqual(["OfflineLost phoneDisconnect"]);
    await act(async () => { action(root, "disconnect-device").props.onClick(); });
    expect(textOf(dialog(root))).toContain("Disconnect Lost phone?");
    expect(calls).toEqual([]);
    await act(async () => { await press(root, "Disconnect"); });
    expect(calls).toEqual(["disconnect phone-key"]);
    expect(root.findAll((node) => node.props.role === "alertdialog")).toHaveLength(0);
  });

  it("offers Remove on an offline PC whatever its age, never on one heard from lately, and removes it after one confirm", async () => {
    const root = await mount();
    expect(rows(root, "account-pcs")).toEqual(["OnlineDesk", "OfflineDead boxRemove"]);
    await act(async () => { action(root, "remove-pc").props.onClick(); });
    expect(textOf(dialog(root))).toContain("Remove Dead box from your account?");
    await act(async () => { await press(root, "Remove"); });
    expect(calls).toEqual([`remove ${"b".repeat(32)}`]);
  });

  it("keeps the confirm up with a retry line when the removal fails", async () => {
    deleteFails = true;
    const root = await mount();
    await act(async () => { action(root, "remove-pc").props.onClick(); });
    await act(async () => { await press(root, "Remove"); });
    expect(textOf(dialog(root).find((node) => node.props.role === "alert"))).toBe("Dead box could not be removed. Try again.");
  });

  it("says the lists could not be read rather than show an empty account", async () => {
    readsFail = true;
    const root = await mount();
    expect(rows(root, "account-devices")).toEqual(["Devices could not be loaded."]);
    expect(rows(root, "account-pcs")).toEqual(["PCs could not be loaded."]);
  });

  it("offers a watching device no PC removal", async () => {
    const root = await mount({ watching: true });
    expect(root.findAll((node) => node.type === "button" && node.props["data-action"] === "remove-pc")).toHaveLength(0);
  });

  it("lets this device leave the account from its own row, after a confirm, where the page offers it", async () => {
    let left = 0;
    const root = await mount({ onLeave: async () => { left++; } });
    expect(rows(root, "account-devices")[0]).toBe("This deviceDisconnect");
    await act(async () => { action(root, "leave-account").props.onClick(); });
    expect(left).toBe(0);
    await act(async () => { await press(root, "Disconnect"); });
    expect(left).toBe(1);
  });

  type Leave = () => Promise<{ readonly left: boolean; readonly message: string | null }>;
  const hosted = (leave: Leave) => ({ provider: "github" as const, account: "acct", signOut() {}, leave, deleteAccount: async () => null });
  const group = (signIn: ReturnType<typeof hosted> | null) => createElement(SettingsProvider, { children: createElement(HostedAccountGroup, { signIn }) });
  const leaveFromSheet = async (leave: Leave): Promise<ReactTestInstance> => {
    await act(async () => {
      renderer = create(group(hosted(leave)), {
        createNodeMock: () => ({ isConnected: true, focus() {}, contains: () => false, querySelectorAll: () => [], getClientRects: () => [], closest: () => null, addEventListener() {}, removeEventListener() {} }),
      });
    });
    const root = renderer!.root;
    await act(async () => { action(root, "manage-account").props.onClick(); });
    await act(async () => { action(root, "leave-account").props.onClick(); });
    await act(async () => { await press(root, "Disconnect"); });
    return root;
  };
  const sheets = (root: ReactTestInstance) => root.findAll((node) => node.type === "div" && node.props["data-testid"] === "manage-account");

  it("keeps the sheet and its confirm up with the error when this device could not leave the account", async () => {
    const root = await leaveFromSheet(async () => ({ left: false, message: "This device could not leave the account. Try again." }));
    expect(textOf(dialog(root).find((node) => node.props.role === "alert"))).toBe("This device could not leave the account. Try again.");
    expect(sheets(root)).toHaveLength(1);
  });

  it("names the PCs that kept this device in the sheet after a partial leave, once the sign-in is gone", async () => {
    const root = await leaveFromSheet(async () => ({ left: true, message: "These PCs still have it, so revoke it on them: Desk" }));
    await act(async () => { renderer!.update(group(null)); });
    expect(root.findAll((node) => node.props.role === "alertdialog")).toHaveLength(0);
    expect(sheets(root)).toHaveLength(1);
    expect(textOf(sheets(root)[0]!.find((node) => node.props.role === "alert"))).toBe("These PCs still have it, so revoke it on them: Desk");
  });

  it("opens Manage account from the signed-in start screen with no PC open, and removes an offline PC through the account service", async () => {
    const none = () => {};
    keepShellAccount({ signOut: none, leave: async () => ({ left: true, message: null }), deleteAccount: async () => null });
    try {
      await act(async () => {
        renderer = create(createElement(SettingsProvider, { children: createElement(RelayShell, {
          state: { kind: "list", devices: [], account: { kind: "signed-in", provider: "github", error: null, pcs: [] } },
          scoped: false, iosTab: false, onSignIn: none, onPair: none, onRetry: none, onCancel: none, onBack: none, onForget: none, onUpdate: none, onMatch: none, onCodeStart: none, onCodeSubmit: none, onCodeMatch: none,
        }) }), {
          createNodeMock: () => ({ isConnected: true, focus() {}, contains: () => false, querySelectorAll: () => [], getClientRects: () => [], closest: () => null, addEventListener() {}, removeEventListener() {} }),
        });
      });
      const root = renderer!.root;
      await act(async () => { action(root, "manage-account").props.onClick(); });
      // no PC answers here: the sheet asks none for its devices, and offers this device's own row
      expect(deviceReads).toBe(0);
      expect(rows(root, "account-devices")).toEqual(["This deviceDisconnect"]);
      expect(rows(root, "account-pcs")).toEqual(["OnlineDesk", "OfflineDead boxRemove"]);
      await act(async () => { action(root, "remove-pc").props.onClick(); });
      await act(async () => { await press(root, "Remove"); });
      expect(calls).toEqual([`remove ${"b".repeat(32)}`]);
    } finally {
      keepShellAccount(null);
    }
  });

  it("closes the sheet once this device left everywhere", async () => {
    const root = await leaveFromSheet(async () => ({ left: true, message: null }));
    expect(sheets(root)).toHaveLength(0);
  });
});
