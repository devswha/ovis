import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act, createElement, type ReactNode } from "react";
import * as ReactDom from "react-dom";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { HealthAuth } from "../../shared/access.ts";
import { FLEET_CAUSE_SENTENCE } from "../../shared/fleet-cause.ts";
import type { FleetMachineRow } from "../../shared/fleet-cause.ts";
import { mintFleetInvites } from "../lib/fleet.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { crc32, storedZip } from "../lib/storedZip.ts";

await mock.module("react-dom", () => ({ ...ReactDom, createPortal: (node: ReactNode) => node }));
const { FleetView, FLEET_WINDOW_FROM } = await import("./FleetView.tsx");

const NOW = Date.parse("2026-11-14T12:00:00Z");
const OWNER: HealthAuth = { required: true, authenticated: true, via: "token", role: "drive" };
const WATCHER: HealthAuth = { required: true, authenticated: true, via: "device", role: "watch" };
const FINGERPRINT = "0123 4567 89ab cdef 0123 4567 89ab cdef";

const machine = (index: number, over: Partial<FleetMachineRow> = {}): FleetMachineRow => ({
  machine_id: index.toString(16).padStart(32, "0"), name: `vm-${index}`, slot: index, fingerprint: FINGERPRINT, batch_id: null,
  state: "active", online: index % 2 === 0, cause: index % 2 === 0 ? null : "offline", message: null, since: NOW, warnings: [],
  route: index % 2 === 0 ? "relay" : null, last_seen: index % 2 === 0 ? NOW : NOW - 3_600_000, ...over,
});
const BATCH = {
  batch_id: "00000000000000aa", created_at: NOW, count: 3, digest: "d".repeat(64), invites: { unused: 0, used: 3, expired: 0 },
  machines: [0, 1, 2].map((slot) => ({ machine_id: `${slot}`.padStart(32, "a"), slot, name: `new-${slot}`, fingerprint: `aaaa bbbb cccc ${slot}${slot}${slot}${slot} 0000 1111 2222 3333` })),
};

interface Answers { machines: unknown[]; batches: unknown[]; invites: unknown[]; held?: boolean }
let answers: Answers = { machines: [], batches: [], invites: [] };
const requests: { url: string; method: string; body: unknown; headers: Headers }[] = [];

const textOf = (node: ReactTestInstance | string): string => typeof node === "string" ? node : node.children.map(textOf).join("");
const buttons = (root: ReactTestInstance, label: RegExp): ReactTestInstance[] => root.findAll((node) => node.type === "button" && label.test(textOf(node)));

describe("FleetView", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;

  beforeEach(() => {
    answers = { machines: [], batches: [], invites: [] };
    requests.length = 0;
    for (const key of ["window", "document", "navigator", "localStorage", "getComputedStyle", "matchMedia", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT", "location", "fetch"]) {
      descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    }
    const events = new EventTarget();
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); }, key: () => null, length: 0, clear: () => store.clear() };
    const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    class HTMLElement { isConnected = true; focus(): void {} }
    const location = { href: "http://127.0.0.1/", search: "", origin: "http://127.0.0.1", pathname: "/" };
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: HTMLElement });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Test", maxTouchPoints: 0 } });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: matchMedia });
    Object.defineProperty(globalThis, "location", { configurable: true, value: location });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location, history: { state: null, replaceState() {} }, localStorage: storage, matchMedia, innerWidth: 1440,
        addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events),
        setTimeout: () => 0, clearTimeout: () => {},
      },
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
        activeElement: new HTMLElement(),
        body: { nodeType: 1, children: [] },
        querySelector: () => null, querySelectorAll: () => [],
        addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
      },
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: string, init: RequestInit = {}) => {
        const method = init.method ?? "GET";
        requests.push({ url: input, method, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined, headers: new Headers(init.headers) });
        const held = answers.held ? { fleet_state: "fleet_token_required" } : {};
        if (method === "GET" && input === "/api/fleet/machines") return Response.json({ machines: answers.machines, ...held });
        if (method === "GET" && input === "/api/fleet/batches") return Response.json({ batches: answers.batches, ...held });
        if (method === "GET" && input === "/api/fleet/invites") return Response.json({ invites: answers.invites, ...held });
        if (method === "POST" && input.endsWith("/confirm")) return Response.json({ batch_id: BATCH.batch_id, activated: [] });
        if (method === "POST" && input === "/api/fleet/invites") {
          return Response.json({ batch_id: "00000000000000bb", count: 2, exp: NOW / 1000 + 3600, invites: [
            { v: 1, id: "1111111111111111", slot: 0, secret: "SECRET-ONE", exp: NOW / 1000 + 3600 },
            { v: 1, id: "2222222222222222", slot: 1, secret: "SECRET-TWO", exp: NOW / 1000 + 3600 },
          ] }, { status: 201 });
        }
        return new Response(null, { status: 404 });
      },
    });
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

  const mount = async (auth: HealthAuth | null): Promise<ReactTestInstance> => {
    await act(async () => {
      renderer = create(createElement(SettingsProvider, { children: createElement(FleetView, { auth, onClose: () => {}, now: NOW }) }), { createNodeMock: () => null });
    });
    // the three reads answer: one more turn lets their state land
    await act(async () => { await Promise.resolve(); });
    return renderer!.root;
  };

  it("draws only a window of a hundred machines, each row with its state word, and names the list's full size", async () => {
    answers.machines = Array.from({ length: 100 }, (_, index) => machine(index));
    const root = await mount(OWNER);
    const rows = root.findAll((node) => node.type === "li" && node.props.className === "fleet-row");
    expect(100).toBeGreaterThanOrEqual(FLEET_WINDOW_FROM);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(100);
    for (const row of rows) {
      expect(row.props["aria-setsize"]).toBe(100);
      expect(textOf(row.find((node) => node.props.className === "fleet-state-word"))).toMatch(/^(Connected|Offline)$/);
    }
    const offline = rows.find((row) => row.props["data-machine-id"] === machine(1).machine_id)!;
    expect(textOf(offline)).toContain(FLEET_CAUSE_SENTENCE.offline);
    expect(textOf(offline)).toContain("1 h ago");
    const connected = rows.find((row) => row.props["data-machine-id"] === machine(0).machine_id)!;
    expect(textOf(connected)).toContain("Relay");
    expect(textOf(connected)).toContain("Now");
  });

  it("an owner confirms a batch with the count and digest it showed", async () => {
    answers.machines = BATCH.machines.map((entry, index) => machine(index, { machine_id: entry.machine_id, name: entry.name, state: "pending", cause: "pending_confirmation", batch_id: BATCH.batch_id }));
    answers.batches = [BATCH];
    const root = await mount(OWNER);
    const batch = root.find((node) => node.props["data-batch-id"] === BATCH.batch_id && node.props.className === "fleet-batch");
    expect(textOf(batch)).toContain("3 machines joined");
    for (const entry of BATCH.machines) expect(textOf(batch)).toContain(entry.fingerprint);
    const [confirm] = buttons(root, /^Confirm 3 machines$/);
    await act(async () => { confirm!.props.onClick(); await Promise.resolve(); });
    const sent = requests.find((request) => request.method === "POST")!;
    expect(sent.url).toBe(`/api/fleet/batches/${BATCH.batch_id}/confirm`);
    expect(sent.body).toEqual({ count: 3, digest: BATCH.digest });
    expect(sent.headers.get("x-herdr-update")).toBe("1");
  });

  it("a watching device reads the batch and the machines with no Confirm, Remove or Download", async () => {
    answers.machines = [machine(0), ...BATCH.machines.map((entry, index) => machine(index + 1, { machine_id: entry.machine_id, state: "pending" }))];
    answers.batches = [BATCH];
    const root = await mount(WATCHER);
    expect(textOf(root.find((node) => node.props.className === "fleet-batch"))).toContain(BATCH.machines[0]!.fingerprint);
    expect(buttons(root, /^Confirm/).length).toBe(0);
    expect(buttons(root, /^Remove$/).length).toBe(0);
    expect(buttons(root, /^Download invites$/).length).toBe(0);
    expect(root.findAll((node) => node.props["data-fleet-watching"] !== undefined).length).toBe(1);
  });

  it("a slot on hold raises its alert with no Confirm of its own", async () => {
    const held = machine(7, { state: "quarantined", cause: "quarantined", online: false, name: "vm-7" });
    answers.machines = [held, ...BATCH.machines.map((entry, index) => machine(index, { machine_id: entry.machine_id, name: entry.name, state: "pending", batch_id: BATCH.batch_id }))];
    answers.batches = [BATCH];
    const root = await mount(OWNER);
    const alert = root.find((node) => node.props.role === "alert" && /fleet-on-hold/.test(node.props.className ?? ""));
    expect(textOf(alert)).toBe(`vm-7 (slot 7) ${FLEET_CAUSE_SENTENCE.quarantined}Remove`);
    expect(buttons(alert, /^Confirm/).length).toBe(0);
    // the only Confirm is the batch's, and the slot on hold is not one of its machines
    expect(buttons(root, /^Confirm/).length).toBe(1);
    expect(textOf(root.find((node) => node.props.className === "fleet-batch"))).not.toContain("vm-7");
  });

  it("a held fleet shows the token's sentence and how to set it in place of every write", async () => {
    answers.machines = [machine(0, { cause: "fleet_token_required", online: false })];
    answers.batches = [BATCH];
    answers.held = true;
    const root = await mount(OWNER);
    const notice = root.find((node) => node.props["data-fleet-held"] !== undefined);
    expect(textOf(notice)).toContain(FLEET_CAUSE_SENTENCE.fleet_token_required);
    expect(textOf(notice)).toContain("openssl rand -hex 32");
    expect(buttons(root, /^Confirm/).length).toBe(0);
    expect(buttons(root, /^Remove$/).length).toBe(0);
    expect(buttons(root, /^Download invites$/).length).toBe(0);
  });
});

describe("the invite archive", () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  afterEach(() => { if (saved) Object.defineProperty(globalThis, "fetch", saved); });

  it("stores each file as it is, under its name, with zip's CRC-32", () => {
    const files = [{ name: "a.json", data: new TextEncoder().encode("{\"a\":1}") }, { name: "b.json", data: new TextEncoder().encode("bee") }];
    const zip = storedZip(files, new Date(2026, 10, 14, 12, 0, 0));
    const view = new DataView(zip.buffer);
    let offset = 0;
    for (const file of files) {
      expect(view.getUint32(offset, true)).toBe(0x04034b50);
      expect(view.getUint32(offset + 14, true)).toBe(crc32(file.data));
      expect(crc32(file.data)).toBe(Bun.hash.crc32(file.data));
      const nameLength = view.getUint16(offset + 26, true);
      expect(new TextDecoder().decode(zip.subarray(offset + 30, offset + 30 + nameLength))).toBe(file.name);
      expect(zip.subarray(offset + 30 + nameLength, offset + 30 + nameLength + file.data.length)).toEqual(file.data);
      offset += 30 + nameLength + file.data.length;
    }
    const end = zip.length - 22;
    expect(view.getUint32(end, true)).toBe(0x06054b50);
    expect(view.getUint16(end + 10, true)).toBe(2);
    expect(view.getUint32(end + 16, true)).toBe(offset);
  });

  it("packs every minted invite as <id>.json and keeps nothing of the answer but the archive", async () => {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async () => Response.json({ batch_id: "00000000000000bb", count: 1, exp: 1_900_000_000, invites: [{ v: 1, id: "1111111111111111", slot: 0, secret: "SECRET-ONE", exp: 1_900_000_000 }] }, { status: 201 }),
    });
    const minted = await mintFleetInvites({ count: 1, prefix: "vm-", life_s: 3600 });
    expect(minted.fileName).toBe("ovis-invites-00000000000000bb.zip");
    expect(minted.count).toBe(1);
    expect(Object.keys(minted).sort()).toEqual(["archive", "batchId", "count", "exp", "fileName"]);
    const text = new TextDecoder().decode(minted.archive);
    expect(text).toContain("1111111111111111.json");
    expect(text).toContain("\"secret\":\"SECRET-ONE\"");
  });
});
