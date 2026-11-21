import { expect, test } from "bun:test";
import type { DevicePairedEvent } from "../shared/protocol.ts";
import type { Access } from "./access.ts";
import type { ServerContext } from "./dispatch.ts";
import { machinePairingEvents } from "./machine-pairing-events.ts";

const PHONE_KEY = "phone-key";

/** One PC whose registry holds `keys` (device id -> relay key), and the paired events this window's subscription hears. */
function heard(access: Access, peer: ServerContext["peer"], keys: Record<string, string>, waiting: readonly string[] = []) {
  const paired = new Set<(event: DevicePairedEvent, origin: readonly string[]) => void>();
  const joinEvent = (deviceId: string): DevicePairedEvent => ({ type: "device-paired", event_id: deviceId, device_id: deviceId, label: "Phone", enrolled_at: new Date(0).toISOString() });
  const devices = {
    onPaired: (listener: (event: DevicePairedEvent, origin: readonly string[]) => void) => { paired.add(listener); return () => paired.delete(listener); },
    onRemoved: () => () => {},
    relayKeyOf: (id: string) => keys[id],
    isAccountApproverSession: () => false,
  };
  const joins = { waiting: () => waiting.map((deviceId) => ({ event: joinEvent(deviceId), origin: [] })), onSeen: () => () => {} };
  const relay = { approvals: { subscribe: () => () => {}, subscribeRemote: () => () => {} } };
  const ctx = { services: { devices, joins, relay, pendingRedemptions: undefined }, peer } as unknown as ServerContext;
  const told: string[] = [];
  machinePairingEvents(ctx, access, []).subscribe((event) => { if (event.type === "device-paired") told.push(event.device_id); });
  const enroll = (deviceId: string) => { for (const listener of paired) listener(joinEvent(deviceId), []); };
  return { told, enroll };
}

test("the joining device's own session is never told of its admission, also through another row of its key; others are", () => {
  const old = { id: "phone-old-row", label: "Phone", role: "drive" as const };
  const phone = heard({ level: "full", via: "relay", role: "drive", device: old },
    { kind: "relay", device: old, sessionId: "s", serverId: "pc", key: PHONE_KEY },
    { "phone-old-row": PHONE_KEY, "phone-new-row": PHONE_KEY, tablet: "tablet-key" });
  phone.enroll("phone-old-row");
  phone.enroll("phone-new-row");
  phone.enroll("tablet");
  expect(phone.told).toEqual(["tablet"]);
});

test("a join waiting on the PC is told to a window as it opens, but never to the joined device nor a window the open LAN let in", () => {
  const waiting = ["phone-new-row"];
  const keys = { "phone-new-row": PHONE_KEY };
  const phoneRow = { id: "phone-new-row", label: "Phone", role: "drive" as const };
  const own = heard({ level: "full", via: "local", role: "drive" }, { kind: "socket" }, keys, waiting);
  const phone = heard({ level: "full", via: "relay", role: "drive", device: phoneRow }, { kind: "relay", device: phoneRow, sessionId: "s", serverId: "pc", key: PHONE_KEY }, keys, waiting);
  const open = heard({ level: "full", via: "open", role: "drive" }, { kind: "socket" }, keys, waiting);
  expect([own.told, phone.told, open.told]).toEqual([["phone-new-row"], [], []]);
});

test("this PC's own window hears every join on it, signed in or not; a window the open LAN let in hears none", () => {
  const keys = { "phone-new-row": PHONE_KEY };
  const own = heard({ level: "full", via: "local", role: "drive" }, { kind: "socket" }, keys);
  const token = heard({ level: "full", via: "token", role: "drive" }, { kind: "socket" }, keys);
  const open = heard({ level: "full", via: "open", role: "drive" }, { kind: "socket" }, keys);
  for (const window of [own, token, open]) window.enroll("phone-new-row");
  expect([own.told, token.told, open.told]).toEqual([["phone-new-row"], ["phone-new-row"], []]);
});
