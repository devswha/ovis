/**
 * The fleet depends on a token (todo 60 of the relay-fleet plan, server/fleet/gate.ts): one table per way in, the
 * outcome each input gets, on servers started with `port: 0` and a mkdtemp state folder. With no token configured every
 * fleet write and both fleet sign-in paths answer `fleet_token_required` and nothing under `<stateDir>/fleet/` changes;
 * with a token the access rule of server/access.ts decides as it always did; a server whose fleet was never turned on
 * answers as before.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bounded, relayConnection, relayDevice, relayFixture } from "../relay/test-helpers.ts";
import { exportPublicKey, generateKeyPair } from "../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../shared/relay-server-proof.ts";
import { FLEET_EXIT, runFleet } from "../../scripts/plugin-fleet.ts";
import type { FleetCommandIo } from "../../scripts/plugin-fleet.ts";
import { runFleetCli } from "./cli.ts";
import { mintRequest } from "./invites.ts";
import { machineConnection, machineKey, signEnroll, turnFleetOn } from "./test-helpers.ts";
import type { InviteSecret, MachineKey } from "./test-helpers.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const TOKEN = "fleet-gate-token";
const controllerKeys = generateKeyPair();
const CONTROLLER = { server_id: deriveServerId(controllerKeys.publicKey), server_public_key: exportPublicKey(controllerKeys.publicKey), relay: "wss://relay.ovis.example", direct: [] as string[] };
const WRITE = { "x-herdr-update": "1", "content-type": "application/json" };

/** Every file under `<stateDir>/fleet/` with the SHA-256 of its bytes (a folder as itself). */
function fleetHashes(stateDir: string): Record<string, string> {
  const root = join(stateDir, "fleet");
  const out: Record<string, string> = {};
  if (!existsSync(root)) return out;
  for (const name of readdirSync(root, { recursive: true }) as string[]) {
    const path = join(root, name);
    out[name] = statSync(path).isDirectory() ? "dir" : createHash("sha256").update(readFileSync(path)).digest("hex");
  }
  return out;
}

/** A server on `stateDir` (made when not given) with `token`; its relay names CONTROLLER. Stopped at the test's end. */
function server(token: string, stateDir?: string) {
  const dir = stateDir ?? mkdtempSync(join(tmpdir(), "fleet-gate-"));
  if (!stateDir) cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const fixture = relayFixture(false, { token, stateDir: dir, machines: false });
  const relay = fixture.app.context.services.relay;
  const describeSpy = spyOn(relay, "fleetController").mockResolvedValue(CONTROLLER);
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    describeSpy.mockRestore();
    for (const close of fixture.closes) close();
    void fixture.app.stop();
  };
  cleanups.push(stop);
  const base = `http://127.0.0.1:${fixture.app.port}`;
  return {
    fixture, relay, base, stateDir: dir, stop,
    write: (path: string, body: string, headers: Record<string, string> = {}, method = "POST") =>
      fetch(`${base}${path}`, { method, headers: { ...headers, ...WRITE, origin: base }, ...(method === "DELETE" ? {} : { body }) }),
    read: (path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { headers }),
  };
}
type Server = ReturnType<typeof server>;

const code = async (answer: Response) => [answer.status, answer.status >= 400 ? ((await answer.json()) as { error: { code: string } }).error.code : "ok"];

/**
 * A fleet turned on whose one invite was redeemed by `key` (its batch waits for confirmation), set up through the fleet's
 * own code, as a token-holding owner would have: the state a tokenless restart then finds.
 */
async function enrolled(ctx: Server, key: MachineKey): Promise<{ batchId: string; confirmBody: string; invite: InviteSecret; minted: Awaited<ReturnType<typeof mintInvites>> }> {
  turnFleetOn(ctx.stateDir);
  // the store of a held fleet takes no write: the state is made as it was while a token was set
  const held = ctx.relay.fleet.held();
  if (held) ctx.relay.fleet.setTokenConfigured(true);
  try {
    const minted = await mintInvites(ctx);
    const binding = new Uint8Array(32).fill(7);
    expect(await ctx.relay.fleet.invites.enroll(signEnroll(key, minted.invites[0]!, binding), { binding })).toEqual({ machineId: key.id });
    const [batch] = ctx.relay.fleet.invites.batches();
    return { batchId: minted.batch_id, confirmBody: JSON.stringify({ count: 1, digest: batch!.digest }), invite: minted.invites[1]!, minted };
  } finally {
    if (held) ctx.relay.fleet.setTokenConfigured(false);
  }
}
const mintInvites = (ctx: Server) => ctx.relay.fleet.invites.mint(mintRequest({ count: 3 }), async () => CONTROLLER);

describe("with no token configured", () => {
  it("answers fleet_token_required to every fleet write from this PC, and writes nothing under fleet/", async () => {
    const ctx = server("");
    const key = await machineKey();
    const { batchId, confirmBody } = await enrolled(ctx, key);
    const before = fleetHashes(ctx.stateDir);
    const table: [string, () => Promise<Response>][] = [
      ["POST /api/fleet/enable", () => ctx.write("/api/fleet/enable", "{}")],
      ["POST /api/fleet/invites", () => ctx.write("/api/fleet/invites", "{\"count\":1}")],
      ["POST /api/fleet/batches/<id>/confirm", () => ctx.write(`/api/fleet/batches/${batchId}/confirm`, confirmBody)],
      ["DELETE /api/fleet/machines/<id>", () => ctx.write(`/api/fleet/machines/${key.id}`, "", {}, "DELETE")],
    ];
    for (const [route, call] of table) expect(await code(await call()), route).toEqual([409, "fleet_token_required"]);
    expect(fleetHashes(ctx.stateDir)).toEqual(before);
    expect(ctx.relay.fleet.store.get(key.id)?.state).toBe("pending");
  });

  it("answers the same through the relay to a device paired to drive", async () => {
    const ctx = server("");
    const key = await machineKey();
    const { batchId, confirmBody } = await enrolled(ctx, key);
    const before = fleetHashes(ctx.stateDir);
    const link = await relayConnection(ctx.fixture);
    await link.auth(await relayDevice(ctx.fixture, "drive"));
    const request = link.open(`/api/fleet/batches/${batchId}/confirm`, { method: "POST", headers: [["x-herdr-update", "1"], ["content-type", "application/json"]], body: "stream" });
    void request.stream.sendBody(new Response(confirmBody).body ?? new ReadableStream()).catch(() => {});
    expect(await code(await request.response)).toEqual([409, "fleet_token_required"]);
    expect(fleetHashes(ctx.stateDir)).toEqual(before);
  });

  it("ends a machine-key AUTH and an ENROLL with fleet_token_required, the fleet store byte-identical", async () => {
    // set up with a token, then the same state folder served without one: the controller restarted without its token
    const first = server(TOKEN);
    const key = await machineKey();
    const { invite } = await enrolled(first, key);
    first.relay.fleet.store.setState(key.id, "active");
    // a second machine enrolled and left pending: a held fleet answers it the same, before anything about pending
    const pending = await machineKey();
    const binding = new Uint8Array(32).fill(9);
    expect(await first.relay.fleet.invites.enroll(signEnroll(pending, invite, binding), { binding })).toEqual({ machineId: pending.id });
    const spare = (await mintInvites(first)).invites[0]!;
    first.stop();
    const ctx = server("", first.stateDir);
    const before = fleetHashes(ctx.stateDir);

    const pendingSignIn = await machineConnection(ctx.fixture, ctx.relay.fleet, { machineSessions: ctx.relay.fleet, enrolment: ctx.relay.fleet });
    await pendingSignIn.hello();
    await pendingSignIn.sendAuth(pending);
    expect(await bounded(pendingSignIn.error)).toEqual({ code: "auth_failed", message: "fleet_token_required" });

    const signIn = await machineConnection(ctx.fixture, ctx.relay.fleet, { machineSessions: ctx.relay.fleet, enrolment: ctx.relay.fleet });
    await signIn.hello();
    await signIn.sendAuth(key);
    expect(await bounded(signIn.error)).toEqual({ code: "auth_failed", message: "fleet_token_required" });

    const newcomer = await machineKey();
    const enrol = await machineConnection(ctx.fixture, ctx.relay.fleet, { machineSessions: ctx.relay.fleet, enrolment: ctx.relay.fleet });
    await enrol.hello();
    enrol.sendEnroll(newcomer, spare);
    expect(await bounded(enrol.error)).toEqual({ code: "auth_failed", message: "fleet_token_required" });
    expect(fleetHashes(ctx.stateDir)).toEqual(before);
  });

  it("shows every machine of a fleet restarted without its token with the cause fleet_token_required, opens no forward, and signs them in again with the token", async () => {
    const first = server(TOKEN);
    const key = await machineKey();
    await enrolled(first, key);
    first.relay.fleet.store.setState(key.id, "active");
    first.stop();

    const held = server("", first.stateDir);
    const before = fleetHashes(held.stateDir);
    const answer = await held.read("/api/fleet/machines");
    expect(answer.status).toBe(200);
    const body = (await answer.json()) as { fleet_state?: string; machines: { machine_id: string; cause: string | null; message: string | null }[] };
    expect(body.fleet_state).toBe("fleet_token_required");
    expect(body.machines.map((row) => [row.machine_id, row.cause])).toEqual([[key.id, "fleet_token_required"]]);
    expect(body.machines[0]!.message).toBeString();
    for (const path of ["/api/fleet/invites", "/api/fleet/batches"]) {
      expect(((await (await held.read(path)).json()) as { fleet_state?: string }).fleet_state, path).toBe("fleet_token_required");
    }
    expect(await held.relay.fleet.forwardReady(key.id)).toBeUndefined();
    expect((await import("./gate.ts")).fleetHeldWarning(held.stateDir, false)).toContain("OVIS_TOKEN");
    expect(fleetHashes(held.stateDir)).toEqual(before);
    held.stop();

    const back = server(TOKEN, first.stateDir);
    const machine = await machineConnection(back.fixture, back.relay.fleet, { machineSessions: back.relay.fleet, enrolment: back.relay.fleet });
    await machine.hello();
    expect((await machine.signIn(key)).machine_id).toBe(key.id);
    expect((await back.relay.fleet.forwardReady(key.id))?.port).toBeGreaterThan(0);
    const rows = (await (await back.read("/api/fleet/machines", { authorization: `Bearer ${TOKEN}` })).json()) as { fleet_state?: string; machines: { cause: string | null }[] };
    expect(rows.fleet_state).toBeUndefined();
    expect(rows.machines[0]!.cause).not.toBe("fleet_token_required");
    expect((await import("./gate.ts")).fleetHeldWarning(back.stateDir, true)).toBeNull();
    rmSync(first.stateDir, { recursive: true, force: true });
  });

  it("refuses the owner-key step (`ovis-server fleet owner`, `ovis fleet on`) and makes nothing", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "fleet-gate-owner-"));
    cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
    const phrase = join(stateDir, "phrase.txt");
    const errors: string[] = [];
    const exit = runFleetCli(["owner", "--phrase-file", phrase], { stateDir, isTTY: false, tokenConfigured: false, out: () => {}, err: (text) => errors.push(text) });
    expect(exit).toBe(2);
    expect(errors.join("\n")).toContain("fleet_token_required");
    const out: string[] = [];
    const io: FleetCommandIo = { origin: "http://127.0.0.1:9", headers: {}, stateDir, stdoutTTY: false, stdinTTY: false, out: (text) => out.push(text), err: () => {}, ask: async () => null };
    expect(await runFleet(["on", "--phrase-file", phrase, "--json"], io)).toBe(FLEET_EXIT.fleet_token_required);
    expect(JSON.parse(out[0]!).error.code).toBe("fleet_token_required");
    expect(existsSync(phrase)).toBe(false);
    expect(fleetHashes(stateDir)).toEqual({});
  });

  it("gives `ovis fleet invite` its own exit code for fleet_token_required", async () => {
    const ctx = server("");
    turnFleetOn(ctx.stateDir);
    const before = fleetHashes(ctx.stateDir);
    const out: string[] = [];
    const io: FleetCommandIo = { origin: ctx.base, headers: {}, stateDir: ctx.stateDir, stdoutTTY: false, stdinTTY: false, out: (text) => out.push(text), err: () => {}, ask: async () => null };
    const dir = join(ctx.stateDir, "invites-out");
    expect(await runFleet(["invite", "--out", dir, "--json"], io)).toBe(FLEET_EXIT.fleet_token_required);
    expect(JSON.parse(out[0]!).error.code).toBe("fleet_token_required");
    expect(existsSync(dir)).toBe(false);
    expect(fleetHashes(ctx.stateDir)).toEqual(before);
  });
});

describe("the store of a held fleet", () => {
  it("refuses every writer that is not HTTP, with the typed cause, and writes nothing under fleet/", async () => {
    const first = server(TOKEN);
    const key = await machineKey();
    const { batchId, confirmBody, minted } = await enrolled(first, key);
    first.stop();
    const ctx = server("", first.stateDir);
    const fleet = ctx.relay.fleet;
    const before = fleetHashes(ctx.stateDir);
    const other = await machineKey();
    const typed = (write: () => unknown) => {
      try { write(); } catch (error) { return (error as { code?: string }).code; }
      return "written";
    };
    expect(typed(() => fleet.store.add({ machine_id: other.id, public_key: other.spki }))).toBe("fleet_token_required");
    expect(typed(() => fleet.store.setState(key.id, "active"))).toBe("fleet_token_required");
    expect(typed(() => fleet.store.setRuntime(key.id, "rt-held"))).toBe("fleet_token_required");
    expect(typed(() => fleet.store.remove(key.id))).toBe("fleet_token_required");
    expect(typed(() => fleet.store.update((document) => ({ document: { ...document, batches: [] }, result: null })))).toBe("fleet_token_required");
    expect(await fleet.invites.mint(mintRequest({ count: 1 }), async () => CONTROLLER).then(() => "written", (error: { code?: string }) => error.code)).toBe("fleet_token_required");
    const { digest } = JSON.parse(confirmBody) as { digest: string };
    expect(await fleet.invites.confirm(batchId, 1, digest).then(() => "written", (error: { code?: string }) => error.code)).toBe("fleet_token_required");
    const binding = new Uint8Array(32).fill(5);
    expect(await fleet.invites.enroll(signEnroll(other, minted.invites[1]!, binding), { binding })).toEqual({ code: "auth_failed", cause: "fleet_token_required" });
    expect(fleetHashes(ctx.stateDir)).toEqual(before);
    expect(fleet.store.get(key.id)?.state).toBe("pending");
  });

  it("answers a read that carries no secret: no invite secret, no owner key material, no bearer or bridge token", async () => {
    const first = server(TOKEN);
    const key = await machineKey();
    const { minted } = await enrolled(first, key);
    first.relay.fleet.store.setState(key.id, "active");
    first.stop();
    const ctx = server("", first.stateDir);
    const owner = JSON.parse(readFileSync(join(ctx.stateDir, "fleet", "owner.json"), "utf8")) as { seed: string };
    const secrets = [owner.seed, ...minted.invites.map((invite) => invite.secret), Buffer.from(owner.seed, "base64url").toString("hex")];
    for (const path of ["/api/fleet/machines", "/api/fleet/invites", "/api/fleet/batches"]) {
      const text = await (await ctx.read(path)).text();
      expect((JSON.parse(text) as { fleet_state?: string }).fleet_state, path).toBe("fleet_token_required");
      for (const secret of secrets) expect(text, path).not.toContain(secret);
      expect(text, path).not.toMatch(/secret|seed|private|bearer|bridge_token|native_bearer/i);
    }
  });
});

describe("with a token configured", () => {
  it("turns the fleet on with POST /api/fleet/enable without making an owner key: a mint still needs one", async () => {
    const ctx = server(TOKEN);
    const auth = { authorization: `Bearer ${TOKEN}` };
    expect(await code(await ctx.write("/api/fleet/enable", "{}", auth))).toEqual([200, "ok"]);
    expect(Object.keys(fleetHashes(ctx.stateDir))).toEqual(["enabled"]);
    expect(await code(await ctx.write("/api/fleet/invites", "{\"count\":1}", auth))).toEqual([409, "owner_key_missing"]);
    expect(Object.keys(fleetHashes(ctx.stateDir))).toEqual(["enabled"]);
  });

  it("refuses the same loopback calls without it token_required, and answers them with it", async () => {
    const without = server(TOKEN);
    turnFleetOn(without.stateDir);
    for (const [route, call] of [
      ["POST /api/fleet/enable", () => without.write("/api/fleet/enable", "{}")],
      ["POST /api/fleet/invites", () => without.write("/api/fleet/invites", "{\"count\":1}")],
    ] as const) {
      const answer = await call();
      expect(answer.status, route).toBe(401);
    }
    expect(existsSync(join(without.stateDir, "fleet", "enabled"))).toBe(false);

    const ctx = server(TOKEN);
    const key = await machineKey();
    const { batchId, confirmBody } = await enrolled(ctx, key);
    const auth = { authorization: `Bearer ${TOKEN}` };
    expect(await code(await ctx.write("/api/fleet/enable", "{}", auth))).toEqual([200, "ok"]);
    expect(existsSync(join(ctx.stateDir, "fleet", "enabled"))).toBe(true);
    expect(await code(await ctx.write("/api/fleet/invites", "{\"count\":1}", auth))).toEqual([201, "ok"]);
    expect(await code(await ctx.write(`/api/fleet/batches/${batchId}/confirm`, confirmBody, auth))).toEqual([200, "ok"]);
    expect(ctx.relay.fleet.store.get(key.id)?.state).toBe("active");
  });

  it("lets a device paired to drive confirm a batch through the relay without the token, and refuses one that watches read_only", async () => {
    const ctx = server(TOKEN);
    const key = await machineKey();
    const { batchId, confirmBody } = await enrolled(ctx, key);
    const confirm = async (role: "drive" | "watch") => {
      const link = await relayConnection(ctx.fixture);
      await link.auth(await relayDevice(ctx.fixture, role));
      const request = link.open(`/api/fleet/batches/${batchId}/confirm`, { method: "POST", headers: [["x-herdr-update", "1"], ["content-type", "application/json"]], body: "stream" });
      void request.stream.sendBody(new Response(confirmBody).body ?? new ReadableStream()).catch(() => {});
      return code(await request.response);
    };
    expect(await confirm("watch")).toEqual([403, "read_only"]);
    expect(ctx.relay.fleet.store.get(key.id)?.state).toBe("pending");
    expect(await confirm("drive")).toEqual([200, "ok"]);
    expect(ctx.relay.fleet.store.get(key.id)?.state).toBe("active");
  });

  it("lets a machine enrol and sign in", async () => {
    const ctx = server(TOKEN);
    turnFleetOn(ctx.stateDir);
    const minted = await ctx.relay.fleet.invites.mint(mintRequest({ count: 1 }), async () => CONTROLLER);
    const key = await machineKey();
    const machine = await machineConnection(ctx.fixture, ctx.relay.fleet, { machineSessions: ctx.relay.fleet, enrolment: ctx.relay.fleet });
    await machine.hello();
    expect((await machine.enrollAndSignIn(key, minted.invites[0]!)).machine_id).toBe(key.id);
  });
});

describe("a server whose fleet was never turned on", () => {
  it("answers as before: a loopback request with no token gets full access, fleet reads carry no fleet state, and no line is logged", async () => {
    const ctx = server("");
    const answer = await ctx.read("/api/fleet/machines");
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ machines: [] });
    expect((await import("./gate.ts")).fleetHeldWarning(ctx.stateDir, false)).toBeNull();
    expect(fleetHashes(ctx.stateDir)).toEqual({});
    expect((await import("./gate.ts")).fleetEnabled(ctx.stateDir)).toBe(false);
  });
});
