/**
 * Todo 37 on todo 30's enrolment: pace slots given in the same write that enrols a machine and kept when its batch is
 * confirmed, a wave of pending machines beside active ones without a shared slot or a starved sign-in, ENROLL taking its
 * turn of the sign-in queue as AUTH does, and one keepalive probe on a machine session however many ask for a round trip.
 */
import { afterEach, describe, expect, it, setDefaultTimeout, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportPublicKey, generateKeyPair } from "../../shared/relay-e2ee.ts";
import { MuxEngine } from "../../shared/relay-mux-engine.ts";
import { decodeFrame, FrameType } from "../../shared/relay-mux.ts";
import { deriveServerId } from "../../shared/relay-server-proof.ts";
import { bounded, deferred, relayFixture, TestClock } from "../relay/test-helpers.ts";
import { FleetInvites, mintRequest } from "./invites.ts";
import { Fleet } from "./sessions.ts";
import type { InviteController } from "./invites.ts";
import { SignInQueue } from "./sign-in-queue.ts";
import { FLEET_TEST_AUTH, fleetTestServer } from "./test-server.ts";
import { FleetStore } from "./store.ts";
import { machineConnection, machineKey, memoryDirectory, signEnroll, turnFleetOn } from "./test-helpers.ts";
import type { Invite } from "./invites.ts";
import type { MachineKey } from "./test-helpers.ts";

// a hundred enrolments are a hundred synced store writes: on a loaded disk they take longer than bun's 5 s default
setDefaultTimeout(120_000);

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const keys = generateKeyPair();
const CONTROLLER: InviteController = { server_id: deriveServerId(keys.publicKey), server_public_key: exportPublicKey(keys.publicKey), relay: "wss://relay.ovis.example", direct: [] };

function setup(max: number) {
  const stateDir = mkdtempSync(join(tmpdir(), "fleet-pace-slots-"));
  cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
  const store = new FleetStore({ stateDir, max });
  turnFleetOn(stateDir);
  return { store, invites: new FleetInvites(store, {}) };
}

/** Mints `count` invites and enrols one fresh machine through each; resolves with the batch and the machines' ids. */
async function enrolBatch(invites: FleetInvites, count: number): Promise<{ batch: string; ids: string[] }> {
  const minted = await invites.mint(mintRequest({ count, prefix: "vm-" }), async () => CONTROLLER);
  const ids: string[] = [];
  const binding = new Uint8Array(32).fill(7);
  for (const invite of minted.invites) {
    const key: MachineKey = await machineKey();
    expect(await invites.enroll(signEnroll(key, invite, binding), { binding })).toEqual({ machineId: key.id });
    ids.push(key.id);
  }
  return { batch: minted.batch_id, ids };
}

describe("pace slots on enrolment", () => {
  it("gives 100 machines enrolled and confirmed in one batch 100 distinct slots, given when they enrol and kept by the confirm", async () => {
    const { store, invites } = setup(100);
    const { batch, ids } = await enrolBatch(invites, 100);
    const pending = new Map(store.machines().map((machine) => [machine.machine_id, machine.pace_slot]));
    expect([...pending.values()].sort((a, b) => a! - b!)).toEqual(Array.from({ length: 100 }, (_, index) => index));
    const [row] = invites.batches();
    await invites.confirm(batch, row!.count, row!.digest);
    expect(store.machines().every((machine) => machine.state === "active")).toBe(true);
    for (const id of ids) expect(store.get(id)!.pace_slot).toBe(pending.get(id));
  });

  it("gives a wave of 100 pending machines slots of their own beside 100 active ones, whose slots do not move", async () => {
    const { store, invites } = setup(200);
    const first = await enrolBatch(invites, 100);
    const [row] = invites.batches();
    await invites.confirm(first.batch, row!.count, row!.digest);
    const active = new Map(store.machines().map((machine) => [machine.machine_id, machine.pace_slot]));
    await enrolBatch(invites, 100);
    const slots = store.machines().map((machine) => machine.pace_slot);
    expect(new Set(slots).size).toBe(200);
    expect(slots.every((slot) => slot !== undefined && slot < 200)).toBe(true);
    for (const [id, slot] of active) expect(store.get(id)!.pace_slot).toBe(slot);
    expect(store.machines().filter((machine) => machine.state === "pending")).toHaveLength(100);
  });
});

describe("pace slots after a revoke", () => {
  const confirmAll = async (invites: FleetInvites, batch: string) => {
    const row = invites.batches().find((entry) => entry.batch_id === batch)!;
    await invites.confirm(batch, row.count, row.digest);
  };
  const live = (store: FleetStore) => store.machines().filter((machine) => machine.state !== "revoked");

  it("gives machines enrolled after 5 of a full fleet's 100 were revoked the revoked ones' slots: 100 distinct among those not revoked", async () => {
    const { store, invites } = setup(100);
    const first = await enrolBatch(invites, 100);
    await confirmAll(invites, first.batch);
    const gone = first.ids.slice(0, 5);
    const freed = gone.map((id) => store.get(id)!.pace_slot!).sort((a, b) => a - b);
    for (const id of gone) store.setState(id, "revoked");
    const second = await enrolBatch(invites, 5);
    expect(second.ids.map((id) => store.get(id)!.pace_slot).sort((a, b) => a! - b!)).toEqual(freed);
    const slots = live(store).map((machine) => machine.pace_slot);
    expect(slots.every((slot) => slot !== undefined)).toBe(true);
    expect(new Set(slots).size).toBe(100);
    // a revoked record whose slot went to another machine no longer holds it
    expect(gone.every((id) => store.get(id)!.pace_slot === undefined)).toBe(true);
  });

  it("gives a machine re-enrolled into a revoked machine's invite slot that machine's pace slot, before any lower retired one", async () => {
    const { store } = setup(100);
    const keys = await Promise.all(Array.from({ length: 102 }, () => machineKey()));
    for (const [slot, key] of keys.slice(0, 100).entries()) { store.add({ machine_id: key.id, public_key: key.spki, slot }); store.setState(key.id, "active"); }
    for (const slot of [10, 20, 30]) store.setState(keys[slot]!.id, "revoked");
    expect(store.add({ machine_id: keys[100]!.id, public_key: keys[100]!.spki, slot: 30 }).pace_slot).toBe(30);
    expect(store.add({ machine_id: keys[101]!.id, public_key: keys[101]!.spki }).pace_slot).toBe(10);
  });

  it("gives a revoked machine's slot out last: a never-used slot first while one is left", async () => {
    const { store } = setup(100);
    const keys = await Promise.all(Array.from({ length: 11 }, () => machineKey()));
    for (const key of keys.slice(0, 10)) { store.add({ machine_id: key.id, public_key: key.spki }); store.setState(key.id, "active"); }
    store.setState(keys[3]!.id, "revoked");
    expect(store.add({ machine_id: keys[10]!.id, public_key: keys[10]!.spki }).pace_slot).toBe(10);
    expect(store.get(keys[3]!.id)!.pace_slot).toBe(3);
  });

  it("gives 100 machines enrolled beside 100 revoked tombstones 100 distinct slots", async () => {
    const { store, invites } = setup(100);
    const first = await enrolBatch(invites, 100);
    await confirmAll(invites, first.batch);
    for (const id of first.ids) store.setState(id, "revoked");
    await enrolBatch(invites, 100);
    const slots = live(store).map((machine) => machine.pace_slot);
    expect(slots).toHaveLength(100);
    expect(new Set(slots).size).toBe(100);
    expect(slots.every((slot) => slot !== undefined && slot < 100)).toBe(true);
  });

  it("backfills at start a store written before this fix: revoked records holding slots, their replacements with none", async () => {
    const { store, invites } = setup(100);
    const first = await enrolBatch(invites, 100);
    await confirmAll(invites, first.batch);
    const gone = first.ids.slice(0, 5);
    const held = new Map(gone.map((id) => [id, store.get(id)!.pace_slot!]));
    for (const id of gone) store.setState(id, "revoked");
    const second = await enrolBatch(invites, 5);
    // as 9ef886c1 left it: the revoked records keep their slots and the new ones have none
    const file = JSON.parse(readFileSync(store.path, "utf8"));
    for (const record of file.machines) {
      if (held.has(record.machine_id)) record.pace_slot = held.get(record.machine_id);
      if (second.ids.includes(record.machine_id)) delete record.pace_slot;
    }
    writeFileSync(store.path, JSON.stringify(file));
    const reopened = new FleetStore({ stateDir: store.path.replace(/\/fleet\/machines\.json$/, ""), max: 100 });
    const fleet = new Fleet({ stateDir: reopened.path.replace(/\/fleet\/machines\.json$/, ""), store: reopened, tokenConfigured: true });
    fleet.start();
    const slots = reopened.machines().filter((machine) => machine.state !== "revoked").map((machine) => machine.pace_slot);
    expect(new Set(slots).size).toBe(100);
    expect(slots.every((slot) => slot !== undefined)).toBe(true);
    await fleet.close();
  });

  it("backfills at start a pending record made before pace slots existed", async () => {
    const { store } = setup(100);
    const key = await machineKey();
    store.add({ machine_id: key.id, public_key: key.spki });
    const file = JSON.parse(readFileSync(store.path, "utf8"));
    delete file.machines[0].pace_slot;
    writeFileSync(store.path, JSON.stringify(file));
    const dir = store.path.replace(/\/fleet\/machines\.json$/, "");
    const reopened = new FleetStore({ stateDir: dir, max: 100 });
    expect(reopened.get(key.id)!.pace_slot).toBeUndefined();
    const fleet = new Fleet({ stateDir: dir, store: reopened, tokenConfigured: true });
    fleet.start();
    expect(reopened.get(key.id)).toMatchObject({ state: "pending", pace_slot: 0 });
    await fleet.close();
  });
});

describe("PACE beside todo 28's `pending`", () => {
  it("sends a pending machine AUTH_OK with pending and its relay_pace, then a PACE; after the confirm's GOAWAY it signs in again, no longer pending, on the same slot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-pace-pending-"));
    turnFleetOn(dir);
    const fleet = new Fleet({ stateDir: dir, store: new FleetStore({ stateDir: dir, max: 100 }), tokenConfigured: true });
    fleet.start();
    cleanups.push(() => fleet.close());
    const fixture = relayFixture(false, { stateDir: dir });
    cleanups.push(() => fixture.close());
    const session = () => machineConnection(fixture, fleet, { machineSessions: fleet, enrolment: fleet });
    const [invite] = (await fleet.invites.mint(mintRequest({ count: 1 }), async () => CONTROLLER)).invites;
    const key = await machineKey();
    const machine = await session();
    await machine.hello();
    const ok = await machine.enrollAndSignIn(key, invite as Invite);
    // AUTH_OK comes first: no PACE was read before it
    const pacesBeforeOk = machine.paces.length;
    const slot = fleet.store.get(key.id)!.pace_slot!;
    expect(pacesBeforeOk).toBe(0);
    expect(ok).toMatchObject({ pending: true, relay_pace: { slot } });
    await bounded((async () => { while (machine.paces.length < 1) await new Promise<void>((resolve) => setImmediate(resolve)); })());
    expect(machine.paces[0]!.slot).toBe(slot);
    const [batch] = fleet.invites.batches();
    await fleet.invites.confirm(batch!.batch_id, batch!.count, batch!.digest);
    await bounded(machine.closed);
    // the confirmation's GOAWAY, and only it, names the reason the agent dials again at once on
    expect(machine.goaways).toEqual([{ code: "shutdown", last_open_id: 0, drain_ms: 1000, reason: "confirmed" }]);
    const again = await session();
    await again.hello();
    const confirmed = await again.signIn(key);
    expect(confirmed.pending).toBeUndefined();
    expect(confirmed.relay_pace?.slot).toBe(slot);
    expect(fleet.store.get(key.id)).toMatchObject({ state: "active", pace_slot: slot });
  });
});

describe("pace slots through the fleet routes", () => {
  it("DELETE /api/fleet/machines/<id> retires the machine's slot at once: a never-used slot goes first, the retired one when the fleet is full", async () => {
    const before = process.env["OVIS_FLEET_MAX"];
    process.env["OVIS_FLEET_MAX"] = "4";
    cleanups.push(() => { if (before === undefined) delete process.env["OVIS_FLEET_MAX"]; else process.env["OVIS_FLEET_MAX"] = before; });
    const fixture = fleetTestServer({ portal: undefined });
    cleanups.push(() => fixture.close());
    turnFleetOn(fixture.stateDir);
    const relay = fixture.app.context.services.relay;
    const describeSpy = spyOn(relay, "fleetController").mockResolvedValue({ ...CONTROLLER, direct: [...CONTROLLER.direct] });
    cleanups.push(() => describeSpy.mockRestore());
    const base = `http://127.0.0.1:${fixture.app.port}`;
    const write = { ...FLEET_TEST_AUTH, "x-herdr-update": "1", "content-type": "application/json", origin: base };
    const store = relay.fleet.store;
    expect(store.max).toBe(4);
    // what `ovis fleet invite` and `ovis fleet confirm` do: the routes, then each machine enrols with its invite
    const join = async (count: number): Promise<string[]> => {
      const minted = await (await fetch(`${base}/api/fleet/invites`, { method: "POST", headers: write, body: JSON.stringify({ count }) })).json() as { batch_id: string; invites: Invite[] };
      const ids: string[] = [];
      const binding = new Uint8Array(32).fill(5);
      for (const invite of minted.invites) {
        const key = await machineKey();
        expect(await relay.fleet.invites.enroll(signEnroll(key, invite, binding), { binding })).toEqual({ machineId: key.id });
        ids.push(key.id);
      }
      const batch = relay.fleet.invites.batches().find((entry) => entry.batch_id === minted.batch_id)!;
      expect((await fetch(`${base}/api/fleet/batches/${minted.batch_id}/confirm`, { method: "POST", headers: write, body: JSON.stringify({ count: batch.count, digest: batch.digest }) })).status).toBe(200);
      return ids;
    };
    const first = await join(3);
    const gone = first[1]!;
    const retired = store.get(gone)!.pace_slot!;
    // `ovis fleet remove`
    expect((await fetch(`${base}/api/fleet/machines/${gone}`, { method: "DELETE", headers: write })).status).toBe(200);
    expect(store.get(gone)).toMatchObject({ state: "revoked", pace_slot: retired });
    const [fourth] = await join(1);
    expect(store.get(fourth!)!.pace_slot).toBe(3);
    // the fourth machine not revoked fills the fleet: no never-used slot is left, so it takes the retired one
    const [fifth] = await join(1);
    expect(store.get(fifth!)!.pace_slot).toBe(retired);
    expect(store.get(gone)!.pace_slot).toBeUndefined();
    // a full fleet: `ovis fleet remove`, then a fresh invite's machine gets the slot it freed
    const fourthSlot = store.get(fourth!)!.pace_slot!;
    expect((await fetch(`${base}/api/fleet/machines/${fourth}`, { method: "DELETE", headers: write })).status).toBe(200);
    const [sixth] = await join(1);
    expect(store.get(sixth!)!.pace_slot).toBe(fourthSlot);
    const live = store.machines().filter((machine) => machine.state !== "revoked");
    expect(live).toHaveLength(4);
    expect(new Set(live.map((machine) => machine.pace_slot)).size).toBe(4);
    expect(live.every((machine) => machine.pace_slot !== undefined)).toBe(true);
  });
});

describe("PACE frames", () => {
  it("go only to an agent that announced pace: one without it (built before todo 37) gets AUTH_OK's relay_pace, no PACE, and keeps its session", async () => {
    const fixture = relayFixture();
    cleanups.push(() => fixture.close());
    const dir = mkdtempSync(join(tmpdir(), "fleet-pace-feature-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = new FleetStore({ stateDir: dir, max: 100 });
    const [old, current] = await Promise.all([machineKey(), machineKey()]);
    for (const key of [old, current]) { store.add({ machine_id: key.id, public_key: key.spki }); store.setState(key.id, "active"); }
    const fleet = new Fleet({ stateDir: dir, store, clock: new TestClock(), tokenConfigured: true });
    cleanups.push(() => fleet.close());
    const before = await machineConnection(fixture, fleet, { machineSessions: fleet });
    await before.hello();
    const ok = await before.signIn(old, null);
    expect(ok.relay_pace?.slot).toBe(store.get(old.id)!.pace_slot);
    const reader = await machineConnection(fixture, fleet, { machineSessions: fleet });
    await reader.hello();
    await reader.signIn(current);
    const paced = (machine: { paces: unknown[] }, count: number) => bounded((async () => { while (machine.paces.length < count) await new Promise<void>((resolve) => setImmediate(resolve)); })());
    await paced(reader, 1);
    // a budget that changes sends every reader a new PACE: still none to the older agent
    fleet.setRelayBudget(120);
    await paced(reader, 2);
    await bounded(before.mux.measure());
    expect(before.paces).toEqual([]);
    expect(fleet.online(old.id)).toBe(true);
  });


  it("are sent to a pending machine, and to a second session of a key while the first is still live", async () => {
    const fixture = relayFixture();
    cleanups.push(() => fixture.close());
    const dir = mkdtempSync(join(tmpdir(), "fleet-pace-frames-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = new FleetStore({ stateDir: dir, max: 100 });
    const key = await machineKey();
    store.add({ machine_id: key.id, public_key: key.spki });
    // a test clock: the switch window never ends here, so both sessions stay live
    const fleet = new Fleet({ stateDir: dir, store, clock: new TestClock(), tokenConfigured: true });
    cleanups.push(() => fleet.close());
    const paced = (machine: { paces: unknown[] }) => bounded((async () => { while (machine.paces.length < 1) await new Promise<void>((resolve) => setImmediate(resolve)); })());
    const first = await machineConnection(fixture, fleet, { machineSessions: fleet });
    await first.hello();
    await first.signIn(key);
    expect(store.get(key.id)!.state).toBe("pending");
    await paced(first);
    const second = await machineConnection(fixture, fleet, { machineSessions: fleet });
    await second.hello();
    await second.signIn(key);
    await paced(second);
    expect(fleet.online(key.id)).toBe(true);
    expect((fleet as unknown as { live: Map<string, unknown[]> }).live.get(key.id)).toHaveLength(2);
  });
});

describe("the sign-in queue under enrolment", () => {
  it("answers a wave of 100 enrolling machines and an active machine's AUTH in the order they came: the AUTH is not starved", async () => {
    const queue = new SignInQueue(16, 300);
    const order: string[] = [];
    const turn = (name: string) => queue.run(async () => { order.push(name); await Promise.resolve(); return name; }, new AbortController().signal) as Promise<string>;
    const wave = Array.from({ length: 100 }, (_, index) => turn(`enroll-${index}`));
    const auth = turn("auth");
    const later = Array.from({ length: 100 }, (_, index) => turn(`late-${index}`));
    await Promise.all([...wave, auth, ...later]);
    expect(order.indexOf("auth")).toBe(100);
    expect(order.slice(101).every((name) => name.startsWith("late-"))).toBe(true);
  });

  it("verifies an ENROLL only in its turn of the queue, as an AUTH", async () => {
    const fixture = relayFixture();
    cleanups.push(() => fixture.close());
    const queue = new SignInQueue(1, 10);
    const blocker = deferred<string>();
    void queue.run(() => blocker.promise, new AbortController().signal);
    let checked = 0;
    const machine = await machineConnection(fixture, memoryDirectory([]), {
      machineSessions: { admit: () => ({ committed() {}, advert() {}, ended() {} }), signIns: queue },
      enrolment: { enroll: async () => { checked++; return { code: "auth_failed", cause: "unknown" }; } },
    });
    await machine.hello();
    machine.sendEnroll(await machineKey(), { id: "0123456789abcdef", secret: Buffer.alloc(32, 1).toString("base64url") });
    for (let tries = 0; tries < 100 && queue.size.waiting === 0; tries++) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(queue.size).toEqual({ running: 1, waiting: 1 });
    expect(checked).toBe(0);
    blocker.resolve("done");
    expect(await bounded(machine.error)).toEqual({ code: "auth_failed", message: "unknown" });
    expect(checked).toBe(1);
  });

  it("answers an ENROLL that finds the queue full as it answers an AUTH: the retry hint on a direct carrier", async () => {
    const fixture = relayFixture();
    cleanups.push(() => fixture.close());
    const queue = new SignInQueue(1, 0);
    void queue.run(() => new Promise<string>(() => {}), new AbortController().signal);
    const hint = deferred<number>();
    let checked = 0;
    const machine = await machineConnection(fixture, memoryDirectory([]), {
      machineSessions: { admit: () => ({ committed() {}, advert() {}, ended() {} }), signIns: queue },
      enrolment: { enroll: async () => { checked++; return { code: "auth_failed", cause: "unknown" }; } },
      onMachineBusy: (retryAfterMs) => hint.resolve(retryAfterMs),
    });
    await machine.hello();
    machine.sendEnroll(await machineKey(), { id: "0123456789abcdef", secret: Buffer.alloc(32, 1).toString("base64url") });
    expect(await bounded(hint.promise)).toBe(1_000);
    expect(checked).toBe(0);
  });
});

describe("one keepalive probe on a machine session", () => {
  it("sends one PING to a machine silent for 20 s, shared by every round trip asked for meanwhile (PACE, a switch's proof)", async () => {
    const clock = new TestClock();
    const pings: number[] = [];
    const mux = new MuxEngine({
      role: "server", clock, send: async (bytes) => { if (decodeFrame(bytes).type === FrameType.PING) pings.push(clock.now()); }, close: () => {},
      outboundWireByteLength: (bytes) => bytes.byteLength, routingOverhead: 0, maxWireMessageBytes: 64 * 1024, onSession: () => {}, onClose: () => {},
    });
    mux.authenticateExtension("0123456789abcdef0123456789abcdef");
    clock.advance(20_000);
    await mux.flush();
    expect(pings).toEqual([20_000]);
    const asked = [mux.measure(), mux.measure()];
    await mux.flush();
    clock.advance(1_000);
    await mux.flush();
    expect(pings).toEqual([20_000]);
    const probe = (mux as unknown as { probe: bigint }).probe;
    const pong = new Uint8Array(16);
    pong.set([1, FrameType.PONG]);
    new DataView(pong.buffer).setBigUint64(8, probe);
    mux.receive(pong);
    expect(await Promise.all(asked)).toEqual([1_000, 1_000]);
  });
});
