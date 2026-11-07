import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { exportPublicKey, generateKeyPair } from "../../../shared/relay-e2ee.ts";
import { encodeOffer } from "../../../shared/relay-offer.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { RelayShell, type RelayShellProps } from "../../components/RelayShell.tsx";
import { memoryAccountStore } from "../account/store.ts";
import type { RelayDevice, RelayDeviceStore } from "./device.ts";
import { mountRelayShell, type RelayShellMount } from "./shell.tsx";

const AP = "wss://relay-ap.ovis.sh";
const SERVICE = "https://account.ovis.sh";
const SHEET_JOIN = "ovis-add-pc-sheet";

const keyFor = () => { const pair = generateKeyPair(); return { server_id: deriveServerId(pair.publicKey), server_public_key: exportPublicKey(pair.publicKey) }; };

/** Spins the microtask queue until `holds`, or fails naming `what`: the shell's reads are promises alone, so no clock takes part. */
async function until(holds: () => boolean, what: string): Promise<void> {
  for (let turn = 0; turn < 10_000; turn++) {
    if (holds()) return;
    await Promise.resolve();
  }
  throw new Error(`gave up waiting for ${what}`);
}
/** Enough turns for any read the shell wrongly started to reach the fetch (a read takes a few dozen). */
const drain = async (): Promise<void> => { for (let turn = 0; turn < 500; turn++) await Promise.resolve(); };

describe("the hosted shell's front page", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let visibility: "visible" | "hidden";
  let page: EventTarget;
  let sessionStore: Map<string, string>;
  /** every element the shell asked its root to draw, in order */
  let rendered: ReactElement[];

  beforeEach(() => {
    visibility = "visible";
    page = new EventTarget();
    sessionStore = new Map();
    rendered = [];
    for (const key of ["window", "document", "navigator", "localStorage", "sessionStorage", "matchMedia"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const storage = (store: Map<string, string>) => ({ getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); }, key: () => null, length: 0, clear: () => store.clear() });
    const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Mozilla/5.0 (X11; Linux x86_64)", maxTouchPoints: 0 } });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage(new Map()) });
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: storage(sessionStore) });
    Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: matchMedia });
    const events = new EventTarget();
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      location: { href: "https://app.ovis.sh/", search: "", hash: "", origin: "https://app.ovis.sh", pathname: "/" },
      history: { state: null, replaceState() {} },
      matchMedia, innerWidth: 1440,
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events),
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      get visibilityState() { return visibility; },
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
      querySelector: () => null,
      addEventListener: page.addEventListener.bind(page), removeEventListener: page.removeEventListener.bind(page), dispatchEvent: page.dispatchEvent.bind(page),
    } });
  });

  afterEach(() => {
    jest.useRealTimers();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  const deviceStore = (devices: RelayDevice[]): RelayDeviceStore => ({
    async get(serverId) { return devices.find((device) => device.server_id === serverId); },
    async list() { return [...devices]; },
    async remove(serverId) { const at = devices.findIndex((device) => device.server_id === serverId); if (at >= 0) devices.splice(at, 1); },
    async update(serverId, change) { const next = change(devices.find((device) => device.server_id === serverId)); const at = devices.findIndex((device) => device.server_id === serverId); if (at >= 0) devices[at] = next; else devices.push(next); return next; },
  });
  const mountFor = (over: Partial<RelayShellMount>): RelayShellMount => ({
    container: {} as HTMLElement, entryUrl: "https://app.ovis.sh/", shellVersion: "0.0.0-test", label: "Test phone",
    renderApp: () => { throw new Error("the app is not expected here"); },
    createRoot: () => ({ render(element: ReactElement) { rendered.push(element); }, unmount() {} }),
    open: () => Promise.reject(new Error("no connection is expected here")),
    checkPc: async () => ({ kind: "offline", reason: "relay" }),
    reload: async () => {},
    accountService: null,
    ...over,
  });
  const shellProps = (element: ReactElement): RelayShellProps => {
    let node = element;
    while (node.type !== RelayShell) node = (node.props as { children: ReactElement }).children;
    return node.props as RelayShellProps;
  };
  const last = (): RelayShellProps => shellProps(rendered.at(-1)!);
  const account = () => { const { state } = last(); if ((state.kind !== "list" && state.kind !== "empty") || state.account?.kind !== "signed-in") throw new Error(`not the signed-in front page: ${state.kind}`); return state.account; };
  const rows = (): number => renderToStaticMarkup(rendered.at(-1)!).match(/<tr data-pc-state="/g)?.length ?? 0;
  const visible = (next: typeof visibility): void => { visibility = next; page.dispatchEvent(new Event("visibilitychange")); };

  it("reads the directory again when the page comes into view and every 60 s while it stays there, never while hidden, and keeps the rows through a failed read", async () => {
    jest.useFakeTimers();
    const desk = keyFor(), mini = keyFor(), nuc = keyFor();
    const now = Date.now();
    const seen = new Date(now - 60_000).toISOString();
    const directory = [
      { server_id: desk.server_id, label: "Desk PC", added_at: new Date(now - 86_400_000).toISOString(), last_seen_at: seen, public_key: null, relay: AP },
      { server_id: mini.server_id, label: "Mac mini", added_at: new Date(now - 86_400_000).toISOString(), last_seen_at: seen, public_key: null, relay: AP },
      { server_id: nuc.server_id, label: "nuc", added_at: new Date(now - 86_400_000).toISOString(), last_seen_at: seen, public_key: null, relay: "wss://relay.ovis.sh" },
    ];
    type Answer = { status: number; ok: boolean; json: () => Promise<unknown> };
    const ok = (): Answer => ({ status: 200, ok: true, json: async () => ({ pcs: directory }) });
    const down = (): Answer => ({ status: 500, ok: false, json: async () => ({ error: { code: "down" } }) });
    let answer: () => Answer = ok;
    let reads = 0;
    const accountFetch = async (input: Request | string | URL): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname !== "/v1/pcs") throw new Error(`unexpected request ${url.pathname}`);
      reads += 1;
      return answer() as unknown as Response;
    };
    const accountStore = memoryAccountStore();
    await accountStore.set("session", { service: SERVICE, account: "acct-test", provider: "github", access_token: "access", refresh_token: "refresh", expires_at: now + 3_600_000 });
    const paired: RelayDevice = { server_id: desk.server_id, device_id: "0".repeat(16), private_key: {} as CryptoKey, public_spki: "spki", label: "Test phone", server_public_key: "k", relay: AP, name: "Desk PC" };

    // Given the page is opened in the background
    visibility = "hidden";
    await mountRelayShell(mountFor({ accountService: SERVICE, accountProviders: ["github"], accountStore, accountFetch, store: deviceStore([paired]) }));
    await until(() => reads === 1 && rendered.length > 0 && account().pcs !== null, "the first read drawn");
    expect(rows()).toBe(3);
    expect(account().pcs!.map((pc) => [pc.name, pc.state])).toEqual([["Desk PC", "paired"], ["Mac mini", "needs-approval"], ["nuc", "needs-approval"]]);

    // Then nothing is read again while it stays hidden, however long
    visible("hidden");
    jest.advanceTimersByTime(180_000);
    await drain();
    expect(reads).toBe(1);

    // When it comes into view: one read at once
    visible("visible");
    await until(() => reads === 2, "the read on coming into view");
    const drawn = rendered.length;
    await until(() => rendered.length > drawn, "that read drawn");
    expect(rows()).toBe(3);

    // then one every 60 s, not before
    jest.advanceTimersByTime(59_999);
    await drain();
    expect(reads).toBe(2);
    jest.advanceTimersByTime(1);
    await until(() => reads === 3, "the read at 60 s");
    jest.advanceTimersByTime(60_000);
    await until(() => reads === 4, "the read at 120 s");

    // a read that fails keeps the rows and says so under them
    answer = down;
    const before = rendered.length;
    jest.advanceTimersByTime(60_000);
    await until(() => reads === 5 && rendered.length > before, "the failed read drawn");
    expect(rows()).toBe(3);
    expect(account().pcs).toHaveLength(3);
    expect(account().error).toContain("could not be reached");
    answer = ok;

    // hidden again: the timer stops with it
    visible("hidden");
    jest.advanceTimersByTime(600_000);
    await drain();
    expect(reads).toBe(5);

    // back in view: read again, and the failure's line goes
    const shown = rendered.length;
    visible("visible");
    await until(() => reads === 6 && rendered.length > shown, "the read on coming back drawn");
    expect(account().error).toBeNull();
    expect(rows()).toBe(3);
  });

  it("starts one read when two reasons to read again land in the same moment", async () => {
    jest.useFakeTimers();
    const desk = keyFor();
    const now = Date.now();
    const directory = [{ server_id: desk.server_id, label: "Desk PC", added_at: new Date(now - 86_400_000).toISOString(), last_seen_at: new Date(now - 60_000).toISOString(), public_key: null, relay: AP }];
    let reads = 0;
    /** holds every read after the first open until the test lets it answer, so the triggers below overlap it */
    let answer: () => void = () => {};
    const held = new Promise<void>((resolve) => { answer = resolve; });
    const accountFetch = async (input: Request | string | URL): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname !== "/v1/pcs") throw new Error(`unexpected request ${url.pathname}`);
      reads += 1;
      if (reads > 1) await held;
      return { status: 200, ok: true, json: async () => ({ pcs: directory }) } as unknown as Response;
    };
    const accountStore = memoryAccountStore();
    await accountStore.set("session", { service: SERVICE, account: "acct-test", provider: "github", access_token: "access", refresh_token: "refresh", expires_at: now + 3_600_000 });

    await mountRelayShell(mountFor({ accountService: SERVICE, accountProviders: ["github"], accountStore, accountFetch, store: deviceStore([]) }));
    await until(() => reads === 1 && rendered.length > 0 && account().pcs !== null, "the first read drawn");

    // two visibility changes in one tick (a tab switched away and back), then the 60 s tick while that read is out
    visible("visible");
    visible("visible");
    await until(() => reads >= 2, "the read on coming into view");
    await drain();
    expect(reads).toBe(2);
    jest.advanceTimersByTime(60_000);
    await drain();
    expect(reads).toBe(2);

    const drawn = rendered.length;
    answer();
    await until(() => rendered.length > drawn, "the read drawn");
    await drain();
    expect(reads).toBe(2);
    expect(account().pcs!.map((pc) => pc.name)).toEqual(["Desk PC"]);
  });

  it("takes up the dashboard's sheet on the PC's page only for the PC the join was for, once", async () => {
    const pc = keyFor();
    const other = keyFor();
    const entryUrl = encodeOffer({ v: 1, server_id: pc.server_id, server_public_key: pc.server_public_key, relay: AP, name: "Desk PC" }, "https://app.ovis.sh");
    const arriveWith = async (marker: unknown): Promise<RelayShellProps> => {
      if (marker !== undefined) sessionStore.set(SHEET_JOIN, typeof marker === "string" ? marker : JSON.stringify(marker));
      rendered = [];
      await mountRelayShell(mountFor({ entryUrl }));
      expect(last().state.kind).toBe("confirm");
      return last();
    };

    // a marker for another PC is not this page's join
    expect((await arriveWith({ mode: "new", server_id: other.server_id })).sheetJoin).toBeNull();
    // whatever the marker, the page took it: a later plain visit shows the screens alone
    expect(sessionStore.has(SHEET_JOIN)).toBe(false);
    // this PC's join goes on in the sheet, in its mode
    expect((await arriveWith({ mode: "join", server_id: pc.server_id })).sheetJoin).toEqual({ mode: "join", server_id: pc.server_id });
    expect(sessionStore.has(SHEET_JOIN)).toBe(false);
    expect((await arriveWith({ mode: "new", server_id: pc.server_id })).sheetJoin).toEqual({ mode: "new", server_id: pc.server_id });
    // no marker, a mode that is no join, or a marker that does not parse: the screens alone
    expect((await arriveWith(undefined)).sheetJoin).toBeNull();
    expect((await arriveWith({ mode: "add", server_id: pc.server_id })).sheetJoin).toBeNull();
    expect((await arriveWith("{not json")).sheetJoin).toBeNull();
  });
});
