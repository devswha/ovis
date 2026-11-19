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
  let events: EventTarget;

  beforeEach(() => {
    requests = [];
    pairLines = undefined;
    mine = "acct";
    pcAccount = "acct";
    relayPhase = "online";
    awayAnswers = ["offline"];
    source = { account: async () => mine, list: async () => [OWN, DESK, LAB, OLD, AWAY], admit: async () => {} };
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
  const mount = async (onAdded: (machine: Machine) => void = () => {}, machines: readonly Machine[] = [local, lab]) => {
    await act(async () => { renderer = create(<SettingsProvider><SidebarAccountPcs machines={machines} onAdded={onAdded} source={source} /></SettingsProvider>); });
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
});
