import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { act, createElement, type ReactNode } from "react";
import * as ReactDom from "react-dom";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { MyPc } from "../lib/account/myPcs.ts";
import { SignedOutError, type AccountService } from "../lib/account/service.ts";
import type { AccountSession } from "../lib/account/store.ts";
import { SettingsProvider } from "../lib/settings.ts";

// the confirmation is a portal into document.body: drawn in place here, so the test renderer holds it
await mock.module("react-dom", () => ({ ...ReactDom, createPortal: (node: ReactNode) => node }));
const { AccountPcRows, NoAccountPcHint, hostedPcUrl, removePcFromAccount } = await import("./AccountPcs.tsx");

const DESK = "a".repeat(32);
const LAPTOP = "b".repeat(32);
const pc = (server_id: string, name: string): MyPc => ({ server_id, name, state: "needs-approval", last_seen_at: null, added_at: null, listed: true, paired: false, linked: false });

const textOf = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");

describe("the account's PCs in a PC's own Settings", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let warn: typeof console.warn;

  beforeEach(() => {
    warn = console.warn;
    console.warn = () => {};
    for (const key of ["window", "document", "navigator", "localStorage", "getComputedStyle", "matchMedia", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"]) {
      descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    }
    const events = new EventTarget();
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); }, key: () => null, length: 0, clear: () => store.clear() };
    const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    class HTMLElement { isConnected = true; focus(): void {} }
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: HTMLElement });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Test", maxTouchPoints: 0 } });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: matchMedia });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      location: { href: "https://pc.example/", search: "", origin: "https://pc.example", pathname: "/" },
      history: { state: null, replaceState() {} },
      localStorage: storage, matchMedia, innerWidth: 1440,
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events),
      setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
      activeElement: new HTMLElement(),
      body: { nodeType: 1, children: [] },
      querySelector: () => null,
      querySelectorAll: () => [],
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

  const mount = async (node: ReactNode): Promise<ReactTestInstance> => {
    await act(async () => {
      renderer = create(createElement(SettingsProvider, { children: node }), {
        createNodeMock: () => ({ isConnected: true, focus() {}, contains: () => false, querySelectorAll: () => [], getClientRects: () => [], closest: () => null, addEventListener() {}, removeEventListener() {} }),
      });
    });
    if (!renderer) throw new Error("not mounted");
    return renderer.root;
  };
  const dialogs = (root: ReactTestInstance) => root.findAll((node) => node.props.role === "alertdialog");

  it("gives each account PC a link to its page in the hosted app, in a new tab", async () => {
    const root = await mount(createElement(AccountPcRows, { pcs: [pc(DESK, "Desk"), pc(LAPTOP, "Laptop")], watching: false, remove: async () => {}, onRemoved: () => {} }));
    const links = root.findAll((node) => node.type === "a");
    expect(links.map((link) => [textOf(link), link.props.href, link.props.target, link.props.rel])).toEqual([
      ["Open in browser", `https://app.ovis.sh/s/${DESK}/`, "_blank", "noreferrer"],
      ["Open in browser", `https://app.ovis.sh/s/${LAPTOP}/`, "_blank", "noreferrer"],
    ]);
    expect(hostedPcUrl(DESK)).toBe(`https://app.ovis.sh/s/${DESK}/`);
    // the rows still say what the directory knows (the state text of the stacked change)
    expect(root.findAll((node) => node.type === "li").map(textOf)).toEqual(["DeskPCIn your accountOpen in browser", "LaptopPCIn your accountOpen in browser"]);
  });

  it("removes a PC from the account only after the confirm, once, then asks for the list again", async () => {
    const calls: string[] = [];
    const root = await mount(createElement(AccountPcRows, {
      pcs: [pc(DESK, "Desk"), pc(LAPTOP, "Laptop")], watching: false,
      remove: async (id: string) => { calls.push(`remove ${id}`); }, onRemoved: () => { calls.push("recheck"); },
    }));
    const removeButton = root.find((node) => node.type === "button" && node.props["aria-label"] === "Remove Laptop from your account");
    expect(removeButton.props.title).toBe("Remove Laptop from your account");

    await act(async () => { removeButton.props.onClick(); });
    const dialog = dialogs(root)[0]!;
    const words = textOf(dialog);
    expect(words).toContain("Remove Laptop from your account?");
    // what the removal does not do, and what it does to the relay where an account is required
    expect(words).toContain("Devices already paired with it keep working until they are revoked on that PC.");
    expect(words).toContain("Laptop leaves the relay within two days.");

    await act(async () => { dialog.find((node) => node.type === "button" && textOf(node) === "Cancel").props.onClick(); });
    expect(dialogs(root)).toHaveLength(0);
    expect(calls).toEqual([]);

    await act(async () => { removeButton.props.onClick(); });
    await act(async () => { await dialogs(root)[0]!.find((node) => node.type === "button" && textOf(node) === "Remove from account").props.onClick(); });
    expect(calls).toEqual([`remove ${LAPTOP}`, "recheck"]);
    expect(dialogs(root)).toHaveLength(0);
  });

  it("keeps the confirm up with a retry line when the removal fails, and asks for no recheck", async () => {
    let rechecks = 0;
    const root = await mount(createElement(AccountPcRows, {
      pcs: [pc(DESK, "Desk")], watching: false,
      remove: async () => { throw new Error("502 bad gateway from the service"); }, onRemoved: () => { rechecks += 1; },
    }));
    await act(async () => { root.find((node) => node.type === "button" && node.props["aria-label"] === "Remove Desk from your account").props.onClick(); });
    await act(async () => { await dialogs(root)[0]!.find((node) => node.type === "button" && textOf(node) === "Remove from account").props.onClick(); });
    const alert = dialogs(root)[0]!.find((node) => node.props.role === "alert");
    expect(textOf(alert)).toBe("Desk could not be removed. Try again.");
    expect(rechecks).toBe(0);
  });

  it("offers a watching device neither action", async () => {
    const root = await mount(createElement(AccountPcRows, { pcs: [pc(DESK, "Desk")], watching: true, remove: async () => {}, onRemoved: () => {} }));
    expect(root.findAll((node) => node.type === "a")).toHaveLength(0);
    expect(root.findAll((node) => node.type === "button")).toHaveLength(0);
    expect(root.findAll((node) => node.type === "li").map(textOf)).toEqual(["DeskPCIn your account"]);
  });

  it("says an account with no PC has none, naming what it signed in with", async () => {
    const root = await mount(createElement(NoAccountPcHint, { provider: "google" }));
    expect(textOf(root)).toBe("No PC in this account yet. Signed in with Google: GitHub and Google are separate Ovis accounts until you link them.");
  });
});

describe("removePcFromAccount", () => {
  const session = (account: string): AccountSession => ({ service: "https://account.example", account, provider: "github", access_token: "a", refresh_token: "r", expires_at: 0, sign_in_id: `id-${account}` });
  const serviceWith = (stored: AccountSession | undefined, deleted: string[]): Pick<AccountService, "session" | "forSignIn"> => ({
    session: async () => stored,
    forSignIn: (signIn: AccountSession) => ({ deletePc: async (id: string) => { deleted.push(`${signIn.account} ${id}`); } }) as unknown as AccountService,
  });

  it("removes the PC as the sign-in whose list is shown", async () => {
    const deleted: string[] = [];
    await removePcFromAccount(serviceWith(session("acct-1"), deleted), "acct-1", DESK);
    expect(deleted).toEqual([`acct-1 ${DESK}`]);
  });

  it("removes nothing once another sign-in, or none, is stored", async () => {
    const deleted: string[] = [];
    await expect(removePcFromAccount(serviceWith(session("acct-2"), deleted), "acct-1", DESK)).rejects.toBeInstanceOf(SignedOutError);
    await expect(removePcFromAccount(serviceWith(undefined, deleted), "acct-1", DESK)).rejects.toBeInstanceOf(SignedOutError);
    expect(deleted).toEqual([]);
  });
});

describe("Settings → Devices and PCs", () => {
  it("draws the Account group above the device list, outside More settings", () => {
    const source = readFileSync(new URL("./SettingsDialog.tsx", import.meta.url), "utf8");
    const page = source.slice(source.indexOf("function DevicesPage("), source.indexOf("function UseRelayHere("));
    const account = page.indexOf("<AccountSection ");
    const fold = page.indexOf('<SettingsFold kind="more"');
    expect(account).toBeGreaterThan(-1);
    expect(page.indexOf("<AccountSection ", account + 1)).toBe(-1);
    expect(account).toBeLessThan(page.indexOf('<SettingsGroup section="devices">'));
    expect(account).toBeLessThan(fold);
    // and its link from Add a connection opens no fold to reach it
    expect(page.slice(page.indexOf("const openAccount"), page.indexOf("const accountService"))).not.toContain("details");
  });
});
