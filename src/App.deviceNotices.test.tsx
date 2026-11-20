import { expect, it, spyOn } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { parseNoticeAnswer, type DeviceNotice } from "../shared/account-devices-api.ts";
import { parseSafetyRecord, verifySafetyRecord, type BlockRecord } from "../shared/account-records.ts";
import { App } from "./App.tsx";
import { indexedAccountStore, memoryAccountStore, newKey } from "./lib/account/store.ts";
import { DeviceNoticeWire, deviceNotice, NOTICE_SNAPSHOT } from "./lib/deviceNoticeWire.fixture.ts";
import { translate } from "./lib/i18n.ts";
import { MachineSessionRegistry } from "./lib/machineSession.ts";
import { SettingsProvider } from "./lib/settings.ts";
import { storeSelection } from "./lib/useSplitView.ts";

async function withDeviceNotices(
  options: { readonly no?: number | null; readonly laptopId?: string; readonly admission?: Pick<DeviceNotice, "method" | "two_step"> },
  check: (fixture: { readonly tree: ReactTestRenderer; readonly laptop: DeviceNoticeWire; readonly desk: DeviceNoticeWire; readonly delivered: readonly BlockRecord[] }) => void | Promise<void>,
) {
  const keys = memoryAccountStore();
  const target = await newKey();
  await keys.set("session", { account: "acct", sign_in_id: "test", provider: "github", service: "https://account.example", access_token: "test", refresh_token: "test", expires_at: Number.MAX_SAFE_INTEGER });
  if (options.no !== undefined) await keys.set("signin_key", { account: "acct", sign_in_id: "test", key: await newKey(), no: options.no });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown): void => {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  const storage = new Map<string, string>();
  const browserStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  };
  const location = new URL("http://localhost:4880/");
  const matchMedia = () => Object.assign(new EventTarget(), { matches: false });
  const history = { replaceState() {}, pushState() {} };
  const wires = new Map<string, DeviceNoticeWire>();
  const delivered: BlockRecord[] = [];
  class Wire extends DeviceNoticeWire {
    constructor(url: string) { super(url); wires.set(new URL(url, location).searchParams.get("machine_id") ?? "local", this); }
    override send(message: string) {
      super.send(message);
      const frame: unknown = JSON.parse(message);
      if (typeof frame !== "object" || frame === null || !("type" in frame) || frame.type !== "notice-answer") return;
      const answer = parseNoticeAnswer(frame);
      if (answer.answer !== "not_me") return;
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
        type: "notice-answer-result", id: answer.id, receipts: answer.blocks.map(({ id }) => ({ outcome: "applied", id, n: 1 })),
      }) }));
    }
  }
  install("window", Object.assign(new EventTarget(), { location, history, matchMedia, localStorage: browserStorage, sessionStorage: browserStorage, setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: (frame: FrameRequestCallback) => setTimeout(() => frame(performance.now()), 0), cancelAnimationFrame: clearTimeout, innerWidth: 1440, innerHeight: 900,
  }));
  install("document", Object.assign(new EventTarget(), {
    visibilityState: "visible", documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, classList: { toggle() {} }, hasAttribute: () => false },
    body: { dataset: {}, style: {}, classList: { toggle() {} } },
    querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, hasFocus: () => true,
  }));
  install("navigator", { language: "en-US", languages: ["en-US"], userAgent: "Test", platform: "Linux", onLine: true });
  install("localStorage", browserStorage);
  install("sessionStorage", browserStorage);
  install("location", location);
  install("history", history);
  install("matchMedia", matchMedia);
  install("getComputedStyle", () => ({ getPropertyValue: () => "" }));
  install("MutationObserver", class { observe() {} disconnect() {} });
  install("ResizeObserver", class { observe() {} disconnect() {} });
  install("__HERDR_TEST_HOOKS__", false);
  install("WebSocket", Wire);
  install("EventSource", class extends EventTarget { close() {} });
  install("IS_REACT_ACT_ENVIRONMENT", true);
  install("fetch", async (input: string | URL, init?: RequestInit) => {
    const { pathname } = new URL(input, location);
    if (pathname === "/api/health") return Response.json({
      auth: { required: false, authenticated: true, role: "drive" },
      web_ui: { boot_id: null, revision: null, server_id: options.laptopId },
    });
    if (pathname === "/api/machines") return Response.json({ machines: [
      { id: "local", name: "Laptop", kind: "local", enabled: true, state: "connected", error: null, snapshot: NOTICE_SNAPSHOT },
      { id: "desk", server_id: "b".repeat(32), name: "Desk", kind: "address", enabled: true, state: "connected", error: null, snapshot: NOTICE_SNAPSHOT },
    ] });
    if (pathname === "/api/machines/desk/account/records" && init?.method === "POST" && typeof init.body === "string") {
      const body: unknown = JSON.parse(init.body);
      if (typeof body !== "object" || body === null || !("records" in body) || !Array.isArray(body.records)) return new Response(null, { status: 400 });
      const receipts = [];
      for (const input of body.records) {
        const record = parseSafetyRecord(input);
        if (record.kind !== "block") return new Response(null, { status: 400 });
        delivered.push(record);
        receipts.push({ outcome: "applied", id: record.id, n: 2 });
      }
      return Response.json({ receipts });
    }
    return new Response(null, { status: 404 });
  });
  let tree: ReactTestRenderer | undefined;
  const sessions = spyOn(MachineSessionRegistry.prototype, "peek").mockImplementation(function (this: MachineSessionRegistry, id) {
    const session = this.get(id);
    session.connect();
    return session;
  });
  const account = spyOn(indexedAccountStore, "get").mockImplementation(keys.get);
  try {
    storeSelection("local", null);
    await act(async () => { tree = create(<SettingsProvider><App /></SettingsProvider>); });
    const laptop = wires.get("local");
    const desk = wires.get("desk");
    if (!tree || !laptop || !desk) throw new Error(`App sockets not connected: ${[...wires.keys()]}`);
    await act(async () => {
      laptop.open();
      desk.open();
      laptop.snapshot();
      desk.snapshot();
      laptop.read({ type: "device-notice", notice: deviceNotice({ label: "Laptop phone", key: target.public_spki, ...options.admission }) });
      desk.read({ type: "device-notice", notice: deviceNotice({ label: "Desk phone", key: "d".repeat(43) }) });
    });
    await check({ tree, laptop, desk, delivered });
  } finally {
    await act(async () => { tree?.unmount(); });
    sessions.mockRestore();
    account.mockRestore();
    for (const [key, previous] of originals) {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

it("T57, P15: Laptop's pane never shows Desk's device notice", async () => {
  await withDeviceNotices({}, ({ tree, laptop, desk }) => {
    const cards = tree.root.findAll((node) => node.type === "div" && node.props["data-testid"] === "device-notice");
    expect(cards).toHaveLength(1);
    expect(JSON.stringify(tree.toJSON())).toContain("Laptop phone");
    expect(JSON.stringify(tree.toJSON())).not.toContain("Desk phone");
    expect(laptop.seen()).toEqual([{ type: "notice-seen", seq: 1 }]);
    expect(desk.seen()).toEqual([]);
  });
});

it.each([
  ["older", 3, 1],
  ["same order", 4, 0],
  ["newer", 5, 0],
  ["unregistered", null, 0],
  ["missing", undefined, 0],
] as const)("T51: Not me is gated by a %s sign-in key", async (_label, no, count) => {
  await withDeviceNotices(no === undefined ? {} : { no }, ({ tree }) => {
    expect(tree.root.findAllByType("button").filter((button) => button.children.includes("Not me"))).toHaveLength(count);
  });
});

it.each([
  ["identified", { laptopId: "a".repeat(32) }, "applied", "Laptop: blocked"],
  ["unidentified", {}, "waiting", "Laptop: waiting for its answer"],
] as const)("T51, T60, T65: an %s notice PC takes one signed block; proxy receipts never count", async (_label, identity, state, line) => {
  await withDeviceNotices({ no: 3, ...identity }, async ({ tree, laptop, desk, delivered }) => {
    const button = tree.root.findAllByType("button").find((node) => node.children.includes("Not me"));
    expect(button).toBeDefined();
    if (button === undefined) return;
    await act(async () => { await button.props.onClick(); });

    const answers = laptop.sent.filter((frame) => frame.type === "notice-answer").map(parseNoticeAnswer);
    expect(answers).toHaveLength(1);
    const answer = answers[0];
    expect(answer).toMatchObject({ id: deviceNotice().id, answer: "not_me" });
    if (answer?.answer !== "not_me") return;
    expect(answer.blocks).toHaveLength(1);
    for (const block of answer.blocks) expect(await verifySafetyRecord(block)).toBe(true);
    expect(desk.sent.filter((frame) => frame.type === "notice-answer")).toEqual([]);
    expect(delivered).toEqual(answer.blocks);

    const card = tree.root.findByProps({ "data-testid": "device-notice" });
    expect(card.findAllByType("li").map((row) => [row.props["data-state"], row.children.join("")])).toEqual([
      [state, line],
      ["waiting", "Desk: waiting for its answer"],
    ]);
  });
});

it("an admission with two-step unknown keeps the one-tap Not me (T51, T60)", async () => {
  await withDeviceNotices({ no: 3, admission: { method: "google", two_step: "unknown" } }, ({ tree }) => {
    const card = tree.root.findByProps({ "data-testid": "device-notice" });
    const buttons = card.findAllByType("button").filter((button) => button.children.includes(translate("en", "Not me")));
    expect(buttons.map((button) => button.props.disabled)).toEqual([false]);
  });
});
