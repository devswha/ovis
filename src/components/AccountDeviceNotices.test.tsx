import { afterEach, expect, it, jest, spyOn } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { Machine } from "../../shared/machines.ts";
import { indexedAccountStore, memoryAccountStore } from "../lib/account/store.ts";
import { DeviceNoticeWire, deviceNotice } from "../lib/deviceNoticeWire.fixture.ts";
import { MachineSession, MachineSessionRegistry } from "../lib/machineSession.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { HerdrSocket } from "../lib/ws.ts";
import { useAccountDeviceNotices } from "./AccountDeviceNotices.tsx";

const machines: readonly Machine[] = [
  { id: "local", name: "Desk", kind: "local", enabled: true, state: "connected", error: null, snapshot: null },
  { id: "lab", name: "Lab", kind: "relay", enabled: true, state: "connected", error: null, snapshot: null },
];

let renderer: ReactTestRenderer | undefined;
let sessions: MachineSessionRegistry | undefined;
const globals = new Map<string, PropertyDescriptor | undefined>();

afterEach(async () => {
  await act(async () => { renderer?.unmount(); });
  renderer = undefined;
  sessions?.retainMachines(new Set());
  sessions = undefined;
  jest.restoreAllMocks();
  jest.useRealTimers();
  for (const [key, old] of globals) {
    if (old) Object.defineProperty(globalThis, key, old);
    else Reflect.deleteProperty(globalThis, key);
  }
  globals.clear();
});

it("T53, T57: It's me uses only the admission PC's socket and retries only until that PC confirms", async () => {
  jest.useFakeTimers();
  const desk = new DeviceNoticeWire("ws://localhost/ws?pc=desk");
  const lab = new DeviceNoticeWire("ws://localhost/ws?pc=lab");
  for (const [key, value] of Object.entries({
    window: Object.assign(new EventTarget(), { location: new URL("http://localhost/"), setTimeout, clearTimeout, setInterval, clearInterval }),
    document: Object.assign(new EventTarget(), { visibilityState: "visible", hasFocus: () => true, querySelector: () => null, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } } }),
    navigator: { languages: ["en"] },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    WebSocket: class { constructor(url: string) { return url === desk.url ? desk : lab; } },
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const store = memoryAccountStore();
  await store.set("session", {
    service: "https://account.ovis.sh", account: "acct", provider: "github",
    access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 60_000, sign_in_id: "this-sign-in",
  });
  spyOn(indexedAccountStore, "get").mockImplementation(store.get);
  const registry = new MachineSessionRegistry((id) => new MachineSession(id, { socket: new HerdrSocket(id === "local" ? desk.url : lab.url) }));
  sessions = registry;
  for (const machine of machines) registry.get(machine.id).socket.connect();
  desk.open();
  lab.open();
  function Notices() {
    return useAccountDeviceNotices({ machines, machineSessions: registry, selectedMachineId: "local", pageServerId: undefined });
  }
  await act(async () => { renderer = create(<SettingsProvider><Notices /></SettingsProvider>); });
  const view = renderer;
  if (view === undefined) throw new TypeError("Missing notice view");
  const admission = deviceNotice({ row: "new-phone" });
  const confirmation = deviceNotice({ ...admission, id: "b".repeat(32), seq: 2, kind: "confirm", how: "its_me", open: false });
  const answer = { type: "notice-answer", id: admission.id, answer: "its_me" };
  const answers = (wire: DeviceNoticeWire) => wire.sent.filter(({ type }) => type === "notice-answer");
  const actions = () => view.root.findAll((node) => node.type === "button" && node.children.includes("It's me"));

  await act(async () => {
    desk.snapshot();
    lab.snapshot();
    desk.read({ type: "device-notice", notice: deviceNotice({ ...admission, account: "another-account" }) });
  });
  expect(actions()).toHaveLength(0);
  await act(async () => { desk.read({ type: "device-notice", notice: admission }); });
  expect(actions()).toHaveLength(1);
  const [button] = actions();
  if (button === undefined) throw new TypeError("Missing admission action");
  await act(async () => { button.props.onClick(); });
  expect(button.props.disabled).toBe(true);
  expect(answers(desk)).toEqual([answer]);
  await act(async () => { lab.read({ type: "device-notice", notice: confirmation }); jest.advanceTimersByTime(5_000); });
  expect(answers(desk)).toEqual([answer, answer]);
  expect(answers(lab)).toEqual([]);
  await act(async () => { desk.read({ type: "device-notice", notice: confirmation }); });
  expect(actions()).toHaveLength(0);
  await act(async () => { jest.advanceTimersByTime(10_000); });
  expect(answers(desk)).toEqual([answer, answer]);
});
