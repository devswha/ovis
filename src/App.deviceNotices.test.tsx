import { expect, it, spyOn } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { App } from "./App.tsx";
import { DeviceNoticeWire, deviceNotice, NOTICE_SNAPSHOT } from "./lib/deviceNoticeWire.fixture.ts";
import { MachineSessionRegistry } from "./lib/machineSession.ts";
import { SettingsProvider } from "./lib/settings.ts";
import { storeSelection } from "./lib/useSplitView.ts";

it("T57, P15: Laptop's pane never shows Desk's device notice", async () => {
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
  class Wire extends DeviceNoticeWire {
    constructor(url: string) { super(url); wires.set(new URL(url, location).searchParams.get("machine_id") ?? "local", this); }
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
  install("fetch", async (input: string | URL) => {
    const { pathname } = new URL(input, location);
    if (pathname === "/api/health") return Response.json({ auth: { required: false, authenticated: true, role: "drive" } });
    if (pathname === "/api/machines") return Response.json({ machines: [
      { id: "local", name: "Laptop", kind: "local", enabled: true, state: "connected", error: null, snapshot: NOTICE_SNAPSHOT },
      { id: "desk", name: "Desk", kind: "address", enabled: true, state: "connected", error: null, snapshot: NOTICE_SNAPSHOT },
    ] });
    return new Response(null, { status: 404 });
  });
  let tree: ReactTestRenderer | undefined;
  const sessions = spyOn(MachineSessionRegistry.prototype, "peek").mockImplementation(function (this: MachineSessionRegistry, id) {
    const session = this.get(id);
    session.connect();
    return session;
  });
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
      laptop.read({ type: "device-notice", notice: deviceNotice({ label: "Laptop phone", key: "l".repeat(43) }) });
      desk.read({ type: "device-notice", notice: deviceNotice({ label: "Desk phone", key: "d".repeat(43) }) });
    });
    const cards = tree.root.findAll((node) => node.type === "div" && node.props["data-testid"] === "device-notice");
    expect(cards).toHaveLength(1);
    expect(JSON.stringify(tree.toJSON())).toContain("Laptop phone");
    expect(JSON.stringify(tree.toJSON())).not.toContain("Desk phone");
    expect(laptop.seen()).toEqual([{ type: "notice-seen", seq: 1 }]);
    expect(desk.seen()).toEqual([]);
  } finally {
    await act(async () => { tree?.unmount(); });
    sessions.mockRestore();
    for (const [key, previous] of originals) {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
