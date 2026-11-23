import { afterEach, expect, spyOn, test } from "bun:test";
import type { DeviceConnection, DevicePairedEvent, PairedDevice } from "../../shared/protocol.ts";
import { handleDeviceRequest } from "../devices.ts";
import { relayConnection, relayFixture } from "../relay/test-helpers.ts";
import { JOIN_HOLD_MS } from "./join-hold.ts";
import { ACCOUNT, createListedPc } from "./listed-pc.test-helpers.ts";
import { ask, phone } from "./pairing.test-helpers.ts";
import { EXPIRY_DAYS } from "./row-expiry.ts";

const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0)) close(); });
const listedPc = () => createListedPc(close => closes.push(close));

/** GET /api/devices from this PC's own window (loopback). */
async function ownList(port: number): Promise<PairedDevice[]> {
  const response = await fetch(`http://127.0.0.1:${port}/api/devices`);
  expect(response.status).toBe(200);
  return (await response.json() as { devices: PairedDevice[] }).devices;
}

/** The same read at the handler, as this PC's own window, with the relay sessions `live` up. */
async function handlerList(pc: Awaited<ReturnType<typeof listedPc>>, live = new Map<string, DeviceConnection>()): Promise<PairedDevice[]> {
  const response = await handleDeviceRequest(new Request("http://127.0.0.1/api/devices"), "/api/devices", pc.fixture.app.context.services.devices,
    { level: "full", via: "local", role: "drive" }, null, undefined, false, { list: () => live, check: async () => {} }, true);
  expect(response.status).toBe(200);
  return (await response.json() as { devices: PairedDevice[] }).devices;
}

test("GET /api/devices lists an account-joined row once, marked through_account, while list(null) keeps devices.json alone", async () => {
  const { fixture, device, member } = await listedPc();
  const { devices } = fixture.app.context.services;
  expect(devices.list(null).map(row => row.id)).toEqual([member.id]);
  const rows = await ownList(fixture.app.port);
  expect(rows.map(row => row.id).sort()).toEqual([member.id, device.id].sort());
  const joined = rows.find(row => row.id === device.id);
  expect(joined).toMatchObject({ label: "Laptop", role: "drive", current: false, via_relay: true, through_account: true });
  // account fields stay with devices.json members: an account-joined key signs no remove of another device
  expect(joined?.account).toBeUndefined();
  expect(joined?.account_key).toBeUndefined();
  expect(rows.find(row => row.id === member.id)?.through_account).toBeUndefined();
  expect(devices.list(null).map(row => row.id)).toEqual([member.id]);
});

test("the account-joined row's own session sees itself as this device, and the PC's window sees its connection", async () => {
  const { fixture, device, member, serverId } = await listedPc();
  const clock = spyOn(Date, "now").mockReturnValue(Date.now() + JOIN_HOLD_MS);
  try {
    const link = await relayConnection(fixture, { serverId });
    await link.auth(device);
    const answer = await ask(link, "/api/devices");
    expect(answer.status).toBe(200);
    const seen = (answer.body as unknown as { devices: PairedDevice[] }).devices;
    expect(seen.find(row => row.id === device.id)).toMatchObject({ current: true, through_account: true, remote_revoke: "allowed" });
    expect(seen.find(row => row.id === member.id)).toMatchObject({ current: false, remote_revoke: "older" });
    expect(seen.filter(row => row.current)).toHaveLength(1);
    expect((await ownList(fixture.app.port)).some(row => row.current)).toBe(false);
  } finally { clock.mockRestore(); }
});

test("the PC's own window sees how an account-joined row's session reaches it, by the row's id", async () => {
  const pc = await listedPc();
  const connection: DeviceConnection = { route: "relay", relay: "wss://relay.ovis.sh", rtt_ms: 40, since: new Date().toISOString() };
  const rows = await handlerList(pc, new Map([[pc.device.id, connection]]));
  expect(rows.find(row => row.id === pc.device.id)).toMatchObject({ through_account: true, connection });
  expect(rows.find(row => row.id === pc.member.id)?.connection).toBeUndefined();
});

test("an expired account-joined row is not listed, by the clock or by its state", async () => {
  const { fixture, device } = await listedPc();
  const now = Date.now();
  const clock = spyOn(Date, "now").mockReturnValue(now + (EXPIRY_DAYS + 1) * 86_400_000);
  try {
    expect((await ownList(fixture.app.port)).some(row => row.id === device.id)).toBe(false);
    fixture.app.context.services.accountRows?.store()?.expire();
  } finally { clock.mockRestore(); }
  expect(fixture.app.context.services.accountRows?.row(device.id)?.state).toBe("expired");
  expect((await ownList(fixture.app.port)).some(row => row.id === device.id)).toBe(false);
});

test.each(["lock", "freeze"] as const)("an account-joined row that cannot sign in here (%s) is not listed as a usable device", async change => {
  const pc = await listedPc();
  const { device } = pc;
  const { safetyLog, accountRows } = pc.fixture.app.context.services;
  expect((await handlerList(pc)).some(row => row.id === device.id)).toBe(true);
  if (change === "lock") expect(safetyLog?.appendLock({ account: ACCOUNT })).toMatchObject({ outcome: "applied" });
  else expect(safetyLog?.append({ got: "snapshot", record: { v: 1, kind: "freeze", id: `f:${"c".repeat(64)}`, account: ACCOUNT,
    target: device.publicKey, after: 1, signer: "service", signed_at: new Date().toISOString(), signature: "" } }).outcome).toBe("applied");
  // still in account-devices.json, but stale here: the list leaves it out rather than show it as one that gets in
  expect(accountRows?.row(device.id)).not.toBeNull();
  expect((await handlerList(pc)).some(row => row.id === device.id)).toBe(false);
});

test("the PC's own window renames and revokes an account-joined row by its id, through the routes every row uses", async () => {
  const pc = await listedPc();
  const { devices, accountRows } = pc.fixture.app.context.services;
  const call = (method: string, body?: unknown) => handleDeviceRequest(new Request(`http://127.0.0.1/api/devices/${pc.device.id}`, {
    method, headers: { origin: "http://127.0.0.1", "x-herdr-machine": "1", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), `/api/devices/${pc.device.id}`, devices, { level: "full", via: "local", role: "drive" }, null, undefined, false, undefined, true);
  const renamed = await call("PATCH", { label: "Work laptop" });
  expect(renamed.status).toBe(200);
  expect(await renamed.json()).toMatchObject({ id: pc.device.id, label: "Work laptop", through_account: true, current: false });
  expect((await handlerList(pc)).find(row => row.id === pc.device.id)).toMatchObject({ label: "Work laptop", through_account: true });
  expect((await call("DELETE")).status).toBe(204);
  expect(accountRows?.row(pc.device.id)).toBeNull();
  expect((await handlerList(pc)).map(row => row.id)).toEqual([pc.member.id]);
  expect(devices.list(null).map(row => row.id)).toEqual([pc.member.id]);
});

test("a list admission tells this PC's windows of the new device once: not again on a re-read, a sign-in or a restart", async () => {
  const { fixture, device, service, serverId } = await listedPc();
  const { joins, devices, accountMailbox } = fixture.app.context.services;
  const first = joins.waiting().filter(join => join.event.device_id === device.id);
  expect(first.map(join => [join.event.type, join.event.label])).toEqual([["device-paired", "Laptop"]]);
  const heard: DevicePairedEvent[] = [];
  devices.onPaired(event => heard.push(event));
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  const clock = spyOn(Date, "now").mockReturnValue(Date.now() + JOIN_HOLD_MS);
  try {
    const link = await relayConnection(fixture, { serverId });
    await link.auth(device);
  } finally { clock.mockRestore(); }
  expect(heard).toEqual([]);

  const newer = await phone();
  service.registerDevice(ACCOUNT, newer.spki, "Tablet");
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  expect(heard.map(event => event.label)).toEqual(["Tablet"]);
  expect(joins.waiting().map(join => join.event.label)).toEqual(["Laptop", "Tablet"]);

  expect(joins.see(first[0]!.event.event_id)).toBe(true);
  fixture.app.stop();
  const reopened = relayFixture(false, { stateDir: fixture.stateDir, accountOpensAll: true, accountService: { url: "https://account.test", fetch: service.fetch } });
  closes.unshift(() => reopened.app.stop());
  const again: DevicePairedEvent[] = [];
  reopened.app.context.services.devices.onPaired(event => again.push(event));
  expect(await reopened.app.context.services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  expect(again).toEqual([]);
  expect(reopened.app.context.services.joins.waiting().map(join => join.event.label)).toEqual(["Tablet"]);
});
