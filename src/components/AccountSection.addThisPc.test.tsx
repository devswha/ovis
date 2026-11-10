import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { exportPublicKey, generateKeyPair, importPublicKey } from "../../shared/relay-e2ee.ts";
import { encodeOffer } from "../../shared/relay-offer.ts";
import { deriveServerId } from "../../shared/relay-server-proof.ts";
import type { AccountService } from "../lib/account/service.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { nativeTransport, setTransport } from "../lib/transport.ts";
import { ADDED_POLL_MS, AddThisPc, REOPEN_MS, WAITING_MS } from "./AccountSection.tsx";

const at = Date.parse("2026-11-10T03:00:00Z");
const MARKER = "ovis-add-pc-waiting";
const ACCOUNT = "acct_0123456789abcdef";
const keys = generateKeyPair();
const publicKey = exportPublicKey(keys.publicKey);
const offerUrl = encodeOffer({ v: 1, server_id: deriveServerId(importPublicKey(publicKey)), server_public_key: publicKey, relay: "wss://relay.ovis.sh", name: "desk" }, "https://app.ovis.sh");

describe("AddThisPc", () => {
  const globals = ["IS_REACT_ACT_ENVIRONMENT", "window", "document", "getComputedStyle", "navigator"];
  const saved = new Map<string, PropertyDescriptor | undefined>();
  let renderers: ReactTestRenderer[];
  /** what the PC answers: its account, and how the link route fails (null: it gives a link) */
  let pc: { account: string | null; linkError: { status: number; code: string } | null };
  /** every request to the PC: its path, and whether it asked for an approve-here window */
  let asked: { path: string; localOnly: boolean }[];
  /** the account directory's writes */
  let directory: string[];
  let page: { hidden: boolean; events: EventTarget };
  let tab: Map<string, string>;
  let restore: (() => void)[];
  const service = (): AccountService => ({
    listPcs: async () => [],
    putPc: async () => { directory.push("putPc"); },
    deletePc: async () => { directory.push("deletePc"); },
    session: async () => undefined,
  }) as unknown as AccountService;

  beforeEach(() => {
    renderers = [];
    pc = { account: null, linkError: null };
    asked = [];
    directory = [];
    tab = new Map();
    page = { hidden: false, events: new EventTarget() };
    for (const name of globals) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    const style = { setProperty: () => {}, removeProperty: () => {}, getPropertyValue: () => "", backgroundColor: "" };
    const listen = { addEventListener: () => {}, removeEventListener: () => {} };
    const storage = { getItem: (key: string) => tab.get(key) ?? null, setItem: (key: string, value: string) => { tab.set(key, value); }, removeItem: (key: string) => { tab.delete(key); } };
    const values: Record<string, unknown> = {
      IS_REACT_ACT_ENVIRONMENT: true,
      window: { ...listen, sessionStorage: storage, localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, key: () => null, length: 0 } },
      document: {
        documentElement: { lang: "", dataset: {}, style }, querySelector: () => null,
        get hidden() { return page.hidden; },
        addEventListener: page.events.addEventListener.bind(page.events), removeEventListener: page.events.removeEventListener.bind(page.events),
      },
      getComputedStyle: () => style,
      navigator: { languages: ["en"], userAgent: "Mozilla/5.0", maxTouchPoints: 0 },
    };
    for (const name of globals) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: values[name] });
    const answer = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = new URL(String(input instanceof Request ? input.url : input), "http://localhost").pathname;
      asked.push({ path, localOnly: new Headers(init?.headers).get("x-ovis-local-only") === "1" });
      if (path === "/api/account/status") return Response.json({ account: pc.account, unlinked: [], removals: [], adds: [], blocked: [] });
      if (path === "/api/relay/link") return pc.linkError === null ? Response.json({ url: offerUrl }) : Response.json({ error: { code: pc.linkError.code, message: "refused" } }, { status: pc.linkError.status });
      return Response.json({ error: { code: "not_found", message: "no such route" } }, { status: 404 });
    };
    setTransport({ ...nativeTransport, fetch: answer });
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(answer as typeof fetch);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    restore = [() => fetchSpy.mockRestore(), () => warn.mockRestore()];
    jest.useFakeTimers();
    jest.setSystemTime(new Date(at));
  });
  afterEach(() => {
    act(() => { for (const renderer of renderers) renderer.unmount(); });
    jest.useRealTimers();
    setTransport(nativeTransport);
    for (const undo of restore) undo();
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    saved.clear();
  });

  /** lets the answers on their way arrive and the screen draw them */
  const settle = async (): Promise<void> => { await act(async () => { for (let turn = 0; turn < 200; turn++) await Promise.resolve(); }); };
  const advance = async (ms: number): Promise<void> => { act(() => { jest.advanceTimersByTime(ms); }); await settle(); };
  const mount = async (): Promise<ReactTestRenderer> => {
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(createElement(SettingsProvider, { children: createElement(AddThisPc, { service }) })); });
    renderers.push(renderer);
    await settle();
    return renderer;
  };
  const words = (renderer: ReactTestRenderer): string => {
    const text = (node: ReactTestInstance | string): string => typeof node === "string" ? node : node.children.map(text).join("");
    return renderer.root.findAll((node) => node.type === "p").map(text).join("\n");
  };
  const press = async (renderer: ReactTestRenderer, label: string): Promise<void> => {
    const button = renderer.root.find((node) => node.type === "button" && node.children.join("") === label);
    act(() => { (button.props as { onClick: () => void }).onClick(); });
    await settle();
  };
  const buttons = (renderer: ReactTestRenderer): string[] => renderer.root.findAll((node) => node.type === "button").map((node) => node.children.join(""));
  const links = (): number => asked.filter((request) => request.path === "/api/relay/link").length;
  const show = (hidden: boolean): void => { page.hidden = hidden; act(() => { page.events.dispatchEvent(new Event("visibilitychange")); }); };
  const waitingFrom = async (): Promise<ReactTestRenderer> => {
    const renderer = await mount();
    await press(renderer, "Add this PC to my account");
    return renderer;
  };

  test("after the press it says what to do on any signed-in device, and keeps the wait for a reload", async () => {
    const renderer = await waitingFrom();
    expect(words(renderer)).toContain("On a device already signed in to this account (the Ovis app or app.ovis.sh), choose Add on desk. This screen then shows a six-digit number: type it there, then press Approve here. Keep this page open.");
    expect(words(renderer)).toContain("Waiting. The window reopens by itself if Ovis restarts.");
    expect(buttons(renderer)).toEqual(["Stop waiting"]);
    expect(directory).toEqual(["putPc"]);
    expect(JSON.parse(tab.get(MARKER)!)).toEqual({ name: "desk", until: at + WAITING_MS });
  });

  test("opens the window again every 30 seconds, approve-here only, with no directory write", async () => {
    await waitingFrom();
    expect(links()).toBe(1);
    await advance(REOPEN_MS - 1);
    expect(links()).toBe(1);
    await advance(1);
    expect(links()).toBe(2);
    // one at a time, as a clock passes them: an answer still on its way holds the next reopen back
    for (let tick = 0; tick < 3; tick++) await advance(REOPEN_MS);
    expect(links()).toBe(5);
    expect(asked.filter((request) => request.path === "/api/relay/link").every((request) => request.localOnly)).toBe(true);
    // the press listed the PC once; no reopening wrote to the directory or asked any other route
    expect(directory).toEqual(["putPc"]);
    expect(new Set(asked.map((request) => request.path))).toEqual(new Set(["/api/account/status", "/api/relay/link"]));
  });

  test("goes on reopening after a refused attempt, as while Ovis restarts", async () => {
    const renderer = await waitingFrom();
    pc.linkError = { status: 503, code: "internal" };
    await advance(REOPEN_MS);
    pc.linkError = null;
    await advance(REOPEN_MS);
    expect(links()).toBe(3);
    expect(buttons(renderer)).toEqual(["Stop waiting"]);
  });

  test("reopens nothing while the page is hidden, and at once when it shows again", async () => {
    await waitingFrom();
    show(true);
    await settle();
    for (let tick = 0; tick < 4; tick++) await advance(REOPEN_MS);
    expect(links()).toBe(1);
    show(false);
    await settle();
    expect(links()).toBe(2);
  });

  test("says by itself that the PC is in the account once a device added it, and then asks nothing more", async () => {
    const renderer = await waitingFrom();
    await advance(ADDED_POLL_MS);
    expect(buttons(renderer)).toEqual(["Stop waiting"]);
    pc.account = ACCOUNT;
    await advance(ADDED_POLL_MS);
    expect(words(renderer)).toContain("This PC is in your account. Your other devices can open it now.");
    expect(words(renderer)).toContain("Account acct_0123456…");
    expect(words(renderer)).not.toContain(ACCOUNT);
    expect(buttons(renderer)).toEqual([]);
    expect(tab.has(MARKER)).toBe(false);
    const before = asked.length;
    await advance(WAITING_MS);
    expect(asked.length).toBe(before);
    expect(jest.getTimerCount()).toBe(0);
    expect(words(renderer)).toContain("This PC is in your account.");
  });

  test("a reloaded tab that was waiting goes on waiting and opens the window, without a press or a directory write", async () => {
    tab.set(MARKER, JSON.stringify({ name: "desk", until: at + 10 * 60_000 }));
    const renderer = await mount();
    expect(words(renderer)).toContain("choose Add on desk.");
    expect(links()).toBe(1);
    expect(asked.filter((request) => request.path === "/api/relay/link")[0]!.localOnly).toBe(true);
    expect(directory).toEqual([]);
    // the reload starts no new thirty minutes: the wait ends when the press's would have
    await advance(10 * 60_000);
    expect(words(renderer)).toContain("This PC stopped waiting after 30 minutes.");
  });

  test("a reloaded tab whose wait ran out, or whose marker is not one, offers the button and opens nothing", async () => {
    for (const kept of [JSON.stringify({ name: "desk", until: at - 1 }), JSON.stringify({ name: "desk", until: at + WAITING_MS + 60_000 }), "{", JSON.stringify({ name: 3, until: "soon" })]) {
      tab.set(MARKER, kept);
      const renderer = await mount();
      expect(buttons(renderer)).toEqual(["Add this PC to my account"]);
      expect(tab.has(MARKER)).toBe(false);
    }
    expect(links()).toBe(0);
  });

  test("a reloaded tab finds the PC added meanwhile and says so", async () => {
    tab.set(MARKER, JSON.stringify({ name: "desk", until: at + 10 * 60_000 }));
    pc.account = ACCOUNT;
    const renderer = await mount();
    expect(words(renderer)).toContain("This PC is in your account. Your other devices can open it now.");
    expect(tab.has(MARKER)).toBe(false);
    expect(links()).toBe(0);
  });

  test("a PC already in an account, with no wait kept, shows nothing", async () => {
    pc.account = ACCOUNT;
    const renderer = await mount();
    expect(renderer.toJSON()).toBeNull();
  });

  test("stops after 30 minutes, and Keep waiting starts another 30", async () => {
    const renderer = await waitingFrom();
    await advance(WAITING_MS - 1);
    expect(buttons(renderer)).toEqual(["Stop waiting"]);
    await advance(1);
    expect(words(renderer)).toBe("This PC stopped waiting after 30 minutes.");
    expect(buttons(renderer)).toEqual(["Keep waiting"]);
    expect(tab.has(MARKER)).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
    const stopped = asked.length;
    await advance(WAITING_MS);
    expect(asked.length).toBe(stopped);

    await press(renderer, "Keep waiting");
    expect(buttons(renderer)).toEqual(["Stop waiting"]);
    expect(JSON.parse(tab.get(MARKER)!)).toEqual({ name: "desk", until: Date.now() + WAITING_MS });
    const opened = links();
    await advance(REOPEN_MS);
    expect(links()).toBe(opened + 1);
  });

  test("a page hidden through the end of its 30 minutes reopens nothing when it shows again", async () => {
    const renderer = await waitingFrom();
    show(true);
    await advance(WAITING_MS);
    const opened = links();
    show(false);
    await settle();
    expect(links()).toBe(opened);
    expect(buttons(renderer)).toEqual(["Keep waiting"]);
  });

  test("Stop waiting returns to the offer, forgets the wait and reopens nothing more", async () => {
    const renderer = await waitingFrom();
    await press(renderer, "Stop waiting");
    expect(buttons(renderer)).toEqual(["Add this PC to my account"]);
    expect(tab.has(MARKER)).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
    const stopped = asked.length;
    await advance(REOPEN_MS * 2);
    expect(asked.length).toBe(stopped);
  });

  test("words a relay that is off or still connecting, and keeps the offer", async () => {
    const renderer = await mount();
    pc.linkError = { status: 409, code: "relay_offline" };
    await press(renderer, "Add this PC to my account");
    expect(words(renderer)).toContain("The relay is still connecting. Try again in a moment.");
    pc.linkError = { status: 409, code: "relay_off" };
    await press(renderer, "Add this PC to my account");
    expect(words(renderer)).toContain("Turn on remote access through the Ovis relay above first.");
    expect(buttons(renderer)).toEqual(["Add this PC to my account"]);
    expect(tab.has(MARKER)).toBe(false);
  });

  test("works without a tab storage, only not resumed", async () => {
    Object.defineProperty(window, "sessionStorage", { configurable: true, get() { throw new Error("blocked"); } });
    const renderer = await waitingFrom();
    expect(buttons(renderer)).toEqual(["Stop waiting"]);
    await advance(REOPEN_MS);
    expect(links()).toBe(2);
  });
});
