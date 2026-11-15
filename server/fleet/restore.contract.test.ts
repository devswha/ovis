/**
 * A state folder put back from a backup (todo 31 of the relay-fleet plan): the controller keeps a witness outside the
 * state folder (server/fleet/witness.ts; here in a mkdtemp folder of each test, OVIS_FLEET_WITNESS_DIR), so a restored
 * folder cannot prove itself current. Servers start with `port: 0` on a mkdtemp state folder, are stopped, and start
 * again on the same folder; machines sign in on in-process sessions and present the FLEET_STATE they kept.
 */
import { afterEach, describe, expect, it, setDefaultTimeout, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportPublicKey, generateKeyPair } from "../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../shared/relay-server-proof.ts";
import type { FleetMachinesBody } from "../../shared/fleet-cause.ts";
import { bounded } from "../relay/test-helpers.ts";
import { FLEET_TEST_AUTH, fleetTestServer } from "./test-server.ts";
import { mintRequest } from "./invites.ts";
import type { Invite } from "./invites.ts";
import { stateTag } from "./witness.ts";
import type { FleetState } from "./mux-ext.ts";
import { machineConnection, machineKey, SERVER_ID, turnFleetOn } from "./test-helpers.ts";
import type { MachineKey } from "./test-helpers.ts";

setDefaultTimeout(60_000);

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const keys = generateKeyPair();
const CONTROLLER = { server_id: deriveServerId(keys.publicKey), server_public_key: exportPublicKey(keys.publicKey), relay: "wss://relay.ovis.example", direct: [] as string[] };
const WRITE = { "x-herdr-update": "1", "content-type": "application/json", ...FLEET_TEST_AUTH };

function folder(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A witness folder of this test alone. */
function witnessFolder(): string {
  const dir = folder("fleet-restore-witness-");
  const before = process.env["OVIS_FLEET_WITNESS_DIR"];
  process.env["OVIS_FLEET_WITNESS_DIR"] = dir;
  cleanups.push(() => { process.env["OVIS_FLEET_WITNESS_DIR"] = before; });
  return dir;
}

/** A server on `stateDir` (kept when it stops); its relay names CONTROLLER. */
function start(stateDir: string) {
  const fixture = fleetTestServer({ stateDir, portal: undefined });
  const relay = fixture.app.context.services.relay;
  const describing = spyOn(relay, "fleetController").mockResolvedValue(CONTROLLER);
  let stopped: Promise<void> | undefined;
  const stop = () => stopped ??= (async () => {
    for (const close of fixture.closes) close();
    await relay.fleet.close();
    await fixture.app.stop();
    describing.mockRestore();
  })();
  cleanups.push(stop);
  const fleet = relay.fleet;
  const base = `http://127.0.0.1:${fixture.app.port}`;
  const post = async (path: string, body: unknown) => {
    const answer = await fetch(`${base}${path}`, { method: "POST", headers: { ...WRITE, origin: base }, body: JSON.stringify(body) });
    return { status: answer.status, body: await answer.json() as Record<string, unknown> & { error?: { code: string } } };
  };
  return {
    fixture, fleet, base, post, stop,
    machines: async () => await (await fetch(`${base}/api/fleet/machines`, { headers: FLEET_TEST_AUTH })).json() as FleetMachinesBody,
    remove: async (machineId: string) => (await fetch(`${base}/api/fleet/machines/${machineId}`, { method: "DELETE", headers: { ...WRITE, origin: base } })).status,
    /** A session that signs in as `key`, presenting `seen`: its AUTH_OK or the SESSION_ERROR that refused it. */
    signIn: async (key: MachineKey, seen?: FleetState) => {
      const machine = await machineConnection(fixture, fleet, { machineSessions: fleet, enrolment: fleet });
      await machine.hello();
      await machine.sendAuth(key, seen ? { seen } : {});
      const answer = await bounded(Promise.race([machine.admitted.then(() => "signed in" as const), machine.error]));
      return { answer, machine };
    },
  };
}
type Server = ReturnType<typeof start>;

/** Machines A and B enrolled and confirmed on `server`, each signed in and holding the FLEET_STATE it was sent. */
async function enrolTwo(server: Server) {
  const minted = await server.fleet.invites.mint(mintRequest({ count: 2 }), async () => CONTROLLER);
  invitesOf.set(server, minted.invites);
  const [a, b] = [await machineKey(), await machineKey()];
  const sessions = [];
  for (const [index, key] of [a, b].entries()) {
    const machine = await machineConnection(server.fixture, server.fleet, { machineSessions: server.fleet, enrolment: server.fleet });
    await machine.hello();
    await machine.enrollAndSignIn(key, minted.invites[index]!);
    sessions.push(machine);
  }
  const [batch] = server.fleet.invites.batches();
  await server.fleet.invites.confirm(batch!.batch_id, batch!.count, batch!.digest);
  for (const session of sessions) await bounded(session.mux.measure());
  return { a, b, sessionA: sessions[0]!, sessionB: sessions[1]! };
}

const invitesOf = new Map<Server, readonly Invite[]>();

/** A FLEET_STATE of `generation` that verifies: tagged with the witness key of the store in `stateDir`, from `witnessDir`. */
function provenState(stateDir: string, witnessDir: string, generation: number): FleetState {
  const id = (JSON.parse(readFileSync(join(stateDir, "fleet", "machines.json"), "utf8")) as { witness_id: string }).witness_id;
  const witness = JSON.parse(readFileSync(join(witnessDir, `${id}.json`), "utf8")) as { witness_key: string };
  return { generation, tag: stateTag(Buffer.from(witness.witness_key, "base64url"), SERVER_ID, generation).toString("base64url") };
}

/** The FLEET_STATE a test machine holds last, once the controller's latest frames were read. */
async function newest(session: Awaited<ReturnType<typeof enrolTwo>>["sessionA"]): Promise<FleetState> {
  await bounded(session.mux.measure());
  return session.states.at(-1)!;
}

/** Enrols A and B, copies the state folder (and, for a snapshot, the witness folder), revokes B, and stops the server. */
async function backupThenRemoveB(options: { snapshot?: boolean } = {}) {
  const witness = witnessFolder();
  const stateDir = folder("fleet-restore-");
  turnFleetOn(stateDir);
  const first = start(stateDir);
  const { a, b, sessionA } = await enrolTwo(first);
  const before = await newest(sessionA);
  const backup = folder("fleet-restore-backup-");
  cpSync(stateDir, backup, { recursive: true });
  const oldWitness = folder("fleet-restore-old-witness-");
  if (options.snapshot) cpSync(witness, oldWitness, { recursive: true });
  expect(await first.remove(b.id)).toBe(200);
  // A was told of the removal's generation; it keeps it for its next sign-in
  const seenA = await newest(sessionA);
  expect(seenA.generation).toBe(before.generation + 1);
  await first.stop();
  // the whole state folder put back; the witness left as it is (or put back too, as a whole-disk snapshot would)
  rmSync(stateDir, { recursive: true, force: true });
  cpSync(backup, stateDir, { recursive: true });
  if (options.snapshot) {
    for (const file of readdirSync(witness)) rmSync(join(witness, file), { force: true });
    cpSync(oldWitness, witness, { recursive: true });
  }
  return { stateDir, witness, a, b, seenA, seenB: before };
}

describe("a state folder put back from a backup", () => {
  it("holds every machine out (restored) until the operator confirms; B stays revoked until it is re-admitted", async () => {
    const { stateDir, a, b, seenA, seenB } = await backupThenRemoveB();
    const server = start(stateDir);
    expect((await server.signIn(a, seenA)).answer).toEqual({ code: "auth_failed", message: "restored" });
    expect((await server.signIn(b, seenB)).answer).toEqual({ code: "auth_revoked", message: "revoked" });
    await server.fleet.idle();
    expect([server.fleet.forward(a.id), server.fleet.forward(b.id)]).toEqual([undefined, undefined]);
    const listed = await server.machines();
    expect(listed.restore?.notice).toBe("This controller's fleet records are older than its witness");
    expect(listed.machines.map((row) => [row.machine_id, row.cause, row.removed_after_backup]).sort()).toEqual([[a.id, "restored", false], [b.id, "restored", true]].sort());

    expect((await server.post("/api/fleet/restore/confirm", { digest: "0".repeat(64) })).body.error?.code).toBe("restore_changed");
    const confirmed = await server.post("/api/fleet/restore/confirm", { digest: listed.restore!.digest });
    expect(confirmed.status).toBe(200);
    expect((await server.machines()).restore).toBeUndefined();
    expect((await server.signIn(a, seenA)).answer).toBe("signed in");
    expect((await server.signIn(b, seenB)).answer).toEqual({ code: "auth_revoked", message: "revoked" });
    const readmitted = await server.post(`/api/fleet/machines/${b.id}/readmit`, {});
    expect(readmitted.status).toBe(200);
    expect((await server.signIn(b, seenB)).answer).toBe("signed in");
    expect((await server.post(`/api/fleet/machines/${b.id}/readmit`, {})).body.error?.code).toBe("not_removed");
  });

  it("gives B alone no session and stays rolled back, also across a restart", async () => {
    const { stateDir, b, seenB } = await backupThenRemoveB();
    const server = start(stateDir);
    expect((await server.signIn(b, seenB)).answer).toEqual({ code: "auth_revoked", message: "revoked" });
    expect((await server.machines()).restore).toBeDefined();
    await server.stop();
    const again = start(stateDir);
    expect((await again.machines()).restore).toBeDefined();
    expect((await again.signIn(b, seenB)).answer).toEqual({ code: "auth_revoked", message: "revoked" });
  });

  it("starts rolled back when the witness is gone while the store holds machines (a move without it)", async () => {
    const { stateDir, witness, a, seenA } = await backupThenRemoveB();
    for (const file of readdirSync(witness)) rmSync(join(witness, file), { force: true });
    const server = start(stateDir);
    expect((await server.machines()).restore?.reason).toBe("witness_missing");
    expect((await server.signIn(a, seenA)).answer).toEqual({ code: "auth_failed", message: "restored" });
  });

  it("after a snapshot that brought the old witness back: A's newer seen_state rolls the controller back, B's older one does not lift it", async () => {
    const { stateDir, a, b, seenA, seenB } = await backupThenRemoveB({ snapshot: true });
    const server = start(stateDir);
    expect((await server.machines()).restore).toBeUndefined();
    expect((await server.signIn(a, seenA)).answer).toEqual({ code: "auth_failed", message: "restored" });
    expect((await server.machines()).restore?.reason).toBe("seen_state");
    expect((await server.signIn(b, seenB)).answer).toEqual({ code: "auth_failed", message: "restored" });
    expect((await server.machines()).restore).toBeDefined();
  });

  it("after a snapshot hold, the confirmation lets A in for good; only a proof newer than the confirmation holds it again", async () => {
    const { stateDir, witness, a, b, seenA } = await backupThenRemoveB({ snapshot: true });
    const server = start(stateDir);
    expect((await server.signIn(a, seenA)).answer).toEqual({ code: "auth_failed", message: "restored" });
    const held = await server.machines();
    expect(held.restore?.reason).toBe("seen_state");
    // what A proved is recorded at once, outside the state folder
    expect(held.restore?.witness_generation).toBe(seenA.generation);
    const confirmed = await server.post("/api/fleet/restore/confirm", { digest: held.restore!.digest });
    expect([confirmed.status, confirmed.body["generation"]]).toEqual([200, seenA.generation]);
    expect((await server.signIn(a, seenA)).answer).toBe("signed in");
    expect((await server.signIn(a, seenA)).answer).toBe("signed in");
    expect((await server.machines()).restore).toBeUndefined();
    // the snapshot lost B's removal: B is not known as removed, as the plan says of a whole-disk snapshot
    expect((await server.signIn(b)).answer).toBe("signed in");
    // a machine that proves a generation above the confirmed one (an even older copy was put back): held again
    const newer = provenState(stateDir, witness, seenA.generation + 5);
    expect((await server.signIn(a, newer)).answer).toEqual({ code: "auth_failed", message: "restored" });
    expect((await server.machines()).restore?.reason).toBe("seen_state");
  });

  it("after a hold by OVIS_FLEET_RESTORED=1 over a snapshot, the confirmation rises to what A proved and A stays in", async () => {
    const { stateDir, a, seenA } = await backupThenRemoveB({ snapshot: true });
    const before = process.env["OVIS_FLEET_RESTORED"];
    process.env["OVIS_FLEET_RESTORED"] = "1";
    cleanups.push(() => { if (before === undefined) delete process.env["OVIS_FLEET_RESTORED"]; else process.env["OVIS_FLEET_RESTORED"] = before; });
    const server = start(stateDir);
    expect((await server.machines()).restore?.reason).toBe("restored_flag");
    expect((await server.signIn(a, seenA)).answer).toEqual({ code: "auth_failed", message: "restored" });
    const held = await server.machines();
    expect((await server.post("/api/fleet/restore/confirm", { digest: held.restore!.digest })).status).toBe(200);
    expect((await server.signIn(a, seenA)).answer).toBe("signed in");
    expect((await server.machines()).restore).toBeUndefined();
  });

  it("never lifts a quarantine unseen: the witness keeps the key held after a restore and a confirmation, until the slot is released", async () => {
    witnessFolder();
    const stateDir = folder("fleet-restore-quarantine-");
    turnFleetOn(stateDir);
    const first = start(stateDir);
    const { a } = await enrolTwo(first);
    const backup = folder("fleet-restore-backup-");
    cpSync(stateDir, backup, { recursive: true });
    // a copy of A's invite from another key quarantines A, after the backup
    const copy = await machineConnection(first.fixture, first.fleet, { machineSessions: first.fleet, enrolment: first.fleet });
    await copy.hello();
    copy.sendEnroll(await machineKey(), invitesOf.get(first)![0]!);
    expect(await bounded(copy.error)).toEqual({ code: "auth_revoked", message: "quarantined" });
    await first.stop();
    rmSync(stateDir, { recursive: true, force: true });
    cpSync(backup, stateDir, { recursive: true });
    const server = start(stateDir);
    const held = await server.machines();
    expect(held.machines.find((row) => row.machine_id === a.id)?.quarantined_after_backup).toBe(true);
    // the quarantine mark is part of what is confirmed: the same list read without it is refused
    const unmarked = createHash("sha256").update(held.machines.filter((row) => row.state !== "revoked").map((row) => row.machine_id).sort()
      .map((id) => `${id} ${held.machines.find((row) => row.machine_id === id)?.removed_after_backup ? "removed" : "kept"}\n`).join("")).digest("hex");
    expect((await server.post("/api/fleet/restore/confirm", { digest: unmarked })).body.error?.code).toBe("restore_changed");
    expect((await server.post("/api/fleet/restore/confirm", { digest: held.restore!.digest })).status).toBe(200);
    expect(server.fleet.store.get(a.id)?.state).toBe("active");
    expect((await server.signIn(a)).answer).toEqual({ code: "auth_revoked", message: "quarantined" });
    const slot = invitesOf.get(first)![0]!.slot;
    const released = await server.post(`/api/fleet/slots/${slot}/release`, {});
    expect([released.status, released.body["revoked"]]).toEqual([200, [a.id]]);
    expect((await server.signIn(a)).answer).toEqual({ code: "auth_revoked", message: "revoked" });
    // released means removed: the operator may re-admit it, and then it is neither removed nor quarantined
    expect((await server.post(`/api/fleet/machines/${a.id}/readmit`, {})).status).toBe(200);
    expect((await server.signIn(a)).answer).toBe("signed in");
  });

  it("sends FLEET_STATE only to an agent whose AUTH lists fleet_state: one from before todo 31 keeps working without it", async () => {
    witnessFolder();
    const stateDir = folder("fleet-restore-features-");
    turnFleetOn(stateDir);
    const server = start(stateDir);
    const { a, b } = await enrolTwo(server);
    for (const [key, features, told] of [[a, ["pace"], 0], [b, ["pace", "fleet_state"], 1]] as const) {
      const machine = await machineConnection(server.fixture, server.fleet, { machineSessions: server.fleet, enrolment: server.fleet });
      await machine.hello();
      await machine.sendAuth(key, { features: [...features] });
      await bounded(machine.admitted);
      await bounded(machine.mux.measure());
      expect([features.join(","), machine.states.length]).toEqual([features.join(","), told]);
      expect(machine.session.mux.active).toBe(true);
    }
  });

  it("ignores a seen_state whose tag does not verify", async () => {
    const { stateDir, a, seenA } = await backupThenRemoveB({ snapshot: true });
    const server = start(stateDir);
    const forged: FleetState = { generation: seenA.generation + 5, tag: Buffer.alloc(32, 7).toString("base64url") };
    expect((await server.signIn(a, forged)).answer).toBe("signed in");
    expect((await server.machines()).restore).toBeUndefined();
  });

  it("holds the fleet when started with OVIS_FLEET_RESTORED=1", async () => {
    witnessFolder();
    const stateDir = folder("fleet-restore-flag-");
    turnFleetOn(stateDir);
    const first = start(stateDir);
    const { a } = await enrolTwo(first);
    const state = await newest((await first.signIn(a)).machine);
    await first.stop();
    const before = process.env["OVIS_FLEET_RESTORED"];
    process.env["OVIS_FLEET_RESTORED"] = "1";
    cleanups.push(() => { if (before === undefined) delete process.env["OVIS_FLEET_RESTORED"]; else process.env["OVIS_FLEET_RESTORED"] = before; });
    const server = start(stateDir);
    expect((await server.machines()).restore?.reason).toBe("restored_flag");
    expect((await server.signIn(a, state)).answer).toEqual({ code: "auth_failed", message: "restored" });
  });
});
