/**
 * Remove, revoke, vanish, rebuild (todo 31 of the relay-fleet plan) on a server started with `port: 0` and a mkdtemp
 * state folder, its machines on in-process sessions: `DELETE /api/fleet/machines/<id>` revokes a key (into the witness,
 * which lives in the test run's own folder: scripts/test-herdr.ts), the vanish sweep removes a machine past its batch's
 * retention on an injected wall clock, a rebuild (`slots_from`) re-enrols a slot under its name with a new key, an open
 * invite is withdrawn, and a quarantined slot is released only by the operator. Every wait is on an event with a bound.
 */
import { afterEach, describe, expect, it, setDefaultTimeout, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportPublicKey, generateKeyPair } from "../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../shared/relay-server-proof.ts";
import { bounded } from "../relay/test-helpers.ts";
import { FLEET_TEST_AUTH, fleetTestServer } from "./test-server.ts";
import { mintRequest } from "./invites.ts";
import type { Invite } from "./invites.ts";
import { Fleet } from "./sessions.ts";
import { WitnessError } from "./witness.ts";
import { FleetStore } from "./store.ts";
import { machineConnection, machineKey, signEnroll, testAdvert, advertFrame, turnFleetOn } from "./test-helpers.ts";
import type { MachineKey } from "./test-helpers.ts";

setDefaultTimeout(30_000);

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const keys = generateKeyPair();
const CONTROLLER = { server_id: deriveServerId(keys.publicKey), server_public_key: exportPublicKey(keys.publicKey), relay: "wss://relay.ovis.example", direct: [] as string[] };
const WRITE = { "x-herdr-update": "1", "content-type": "application/json", ...FLEET_TEST_AUTH };

/** A server whose fleet is on, its relay naming CONTROLLER; machines sign in on in-process sessions of its own fleet. */
function server() {
  const fixture = fleetTestServer({ portal: undefined });
  // the server and its fleet stop before the folder goes, so no late write makes it again
  cleanups.push(async () => {
    for (const close of fixture.closes) close();
    await fixture.app.context.services.relay.fleet.close();
    await fixture.app.stop();
    rmSync(fixture.stateDir, { recursive: true, force: true });
  });
  turnFleetOn(fixture.stateDir);
  const relay = fixture.app.context.services.relay;
  const describing = spyOn(relay, "fleetController").mockResolvedValue(CONTROLLER);
  cleanups.push(() => describing.mockRestore());
  const fleet = relay.fleet;
  const base = `http://127.0.0.1:${fixture.app.port}`;
  const post = async (path: string, body: unknown) => {
    const answer = await fetch(`${base}${path}`, { method: "POST", headers: { ...WRITE, origin: base }, body: JSON.stringify(body) });
    return { status: answer.status, body: await answer.json() as Record<string, unknown> & { error?: { code: string } } };
  };
  return {
    fixture, fleet, base, post,
    mint: async (body: Record<string, unknown> = { count: 1 }) => fleet.invites.mint(mintRequest(body), async () => CONTROLLER),
    remove: async (machineId: string) => {
      const answer = await fetch(`${base}/api/fleet/machines/${machineId}`, { method: "DELETE", headers: { ...WRITE, origin: base } });
      return { status: answer.status, body: await answer.json() as Record<string, unknown> & { error?: { code: string } } };
    },
    session: () => machineConnection(fixture, fleet, { machineSessions: fleet, enrolment: fleet }),
  };
}
type Server = ReturnType<typeof server>;

/** Enrols `key` with `invite` on a new session and confirms its batch; the session stays signed in. */
async function enrolled(ctx: Server, invite: Invite, key: MachineKey) {
  const machine = await ctx.session();
  await machine.hello();
  await machine.enrollAndSignIn(key, invite);
  const batch = ctx.fleet.invites.batches().find((row) => row.machines.some((entry) => entry.machine_id === key.id));
  if (!batch) return machine;
  await ctx.fleet.invites.confirm(batch.batch_id, batch.count, batch.digest);
  // a machine signed in while pending reconnects once confirmed (todo 37's AUTH_OK `pending`): pipes open on that session
  machine.stop();
  await bounded(machine.closed);
  const active = await ctx.session();
  await active.hello();
  await active.signIn(key);
  return active;
}

/** A fresh session that signs in as `key`: its AUTH_OK or the SESSION_ERROR that refused it. */
async function signInAgain(ctx: Server, key: MachineKey) {
  const again = await ctx.session();
  await again.hello();
  await again.sendAuth(key);
  return bounded(Promise.race([again.admitted.then(() => "signed in" as const), again.error]));
}

describe("DELETE /api/fleet/machines/<id>", () => {
  it("revokes: the open pipe closes within one event-loop turn, the session ends auth_revoked, the forward and the roster row go, the key is witnessed and refused", async () => {
    const ctx = server();
    const { invites } = await ctx.mint();
    const key = await machineKey();
    const machine = await enrolled(ctx, invites[0]!, key);
    machine.mux.enqueueControl(advertFrame(testAdvert(["bridge"])));
    await bounded(machine.mux.measure());
    expect(await bounded(ctx.fleet.forwardReady(key.id))).toBeDefined();
    const generation = ctx.fleet.store.document().generation ?? 0;
    // the machine keeps the newest FLEET_STATE (docs/fleet-link.md section 1.7)
    expect(machine.states.at(-1)?.generation).toBe(generation);
    const opened = await ctx.fleet.openPipe(key.id, "bridge");
    const closed = opened.disposed.then(() => "closed" as const);

    const removed = await ctx.remove(key.id);
    expect([removed.status, removed.body]).toEqual([200, { machine_id: key.id, name: "machine-0", state: "revoked" }]);
    expect(await Promise.race([closed, new Promise<"open">((resolve) => setImmediate(() => resolve("open")))])).toBe("closed");
    expect(await bounded(machine.error)).toEqual({ code: "auth_revoked", message: "revoked" });
    await ctx.fleet.idle();
    expect(ctx.fleet.forward(key.id)).toBeUndefined();
    const pcs = await (await fetch(`${ctx.base}/api/machines`, { headers: FLEET_TEST_AUTH })).json();
    expect(JSON.stringify(pcs)).not.toContain(key.id);
    // the witness lists it and its generation rose with the removal; the store records that generation
    expect(ctx.fleet.witness().isRemoved(key.id)).toBe(true);
    expect(ctx.fleet.witness().generation).toBe(generation + 1);
    expect(ctx.fleet.store.document().generation).toBe(generation + 1);
    expect(await signInAgain(ctx, key)).toEqual({ code: "auth_revoked", message: "revoked" });

    // removing it again forgets the tombstone; the witness keeps the key refused
    const forgotten = await ctx.remove(key.id);
    expect([forgotten.status, forgotten.body["state"]]).toEqual([200, "forgotten"]);
    expect(ctx.fleet.store.get(key.id)).toBeUndefined();
    expect(await signInAgain(ctx, key)).toEqual({ code: "auth_revoked", message: "revoked" });
    expect((await ctx.remove(key.id)).body.error?.code).toBe("unknown_machine");
    // nor does a fresh invite bring the forgotten key back: refused, no record, the invite still unused
    const fresh = await ctx.mint();
    const comeback = await ctx.session();
    await comeback.hello();
    comeback.sendEnroll(key, fresh.invites[0]!);
    expect(await bounded(comeback.error)).toEqual({ code: "auth_revoked", message: "revoked" });
    expect(ctx.fleet.store.get(key.id)).toBeUndefined();
    expect(ctx.fleet.invites.list().find((row) => row.id === fresh.invites[0]!.id)?.state).toBe("unused");
    expect(ctx.fleet.invites.batches()).toEqual([]);
  });

  it("refuses with witness_write_failed and changes nothing when the witness cannot be written", async () => {
    const ctx = server();
    const { invites } = await ctx.mint();
    const key = await machineKey();
    const machine = await enrolled(ctx, invites[0]!, key);
    const write = spyOn(ctx.fleet.witness(), "write").mockImplementation(() => { throw new WitnessError("witness_write_failed", "the disk refused"); });
    cleanups.push(() => write.mockRestore());
    const before = ctx.fleet.store.document();
    const refused = await ctx.remove(key.id);
    expect([refused.status, refused.body.error?.code]).toEqual([503, "witness_write_failed"]);
    const after = ctx.fleet.store.document();
    expect([after.generation, after.machines.map((machine) => machine.state)]).toEqual([before.generation, before.machines.map((machine) => machine.state)]);
    expect(machine.session.mux.active).toBe(true);
  });
});

describe("pace slots of a forgotten machine (todo 37's rule on todo 31's forget)", () => {
  it("retires the slot of a forgotten record: a new machine gets one never used, the forgotten one only once the fleet is full", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "fleet-forget-pace-"));
    cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
    turnFleetOn(stateDir);
    const store = new FleetStore({ stateDir, max: 5 });
    const fleet = new Fleet({ stateDir, tokenConfigured: true, store, serverId: () => CONTROLLER.server_id });
    cleanups.push(() => fleet.close());
    const newMachine = async () => {
      const key = await machineKey();
      store.add({ machine_id: key.id, public_key: key.spki });
      store.setState(key.id, "active");
      return key.id;
    };
    const [a, b, c] = [await newMachine(), await newMachine(), await newMachine()];
    expect([a, b, c].map((id) => store.get(id)?.pace_slot)).toEqual([0, 1, 2]);
    // removed while offline (it never heard auth_revoked and may still dial on slot 0), then forgotten
    expect(fleet.removeMachine(a).state).toBe("revoked");
    expect(fleet.removeMachine(a).state).toBe("forgotten");
    expect(store.document().retired_pace_slots).toEqual([0]);
    const d = await newMachine();
    const e = await newMachine();
    expect([store.get(d)?.pace_slot, store.get(e)?.pace_slot]).toEqual([3, 4]);
    // the fleet is full but for one: only now does the forgotten slot go out again
    const f = await newMachine();
    expect(store.get(f)?.pace_slot).toBe(0);
    expect(store.document().retired_pace_slots).toBeUndefined();
  });
});

describe("a fleet with no token (todo 60) and todo 31's own writes", () => {
  it("starts and sweeps quietly: no hold, no removal, no write, also with the witness gone and machines past their retention", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "fleet-tokenless-"));
    cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
    turnFleetOn(stateDir);
    let now = Date.UTC(2026, 10, 13, 12);
    const store = new FleetStore({ stateDir, now: () => now });
    const key = await machineKey();
    store.add({ machine_id: key.id, public_key: key.spki });
    store.setState(key.id, "active");
    const before = readFileSync(store.path);
    // no witness for this store (its start check would hold it as rolled back), and a day past any retention
    now += 400 * 24 * 3600 * 1000;
    const logged: string[] = [];
    const log = spyOn(console, "error").mockImplementation((line: unknown) => { logged.push(String(line)); });
    cleanups.push(() => log.mockRestore());
    const fleet = new Fleet({ stateDir, tokenConfigured: false, store, wall: () => now, serverId: () => CONTROLLER.server_id });
    cleanups.push(() => fleet.close());
    fleet.start();
    expect(fleet.sweep()).toEqual([]);
    // quiet: no refused write was even tried, so nothing was logged
    expect(logged).toEqual([]);
    expect(fleet.rolledBack()).toBe(false);
    expect(readFileSync(store.path).equals(before)).toBe(true);
    expect(store.get(key.id)?.state).toBe("active");
  });
});

describe("the vanish sweep", () => {
  it("removes a machine unseen past its batch's retention on the next sweep, keeps one within it and one of a batch kept forever", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "fleet-vanish-"));
    cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
    turnFleetOn(stateDir);
    let now = Date.UTC(2026, 10, 13, 12);
    const fleet = new Fleet({ stateDir, tokenConfigured: true, store: new FleetStore({ stateDir, now: () => now }), wall: () => now, serverId: () => CONTROLLER.server_id });
    cleanups.push(() => fleet.close());
    const binding = new Uint8Array(32).fill(7);
    const enrol = async (body: Record<string, unknown>) => {
      const minted = await fleet.invites.mint(mintRequest(body), async () => CONTROLLER);
      const key = await machineKey();
      expect(await fleet.invites.enroll(signEnroll(key, minted.invites[0]!, binding), { binding })).toEqual({ machineId: key.id });
      const [batch] = fleet.invites.batches();
      await fleet.invites.confirm(batch!.batch_id, batch!.count, batch!.digest);
      return key;
    };
    const hour = await enrol({ count: 1, retention_s: 3600 });
    const forever = await enrol({ count: 1, retention_s: 0 });
    now += 3600 * 1000 - 1;
    const day = await enrol({ count: 1 });
    expect(fleet.sweep()).toEqual([]);
    const logged: string[] = [];
    const log = spyOn(console, "error").mockImplementation((line: unknown) => { logged.push(String(line)); });
    cleanups.push(() => log.mockRestore());
    now += 2;
    expect(fleet.sweep()).toEqual([hour.id]);
    expect(fleet.store.get(hour.id)?.state).toBe("revoked");
    expect(fleet.witness().isRemoved(hour.id)).toBe(true);
    expect(logged.map((line) => JSON.parse(line) as { event: string; machine_id: string })).toContainEqual({ event: "fleet.vanished", machine_id: hour.id });
    // a day later still: the default retention (24 h) removes the third; 0 keeps the second for ever
    now += 24 * 3600 * 1000;
    expect(fleet.sweep()).toEqual([day.id]);
    expect(fleet.store.get(forever.id)?.state).toBe("active");
    // a fleet held as rolled back is swept by nobody: a machine past its retention stays, and nothing is written
    const late = await enrol({ count: 1, retention_s: 3600 });
    fleet.store.update((document) => ({ document: { ...document, hold: true }, result: undefined }));
    const before = readFileSync(fleet.store.path);
    now += 2 * 3600 * 1000;
    expect(fleet.sweep()).toEqual([]);
    expect(readFileSync(fleet.store.path).equals(before)).toBe(true);
    expect(fleet.store.get(late.id)?.state).toBe("active");
  });
});

describe("rebuild, withdraw and release", () => {
  it("re-enrols a slot with an invite of --slots-from: the name stays, the machine id is new, the old key is revoked and logged re-enrolled", async () => {
    const ctx = server();
    const first = await ctx.mint({ count: 1, prefix: "vm-" });
    const old = await machineKey();
    const machine = await enrolled(ctx, first.invites[0]!, old);
    // a second machine holds the next pace slot, so the rebuild's slot cannot fall to it by chance (C5)
    const other = await ctx.mint({ count: 1 });
    await enrolled(ctx, other.invites[0]!, await machineKey());
    const oldPace = ctx.fleet.store.get(old.id)?.pace_slot;
    expect(oldPace).toBeNumber();
    const logged: string[] = [];
    const log = spyOn(console, "error").mockImplementation((line: unknown) => { logged.push(String(line)); });
    cleanups.push(() => log.mockRestore());
    const rebuilt = await ctx.post("/api/fleet/invites", { slots_from: first.batch_id });
    expect(rebuilt.status).toBe(201);
    const invite = (rebuilt.body["invites"] as Invite[])[0]!;
    expect(invite.slot).toBe(first.invites[0]!.slot);
    const fresh = await machineKey();
    const again = await ctx.session();
    await again.hello();
    await again.enrollAndSignIn(fresh, invite);
    expect(ctx.fleet.store.get(fresh.id)).toMatchObject({ name: "vm-0", slot: invite.slot, state: "pending" });
    expect(fresh.id).not.toBe(old.id);
    expect(ctx.fleet.store.get(old.id)?.state).toBe("revoked");
    // C5 (todo 37): the new key takes the revoked holder's place on the pace timeline, and the revoked record gives it up
    expect([ctx.fleet.store.get(fresh.id)?.pace_slot, ctx.fleet.store.get(old.id)?.pace_slot]).toEqual([oldPace, undefined]);
    expect(await bounded(machine.error)).toEqual({ code: "auth_revoked", message: "revoked" });
    expect(ctx.fleet.witness().isRemoved(old.id)).toBe(true);
    expect(logged.flatMap((line) => line.startsWith("{") ? [JSON.parse(line) as Record<string, unknown>] : []).find((entry) => entry["event"] === "fleet.re-enrolled"))
      .toMatchObject({ slot: invite.slot, name: "vm-0", old_machine_id: old.id, machine_id: fresh.id });
    // a rebuild whose slot still has an open invite is refused: two open invites on one slot would replace each other
    const open = await ctx.post("/api/fleet/invites", { slots_from: first.batch_id });
    expect(open.status).toBe(201);
    expect((await ctx.post("/api/fleet/invites", { slots_from: first.batch_id })).body.error?.code).toBe("invalid_request");
  });

  it("withdraws one open invite, then the rest of its batch: ENROLL with a withdrawn one is refused unknown", async () => {
    const ctx = server();
    const minted = await ctx.mint({ count: 3 });
    const [one, two, three] = minted.invites;
    const withdrawn = await ctx.post("/api/fleet/invites/withdraw", { invite_id: one!.id });
    expect([withdrawn.status, withdrawn.body]).toEqual([200, { withdrawn: [one!.id] }]);
    expect(ctx.fleet.invites.list().map((row) => row.id).sort()).toEqual([two!.id, three!.id].sort());
    const key = await machineKey();
    const machine = await ctx.session();
    await machine.hello();
    machine.sendEnroll(key, one!);
    expect(await bounded(machine.error)).toEqual({ code: "auth_failed", message: "unknown" });
    // one used invite stays with its machine; the batch's unused ones go
    await enrolled(ctx, two!, await machineKey());
    const batch = await ctx.post("/api/fleet/invites/withdraw", { batch_id: minted.batch_id });
    expect(batch.body).toEqual({ withdrawn: [three!.id] });
    expect(ctx.fleet.invites.list().map((row) => [row.id, row.state])).toEqual([[two!.id, "used"]]);
    expect((await ctx.post("/api/fleet/invites/withdraw", { invite_id: one!.id })).body.error?.code).toBe("unknown_invite");
    expect((await ctx.post("/api/fleet/invites/withdraw", { invite_id: two!.id })).body.error?.code).toBe("invalid_request");
  });

  it("holds a quarantined slot until the operator releases it: a rebuild's key is refused quarantined, then enrols after the release", async () => {
    const ctx = server();
    const first = await ctx.mint();
    const invite = first.invites[0]!;
    const real = await machineKey();
    await enrolled(ctx, invite, real);
    // a copy of the used invite from a second key quarantines the slot
    const copy = await ctx.session();
    await copy.hello();
    copy.sendEnroll(await machineKey(), invite);
    expect(await bounded(copy.error)).toEqual({ code: "auth_revoked", message: "quarantined" });
    expect(ctx.fleet.store.get(real.id)?.state).toBe("quarantined");
    // a pipe to a quarantined machine is refused with its typed cause
    expect(await ctx.fleet.openPipe(real.id, "bridge").then(() => "opened", (error: { reason?: string }) => error.reason)).toBe("not_active");
    const rows = await (await fetch(`${ctx.base}/api/fleet/machines`, { headers: FLEET_TEST_AUTH })).json() as { machines: { machine_id: string; cause: string }[] };
    expect(rows.machines.find((row) => row.machine_id === real.id)?.cause).toBe("quarantined");

    const rebuilt = await ctx.post("/api/fleet/invites", { slots_from: first.batch_id });
    const next = (rebuilt.body["invites"] as Invite[])[0]!;
    const fresh = await machineKey();
    const refused = await ctx.session();
    await refused.hello();
    refused.sendEnroll(fresh, next);
    expect(await bounded(refused.error)).toEqual({ code: "auth_revoked", message: "quarantined" });
    expect(ctx.fleet.store.get(real.id)?.state).toBe("quarantined");

    expect((await ctx.post(`/api/fleet/slots/${invite.slot + 1}/release`, {})).body.error?.code).toBe("unknown_slot");
    const released = await ctx.post(`/api/fleet/slots/${invite.slot}/release`, {});
    expect([released.status, released.body]).toEqual([200, { slot: invite.slot, revoked: [real.id] }]);
    expect(ctx.fleet.store.get(real.id)?.state).toBe("revoked");
    expect((await ctx.post(`/api/fleet/slots/${invite.slot}/release`, {})).body.error?.code).toBe("slot_not_quarantined");
    const after = await ctx.session();
    await after.hello();
    await after.enrollAndSignIn(fresh, next);
    expect(ctx.fleet.store.get(fresh.id)?.state).toBe("pending");
  });
});
