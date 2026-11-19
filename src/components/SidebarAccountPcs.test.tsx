import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { Machine } from "../../shared/machines.ts";
import type { AccountPcEntry } from "../lib/api.ts";
import { SettingsProvider } from "../lib/settings.ts";
import type { AccountPcsSource } from "./RelayAccountPcs.tsx";
import { SidebarAccountPcs } from "./SidebarAccountPcs.tsx";

const pc = (id: string, name: string): AccountPcEntry => ({ server_id: id.repeat(32).slice(0, 32), server_public_key: "key", relay: "wss://relay.ovis.example", name });
const OWN = pc("0", "This PC");
const DESK = pc("d", "Desk");
const LAB = pc("1", "Lab");
const OLD = pc("2", "Old box");
const AWAY = pc("3", "Away");
const local = { id: "local", name: "This PC", kind: "local", server_id: OWN.server_id } as unknown as Machine;
const lab = { id: "lab-id", name: "Lab", kind: "relay", relay: { server_id: LAB.server_id, relay: LAB.relay } } as unknown as Machine;
const desk = { id: "desk-id", name: "Desk", kind: "relay", relay: { server_id: DESK.server_id, relay: DESK.relay } } as unknown as Machine;

describe("the account's PCs in the sidebar", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let requests: { path: string; body: unknown }[];
  let pairLines: ReadableStreamDefaultController<Uint8Array> | undefined;
  let source: AccountPcsSource;
  let mine: string | null;
  let pcAccount: string | null;
  let relayPhase: string;
  let awayAnswers: string[];
  let listAccount: string | null;
  let lists: number;
  let admitted: string[];
  let failAwayCheck: boolean;
  // Check again's hold is per PC for the page's life (MachineOffLine.tsx): each test starts a minute after the last
  let clock = 0;
  let events: EventTarget;

  beforeEach(() => {
    requests = [];
    pairLines = undefined;
    mine = "acct";
    pcAccount = "acct";
    relayPhase = "online";
    awayAnswers = ["offline"];
    listAccount = null;
    lists = 0;
    admitted = [];
    failAwayCheck = false;
    clock += 60_000;
    const realNow = performance.now.bind(performance);
    spyOn(performance, "now").mockImplementation(() => realNow() + clock);
    source = {
      account: async () => mine,
      list: async () => { lists += 1; const who = listAccount ?? mine; return who === null ? null : { account: who, pcs: [OWN, DESK, LAB, OLD, AWAY] }; },
      admit: async (serverId) => { admitted.push(serverId); },
    };
    for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Mozilla/5.0 (X11; Linux x86_64)", maxTouchPoints: 0 } });
    events = new EventTarget();
    const documentEvents = new EventTarget();
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      location: { href: "http://127.0.0.1:7318/", origin: "http://127.0.0.1:7318" },
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
      setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      hidden: false, visibilityState: "visible",
      addEventListener: documentEvents.addEventListener.bind(documentEvents), removeEventListener: documentEvents.removeEventListener.bind(documentEvents),
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null,
    } });
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input instanceof Request ? input.url : input), "http://127.0.0.1:7318").pathname;
      const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      requests.push({ path, body });
      if (path === "/api/relay") return Response.json({ phase: relayPhase, blocked: null, error: null });
      if (path === "/api/account/status") return Response.json({ account: pcAccount, unlinked: [], removals: [], adds: [], blocked: [] });
      if (path === "/api/machines/relay/account/check") {
        const asked = (body as { pcs: AccountPcEntry[] }).pcs;
        if (failAwayCheck && asked[0]?.server_id === AWAY.server_id) return Response.json({ error: { code: "relay_unavailable", message: "The relay did not answer." } }, { status: 503 });
        const states: Record<string, string> = { [DESK.server_id]: "ready", [LAB.server_id]: "ready", [OLD.server_id]: "outdated" };
        return Response.json({ pcs: asked.map((entry) => ({ server_id: entry.server_id, state: entry.server_id === AWAY.server_id ? awayAnswers.shift() : states[entry.server_id] })) });
      }
      if (path === "/api/machines/relay/account/start") return Response.json({ ticket: "ticket-1", key: "a-key", label: "Ovis on here" });
      if (path === "/api/machines/relay/account/pair") return new Response(new ReadableStream<Uint8Array>({ start: (controller) => { pairLines = controller; } }));
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

  const text = (node: ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : text(child)).join("");
  const groups = () => renderer!.root.findAll((node) => node.type === "section").map((group) => [
    group.props["aria-label"], group.props["data-pc-state"],
    group.findAll((node) => node.type === "button").map((button) => text(button)).join(","),
  ]);
  const button = (label: string) => renderer!.root.find((node) => node.type === "button" && node.props["aria-label"] === label);
  const settle = async () => { for (let round = 0; round < 6; round += 1) await act(async () => {}); };
  const tree = (onAdded: (machine: Machine) => void, machines: readonly Machine[], hidden = false) => <SettingsProvider><SidebarAccountPcs machines={machines} onAdded={onAdded} source={source} hidden={hidden} /></SettingsProvider>;
  const mount = async (onAdded: (machine: Machine) => void = () => {}, machines: readonly Machine[] = [local, lab]) => {
    await act(async () => { renderer = create(tree(onAdded, machines)); });
    await settle();
  };

  it("lists the account's PCs not in this app yet: Add where one would pair, Off with Check again where one did not answer", async () => {
    await mount();
    expect(groups()).toEqual([
      ["PC Desk", "ready", "Add"], ["PC Old box", "outdated", ""], ["PC Away", "offline", "Check again"],
    ]);
    expect(text(renderer!.root)).toContain("Switched off");
  });

  it("asks only that PC again on Check again, and offers Add once it answers", async () => {
    awayAnswers = ["offline", "ready"];
    await mount();
    const asked = () => requests.filter((request) => request.path.endsWith("/check")).map((request) => (request.body as { pcs: AccountPcEntry[] }).pcs.map((entry) => entry.name).join());
    expect(asked()).toEqual(["Desk", "Old box", "Away"]);
    const away = renderer!.root.find((node) => node.type === "section" && node.props["aria-label"] === "PC Away");
    await act(async () => { away.find((node) => node.type === "button" && text(node) === "Check again").props.onClick(); });
    await settle();
    expect(asked()).toEqual(["Desk", "Old box", "Away", "Away"]);
    expect(groups()[2]).toEqual(["PC Away", "ready", "Add"]);
  });

  it("adds a PC as the relay tab does, with the digits to approve on another device, then hands it over", async () => {
    const opened: Machine[] = [];
    await mount((machine) => opened.push(machine));
    await act(async () => { button("Add Desk").props.onClick(); });
    await settle();
    await act(async () => { pairLines!.enqueue(new TextEncoder().encode(`${JSON.stringify({ digits: "123456" })}\n`)); });
    expect(admitted).toEqual([DESK.server_id]);
    expect(text(renderer!.root.findByProps({ className: "account-pc-wait" }))).toBe("Approve on another device of your account123 456");
    await act(async () => { pairLines!.enqueue(new TextEncoder().encode(`${JSON.stringify({ machine: desk })}\n`)); pairLines!.close(); });
    await settle();
    expect(opened.map((machine) => machine.id)).toEqual(["desk-id"]);
  });

  it("signed out, asks this PC nothing: not its relay, not its account", async () => {
    mine = null;
    await mount();
    expect(groups()).toEqual([]);
    expect(requests).toEqual([]);
  });

  it("shows nothing signed out, on a PC in another account or in none, or with the relay not online, and asks the account for no PC", async () => {
    for (const [who, pcIn, phase] of [[null, "acct", "online"], ["acct", "other", "online"], ["acct", null, "online"], ["acct", "acct", "connecting"]] as const) {
      mine = who;
      pcAccount = pcIn;
      relayPhase = phase;
      requests = [];
      await mount();
      expect(groups()).toEqual([]);
      expect(requests.some((request) => request.path.startsWith("/api/machines/relay/account"))).toBe(false);
      expect(lists).toBe(0);
      await act(async () => { renderer!.unmount(); });
      renderer = undefined;
    }
  });

  it("lists the account once this browser signs in to it, when the window comes back", async () => {
    mine = null;
    await mount();
    expect(groups()).toEqual([]);
    mine = "acct";
    await act(async () => { events.dispatchEvent(new Event("focus")); });
    await settle();
    expect(groups().map(([name]) => name)).toEqual(["PC Desk", "PC Old box", "PC Away"]);
  });

  it("leaves out a PC that is in this app already: the sidebar lists it as its own", async () => {
    await mount(() => {}, [local, lab, desk]);
    expect(groups().map(([name]) => name)).toEqual(["PC Old box", "PC Away"]);
  });
  it("keeps only the account it checked this PC against: a list read under another sign-in shows and asks nothing", async () => {
    listAccount = "someone-else";
    await mount();
    expect(groups()).toEqual([]);
    expect(requests.some((request) => request.path.startsWith("/api/machines/relay/account"))).toBe(false);
  });

  it("asks nothing on Add once this page is signed out, and says to sign in again", async () => {
    await mount();
    mine = null;
    await act(async () => { button("Add Desk").props.onClick(); });
    await settle();
    expect(requests.some((request) => request.path.endsWith("/start"))).toBe(false);
    expect(admitted).toEqual([]);
    expect(text(renderer!.root)).toContain("Sign in again");
  });

  it("keeps every row when a Check again fails, and tells it on that PC's row", async () => {
    await mount();
    failAwayCheck = true;
    const away = renderer!.root.find((node) => node.type === "section" && node.props["aria-label"] === "PC Away");
    await act(async () => { away.find((node) => node.type === "button" && text(node) === "Check again").props.onClick(); });
    await settle();
    expect(groups().map(([name]) => name)).toEqual(["PC Desk", "PC Old box", "PC Away"]);
    expect(text(away)).toContain("The relay did not answer.");
  });

  it("steps aside for the sidebar filter without ending a pairing under way", async () => {
    await mount();
    await act(async () => { button("Add Desk").props.onClick(); });
    await settle();
    await act(async () => { renderer!.update(tree(() => {}, [local, lab], true)); });
    const hidden = Object.fromEntries(renderer!.root.findAll((node) => node.type === "section").map((group) => [group.props["aria-label"], group.props.hidden]));
    expect(hidden).toEqual({ "PC Desk": false, "PC Old box": true, "PC Away": true });
    await act(async () => { pairLines!.enqueue(new TextEncoder().encode(`${JSON.stringify({ digits: "654321" })}\n`)); });
    expect(text(renderer!.root.findByProps({ className: "account-pc-wait" }))).toContain("654 321");
  });

  it("lists nothing, not even this PC, until it knows which PC it is on", async () => {
    await mount(() => {}, []);
    expect(groups()).toEqual([]);
    expect(lists).toBe(0);
  });

  it("adds no poll of its own: the relay and the PC's account are read once, and again only when the window comes back", async () => {
    await mount();
    const reads = () => requests.filter((request) => request.path === "/api/relay" || request.path === "/api/account/status").length;
    expect(reads()).toBe(2);
    await settle();
    expect(reads()).toBe(2);
    await act(async () => { events.dispatchEvent(new Event("focus")); });
    await settle();
    expect(reads()).toBe(4);
  });
});
