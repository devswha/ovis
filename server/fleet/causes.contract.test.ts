/**
 * Why a fleet machine is not usable (shared/fleet-cause.ts), as `GET /api/fleet/machines` says it: each cause comes
 * from one scripted situation on live machine sessions of a server started with `port: 0` and a mkdtemp state folder,
 * the route's callers and what it never answers, and every error of the route. Assertions are on the codes, never on
 * a sentence.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FLEET_CAUSE_SENTENCE, FLEET_CAUSES, FLEET_ROUTE_ERRORS, isFleetCause } from "../../shared/fleet-cause.ts";
import type { FleetCause, FleetMachineRow } from "../../shared/fleet-cause.ts";
import { RelayService } from "../relay/service.ts";
import { bounded, relayFixture } from "../relay/test-helpers.ts";
import { fleetRows } from "./causes.ts";
import { Fleet } from "./sessions.ts";
import { FleetStore } from "./store.ts";
import { advertFrame, machineConnection, machineKey, testAdvert } from "./test-helpers.ts";
import { FLEET_TEST_AUTH, FLEET_TEST_TOKEN } from "./test-server.ts";
import type { MachineKey } from "./test-helpers.ts";
import type { PipeAdvert } from "./mux-ext.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const START = 1_800_000_000_000;
/** Every cause or warning a row showed in this file, for the last test. */
const shown = new Set<string>();

async function controller(options: { max?: number; token?: string } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "fleet-causes-"));
  cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
  const clock = { now: START };
  const store = new FleetStore({ stateDir, max: 100 });
  const fleet = new Fleet({ stateDir, tokenConfigured: true, store, ...(options.max ? { max: options.max } : {}), wall: () => clock.now });
  const service = new RelayService({ stateDir, fleet, regionalRelays: [], ovisRelays: [] });
  const fixture = relayFixture(false, { stateDir, relay: service, token: options.token ?? FLEET_TEST_TOKEN });
  cleanups.push(() => { fixture.close(); return service.shutdown(); });
  const base = `http://127.0.0.1:${fixture.app.port}`;
  return {
    stateDir, store, fleet, fixture, clock, base,
    async enrol(state: "active" | "pending" | "quarantined" | "revoked" = "active", name = "vm"): Promise<MachineKey> {
      const key = await machineKey();
      store.add({ machine_id: key.id, public_key: key.spki, name });
      if (state !== "pending") store.setState(key.id, "active");
      if (state === "quarantined" || state === "revoked") store.setState(key.id, state);
      return key;
    },
    /** The route's rows (as the HTTP answer carries them), by machine id. */
    async rows(headers: Record<string, string> = FLEET_TEST_AUTH): Promise<Map<string, FleetMachineRow>> {
      const response = await fetch(`${base}/api/fleet/machines`, { headers });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { machines: FleetMachineRow[] };
      for (const row of body.machines) { if (row.cause) shown.add(row.cause); for (const warning of row.warnings) shown.add(warning); }
      return new Map(body.machines.map((row) => [row.machine_id, row]));
    },
  };
}
type Controller = Awaited<ReturnType<typeof controller>>;

/** An advert whose clock agrees with the controller's. */
const advertAtStart = (): PipeAdvert => ({ ...testAdvert(), now: Math.floor(START / 1000) });

/** A machine signed in with `advert` read by the controller. */
async function signedIn(ctx: Controller, key: MachineKey, advert: PipeAdvert = advertAtStart()) {
  const connection = await machineConnection(ctx.fixture, ctx.fleet, { machineSessions: ctx.fleet });
  await connection.hello();
  await connection.signIn(key);
  connection.mux.enqueueControl(advertFrame(advert));
  await bounded(connection.mux.measure());
  return connection;
}

const withHealth = (health: PipeAdvert["health"], now?: number): PipeAdvert => ({ ...advertAtStart(), health, ...(now === undefined ? {} : { now }) });

describe("each cause from one scripted situation", () => {
  it("offline: an active machine with no session", async () => {
    const ctx = await controller();
    const key = await ctx.enrol();
    expect((await ctx.rows()).get(key.id)).toMatchObject({ state: "active", online: false, cause: "offline", warnings: [], route: null, last_seen: null });
  });

  it("reachable and healthy: no cause, no warning", async () => {
    const ctx = await controller();
    const key = await ctx.enrol();
    const connection = await signedIn(ctx, key);
    // through the relay's in-process carrier: the route says so, and it is seen now
    expect((await ctx.rows()).get(key.id)).toMatchObject({ state: "active", online: true, cause: null, warnings: [], route: "relay", last_seen: START });
    const gone = new Promise<void>((resolve) => { const stop = ctx.fleet.onSession((id) => { if (id === key.id && !ctx.fleet.online(key.id)) { stop(); resolve(); } }); });
    connection.stop();
    await bounded(gone);
    // gone: no route, and last seen when its session ended
    ctx.clock.now = START + 60_000;
    expect((await ctx.rows()).get(key.id)).toMatchObject({ online: false, cause: "offline", route: null, last_seen: START });
  });

  it("reconnecting: a confirmed machine whose pending session drains, until it signs in again", async () => {
    const ctx = await controller();
    const key = await ctx.enrol("pending");
    const pending = await signedIn(ctx, key);
    expect((await ctx.rows()).get(key.id)).toMatchObject({ state: "pending", online: true, cause: "pending_confirmation" });
    ctx.store.setState(key.id, "active");
    expect((await ctx.rows()).get(key.id)).toMatchObject({ state: "active", online: false, cause: "reconnecting", route: null });
    const again = await signedIn(ctx, key);
    expect((await ctx.rows()).get(key.id)).toMatchObject({ online: true, cause: null });
    pending.stop();
    again.stop();
  });

  it("pending_confirmation, quarantined and revoked: the store's state, with the time it changed", async () => {
    const ctx = await controller();
    const pending = await ctx.enrol("pending");
    const quarantined = await ctx.enrol("quarantined");
    const revoked = await ctx.enrol("revoked");
    const rows = await ctx.rows();
    expect(rows.get(pending.id)).toMatchObject({ state: "pending", online: false, cause: "pending_confirmation" });
    expect(rows.get(quarantined.id)).toMatchObject({ state: "quarantined", online: false, cause: "quarantined" });
    expect(rows.get(revoked.id)).toMatchObject({ state: "revoked", online: false, cause: "revoked" });
    for (const row of rows.values()) expect(row.since).toBe(ctx.store.get(row.machine_id)!.updated_at);
  });

  it("runtime_down and bridge_down: the health the machine's advert reports", async () => {
    const ctx = await controller();
    const [runtime, bridge, both, fine] = [await ctx.enrol(), await ctx.enrol(), await ctx.enrol(), await ctx.enrol()];
    const connections = [
      await signedIn(ctx, runtime, withHealth({ runtime: "down", bridge: "up" })),
      await signedIn(ctx, bridge, withHealth({ runtime: "up", bridge: "down" })),
      await signedIn(ctx, both, withHealth({ runtime: "down", bridge: "down" })),
      await signedIn(ctx, fine, withHealth({ runtime: "up", bridge: "up" })),
    ];
    const rows = await ctx.rows();
    expect(rows.get(runtime.id)).toMatchObject({ online: true, cause: "runtime_down" });
    expect(rows.get(bridge.id)).toMatchObject({ online: true, cause: "bridge_down" });
    expect(rows.get(both.id)).toMatchObject({ online: true, cause: "runtime_down" });
    expect(rows.get(fine.id)).toMatchObject({ online: true, cause: null });
    for (const connection of connections) connection.stop();
  });

  it("follows the advert: a bridge that comes back clears the cause", async () => {
    const ctx = await controller();
    const key = await ctx.enrol();
    const connection = await signedIn(ctx, key, withHealth({ runtime: "up", bridge: "down" }));
    expect((await ctx.rows()).get(key.id)?.cause).toBe("bridge_down");
    connection.mux.enqueueControl(advertFrame(withHealth({ runtime: "up", bridge: "up" })));
    await bounded(connection.mux.measure());
    expect((await ctx.rows()).get(key.id)?.cause).toBeNull();
    connection.stop();
  });

  it("clock_skew: a warning past 5 minutes either way, never a refusal", async () => {
    const ctx = await controller();
    const [ahead, behind, near] = [await ctx.enrol(), await ctx.enrol(), await ctx.enrol()];
    const seconds = Math.floor(START / 1000);
    const connections = [
      await signedIn(ctx, ahead, withHealth({ runtime: "up", bridge: "up" }, seconds + 10 * 60)),
      await signedIn(ctx, behind, withHealth({ runtime: "up", bridge: "up" }, seconds - 301)),
      await signedIn(ctx, near, withHealth({ runtime: "up", bridge: "up" }, seconds + 299)),
    ];
    const rows = await ctx.rows();
    for (const key of [ahead, behind]) expect(rows.get(key.id)).toMatchObject({ online: true, cause: null, warnings: ["clock_skew"] });
    expect(rows.get(near.id)).toMatchObject({ online: true, cause: null, warnings: [] });
    expect(ctx.fleet.sessions).toBe(3);
    for (const connection of connections) connection.stop();
  });

  it("clock_skew: judged when the advert arrives, so an old advert from a right clock never warns", async () => {
    const ctx = await controller();
    const [right, wrong] = [await ctx.enrol(), await ctx.enrol()];
    const seconds = Math.floor(START / 1000);
    const good = await signedIn(ctx, right);
    const off = await signedIn(ctx, wrong, withHealth({ runtime: "up", bridge: "up" }, seconds + 10 * 60));
    let rows = await ctx.rows();
    expect(rows.get(right.id)?.warnings).toEqual([]);
    expect(rows.get(wrong.id)?.warnings).toEqual(["clock_skew"]);
    // an hour on the controller's clock with no new advert: nothing about either clock changed
    ctx.clock.now = START + 60 * 60_000;
    rows = await ctx.rows();
    expect(rows.get(right.id)?.warnings).toEqual([]);
    expect(rows.get(wrong.id)?.warnings).toEqual(["clock_skew"]);
    // the wrong clock is put right: its next advert clears the warning
    off.mux.enqueueControl(advertFrame(withHealth({ runtime: "up", bridge: "up" }, Math.floor(ctx.clock.now / 1000))));
    await bounded(off.mux.measure());
    expect((await ctx.rows()).get(wrong.id)?.warnings).toEqual([]);
    good.stop();
    off.stop();
  });

  it("controller_limit: a machine the controller had no place for, shown until it gets in", async () => {
    const ctx = await controller({ max: 1 });
    const [first, second] = [await ctx.enrol(), await ctx.enrol()];
    const holder = await signedIn(ctx, first);
    const refused = await machineConnection(ctx.fixture, ctx.fleet, { machineSessions: ctx.fleet });
    await refused.hello();
    await refused.sendAuth(second);
    expect(await bounded(refused.error)).toEqual({ code: "resource_exhausted", message: "controller_limit" });
    const rows = await ctx.rows();
    expect(rows.get(second.id)).toMatchObject({ state: "active", online: false, cause: "controller_limit" });
    expect(rows.get(first.id)).toMatchObject({ online: true, cause: null });
    holder.stop();
    const next = await signedIn(ctx, second);
    expect((await ctx.rows()).get(second.id)).toMatchObject({ online: true, cause: null });
    next.stop();
  });

  it("controller_limit: a machine that never got in is known only by the key it proved", async () => {
    const ctx = await controller({ max: 1 });
    const holder = await signedIn(ctx, await ctx.enrol());
    const stranger = await machineKey();
    const refused = await machineConnection(ctx.fixture, ctx.fleet, { machineSessions: ctx.fleet });
    await refused.hello();
    await refused.sendAuth(stranger);
    expect((await bounded(refused.error)).message).toBe("unknown");
    expect(Array.from((await ctx.rows()).keys())).not.toContain(stranger.id);
    holder.stop();
  });

  it("controller_limit: a signed-in machine the link ends for a smaller room shows it, as its link does on a smaller sync", async () => {
    const ctx = await controller();
    const key = await ctx.enrol();
    const connection = await machineConnection(ctx.fixture, ctx.fleet, { machineSessions: ctx.fleet });
    await connection.hello();
    await connection.signIn(key);
    connection.mux.enqueueControl(advertFrame(advertAtStart()));
    await bounded(connection.mux.measure());
    expect((await ctx.rows()).get(key.id)).toMatchObject({ online: true, cause: null });
    connection.session.closeMachine("resource_exhausted", "controller_limit");
    expect(await bounded(connection.error)).toEqual({ code: "resource_exhausted", message: "controller_limit" });
    expect((await ctx.rows()).get(key.id)).toMatchObject({ online: false, cause: "controller_limit" });
  });

  it("the causes with no source in this controller yet are set through `report`, and cleared the same way", async () => {
    const ctx = await controller();
    const key = await ctx.enrol();
    const set: FleetCause[] = ["relay_limit", "relay_unreachable", "version_mismatch", "restored"];
    for (const cause of set) {
      ctx.fleet.report(key.id, cause);
      expect((await ctx.rows()).get(key.id)).toMatchObject({ online: false, cause });
    }
    ctx.fleet.report(key.id, null);
    expect((await ctx.rows()).get(key.id)).toMatchObject({ online: false, cause: "offline" });
  });

  it("update_failed and disk_full: warnings on a machine that stays connected, causes on one that is not", async () => {
    const ctx = await controller();
    const key = await ctx.enrol();
    const connection = await signedIn(ctx, key);
    for (const cause of ["update_failed", "disk_full"] as const) {
      ctx.fleet.report(key.id, cause);
      expect((await ctx.rows()).get(key.id)).toMatchObject({ online: true, cause: null, warnings: [cause] });
    }
    connection.stop();
    expect((await ctx.rows()).get(key.id)).toMatchObject({ online: false, cause: "disk_full" });
  });

  it("a stopping cause that was set ends when the machine signs in; a warning stays until it is cleared", async () => {
    const ctx = await controller();
    const key = await ctx.enrol();
    ctx.fleet.report(key.id, "relay_limit");
    const connection = await signedIn(ctx, key);
    expect((await ctx.rows()).get(key.id)).toMatchObject({ online: true, cause: null, warnings: [] });
    ctx.fleet.report(key.id, "update_failed");
    connection.stop();
    const again = await signedIn(ctx, key);
    expect((await ctx.rows()).get(key.id)).toMatchObject({ online: true, cause: null, warnings: ["update_failed"] });
    again.stop();
  });

});

describe("the rows", () => {
  it("say since when: a session's start or end, else the controller's own start", async () => {
    const ctx = await controller();
    const key = await ctx.enrol();
    expect((await ctx.rows()).get(key.id)?.since).toBe(START);
    ctx.clock.now = START + 60_000;
    const connection = await signedIn(ctx, key);
    expect((await ctx.rows()).get(key.id)?.since).toBe(START + 60_000);
    ctx.clock.now = START + 120_000;
    connection.stop();
    expect((await ctx.rows()).get(key.id)).toMatchObject({ online: false, cause: "offline", since: START + 120_000 });
  });

  it("say since when the advert's health changed, not since the sign-in, and keep it while the health stays", async () => {
    const ctx = await controller();
    const key = await ctx.enrol();
    const healthy = withHealth({ runtime: "up", bridge: "up" });
    const connection = await signedIn(ctx, key, healthy);
    ctx.clock.now = START + 29_000;
    connection.mux.enqueueControl(advertFrame(withHealth({ runtime: "up", bridge: "down" })));
    await bounded(connection.mux.measure());
    expect((await ctx.rows()).get(key.id)).toMatchObject({ cause: "bridge_down", since: START + 29_000 });
    ctx.clock.now = START + 90_000;
    connection.mux.enqueueControl(advertFrame(withHealth({ runtime: "up", bridge: "down" })));
    await bounded(connection.mux.measure());
    expect((await ctx.rows()).get(key.id)).toMatchObject({ cause: "bridge_down", since: START + 29_000 });
    ctx.clock.now = START + 120_000;
    connection.mux.enqueueControl(advertFrame(withHealth({ runtime: "down", bridge: "down" })));
    await bounded(connection.mux.measure());
    expect((await ctx.rows()).get(key.id)).toMatchObject({ cause: "runtime_down", since: START + 120_000 });
    connection.stop();
  });

  it("show a signed-in machine whose advert has not come as connected with no cause: the controller knows nothing more", async () => {
    const ctx = await controller();
    const key = await ctx.enrol();
    const connection = await machineConnection(ctx.fixture, ctx.fleet, { machineSessions: ctx.fleet });
    await connection.hello();
    await connection.signIn(key);
    expect((await ctx.rows()).get(key.id)).toMatchObject({ online: true, cause: null, warnings: [] });
    expect(ctx.fleet.advert(key.id)).toBeUndefined();
    connection.stop();
  });

  it("list every machine of the store with its state and name, and an empty store gives an empty list", async () => {
    const ctx = await controller();
    expect(await (await fetch(`${ctx.base}/api/fleet/machines`, { headers: FLEET_TEST_AUTH })).json()).toEqual({ machines: [] });
    const key = await ctx.enrol("active", "build-1");
    const rows = fleetRows(ctx.fleet);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ machine_id: key.id, name: "build-1", state: "active", slot: null });
  });

  it("carry a cause that is in the closed set, and its sentence in English beside it", async () => {
    const ctx = await controller();
    await ctx.enrol("pending");
    await ctx.enrol("revoked");
    for (const row of (await ctx.rows()).values()) {
      expect(isFleetCause(row.cause)).toBe(true);
      expect(typeof row.message).toBe("string");
    }
  });
});

describe("GET /api/fleet/machines: what it never answers (who may ask: routes-access.contract.test.ts)", () => {
  it("never answers a key, a token, a bearer, a forward's port or socket path, or anything of an invite", async () => {
    const ctx = await controller();
    const key = await ctx.enrol("active", "vm");
    const other = await ctx.enrol("pending", "other");
    const advert = advertAtStart();
    const connection = await signedIn(ctx, key, advert);
    ctx.fleet.start();
    const forward = await ctx.fleet.forwardReady(key.id);
    expect(forward?.port).toBeGreaterThan(0);
    const response = await fetch(`${ctx.base}/api/fleet/machines`, { headers: FLEET_TEST_AUTH });
    const text = await response.text();
    for (const secret of [key.spki, other.spki, advert.bridge_token!, advert.native_bearer!, String(forward!.port), forward!.socketPath ?? "no-socket", ctx.stateDir]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toMatch(/bridge_token|native_bearer|public_key|socket|forward|secret|invite|bearer|boot_id|runtime_id/);
    const fields = Object.keys((JSON.parse(text) as { machines: Record<string, unknown>[] }).machines[0]!).sort();
    expect(fields).toEqual(["batch_id", "cause", "fingerprint", "last_seen", "machine_id", "message", "name", "online", "route", "since", "slot", "state", "warnings"]);
    connection.stop();
    await ctx.fleet.close();
  });

  it("writes nothing: the state folder holds only what it held", async () => {
    const ctx = await controller();
    await ctx.enrol();
    const before = (name: string) => readFileSync(join(ctx.stateDir, "fleet", name));
    const files = readdirSync(join(ctx.stateDir, "fleet")).sort();
    const stored = before("machines.json");
    await ctx.rows();
    await ctx.rows();
    expect(readdirSync(join(ctx.stateDir, "fleet")).sort()).toEqual(files);
    expect(before("machines.json").equals(stored)).toBe(true);
  });

  it("with an empty store answers an empty list and creates nothing", async () => {
    const ctx = await controller();
    const response = await fetch(`${ctx.base}/api/fleet/machines`, { headers: FLEET_TEST_AUTH });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ machines: [] });
    expect(() => readdirSync(join(ctx.stateDir, "fleet"))).toThrow();
  });
});

describe("the errors of the fleet routes", () => {
  it("answer a code of the closed list, in the uniform error body", async () => {
    const ctx = await controller();
    const headers = { ...FLEET_TEST_AUTH, origin: ctx.base, "x-herdr-machine": "1", "content-type": "application/json" };
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const response = await fetch(`${ctx.base}/api/fleet/machines`, { method, headers, body: method === "DELETE" ? undefined : "{}" });
      const body = (await response.json()) as { error: { code: string; message: string } };
      expect(response.status).toBe(FLEET_ROUTE_ERRORS.method_not_allowed);
      expect(body.error.code).toBe("method_not_allowed");
      expect(response.headers.get("allow")).toBe("GET");
    }
  });

  it("answer fleet_store_unreadable for a store file that was refused, and change nothing", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "fleet-causes-bad-"));
    cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
    const broken = new FleetStore({ stateDir, max: 100 });
    const key = await machineKey();
    broken.add({ machine_id: key.id, public_key: key.spki });
    await Bun.write(join(stateDir, "fleet", "machines.json"), "{ not json");
    const fleet = new Fleet({ stateDir, tokenConfigured: true });
    const service = new RelayService({ stateDir, fleet, regionalRelays: [], ovisRelays: [] });
    const fixture = relayFixture(false, { stateDir, relay: service, token: FLEET_TEST_TOKEN });
    cleanups.push(() => { fixture.close(); return service.shutdown(); });
    const response = await fetch(`http://127.0.0.1:${fixture.app.port}/api/fleet/machines`, { headers: FLEET_TEST_AUTH });
    const body = (await response.json()) as { error: { code: string } };
    expect([response.status, body.error.code]).toEqual([FLEET_ROUTE_ERRORS.fleet_store_unreadable, "fleet_store_unreadable"]);
    expect(readFileSync(join(stateDir, "fleet", "machines.json"), "utf8")).toBe("{ not json");
  });
});

describe("a fleet held for want of a token (server/fleet/gate.ts)", () => {
  it("fleet_token_required: every machine but a revoked or quarantined one, and the read says the fleet's state", async () => {
    const ctx = await controller({ token: "" });
    // a held store takes no write (server/fleet/gate.ts): the machines are stored as while a token was set
    ctx.fleet.setTokenConfigured(true);
    const active = await ctx.enrol("active");
    const pending = await ctx.enrol("pending");
    const revoked = await ctx.enrol("revoked");
    const quarantined = await ctx.enrol("quarantined");
    ctx.fleet.setTokenConfigured(false);
    const rows = await ctx.rows({});
    expect([active, pending, revoked, quarantined].map((key) => rows.get(key.id)?.cause)).toEqual(["fleet_token_required", "fleet_token_required", "revoked", "quarantined"]);
    expect(rows.get(active.id)?.message).toBe(FLEET_CAUSE_SENTENCE.fleet_token_required);
    expect(((await (await fetch(`${ctx.base}/api/fleet/machines`)).json()) as { fleet_state?: string }).fleet_state).toBe("fleet_token_required");
  });
});

describe("the whole closed set", () => {
  it("was shown by a row in this file's situations, every cause and warning", () => {
    expect([...FLEET_CAUSES].filter((cause) => !shown.has(cause))).toEqual([]);
  });
});
