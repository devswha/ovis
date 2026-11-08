import { afterEach, expect, it, jest } from "bun:test";
import { createPcSweep } from "./pcSweep.ts";
import type { RelayDevice, RelayDeviceStore } from "./device.ts";
import type { PcStatus } from "./pcStatus.ts";
import { exportPublicKey, generateKeyPair } from "../../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";

const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
afterEach(() => {
  jest.useRealTimers();
  if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

it("limits each rotating sweep to eight PCs and two simultaneous checks, including repeated requests", async () => {
  jest.useFakeTimers();
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  } });
  const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const devices: RelayDevice[] = Array.from({ length: 12 }, (_, index) => {
    const pair = generateKeyPair();
    return { server_id: deriveServerId(pair.publicKey), device_id: String(index), private_key: key.privateKey, public_spki: "fixture",
      label: "Phone", server_public_key: exportPublicKey(pair.publicKey), relay: "wss://relay.ovis.sh" };
  });
  const store: RelayDeviceStore = {
    list: async () => devices, get: async (id) => devices.find((device) => device.server_id === id),
    remove: async () => {}, update: async () => { throw new Error("sweep cannot change pairings"); },
  };
  const pending: ReturnType<typeof Promise.withResolvers<Exclude<PcStatus, { kind: "checking" }>>>[] = [];
  const checked: string[] = [];
  const changed = Promise.withResolvers<void>();
  const sweep = createPcSweep(store, { active: () => true, redraw() {} }, { probe: async (device) => {
    checked.push(device.server_id);
    const result = Promise.withResolvers<Exclude<PcStatus, { kind: "checking" }>>();
    pending.push(result);
    if (pending.length === 2) changed.resolve();
    return result.promise;
  } });
  const first = sweep.check();
  await changed.promise;
  await sweep.check();
  expect(pending).toHaveLength(2);
  for (let wave = 0; wave < 4; wave++) {
    pending[wave * 2]?.resolve({ kind: "answered", route: "relay", rttMs: 20 });
    pending[wave * 2 + 1]?.resolve({ kind: "offline", reason: "relay" });
    for (let turn = 0; turn < 50; turn++) await Promise.resolve();
  }
  await first;
  expect(checked).toEqual(devices.slice(0, 8).map((device) => device.server_id));
  await sweep.check();
  expect(checked).toHaveLength(8);
  expect(sweep.status.get(devices[0]?.server_id ?? "")).toEqual({ kind: "answered", route: "relay", rttMs: 20 });
  jest.advanceTimersByTime(60_000);
  for (let turn = 0; turn < 50; turn++) await Promise.resolve();
  expect(checked.slice(8)).toEqual(devices.slice(8, 10).map((device) => device.server_id));
  for (let wave = 4; wave < 8; wave++) {
    pending[wave * 2]?.resolve({ kind: "offline", reason: "relay" });
    pending[wave * 2 + 1]?.resolve({ kind: "offline", reason: "relay" });
    for (let turn = 0; turn < 50; turn++) await Promise.resolve();
  }
  expect(checked.slice(8)).toEqual([...devices.slice(8), ...devices.slice(0, 4)].map((device) => device.server_id));
});
