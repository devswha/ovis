/**
 * A machine session this controller knows is going or gone is never shown online or handed a launch (todo 34, found by
 * the trial harness): right after its batch is confirmed (the pending session is let go and drains for a moment) and
 * right after the controller restarts, the row says `reconnecting`, and a launch made at once (the native route and a
 * connection through the machine's forward) waits for the machine's new session and is carried by
 * it. Controllers run on a local Bun relay (relay/bun.ts) with `port: 0` and a mkdtemp state folder; every wait is on an
 * event with a bound, and the bounded wait itself runs on a test clock.
 */
import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBunRelay } from "../../relay/bun.ts";
import type { FleetMachineRow } from "../../shared/fleet-cause.ts";
import type { Transport } from "../../shared/relay-e2ee.ts";
import { createServer } from "../index.ts";
import { loadRelayIdentity } from "../relay/identity.ts";
import { RelayService } from "../relay/service.ts";
import { bounded, deferred, relayFixture, TestClock } from "../relay/test-helpers.ts";
import { fleetRows } from "./causes.ts";
import type { Invite } from "./invites.ts";
import { handleFleetNativeRoute } from "./routes.ts";
import { Fleet, MachineUnavailable, RECONNECT_MS, RECONNECT_WAIT_MS } from "./sessions.ts";
import { FleetStore } from "./store.ts";
import { advertFrame, machineClient, machineConnection, machineKey, pipeToTarget, testAdvert, turnFleetOn } from "./test-helpers.ts";
import type { MachineKey } from "./test-helpers.ts";
import { FLEET_TEST_AUTH, FLEET_TEST_TOKEN } from "./test-server.ts";

setDefaultTimeout(30_000);

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const T0 = Date.UTC(2026, 10, 14, 12);
function folder(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A WebSocket to the relay's client socket, as the link agent dials it, as a Transport once it said `assigned`. */
async function viaRelay(relayPort: number, serverId: string): Promise<Transport> {
  const socket = new WebSocket(`ws://127.0.0.1:${relayPort}/v1/ws?server_id=${serverId}&role=client&v=1`);
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

/** A local Bun relay with places for machines (a room without a fleet allowance has none). */
function fleetRelay() {
  const allow = { async limit() { return { success: true }; } };
  const relay = startBunRelay({ port: 0, limits: { maxClientsPerServer: 12, maxSocketsPerAddress: 512 }, limiters: { perAddress: allow, global: allow } });
  cleanups.push(() => relay.stop());
  return relay;
}

/** A controller on a local Bun relay with its relay on; `port` lets a restart reuse its port. */
async function controller(stateDir: string, relayPort: number, port = 0) {
  turnFleetOn(stateDir);
  const fleet = new Fleet({ stateDir, tokenConfigured: true, wall: () => T0 });
  const service = new RelayService({
    stateDir, relay: "wss://relay.example", connect: (url) => new WebSocket(url.replace("wss://relay.example", `ws://127.0.0.1:${relayPort}`)),
    regionalRelays: [], ovisRelays: [], fleet,
  });
  const app = createServer({ port, hostname: "127.0.0.1", stateDir, token: FLEET_TEST_TOKEN, tailscaleOwner: null, sidecar: false, relay: service });
  let stopped = false;
  const stop = async () => { if (stopped) return; stopped = true; await service.shutdown(); await app.stop(); };
  cleanups.push(stop);
  const base = `http://127.0.0.1:${app.port}`;
  const write = { ...FLEET_TEST_AUTH, origin: base, "x-herdr-update": "1", "content-type": "application/json" };
  expect((await fetch(`${base}/api/relay/start`, { method: "POST", headers: { ...FLEET_TEST_AUTH, origin: base, "x-herdr-update": "1" } })).status).toBe(200);
  const identity = loadRelayIdentity(stateDir);
  return {
    fleet, app, stop, identity,
    mint: async () => { const answer = await fetch(`${base}/api/fleet/invites`, { method: "POST", headers: write, body: JSON.stringify({ count: 1 }) }); expect(answer.status).toBe(201); return (await answer.json()) as { batch_id: string; invites: Invite[] }; },
    rows: async () => ((await (await fetch(`${base}/api/fleet/machines`, { headers: FLEET_TEST_AUTH })).json()) as { machines: FleetMachineRow[] }).machines,
    confirm: async (batchId: string) => {
      const { batches } = (await (await fetch(`${base}/api/fleet/batches`, { headers: FLEET_TEST_AUTH })).json()) as { batches: { batch_id: string; count: number; digest: string }[] };
      const batch = batches.find((entry) => entry.batch_id === batchId)!;
      return fetch(`${base}/api/fleet/batches/${batchId}/confirm`, { method: "POST", headers: write, body: JSON.stringify({ count: batch.count, digest: batch.digest }) });
    },
    native: (machineId: string) => fetch(`${base}/api/fleet/machines/${machineId}/native`, { headers: FLEET_TEST_AUTH }),
  };
}
type Controller = Awaited<ReturnType<typeof controller>>;

/** A program on the machine its native pipes reach: it echoes. */
function echoTarget(): number {
  const echo = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data(socket, data) { socket.write(data); } } });
  cleanups.push(() => echo.stop(true));
  return echo.port;
}

/** The machine signing in to `ctrl` over the relay, advertising `boot_id`; its native pipes go to the echo. */
async function signedIn(ctrl: Controller, relayPort: number, key: MachineKey, echo: number, bootId: string) {
  const machine = await machineClient(await viaRelay(relayPort, ctrl.identity.server_id), ctrl.identity.public_key, ctrl.identity.server_id, (pipe) => pipeToTarget(pipe, echo));
  await machine.signIn(key);
  await bounded(machine.admitted);
  await machine.advertise({ ...testAdvert(["native"]), boot_id: bootId });
  return machine;
}

/** A launch through the machine's native forward: a line written and its answer read back. */
function launch(socketPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ path: socketPath });
    let text = "";
    socket.on("data", (chunk) => { text += chunk.toString(); if (text === "hello") { resolve(text); socket.destroy(); } });
    socket.on("error", reject);
    socket.on("close", () => reject(new Error(`the forward closed the launch after ${JSON.stringify(text)}`)));
    socket.once("connect", () => socket.write("hello"));
  });
}

/** A test clock that says when a launch began its bounded wait for a reconnecting machine. */
class WaitClock extends TestClock {
  private readonly waits: (() => void)[] = [];
  /** Resolves once a RECONNECT_WAIT_MS wait was armed. */
  waited(): Promise<void> { const { promise, resolve } = Promise.withResolvers<void>(); this.waits.push(resolve); return promise; }
  override setTimeout(callback: () => void, ms: number): () => void {
    if (ms === RECONNECT_WAIT_MS) for (const resolve of this.waits.splice(0)) resolve();
    return super.setTimeout(callback, ms);
  }
}

/**
 * A controller just started, in process, with one active machine the controller that stopped saw a second before: it is
 * reconnecting. Its forward's Unix socket is where a native client connects; `back` signs the machine in, its pipes to an echo.
 */
async function reconnectingFleet() {
  const stateDir = folder("fleet-stale-wait-");
  turnFleetOn(stateDir);
  const store = new FleetStore({ stateDir, now: () => T0 });
  const key = await machineKey();
  store.add({ machine_id: key.id, public_key: key.spki });
  store.setState(key.id, "active");
  store.update((document) => ({ document: { ...document, machines: document.machines.map((machine) => ({ ...machine, seen_at: T0 - 1_000 })) }, result: undefined }));
  const clock = new WaitClock();
  const fleet = new Fleet({ stateDir, store, clock, wall: () => T0, tokenConfigured: true, native: true, witnessDir: folder("fleet-stale-witness-") });
  fleet.start();
  cleanups.push(() => fleet.close());
  const fixture = relayFixture();
  cleanups.push(() => fixture.close());
  const forward = await bounded(fleet.forwardReady(key.id));
  const back = async () => {
    const echo = echoTarget();
    const opened: unknown[] = [];
    const connection = await machineConnection(fixture, fleet, { machineSessions: fleet }, { onPipe: (pipe) => { opened.push(pipe); pipeToTarget(pipe, echo); } });
    await connection.hello();
    await connection.signIn(key);
    connection.mux.enqueueControl(advertFrame(testAdvert(["native"])));
    await bounded(connection.mux.measure());
    return { opened };
  };
  return { fleet, clock, key, socketPath: forward!.socketPath!, back };
}

/** A caller of the native forward that writes a line and hangs up (as a client stopped with Ctrl-C); resolves once the forward let it go. */
function hangUp(socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ path: socketPath });
    socket.on("error", reject);
    socket.on("close", () => resolve());
    socket.once("connect", () => socket.end("hello"));
  });
}

/** A caller of the native forward that stays and sends nothing; resolves once the forward closed it. */
function closedBy(socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ path: socketPath });
    socket.on("error", reject);
    socket.on("close", () => resolve());
  });
}

describe("a launch waiting for a reconnecting machine", () => {
  it("lets go of callers that hang up during the wait, and opens no pipe for them when the machine signs in", async () => {
    const ctx = await reconnectingFleet();
    expect(ctx.fleet.reconnecting(ctx.key.id)).toBe(true);
    await bounded(Promise.all(Array.from({ length: 5 }, () => hangUp(ctx.socketPath))));
    const machine = await ctx.back();
    expect(await bounded(launch(ctx.socketPath))).toBe("hello");
    expect(machine.opened).toHaveLength(1);
  });

  it("closes a connection whose bounded wait ran out at RECONNECT_WAIT_MS, without a second wait", async () => {
    const ctx = await reconnectingFleet();
    const armed = ctx.clock.waited();
    const closed = closedBy(ctx.socketPath);
    await bounded(armed);
    ctx.clock.advance(RECONNECT_WAIT_MS);
    await bounded(closed);
    expect(ctx.fleet.reconnecting(ctx.key.id)).toBe(true);
  });

  it("refuses a launch at once when the machine is removed during the wait, and the native route names it revoked", async () => {
    const ctx = await reconnectingFleet();
    const pathname = `/api/fleet/machines/${ctx.key.id}/native`;
    const opening = ctx.fleet.openPipe(ctx.key.id, "native").then(() => undefined, (error: unknown) => error);
    const answer = handleFleetNativeRoute(new Request(`http://127.0.0.1${pathname}`), pathname, ctx.fleet);
    ctx.fleet.removeMachine(ctx.key.id);
    const refused = await bounded(opening);
    expect(refused).toBeInstanceOf(MachineUnavailable);
    expect((refused as MachineUnavailable).reason).toBe("not_active");
    const body = (await (await bounded(answer)).json()) as { error: { code: string; cause: string } };
    expect(body.error).toMatchObject({ code: "machine_unreachable", cause: "revoked" });
  });
});

describe("a machine session that is going or gone", () => {
  it("after its batch is confirmed: the pending session is not shown online, and a launch at once is carried by the new session", async () => {
    const relay = fleetRelay();
    const ctrl = await controller(folder("fleet-stale-confirm-"), relay.port);
    const echo = echoTarget();
    const key = await machineKey();
    const minted = await ctrl.mint();
    const pending = await machineClient(await viaRelay(relay.port, ctrl.identity.server_id), ctrl.identity.public_key, ctrl.identity.server_id, (pipe) => pipeToTarget(pipe, echo));
    await pending.enroll(key, minted.invites[0]!);
    await bounded(pending.enrolled);
    await pending.signIn(key);
    expect((await bounded(pending.admitted)).pending).toBe(true);
    await pending.advertise({ ...testAdvert(["native"]), boot_id: "boot-pending" });

    expect((await ctrl.confirm(minted.batch_id)).status).toBe(200);
    // at once, while the pending session still drains: not online, and the row says why
    expect((await ctrl.rows())[0]).toMatchObject({ machine_id: key.id, state: "active", online: false, cause: "reconnecting" });
    // a launch at once: the native route and a connection through the forward, both made before the machine is back
    const forward = await bounded(ctrl.fleet.forwardReady(key.id));
    const route = ctrl.native(key.id);
    const launched = launch(forward!.socketPath!);
    launched.catch(() => {});

    // the machine signs in again on a new carrier, as the link agent does after the GOAWAY
    await signedIn(ctrl, relay.port, key, echo, "boot-active");
    expect(await bounded(launched)).toBe("hello");
    const answer = await bounded(route);
    expect(answer.status).toBe(200);
    expect(((await answer.json()) as { boot_id: string }).boot_id).toBe("boot-active");
    expect((await ctrl.rows())[0]).toMatchObject({ online: true, cause: null });
  });

  it("after the controller restarts: nothing is online until the machine dials in again, and a launch at once waits for it", async () => {
    const relay = fleetRelay();
    const stateDir = folder("fleet-stale-restart-");
    const first = await controller(stateDir, relay.port);
    const echo = echoTarget();
    const key = await machineKey();
    const minted = await first.mint();
    const pending = await machineClient(await viaRelay(relay.port, first.identity.server_id), first.identity.public_key, first.identity.server_id);
    await pending.enroll(key, minted.invites[0]!);
    await bounded(pending.enrolled);
    await pending.signIn(key);
    await bounded(pending.admitted);
    expect((await first.confirm(minted.batch_id)).status).toBe(200);
    pending.channel.close();
    const before = await signedIn(first, relay.port, key, echo, "boot-1");
    expect((await first.rows())[0]).toMatchObject({ online: true, cause: null });

    const port = first.app.port;
    await first.stop();
    before.channel.close();
    const second = await controller(stateDir, relay.port, port);
    expect((await second.rows())[0]).toMatchObject({ machine_id: key.id, state: "active", online: false, cause: "reconnecting" });
    const forward = await bounded(second.fleet.forwardReady(key.id));
    const route = second.native(key.id);
    const launched = launch(forward!.socketPath!);
    launched.catch(() => {});

    await signedIn(second, relay.port, key, echo, "boot-2");
    expect(await bounded(launched)).toBe("hello");
    const answer = await bounded(route);
    expect(answer.status).toBe(200);
    expect(((await answer.json()) as { boot_id: string }).boot_id).toBe("boot-2");
  });

  it("a machine that does not come back: a launch is answered `reconnecting` after its bounded wait, and the row says `offline` once the window ends", async () => {
    const stateDir = folder("fleet-stale-gone-");
    turnFleetOn(stateDir);
    const store = new FleetStore({ stateDir, now: () => T0 });
    const key = await machineKey();
    store.add({ machine_id: key.id, public_key: key.spki });
    store.setState(key.id, "active");
    // seen by the controller that stopped, just before this one started
    store.update((document) => ({ document: { ...document, machines: document.machines.map((machine) => ({ ...machine, seen_at: T0 - 1_000 })) }, result: undefined }));
    const clock = new TestClock();
    const fleet = new Fleet({ stateDir, store, clock, wall: () => T0, tokenConfigured: true, native: false, witnessDir: folder("fleet-stale-witness-") });
    fleet.start();
    cleanups.push(() => fleet.close());
    expect(fleetRows(fleet)[0]).toMatchObject({ online: false, cause: "reconnecting" });

    const opening = fleet.openPipe(key.id, "native");
    const refused = opening.then(() => undefined, (error: unknown) => error);
    clock.advance(RECONNECT_WAIT_MS);
    const error = await bounded(refused);
    expect(error).toBeInstanceOf(MachineUnavailable);
    expect((error as MachineUnavailable).reason).toBe("reconnecting");

    clock.advance(RECONNECT_MS - RECONNECT_WAIT_MS);
    expect(fleetRows(fleet)[0]).toMatchObject({ online: false, cause: "offline" });
  });
});
