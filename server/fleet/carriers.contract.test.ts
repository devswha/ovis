/**
 * Machine sessions on the carriers a controller really has: its relay link through a local Bun relay (relay/bun.ts)
 * and its direct carrier on loopback, both made by the RelayService of a server started with `port: 0`, whose fleet
 * reads `<stateDir>/fleet/machines.json` as in production. Devices sign in beside the machines as before.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createTcpServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBunRelay } from "../../relay/bun.ts";
import type { Transport } from "../../shared/relay-e2ee.ts";
import { createServer } from "../index.ts";
import { loadRelayIdentity } from "../relay/identity.ts";
import { RelayService } from "../relay/service.ts";
import { bounded, deferred, relayDevice, relayPhone, TestClock } from "../relay/test-helpers.ts";
import { fleetRows } from "./causes.ts";
import { Fleet } from "./sessions.ts";
import { FleetStore } from "./store.ts";
import { machineClient, machineKey, pipeToTarget, testAdvert } from "./test-helpers.ts";
import { FLEET_TEST_AUTH, FLEET_TEST_TOKEN } from "./test-server.ts";
import type { MachineKey } from "./test-helpers.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** A paired phone's key, its device row written before the server starts (pairing many in a row is rate limited). */
interface Phone { readonly id: string; readonly keys: CryptoKeyPair; readonly publicKey: string }

/**
 * A controller on a local relay whose room holds `room` clients (12 unless given: 8 device places + 4 for machines), with
 * machines written to its store and `phones` device rows to devices.json before it starts.
 */
async function controller(options: { machines?: ("active" | "pending")[]; max?: number; direct?: boolean; room?: number; phones?: number } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "fleet-carriers-"));
  cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
  const phones: Phone[] = await Promise.all(Array.from({ length: options.phones ?? 0 }, async () => {
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    return { id: randomBytes(8).toString("hex"), keys, publicKey: Buffer.from(await crypto.subtle.exportKey("spki", keys.publicKey)).toString("base64url") };
  }));
  if (phones.length) {
    const created = new Date().toISOString();
    writeFileSync(join(stateDir, "devices.json"), JSON.stringify({ gate_closed_at: created, devices: phones.map((phone) => ({
      id: phone.id, label: "Fleet test", role: "drive", token_hash: randomBytes(32).toString("hex"), relay_public_key: phone.publicKey, created_at: created, last_seen_at: null })) }), { mode: 0o600 });
  }
  const store = new FleetStore({ stateDir, max: 1000 });
  const keys: MachineKey[] = [];
  for (const state of options.machines ?? []) {
    const key = await machineKey();
    store.add({ machine_id: key.id, public_key: key.spki });
    if (state === "active") store.setState(key.id, "active");
    keys.push(key);
  }
  const allow = { async limit() { return { success: true }; } };
  // every client and the PC's data socket for it come from 127.0.0.1: a fleet's self-run relay raises the per-address sockets.
  // It names 750 dials a minute, so the controller's relay pace (todo 37) opens up to 148 sockets at once and these
  // tests of the room's places run on a clock nobody moves; the pace itself is server/fleet/relay-pace.test.ts's
  const relay = startBunRelay({ port: 0, limits: { maxClientsPerServer: options.room ?? 12, maxSocketsPerAddress: 512, perAddressPerMinute: 750 }, limiters: { perAddress: allow, global: allow } });
  cleanups.push(() => relay.stop());
  const clock = new TestClock();
  const service = new RelayService({
    stateDir, relay: "wss://relay.example", connect: (url) => new WebSocket(url.replace("wss://relay.example", `ws://127.0.0.1:${relay.port}`)),
    clock, random: () => 0.5, regionalRelays: [], ovisRelays: [],
    ...(options.max ? { fleet: new Fleet({ stateDir, tokenConfigured: true, max: options.max, clock }) } : {}),
    ...(options.direct ? { direct: { addresses: () => ["127.0.0.1"], peerAllowed: () => true, preferredPort: 0 } } : {}),
  });
  const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: FLEET_TEST_TOKEN, tailscaleOwner: null, sidecar: false, relay: service });
  cleanups.push(async () => { await service.shutdown(); app.stop(); });
  const base = `http://127.0.0.1:${app.port}`;
  const started = await fetch(`${base}/api/relay/start`, { method: "POST", headers: { ...FLEET_TEST_AUTH, origin: base, "x-herdr-update": "1" } });
  expect(started.status).toBe(200);
  const identity = loadRelayIdentity(stateDir);
  return { service, app, keys, identity, relay, clock, stateDir, phones };
}
type Controller = Awaited<ReturnType<typeof controller>>;

/** A client socket to the relay (`role=client`, as the link agent dials), or to the direct carrier, as a Transport. */
async function carrier(url: string): Promise<Transport> {
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  const assigned = deferred<void>();
  const transport: Transport = { onmessage: null, onclose: null, onerror: null, send: (data) => { socket.send(data); }, close: (code, reason) => socket.close(code, reason) };
  socket.onmessage = (event) => {
    if (typeof event.data === "string" && event.data.includes('"assigned"')) { assigned.resolve(); return; }
    transport.onmessage?.({ data: event.data, isBinary: typeof event.data !== "string" });
  };
  socket.onclose = (event) => { assigned.reject(new Error(`closed ${event.code}`)); transport.onclose?.(event.code, event.reason); };
  cleanups.push(() => socket.close());
  await bounded(assigned.promise);
  return transport;
}
const viaRelay = (ctx: Controller) => carrier(`ws://127.0.0.1:${ctx.relay.port}/v1/ws?server_id=${ctx.identity.server_id}&role=client&v=1`);
const viaDirect = (ctx: Controller) => {
  const port = (ctx.service as unknown as { directCarrier?: { port: number | null } }).directCarrier?.port;
  if (!port) throw new Error("no direct carrier");
  return carrier(`ws://127.0.0.1:${port}/v1/ws`);
};

async function echoPort(): Promise<number> {
  const server = createTcpServer({ allowHalfOpen: true }, (socket) => { socket.on("error", () => {}); socket.pipe(socket); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => server.close());
  return (server.address() as { port: number }).port;
}

/** `text` through the bridge forward and back from an echo, after the head that carries testAdvert's bridge token (left out of the answer). */
function roundTrip(port: number, text: string): Promise<string> {
  const head = `GET / HTTP/1.1\r\nAuthorization: Bearer ${testAdvert().bridge_token!}\r\n\r\n`;
  const socket = connect({ host: "127.0.0.1", port, allowHalfOpen: true });
  const chunks: Buffer[] = [];
  const done = deferred<string>();
  socket.on("data", (chunk) => chunks.push(chunk));
  socket.on("error", () => {});
  socket.on("close", () => done.resolve(Buffer.concat(chunks).toString().replace(head, "")));
  socket.once("connect", () => socket.end(head + text));
  return bounded(done.promise);
}

async function phoneSignsIn(ctx: Controller): Promise<string> {
  const device = await relayDevice({ app: ctx.app } as Parameters<typeof relayDevice>[0]);
  const phone = await relayPhone(await viaRelay(ctx), ctx.identity.public_key);
  await phone.auth(device, ctx.identity.server_id);
  return (await bounded(phone.admitted)).device_id;
}

describe("machine sessions on the controller's carriers", () => {
  it("refuses every machine-key AUTH with an empty store while a device signs in as before", async () => {
    const ctx = await controller();
    const stranger = await machineKey();
    const machine = await machineClient(await viaRelay(ctx), ctx.identity.public_key, ctx.identity.server_id);
    await machine.signIn(stranger);
    expect(await bounded(machine.error)).toEqual({ code: "auth_failed", message: "unknown" });
    expect(ctx.service.fleet.sessions).toBe(0);
    expect(ctx.service.fleet.machines()).toEqual([]);
    expect(typeof await phoneSignsIn(ctx)).toBe("string");
  });

  it("signs a stored machine in through the relay, apart from the devices and past the sign-in deadline, and forwards to it", async () => {
    const ctx = await controller({ machines: ["active"] });
    const key = ctx.keys[0]!;
    const target = await echoPort();
    const machine = await machineClient(await viaRelay(ctx), ctx.identity.public_key, ctx.identity.server_id, (pipe) => pipeToTarget(pipe, target));
    await machine.signIn(key);
    expect(await bounded(machine.admitted)).toMatchObject({ machine_id: key.id, role: "machine" });
    await machine.advertise(testAdvert(["bridge"]));
    expect(ctx.service.fleet.online(key.id)).toBe(true);
    // the link's 15 s sign-in deadline passes (within the control socket's 30 s keepalive): a signed-in machine keeps its socket
    ctx.clock.advance(20_000);
    expect(machine.mux.active).toBe(true);
    const forward = await bounded(ctx.service.fleet.forwardReady(key.id));
    expect(await roundTrip(forward!.port, "through the relay")).toBe("through the relay");
    // a device still gets one of the 8 device places: the machine took none
    expect(typeof await phoneSignsIn(ctx)).toBe("string");
    expect(ctx.service.status().phase).toBe("online");
  });

  it("signs a pending machine in but opens it no forward", async () => {
    const ctx = await controller({ machines: ["pending"] });
    const pending = await machineClient(await viaRelay(ctx), ctx.identity.public_key, ctx.identity.server_id);
    await pending.signIn(ctx.keys[0]!);
    await bounded(pending.admitted);
    expect(await ctx.service.fleet.forwardReady(ctx.keys[0]!.id)).toBeUndefined();
  });

  it("counts machines on the relay and on a direct carrier against one OVIS_FLEET_MAX", async () => {
    const ctx = await controller({ machines: ["active", "active"], max: 1, direct: true });
    const [first, second] = ctx.keys as [MachineKey, MachineKey];
    const onRelay = await machineClient(await viaRelay(ctx), ctx.identity.public_key, ctx.identity.server_id);
    await onRelay.signIn(first);
    await bounded(onRelay.admitted);
    const refused = await machineClient(await viaDirect(ctx), ctx.identity.public_key, ctx.identity.server_id);
    await refused.signIn(second);
    expect(await bounded(refused.error)).toEqual({ code: "resource_exhausted", message: "controller_limit" });
    onRelay.channel.close();
    await bounded(onRelay.closed);
    const direct = await machineClient(await viaDirect(ctx), ctx.identity.public_key, ctx.identity.server_id);
    await direct.signIn(second);
    expect(await bounded(direct.admitted)).toMatchObject({ machine_id: second.id });
    // past the direct carrier's 15 s sign-in deadline too
    ctx.clock.advance(20_000);
    expect(direct.mux.active).toBe(true);
    expect(ctx.service.fleet.online(second.id)).toBe(true);
  });
});

/** A phone whose device row was written before the server started signs in through the relay. */
async function storedPhoneSignsIn(ctx: Controller, phone: Phone): Promise<string> {
  const client = await relayPhone(await viaRelay(ctx), ctx.identity.public_key);
  await client.auth(phone, ctx.identity.server_id);
  return (await bounded(client.admitted)).device_id;
}

/** Signs `key` in through the relay: the AUTH_OK's machine id, or the SESSION_ERROR it was refused with. */
async function machineViaRelay(ctx: Controller, key: MachineKey): Promise<string | { code: string; message: string }> {
  const machine = await machineClient(await viaRelay(ctx), ctx.identity.public_key, ctx.identity.server_id);
  await machine.signIn(key);
  return bounded(Promise.race([machine.admitted.then((ok) => ok.machine_id), machine.error]));
}

describe("machines on a relay link hold only the room's fleet share, never a device place", () => {
  const refusal = { code: "resource_exhausted", message: "controller_limit" };
  const causeOf = (ctx: Controller, key: MachineKey) => fleetRows(ctx.service.fleet).find((row) => row.machine_id === key.id)?.cause;

  it("fills a room of 8 + 4 with 4 machines, refuses the fifth, and a phone still signs in", async () => {
    const ctx = await controller({ machines: ["active", "active", "active", "active", "active"], room: 12, phones: 1 });
    const answers = [];
    for (const key of ctx.keys) answers.push(await machineViaRelay(ctx, key));
    expect(answers).toEqual([...ctx.keys.slice(0, 4).map((key) => key.id), refusal]);
    // the one the room's share had no place for says so on its row; the four that got in say nothing
    expect(causeOf(ctx, ctx.keys[4]!)).toBe("controller_limit");
    for (const key of ctx.keys.slice(0, 4)) expect(causeOf(ctx, key)).toBeNull();
    expect(await storedPhoneSignsIn(ctx, ctx.phones[0]!)).toBe(ctx.phones[0]!.id);
    expect(ctx.service.fleet.sessions).toBe(4);
  });

  it("refuses every machine in a room without a fleet allowance (8), while the direct carrier still admits one under OVIS_FLEET_MAX", async () => {
    const ctx = await controller({ machines: ["active", "active"], room: 8, phones: 1, direct: true });
    expect(await machineViaRelay(ctx, ctx.keys[0]!)).toEqual(refusal);
    expect(causeOf(ctx, ctx.keys[0]!)).toBe("controller_limit");
    expect(causeOf(ctx, ctx.keys[1]!)).toBe("offline");
    expect(await storedPhoneSignsIn(ctx, ctx.phones[0]!)).toBe(ctx.phones[0]!.id);
    const direct = await machineClient(await viaDirect(ctx), ctx.identity.public_key, ctx.identity.server_id);
    await direct.signIn(ctx.keys[1]!);
    expect(await bounded(direct.admitted)).toMatchObject({ machine_id: ctx.keys[1]!.id });
  });

  it("takes 100 machines and 8 devices in a room of 108", async () => {
    const ctx = await controller({ machines: Array.from({ length: 101 }, () => "active" as const), room: 108, phones: 8 });
    const answers: (string | { code: string; message: string })[] = [];
    // in waves of 10: the relay holds a limited queue of clients waiting for the PC
    for (let at = 0; at < 100; at += 10) answers.push(...await Promise.all(ctx.keys.slice(at, at + 10).map((key) => machineViaRelay(ctx, key))));
    expect(answers).toEqual(ctx.keys.slice(0, 100).map((key) => key.id));
    // the 101st machine is past both OVIS_FLEET_MAX (100) and the room's share
    expect(await machineViaRelay(ctx, ctx.keys[100]!)).toEqual(refusal);
    // one after another: in a full room the oldest client still signing in gives way to a newer one (link.ts serveData),
    // as 8 phones racing into a room of 8 do without a fleet
    const devices: string[] = [];
    for (const phone of ctx.phones) devices.push(await storedPhoneSignsIn(ctx, phone));
    expect(devices).toEqual(ctx.phones.map((phone) => phone.id));
    expect(ctx.service.fleet.sessions).toBe(100);
  }, 120_000);
});
