/**
 * Enrolment on live machine sessions (docs/fleet-link.md section 4): a RelaySession with the fleet's invites, in process
 * on a server started with `port: 0` and a mkdtemp state folder, and on a controller's real relay link through a local
 * Bun relay (relay/bun.ts), restarted on the same state folder and port. The controller's wall clock is injected; every
 * wait is on an event with a bound. After each refusal the store's bytes are hashed against what they were before.
 */
import { afterEach, describe, expect, it, setDefaultTimeout, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBunRelay } from "../../relay/bun.ts";
import type { Transport } from "../../shared/relay-e2ee.ts";
import { exportPublicKey, generateKeyPair } from "../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../shared/relay-server-proof.ts";
import { createServer } from "../index.ts";
import { loadRelayIdentity } from "../relay/identity.ts";
import { RelayService } from "../relay/service.ts";
import { bounded, deferred, TestClock } from "../relay/test-helpers.ts";
import { fleetRows } from "./causes.ts";
import { mintRequest } from "./invites.ts";
import type { Invite } from "./invites.ts";
import { MachineUnavailable, Fleet, SILENT_QUARANTINE, SILENT_WINDOW_MS, SWITCH_PROBE_MS, SWITCH_WINDOW_MS } from "./sessions.ts";
import { FleetStore } from "./store.ts";
import { advertFrame, machineClient, machineConnection, machineKey, pipeToTarget, signEnroll, testAdvert, turnFleetOn } from "./test-helpers.ts";
import { FLEET_TEST_AUTH, FLEET_TEST_TOKEN, fleetTestServer } from "./test-server.ts";

// each test makes a few synced store writes: on a loaded disk they can pass bun's 5 s default (as direct.contract.test.ts says)
setDefaultTimeout(30_000);

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const T0 = Date.UTC(2026, 10, 13, 12);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function folder(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
/** Every form an invite's secret could be written in: raw, hex, base64 and base64url. */
function forms(secret: string): string[] {
  const raw = Buffer.from(secret, "base64url");
  return [raw.toString("latin1"), raw.toString("hex"), raw.toString("base64"), raw.toString("base64url")];
}

/** A fleet on its own state folder with the wall clock in a test's hand, and a server for its sessions. */
async function inProcess(options: { clock?: TestClock } = {}) {
  const stateDir = folder("fleet-enroll-");
  let now = T0;
  turnFleetOn(stateDir);
  const fleet = new Fleet({ stateDir, tokenConfigured: true, store: new FleetStore({ stateDir, now: () => now }), wall: () => now, ...(options.clock ? { clock: options.clock } : {}) });
  fleet.start();
  cleanups.push(() => fleet.close());
  const fixture = fleetTestServer({ stateDir });
  cleanups.push(() => fixture.close());
  const keys = generateKeyPair();
  const controller = { server_id: deriveServerId(keys.publicKey), server_public_key: exportPublicKey(keys.publicKey), relay: "wss://relay.ovis.example", direct: [] };
  const alerts: unknown[] = [];
  fleet.onAlert((alert) => alerts.push(alert));
  return {
    stateDir, fleet, fixture, alerts,
    advance(ms: number) { now += ms; },
    mint: async (count = 1, life_s = 3600): Promise<readonly Invite[]> => (await fleet.invites.mint(mintRequest({ count, life_s }), async () => controller)).invites,
    session: () => machineConnection(fixture, fleet, { machineSessions: fleet, enrolment: fleet }),
    bytes: () => readFileSync(fleet.store.path),
  };
}

describe("enrolment on a machine session", () => {
  it("answers ENROLL_OK, signs the machine in with AUTH on the same session, and records it pending with no pipe", async () => {
    const ctx = await inProcess();
    const [invite] = await ctx.mint();
    const key = await machineKey();
    const machine = await ctx.session();
    await machine.hello();
    expect((await machine.enrollAndSignIn(key, invite!)).machine_id).toBe(key.id);
    expect(await bounded(machine.enrolled)).toEqual({ machine_id: key.id });
    expect(ctx.fleet.store.get(key.id)).toMatchObject({ state: "pending", slot: invite!.slot, invite_id: invite!.id, name: `machine-${invite!.slot}` });
    expect(ctx.fleet.online(key.id)).toBe(true);
    // an unconfirmed machine: no forward, and no pipe opens to it whatever it advertises
    machine.mux.enqueueControl(advertFrame(testAdvert()));
    await bounded(machine.mux.measure());
    expect(ctx.fleet.forward(key.id)).toBeUndefined();
    const refused = await ctx.fleet.openPipe(key.id, "bridge").catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(MachineUnavailable);
    expect((refused as MachineUnavailable).reason).toBe("not_active");
    // the same key again, on another session, gets the same answer
    const again = await ctx.session();
    await again.hello();
    again.sendEnroll(key, invite!);
    expect(await bounded(again.enrolled)).toEqual({ machine_id: key.id });
    expect(ctx.fleet.store.machines()).toHaveLength(1);
  });

  it("ends the session auth_failed and changes nothing for a bad signature, an unknown id, an expired invite and a signature over another key", async () => {
    const ctx = await inProcess();
    const [invite] = await ctx.mint(1, 60);
    const key = await machineKey();
    const other = await machineKey();
    const before = sha(ctx.bytes());
    const cases: [string, (machine: Awaited<ReturnType<typeof ctx.session>>) => void, string][] = [
      ["bad signature", (machine) => machine.sendEnroll(key, invite!, { secret: Buffer.alloc(32, 1).toString("base64url") }), "signature"],
      ["unknown id", (machine) => machine.sendEnroll(key, { id: "00000000000000ff", secret: invite!.secret }), "unknown"],
      ["signature over another machine key", (machine) => machine.sendEnroll(key, invite!, { signedSpki: other.spki }), "signature"],
    ];
    for (const [what, send, cause] of cases) {
      const machine = await ctx.session();
      await machine.hello();
      send(machine);
      expect(await bounded(machine.error), what).toEqual({ code: "auth_failed", message: cause });
      expect(sha(ctx.bytes()), what).toBe(before);
    }
    ctx.advance(60_000);
    const late = await ctx.session();
    await late.hello();
    late.sendEnroll(key, invite!);
    expect(await bounded(late.error)).toEqual({ code: "auth_failed", message: "expired" });
    expect(sha(ctx.bytes())).toBe(before);
    expect(ctx.fleet.invites.list().map((row) => row.state)).toEqual(["expired"]);
  });

  it("refuses the same ENROLL replayed on another session: its signature covers the first session's channel binding", async () => {
    const ctx = await inProcess();
    const [invite] = await ctx.mint();
    const key = await machineKey();
    const first = await ctx.session();
    const second = await ctx.session();
    await second.hello();
    const before = sha(ctx.bytes());
    second.sendEnroll(key, invite!, { enroll: signEnroll(key, invite!, first.binding) });
    expect(await bounded(second.error)).toEqual({ code: "auth_failed", message: "signature" });
    expect(sha(ctx.bytes())).toBe(before);
    expect(ctx.fleet.invites.list()[0]!.state).toBe("unused");
  });

  it("quarantines the slot when a second key presents a used invite: neither key signs in, and an alert is raised", async () => {
    const ctx = await inProcess();
    const [invite] = await ctx.mint();
    const owner = await machineKey();
    const thief = await machineKey();
    const real = await ctx.session();
    await real.hello();
    await real.enrollAndSignIn(owner, invite!);
    const stolen = await ctx.session();
    await stolen.hello();
    stolen.sendEnroll(thief, invite!);
    expect(await bounded(stolen.error)).toEqual({ code: "auth_revoked", message: "quarantined" });
    // the real machine's live session follows its record
    expect(await bounded(real.error)).toEqual({ code: "auth_revoked", message: "quarantined" });
    expect(ctx.fleet.store.machines().map((machine) => [machine.machine_id, machine.state])).toEqual([[owner.id, "quarantined"]]);
    expect(ctx.alerts).toEqual([{ kind: "quarantined", reason: "second_key", machine_id: owner.id, slot: invite!.slot, invite_id: invite!.id }]);
    for (const [key, expected] of [[owner, { code: "auth_revoked", message: "quarantined" }], [thief, { code: "auth_failed", message: "unknown" }]] as const) {
      const machine = await ctx.session();
      await machine.hello();
      await machine.sendAuth(key);
      expect(await bounded(machine.error)).toEqual(expected);
    }
  });

  it("takes one ENROLL per session, never after AUTH, and refuses it where no fleet takes enrolments", async () => {
    const ctx = await inProcess();
    const [one, two] = await ctx.mint(2);
    const key = await machineKey();
    const machine = await ctx.session();
    await machine.hello();
    machine.sendEnroll(key, one!);
    await bounded(machine.enrolled);
    machine.sendEnroll(key, two!);
    expect(await bounded(machine.error)).toEqual({ code: "protocol_error", message: "protocol_error" });
    expect(ctx.fleet.invites.list().map((row) => row.state)).toEqual(["used", "unused"]);
    const without = await machineConnection(ctx.fixture, ctx.fleet, { machineSessions: ctx.fleet });
    await without.hello();
    without.sendEnroll(key, two!);
    expect(await bounded(without.error)).toEqual({ code: "auth_failed", message: "unknown" });
  });

  it("quarantines a machine whose key holds two live sessions past the switch window, closing both", async () => {
    const clock = new TestClock();
    const ctx = await inProcess({ clock });
    const [invite] = await ctx.mint();
    const key = await machineKey();
    const first = await ctx.session();
    await first.hello();
    await first.enrollAndSignIn(key, invite!);
    const second = await ctx.session();
    await second.hello();
    await second.signIn(key);
    clock.advance(SWITCH_WINDOW_MS);
    expect(await bounded(first.error)).toEqual({ code: "auth_revoked", message: "quarantined" });
    expect(await bounded(second.error)).toEqual({ code: "auth_revoked", message: "quarantined" });
    expect(ctx.fleet.store.get(key.id)?.state).toBe("quarantined");
    expect(ctx.alerts).toEqual([{ kind: "quarantined", reason: "two_sessions", machine_id: key.id, slot: invite!.slot, invite_id: invite!.id }]);
  });

  it("alerts at each silent session of one key and quarantines it at the SILENT_QUARANTINE-th within a day, so a silent key copy cannot repeat for ever", async () => {
    const clock = new TestClock();
    const ctx = await inProcess({ clock });
    const [invite] = await ctx.mint();
    const key = await machineKey();
    let current = await machineConnection(ctx.fixture, ctx.fleet, { machineSessions: ctx.fleet, enrolment: ctx.fleet, clock });
    await current.hello();
    await current.enrollAndSignIn(key, invite!);
    const [batch] = ctx.fleet.invites.batches();
    await ctx.fleet.invites.confirm(batch!.batch_id, 1, batch!.digest);
    // signed in while pending, the machine reconnects once confirmed (todo 37's AUTH_OK `pending`)
    current.stop();
    await bounded(current.closed);
    current = await machineConnection(ctx.fixture, ctx.fleet, { machineSessions: ctx.fleet, enrolment: ctx.fleet, clock });
    await current.hello();
    await current.signIn(key);
    for (let round = 1; round <= SILENT_QUARANTINE; round++) {
      const alerted = new Promise<void>((resolve) => { const stop = ctx.fleet.onAlert(() => { stop(); resolve(); }); });
      // the session that signed in first stops answering (a key copy whose holder stays silent, or a real machine held back)
      current.blackhole();
      const next = await machineConnection(ctx.fixture, ctx.fleet, { machineSessions: ctx.fleet, enrolment: ctx.fleet, clock });
      await next.hello();
      await next.signIn(key);
      clock.advance(SWITCH_WINDOW_MS);
      await bounded(next.mux.measure());
      await bounded(next.mux.measure());
      clock.advance(SWITCH_PROBE_MS);
      await bounded(alerted);
      if (round < SILENT_QUARANTINE) {
        expect(ctx.fleet.store.get(key.id)?.state).toBe("active");
      } else {
        expect(await bounded(next.error)).toEqual({ code: "auth_revoked", message: "quarantined" });
      }
      current = next;
    }
    expect(ctx.fleet.store.get(key.id)?.state).toBe("quarantined");
    const alert = { machine_id: key.id, slot: 0, invite_id: invite!.id };
    expect(ctx.alerts).toEqual([
      ...Array.from({ length: SILENT_QUARANTINE }, (_, index) => ({ kind: "alert", reason: "silent_session", ...alert, count: index + 1 })),
      { kind: "quarantined", reason: "silent_sessions", ...alert },
    ]);
    // the machine's row carries its alerts, readable before the Fleet screen exists
    expect(fleetRows(ctx.fleet).find((row) => row.machine_id === key.id)?.alerts?.count).toBe(SILENT_QUARANTINE + 1);
  });

  it("counts silent sessions within SILENT_WINDOW_MS only: older ones no longer move a key towards quarantine", async () => {
    const clock = new TestClock();
    const ctx = await inProcess({ clock });
    const [invite] = await ctx.mint();
    const key = await machineKey();
    let current = await machineConnection(ctx.fixture, ctx.fleet, { machineSessions: ctx.fleet, enrolment: ctx.fleet, clock });
    await current.hello();
    await current.enrollAndSignIn(key, invite!);
    const [batch] = ctx.fleet.invites.batches();
    await ctx.fleet.invites.confirm(batch!.batch_id, 1, batch!.digest);
    current.stop();
    await bounded(current.closed);
    current = await machineConnection(ctx.fixture, ctx.fleet, { machineSessions: ctx.fleet, enrolment: ctx.fleet, clock });
    await current.hello();
    await current.signIn(key);
    const silentRound = async () => {
      const alerted = new Promise<void>((resolve) => { const stop = ctx.fleet.onAlert(() => { stop(); resolve(); }); });
      current.blackhole();
      const next = await machineConnection(ctx.fixture, ctx.fleet, { machineSessions: ctx.fleet, enrolment: ctx.fleet, clock });
      await next.hello();
      await next.signIn(key);
      clock.advance(SWITCH_WINDOW_MS);
      await bounded(next.mux.measure());
      await bounded(next.mux.measure());
      clock.advance(SWITCH_PROBE_MS);
      await bounded(alerted);
      current = next;
    };
    for (let round = 1; round < SILENT_QUARANTINE; round++) await silentRound();
    // the controller's wall clock moves past the window (injected; no sleep): the earlier events no longer count
    ctx.advance(SILENT_WINDOW_MS + 1);
    await silentRound();
    expect(ctx.fleet.store.get(key.id)?.state).toBe("active");
    expect((ctx.alerts.at(-1) as { count: number }).count).toBe(1);
  });

  it("keeps an honest machine active when its older session went half-open: the dead one is ended, the newer one works", async () => {
    const clock = new TestClock();
    const ctx = await inProcess({ clock });
    const [invite] = await ctx.mint();
    const key = await machineKey();
    const first = await machineConnection(ctx.fixture, ctx.fleet, { machineSessions: ctx.fleet, enrolment: ctx.fleet, clock });
    await first.hello();
    await first.enrollAndSignIn(key, invite!);
    const [batch] = ctx.fleet.invites.batches();
    await ctx.fleet.invites.confirm(batch!.batch_id, 1, batch!.digest);
    // signed in while pending, the machine reconnects once confirmed (todo 37's AUTH_OK `pending`)
    first.stop();
    await bounded(first.closed);
    const older = await machineConnection(ctx.fixture, ctx.fleet, { machineSessions: ctx.fleet, enrolment: ctx.fleet, clock });
    await older.hello();
    await older.signIn(key);
    // the link dies silently: the controller still counts the old session, the agent dials again
    older.blackhole();
    const newer = await machineConnection(ctx.fixture, ctx.fleet, { machineSessions: ctx.fleet, enrolment: ctx.fleet, clock });
    await newer.hello();
    await newer.signIn(key);
    newer.mux.enqueueControl(advertFrame(testAdvert(["bridge"])));
    await bounded(newer.mux.measure());
    // past the switch window the controller probes both: the newer answers, the half-open one cannot
    clock.advance(SWITCH_WINDOW_MS);
    await bounded(newer.mux.measure());
    await bounded(newer.mux.measure());
    const alerted = new Promise<void>((resolve) => { const stop = ctx.fleet.onAlert(() => { stop(); resolve(); }); });
    clock.advance(SWITCH_PROBE_MS);
    await bounded(alerted);
    expect(ctx.fleet.store.get(key.id)?.state).toBe("active");
    // one session silent while the other answered is told to the operator (todo 31), and quarantines only when it repeats
    expect(ctx.alerts).toEqual([{ kind: "alert", reason: "silent_session", machine_id: key.id, slot: 0, invite_id: invite!.id, count: 1 }]);
    expect(older.session.mux.active).toBe(false);
    expect(newer.session.mux.active).toBe(true);
    expect(ctx.fleet.online(key.id)).toBe(true);
    // the newer session carries pipes
    const opened = await ctx.fleet.openPipe(key.id, "bridge");
    expect(opened.pipe.endpoint).toBe("bridge");
    opened.pipe.reset("cancelled");
  });

  it("still quarantines a real theft: two live connections on one key, both answering past the switch window", async () => {
    const clock = new TestClock();
    const ctx = await inProcess({ clock });
    const [invite] = await ctx.mint();
    const key = await machineKey();
    const owner = await machineConnection(ctx.fixture, ctx.fleet, { machineSessions: ctx.fleet, enrolment: ctx.fleet, clock });
    await owner.hello();
    await owner.enrollAndSignIn(key, invite!);
    const clone = await machineConnection(ctx.fixture, ctx.fleet, { machineSessions: ctx.fleet, enrolment: ctx.fleet, clock });
    await clone.hello();
    await clone.signIn(key);
    clock.advance(SWITCH_WINDOW_MS);
    expect(await bounded(owner.error)).toEqual({ code: "auth_revoked", message: "quarantined" });
    expect(await bounded(clone.error)).toEqual({ code: "auth_revoked", message: "quarantined" });
    expect(ctx.fleet.store.get(key.id)?.state).toBe("quarantined");
    expect(ctx.alerts).toEqual([{ kind: "quarantined", reason: "two_sessions", machine_id: key.id, slot: invite!.slot, invite_id: invite!.id }]);
  });

  it("enrols nothing for a client that holds a copy of the store but not the invite file", async () => {
    const ctx = await inProcess();
    const [invite] = await ctx.mint();
    const copy = JSON.parse(readFileSync(ctx.fleet.store.path, "utf8")) as { invites: { id: string; public_key: string }[] };
    // all a copy gives: the id and the public key; a signature needs the secret's key, which a public key does not give
    expect(copy.invites[0]).toMatchObject({ id: invite!.id });
    for (const form of forms(invite!.secret)) expect(readFileSync(ctx.fleet.store.path, "latin1").includes(form)).toBe(false);
    const key = await machineKey();
    const before = sha(ctx.bytes());
    for (const guess of [copy.invites[0]!.public_key, Buffer.from(copy.invites[0]!.public_key, "hex").toString("base64url")]) {
      const machine = await ctx.session();
      await machine.hello();
      machine.sendEnroll(key, { id: invite!.id, secret: Buffer.from(guess.slice(0, 64), guess.length === 64 ? "hex" : "base64url").subarray(0, 32).toString("base64url") });
      expect(await bounded(machine.error)).toEqual({ code: "auth_failed", message: "signature" });
    }
    expect(sha(ctx.bytes())).toBe(before);
  });

  it("admits 100 machines enrolling at once on 100 sessions, each exactly once, and activates them with one confirmation", async () => {
    const ctx = await inProcess();
    const invites = await ctx.mint(100);
    const keys = await Promise.all(invites.map(() => machineKey()));
    const sessions = await Promise.all(invites.map(() => ctx.session()));
    await Promise.all(sessions.map((machine) => machine.hello()));
    const answers = await Promise.all(sessions.map(async (machine, index) => { machine.sendEnroll(keys[index]!, invites[index]!); return (await bounded(machine.enrolled, 60_000)).machine_id; }));
    expect(answers).toEqual(keys.map((key) => key.id));
    expect(ctx.fleet.store.machines()).toHaveLength(100);
    const [batch] = ctx.fleet.invites.batches();
    expect(batch!.count).toBe(100);
    await ctx.fleet.invites.confirm(batch!.batch_id, 100, batch!.digest);
    expect(fleetRows(ctx.fleet).filter((row) => row.state === "active")).toHaveLength(100);
  }, 120_000);

  it("lists an invite never presented as unused", async () => {
    const ctx = await inProcess();
    await ctx.mint(2);
    expect(ctx.fleet.invites.list().map((row) => row.state)).toEqual(["unused", "unused"]);
  });
});

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

describe("enrolment on a controller's relay link", () => {
  /** A controller on a local Bun relay with its relay on; `port` and `now` let a restart reuse its port and move its clock. */
  async function controller(stateDir: string, relayPort: number, options: { port?: number; now?: () => number } = {}) {
    turnFleetOn(stateDir);
    const fleet = new Fleet({ stateDir, tokenConfigured: true, wall: options.now ?? (() => T0) });
    const service = new RelayService({
      stateDir, relay: "wss://relay.example", connect: (url) => new WebSocket(url.replace("wss://relay.example", `ws://127.0.0.1:${relayPort}`)),
      regionalRelays: [], ovisRelays: [], fleet,
    });
    const app = createServer({ port: options.port ?? 0, hostname: "127.0.0.1", stateDir, token: FLEET_TEST_TOKEN, tailscaleOwner: null, sidecar: false, relay: service });
    const stop = async () => { await service.shutdown(); await app.stop(); };
    cleanups.push(stop);
    const base = `http://127.0.0.1:${app.port}`;
    const write = { ...FLEET_TEST_AUTH, origin: base, "x-herdr-update": "1", "content-type": "application/json" };
    expect((await fetch(`${base}/api/relay/start`, { method: "POST", headers: { ...FLEET_TEST_AUTH, origin: base, "x-herdr-update": "1" } })).status).toBe(200);
    return {
      fleet, service, app, base, stop, identity: loadRelayIdentity(stateDir),
      mint: async (body: unknown) => { const answer = await fetch(`${base}/api/fleet/invites`, { method: "POST", headers: write, body: JSON.stringify(body) }); expect(answer.status).toBe(201); return (await answer.json()) as { batch_id: string; invites: Invite[] }; },
      get: async <T>(path: string): Promise<T> => (await (await fetch(`${base}${path}`, { headers: FLEET_TEST_AUTH })).json()) as T,
      confirm: (batchId: string, body: unknown) => fetch(`${base}/api/fleet/batches/${batchId}/confirm`, { method: "POST", headers: write, body: JSON.stringify(body) }),
    };
  }

  it("redeems an invite minted before a restart after it, confirms its batch, and refuses one whose expiry passed meanwhile", async () => {
    const stateDir = folder("fleet-enroll-relay-");
    const allow = { async limit() { return { success: true }; } };
    const relay = startBunRelay({ port: 0, limits: { maxClientsPerServer: 12, maxSocketsPerAddress: 512 }, limiters: { perAddress: allow, global: allow } });
    cleanups.push(() => relay.stop());
    const logged: string[] = [];
    for (const method of ["log", "error", "warn", "info"] as const) {
      const spy = spyOn(console, method).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(" ")); });
      cleanups.push(() => spy.mockRestore());
    }
    const first = await controller(stateDir, relay.port);
    const port = first.app.port;
    const minted = await first.mint({ count: 1 });
    const short = await first.mint({ count: 1, life_s: 60 });
    expect(minted.invites[0]!.controller).toMatchObject({ server_id: first.identity.server_id, server_public_key: first.identity.public_key, relay: "wss://relay.example" });
    await first.stop();

    // a new server on the same state folder and port, its clock where the short invite has not expired yet
    let now = T0;
    const second = await controller(stateDir, relay.port, { port, now: () => now });
    expect(second.app.port).toBe(port);
    const key = await machineKey();
    const machine = await machineClient(await viaRelay(relay.port, second.identity.server_id), second.identity.public_key, second.identity.server_id);
    await machine.enroll(key, minted.invites[0]!);
    expect(await bounded(machine.enrolled)).toEqual({ machine_id: key.id });
    await machine.signIn(key);
    expect((await bounded(machine.admitted)).machine_id).toBe(key.id);
    const rows = await second.get<{ machines: { machine_id: string; state: string; batch_id: string; fingerprint: string }[] }>("/api/fleet/machines");
    expect(rows.machines).toEqual([expect.objectContaining({ machine_id: key.id, state: "pending", batch_id: minted.batch_id, fingerprint: key.id.match(/.{4}/g)!.join(" ") })]);
    const { batches } = await second.get<{ batches: { batch_id: string; count: number; digest: string }[] }>("/api/fleet/batches");
    expect(batches.map((batch) => [batch.batch_id, batch.count])).toEqual([[minted.batch_id, 1]]);
    expect((await second.confirm(minted.batch_id, { count: 1, digest: batches[0]!.digest })).status).toBe(200);
    expect(second.fleet.store.get(key.id)?.state).toBe("active");

    // the confirmed machine is usable: its advert reaches the controller and its forward carries a pipe
    const echo = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data(socket, data) { socket.write(data); } } });
    cleanups.push(() => echo.stop(true));
    const usable = await machineClient(await viaRelay(relay.port, second.identity.server_id), second.identity.public_key, second.identity.server_id, (pipe) => pipeToTarget(pipe, echo.port));
    machine.channel.close();
    await usable.signIn(key);
    await bounded(usable.admitted);
    await usable.advertise(testAdvert(["bridge"]));
    const forward = await bounded(second.fleet.forwardReady(key.id));
    const head = `GET / HTTP/1.1\r\nAuthorization: Bearer ${testAdvert().bridge_token!}\r\n\r\n`;
    const echoed = await bounded(new Promise<string>((resolve) => {
      const socket = connect({ host: "127.0.0.1", port: forward!.port });
      let text = "";
      socket.on("data", (chunk) => { text += chunk.toString(); if (text.length >= head.length + 5) { resolve(text); socket.destroy(); } });
      socket.on("error", () => {});
      socket.once("connect", () => socket.write(`${head}hello`));
    }));
    expect(echoed).toBe(`${head}hello`);

    // the short invite: past its expiry on the controller's clock, refused, listed expired, the store unchanged
    now = T0 + 61_000;
    const before = sha(readFileSync(second.fleet.store.path));
    const late = await machineClient(await viaRelay(relay.port, second.identity.server_id), second.identity.public_key, second.identity.server_id);
    await late.enroll(await machineKey(), short.invites[0]!);
    expect(await bounded(late.error)).toEqual({ code: "auth_failed", message: "expired" });
    expect((await second.get<{ invites: { id: string; state: string }[] }>("/api/fleet/invites")).invites.find((row) => row.id === short.invites[0]!.id)?.state).toBe("expired");
    expect(sha(readFileSync(second.fleet.store.path))).toBe(before);

    // no secret anywhere but the mint's answers: not in the state folder, the logs or any GET
    const reads = await Promise.all(["/api/fleet/invites", "/api/fleet/batches", "/api/fleet/machines"].map(async (path) => (await fetch(`${second.base}${path}`, { headers: FLEET_TEST_AUTH })).text()));
    const files = readdirSync(stateDir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => readFileSync(join(entry.parentPath, entry.name), "latin1"));
    for (const invite of [...minted.invites, ...short.invites]) {
      for (const form of forms(invite.secret)) {
        for (const text of [...files, ...reads, logged.join("\n")]) expect(text.includes(form)).toBe(false);
      }
    }
  }, 90_000);

});
