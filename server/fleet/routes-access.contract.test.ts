/**
 * Who may call each fleet route, one row per route (todo 30 adds its rows here): the callers of dispatch.ts's access
 * rule against a server started with `port: 0` and a mkdtemp state folder that holds one machine. Assertions are on
 * statuses and error codes.
 *
 * `GET /api/fleet/machines`: any caller with full access, a watching device included, directly or through the relay;
 * a Portal visitor and an open LAN window get 403 `owner_only` (as `/api/account/`); a page of another site gets 403
 * `invalid_origin` (as `/api/machines`); a machine session gets no route at all.
 *
 * Todo 30's rows: `GET /api/fleet/invites` and `GET /api/fleet/batches` as the machine list; `POST /api/fleet/invites` and
 * `POST /api/fleet/batches/<id>/confirm` only by an owner (server/access.ts ownerAccess), on the controller or through the
 * relay, behind `x-herdr-update: 1`: a watching device gets 403 `read_only`, a Portal visitor and an open LAN window 403
 * `owner_only`, a loopback caller without the token 401, and a machine session that sends HTTP_OPEN for a confirm is ended
 * `protocol_error` with its batch still pending.
 *
 * Todo 31's rows (each a fleet write, as `POST /api/fleet/invites`): `DELETE /api/fleet/machines/<id>`,
 * `POST /api/fleet/machines/<id>/readmit`, `POST /api/fleet/slots/<slot>/release`, `POST /api/fleet/restore/confirm` and
 * `POST /api/fleet/invites/withdraw`.
 *
 * Todo 60's rows: `POST /api/fleet/enable` as the other writes; and on a server with no token every write answers 409
 * `fleet_token_required` and changes nothing (server/fleet/gate.ts; its own table is gate.contract.test.ts).
 *
 * Todo 32's rows: `GET /api/fleet/machines/<id>/native` (slice 32-early-b) and `/bridge` (`ovis start`, `ovis wait`)
 * answer only a process on the controller, a
 * loopback request with no proxy in front that presents the server token in its Authorization header (the token
 * cookie does not count); every paired device, local or remote, driving or watching, gets 403 `controller_only`
 * (server/fleet/on.contract.test.ts holds the rest of its cases).
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRequest } from "../dispatch.ts";
import type { ServerContext } from "../dispatch.ts";
import { createServer } from "../index.ts";
import { PortalService } from "../portal.ts";
import { bounded, relayConnection, relayDevice, relayFixture } from "../relay/test-helpers.ts";
import { exportPublicKey, generateKeyPair } from "../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../shared/relay-server-proof.ts";
import { mintRequest } from "./invites.ts";
import { Fleet } from "./sessions.ts";
import { FleetStore } from "./store.ts";
import { machineConnection, machineKey, signEnroll, turnFleetOn } from "./test-helpers.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const ROUTE = "/api/fleet/machines";

async function controller(options: { token?: string } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "fleet-access-"));
  cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
  const key = await machineKey();
  const store = new FleetStore({ stateDir });
  store.add({ machine_id: key.id, public_key: key.spki, name: "vm" });
  store.setState(key.id, "active");
  const portal = new PortalService({ stateDir });
  const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: options.token ?? "", tailscaleOwner: null, machines: false, sidecar: false, portal });
  cleanups.push(() => { void app.stop(); });
  const base = `http://127.0.0.1:${app.port}`;
  const devices = app.context.services.devices;
  return {
    stateDir, app, base, portal, key, devices,
    get: (headers: Record<string, string> = {}) => fetch(`${base}${ROUTE}`, { headers }),
    /** A paired device's cookie. */
    cookie(role: "drive" | "watch") {
      const device = devices.pair(devices.startPairing().code, `${role} device`, role);
      if (!device) throw new Error("Fixture pairing failed");
      return { cookie: `ovis_device=${device.token}` };
    },
  };
}

describe("GET /api/fleet/machines", () => {
  it("answers the owner on a tokenless installation, and a token holder when a token is set, and nobody else", async () => {
    const open = await controller();
    const answer = await open.get();
    expect(answer.status).toBe(200);
    expect(((await answer.json()) as { machines: { machine_id: string }[] }).machines.map((row) => row.machine_id)).toEqual([open.key.id]);

    const gated = await controller({ token: "owner-token" });
    expect((await gated.get()).status).toBe(401);
    expect((await gated.get({ authorization: "Bearer wrong" })).status).toBe(401);
    expect((await gated.get({ authorization: "Bearer owner-token" })).status).toBe(200);
  });

  it("answers a paired device that drives and one that only watches, directly", async () => {
    const ctx = await controller({ token: "owner-token" });
    expect((await ctx.get(ctx.cookie("drive"))).status).toBe(200);
    expect((await ctx.get(ctx.cookie("watch"))).status).toBe(200);
  });

  it("answers a paired device through the relay, driving or watching", async () => {
    const ctx = await controller({ token: "owner-token" });
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const publicKey = Buffer.from(await crypto.subtle.exportKey("spki", keys.publicKey)).toString("base64url");
    const paired = ctx.devices.pairRelay(ctx.devices.startPairing().code, "Relay phone", publicKey);
    if (!paired) throw new Error("Expected relay enrolment");
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    const signature = Buffer.from(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey,
      Buffer.concat([Buffer.from("ovis-relay-auth/1"), nonce, Buffer.from("fleet-access")]))).toString("base64url");
    for (const role of ["drive", "watch"] as const) {
      ctx.devices.update(paired.device.id, { role });
      const device = await ctx.devices.matchRelay(paired.device.id, nonce, signature, "fleet-access");
      if (!device) throw new Error("Expected an authenticated relay device");
      const peer: ServerContext = { ...ctx.app.context, peer: { kind: "relay", device, sessionId: `s-${role}`, serverId: "0123456789abcdef0123456789abcdef", key: "" }, requestIP: () => null, timeout: () => {} };
      const answer = await handleRequest(new Request(`https://relay.ovis.invalid${ROUTE}`), peer);
      expect(answer?.status).toBe(200);
      expect(((await answer!.json()) as { machines: unknown[] }).machines).toHaveLength(1);
    }
  });

  it("refuses a Portal visitor, whatever role it has, with owner_only", async () => {
    for (const role of ["drive", "watch"] as const) {
      const ctx = await controller();
      const vouches = spyOn(ctx.portal, "vouches").mockReturnValue(true);
      const roleFor = spyOn(ctx.portal, "roleFor").mockReturnValue(role);
      const visitor: ServerContext = { ...ctx.app.context, requestIP: () => ({ address: "127.0.0.1" }), timeout() {}, upgrade() { throw new Error("Unexpected WebSocket upgrade"); } };
      const headers = { host: `127.0.0.1:${ctx.app.port}`, "x-portal-proof": "fixture", "x-portal-user": "visitor", "x-portal-auth": "credential" };
      const answer = await handleRequest(new Request(`http://127.0.0.1:${ctx.app.port}${ROUTE}`, { headers }), visitor);
      expect([answer?.status, ((await answer!.json()) as { error: { code: string } }).error.code]).toEqual([403, "owner_only"]);
      vouches.mockRestore();
      roleFor.mockRestore();
    }
  });

  it("refuses an open LAN window with owner_only", async () => {
    const ctx = await controller();
    const answer = await ctx.get({ origin: ctx.base, "x-forwarded-for": "192.168.1.50" });
    expect([answer.status, ((await answer.json()) as { error: { code: string } }).error.code]).toEqual([403, "owner_only"]);
  });

  it("refuses a page of another site that holds a credential with invalid_origin", async () => {
    const ctx = await controller({ token: "owner-token" });
    const authorization = "Bearer owner-token";
    for (const headers of [{ origin: "https://evil.example" }, { "sec-fetch-site": "cross-site" }] as Record<string, string>[]) {
      const answer = await ctx.get({ authorization, ...headers });
      expect([answer.status, ((await answer.json()) as { error: { code: string } }).error.code]).toEqual([403, "invalid_origin"]);
    }
    expect((await ctx.get({ authorization, origin: ctx.base, "sec-fetch-site": "same-origin" })).status).toBe(200);
  });

  it("answers a watching device nothing but the read: every other method is refused read_only", async () => {
    const ctx = await controller({ token: "owner-token" });
    const watch = ctx.cookie("watch");
    for (const method of ["POST", "PUT", "DELETE"]) {
      const answer = await fetch(`${ctx.base}${ROUTE}`, { method, headers: { ...watch, origin: ctx.base, "x-herdr-machine": "1", "content-type": "application/json" }, body: method === "DELETE" ? undefined : "{}" });
      expect([answer.status, ((await answer.json()) as { error: { code: string } }).error.code]).toEqual([403, "read_only"]);
    }
  });

  it("is no route of a machine session: a machine that sends HTTP_OPEN is ended protocol_error", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "fleet-access-machine-"));
    cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
    const key = await machineKey();
    const store = new FleetStore({ stateDir });
    store.add({ machine_id: key.id, public_key: key.spki });
    store.setState(key.id, "active");
    const fleet = new Fleet({ stateDir, tokenConfigured: true, store });
    const fixture = relayFixture(false, { stateDir });
    cleanups.push(() => fixture.close());
    const machine = await machineConnection(fixture, fleet, { machineSessions: fleet });
    await machine.hello();
    await machine.signIn(key);
    const root = join(import.meta.dir, "vectors");
    const open = readdirSync(root).filter((file) => file.endsWith(".json"))
      .flatMap((file) => (JSON.parse(readFileSync(join(root, file), "utf8")) as { cases: { frame: string; direction: string; context: { state?: string }; bytes: string }[] }).cases)
      .find((entry) => entry.frame === "HTTP_OPEN" && entry.direction === "machine_to_controller");
    if (!open) throw new Error("no HTTP_OPEN vector");
    machine.sendBytes(Uint8Array.from(Buffer.from(open.bytes, "hex")));
    expect((await bounded(machine.error)).code).toBe("protocol_error");
  });
});

const controllerKeys = generateKeyPair();
const CONTROLLER = { server_id: deriveServerId(controllerKeys.publicKey), server_public_key: exportPublicKey(controllerKeys.publicKey), relay: "wss://relay.ovis.example", direct: [] as string[] };
const WRITE = { "x-herdr-update": "1", "content-type": "application/json" };
type Fixture = ReturnType<typeof relayFixture>;

/** A server whose fleet has one batch with one machine waiting for confirmation; its relay names CONTROLLER. */
async function fleetServer(options: { token?: string } = {}) {
  const fixture = relayFixture(false, { ...(options.token ? { token: options.token } : {}), portal: undefined });
  cleanups.push(() => fixture.close());
  turnFleetOn(fixture.stateDir);
  const relay = fixture.app.context.services.relay;
  const describeSpy = spyOn(relay, "fleetController").mockResolvedValue(CONTROLLER);
  cleanups.push(() => describeSpy.mockRestore());
  // a tokenless server holds its fleet, store included (server/fleet/gate.ts): its batch is made as while a token was set
  const held = relay.fleet.held();
  if (held) relay.fleet.setTokenConfigured(true);
  const minted = await relay.fleet.invites.mint(mintRequest({ count: 1 }), async () => CONTROLLER);
  const key = await machineKey();
  const binding = new Uint8Array(32).fill(3);
  expect(await relay.fleet.invites.enroll(signEnroll(key, minted.invites[0]!, binding), { binding })).toEqual({ machineId: key.id });
  if (held) relay.fleet.setTokenConfigured(false);
  const [batch] = relay.fleet.invites.batches();
  const base = `http://127.0.0.1:${fixture.app.port}`;
  const confirmPath = `/api/fleet/batches/${minted.batch_id}/confirm`;
  const confirmBody = JSON.stringify({ count: 1, digest: batch!.digest });
  return {
    fixture, relay, base, key, confirmPath, confirmBody, devices: fixture.app.context.services.devices,
    state: () => relay.fleet.store.get(key.id)?.state,
    cookie(role: "drive" | "watch") {
      const devices = fixture.app.context.services.devices;
      const device = devices.pair(devices.startPairing().code, `${role} device`, role);
      if (!device) throw new Error("Fixture pairing failed");
      return { cookie: `ovis_device=${device.token}` };
    },
  };
}
type FleetServer = Awaited<ReturnType<typeof fleetServer>>;
const code = async (answer: Response) => [answer.status, answer.status >= 400 ? ((await answer.json()) as { error: { code: string } }).error.code : "ok"];
/** Every route of the table at this todo, as a direct request of `headers`. */
function routes(ctx: FleetServer, headers: Record<string, string>) {
  return {
    "GET /api/fleet/invites": () => fetch(`${ctx.base}/api/fleet/invites`, { headers }),
    "GET /api/fleet/batches": () => fetch(`${ctx.base}/api/fleet/batches`, { headers }),
    "GET /api/fleet/machines": () => fetch(`${ctx.base}/api/fleet/machines`, { headers }),
    "POST /api/fleet/enable": () => fetch(`${ctx.base}/api/fleet/enable`, { method: "POST", headers: { ...headers, ...WRITE, origin: ctx.base }, body: "{}" }),
    "POST /api/fleet/invites": () => fetch(`${ctx.base}/api/fleet/invites`, { method: "POST", headers: { ...headers, ...WRITE, origin: ctx.base }, body: "{\"count\":1}" }),
    "POST /api/fleet/batches/<id>/confirm": () => fetch(`${ctx.base}${ctx.confirmPath}`, { method: "POST", headers: { ...headers, ...WRITE, origin: ctx.base }, body: ctx.confirmBody }),
  };
}
async function relayed(f: Fixture, role: "drive" | "watch") {
  const link = await relayConnection(f);
  await link.auth(await relayDevice(f, role));
  return {
    get: async (target: string) => code(await link.open(target).response),
    post: async (target: string, body: string, headers: [string, string][] = [["x-herdr-update", "1"], ["content-type", "application/json"]]) => {
      const request = link.open(target, { method: "POST", headers, body: "stream" });
      void request.stream.sendBody(new Response(body).body ?? new ReadableStream()).catch(() => {});
      return code(await request.response);
    },
  };
}

describe("the invite and batch routes (todo 30's rows)", () => {
  it("answer an owner on the controller with the token; on a tokenless install the reads answer and every write is fleet_token_required", async () => {
    const open = await fleetServer();
    for (const [route, call] of Object.entries(routes(open, {})).filter(([route]) => route.startsWith("GET"))) expect(await code(await call()), route).toEqual([200, "ok"]);
    for (const [route, call] of Object.entries(routes(open, {})).filter(([route]) => route.startsWith("POST"))) expect(await code(await call()), route).toEqual([409, "fleet_token_required"]);
    expect(open.state()).toBe("pending");

    // each refused caller on a server of its own: the token gate counts its failures (server/auth.ts) and soon answers 429
    const refused = await fleetServer({ token: "owner-token" });
    // the enable row's 401 is gate.contract.test.ts's: one more refused call here only slows the token gate's answers
    for (const [route, call] of Object.entries(routes(refused, {})).filter(([route]) => route !== "POST /api/fleet/enable")) expect((await call()).status, `${route} without the token`).toBe(401);
    expect(refused.state()).toBe("pending");
    const wrong = await fleetServer({ token: "owner-token" });
    expect((await routes(wrong, { authorization: "Bearer wrong" })["POST /api/fleet/batches/<id>/confirm"]()).status).toBe(401);
    expect(wrong.state()).toBe("pending");
    const gated = await fleetServer({ token: "owner-token" });
    const owner = routes(gated, { authorization: "Bearer owner-token" });
    expect(await code(await owner["GET /api/fleet/batches"]())).toEqual([200, "ok"]);
    expect(await code(await owner["POST /api/fleet/enable"]())).toEqual([200, "ok"]);
    expect(await code(await owner["POST /api/fleet/invites"]())).toEqual([201, "ok"]);
    expect(await code(await owner["POST /api/fleet/batches/<id>/confirm"]())).toEqual([200, "ok"]);
  });

  it("let a device paired to drive write and one that watches only read, directly", async () => {
    const ctx = await fleetServer({ token: "owner-token" });
    const watch = routes(ctx, ctx.cookie("watch"));
    for (const route of ["GET /api/fleet/invites", "GET /api/fleet/batches", "GET /api/fleet/machines"] as const) expect(await code(await watch[route]()), route).toEqual([200, "ok"]);
    expect(await code(await watch["POST /api/fleet/enable"]())).toEqual([403, "read_only"]);
    expect(await code(await watch["POST /api/fleet/invites"]())).toEqual([403, "read_only"]);
    expect(await code(await watch["POST /api/fleet/batches/<id>/confirm"]())).toEqual([403, "read_only"]);
    expect(ctx.state()).toBe("pending");
    const drive = routes(ctx, ctx.cookie("drive"));
    expect(await code(await drive["POST /api/fleet/enable"]())).toEqual([200, "ok"]);
    expect(await code(await drive["POST /api/fleet/invites"]())).toEqual([201, "ok"]);
    expect(await code(await drive["POST /api/fleet/batches/<id>/confirm"]())).toEqual([200, "ok"]);
  });

  it("let a device paired to drive write through the relay, and one that watches only read", async () => {
    const ctx = await fleetServer({ token: "owner-token" });
    const watch = await relayed(ctx.fixture, "watch");
    for (const target of ["/api/fleet/invites", "/api/fleet/batches", "/api/fleet/machines"]) expect(await watch.get(target), target).toEqual([200, "ok"]);
    expect(await watch.post("/api/fleet/invites", "{}")).toEqual([403, "read_only"]);
    expect(await watch.post(ctx.confirmPath, ctx.confirmBody)).toEqual([403, "read_only"]);
    expect(ctx.state()).toBe("pending");
    const drive = await relayed(ctx.fixture, "drive");
    // the relay-control rule local_required does not apply to fleet routes; the app's own header does
    expect(await drive.post(ctx.confirmPath, ctx.confirmBody, [["content-type", "application/json"]])).toEqual([403, "forbidden"]);
    expect(await drive.post("/api/fleet/invites", "{}")).toEqual([201, "ok"]);
    expect(await drive.post(ctx.confirmPath, ctx.confirmBody)).toEqual([200, "ok"]);
    expect(ctx.state()).toBe("active");
  });

  it("refuse a Portal visitor and an open LAN window owner_only, reads and writes alike", async () => {
    const ctx = await fleetServer();
    for (const [route, call] of Object.entries(routes(ctx, { origin: ctx.base, "x-forwarded-for": "192.168.1.50" }))) expect(await code(await call()), `${route} from an open LAN window`).toEqual([403, "owner_only"]);
    for (const role of ["drive", "watch"] as const) {
      const service = new PortalService({ stateDir: ctx.fixture.stateDir });
      const vouches = spyOn(service, "vouches").mockReturnValue(true);
      const roleFor = spyOn(service, "roleFor").mockReturnValue(role);
      cleanups.push(() => { vouches.mockRestore(); roleFor.mockRestore(); });
      const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir: ctx.fixture.stateDir, token: "", tailscaleOwner: null, machines: false, sidecar: false, portal: service });
      cleanups.push(() => { void app.stop(); });
      const visitor: ServerContext = { ...app.context, requestIP: () => ({ address: "127.0.0.1" }), timeout() {}, upgrade() { throw new Error("Unexpected WebSocket upgrade"); } };
      const headers = { host: `127.0.0.1:${app.port}`, "x-portal-proof": "fixture", "x-portal-user": "visitor", "x-portal-auth": "credential" };
      for (const [method, path, body] of [["GET", "/api/fleet/invites"], ["GET", "/api/fleet/batches"], ["POST", "/api/fleet/invites", "{}"], ["POST", ctx.confirmPath, ctx.confirmBody]] as [string, string, string?][]) {
        const answer = await handleRequest(new Request(`http://127.0.0.1:${app.port}${path}`, { method, headers: method === "POST" ? { ...headers, ...WRITE } : headers, ...(body ? { body } : {}) }), visitor);
        expect(await code(answer!), `${method} ${path} as a ${role} visitor`).toEqual([403, role === "watch" && method === "POST" ? "read_only" : "owner_only"]);
      }
    }
    expect(ctx.state()).toBe("pending");
  });

  it("remove a machine (DELETE /api/fleet/machines/<id>, the early form of todo 31's row) only for an owner behind the app's header", async () => {
    const remove = (ctx: FleetServer, headers: Record<string, string>, id = ctx.key.id) =>
      fetch(`${ctx.base}/api/fleet/machines/${id}`, { method: "DELETE", headers: { ...headers, "x-herdr-update": "1", origin: ctx.base } });
    const gated = await fleetServer({ token: "owner-token" });
    expect((await remove(gated, {})).status).toBe(401);
    expect(await code(await remove(gated, gated.cookie("watch")))).toEqual([403, "read_only"]);
    expect((await remove(gated, { "x-forwarded-for": "192.168.1.50" })).status).toBe(401);
    const noHeader = await fetch(`${gated.base}/api/fleet/machines/${gated.key.id}`, { method: "DELETE", headers: { authorization: "Bearer owner-token", origin: gated.base } });
    expect(await code(noHeader)).toEqual([403, "forbidden"]);
    expect(gated.state()).toBe("pending");
    expect(await code(await remove(gated, { authorization: "Bearer owner-token" }, "0".repeat(32)))).toEqual([404, "unknown_machine"]);
    expect(await code(await fetch(`${gated.base}/api/fleet/machines/${gated.key.id}`, { headers: { authorization: "Bearer owner-token" } }))).toEqual([405, "method_not_allowed"]);
    expect(await code(await remove(gated, gated.cookie("drive")))).toEqual([200, "ok"]);
    expect(gated.state()).toBe("revoked");

    const open = await fleetServer();
    expect(await code(await remove(open, { "x-forwarded-for": "192.168.1.50" }))).toEqual([403, "owner_only"]);
    expect(open.state()).toBe("pending");
    // no token on this server: the owner on it removes nothing either (server/fleet/gate.ts)
    expect(await code(await remove(open, {}))).toEqual([409, "fleet_token_required"]);
    expect(open.state()).toBe("pending");
    // through the relay: a watching device only reads, a driving one removes
    const relayedServer = await fleetServer({ token: "owner-token" });
    const target = `/api/fleet/machines/${relayedServer.key.id}`;
    const watcher = await relayConnection(relayedServer.fixture);
    await watcher.auth(await relayDevice(relayedServer.fixture, "watch"));
    expect(await code(await watcher.open(target, { method: "DELETE", headers: [["x-herdr-update", "1"]] }).response)).toEqual([403, "read_only"]);
    const driver = await relayConnection(relayedServer.fixture);
    await driver.auth(await relayDevice(relayedServer.fixture, "drive"));
    expect(await code(await driver.open(target, { method: "DELETE", headers: [["x-herdr-update", "1"]] }).response)).toEqual([200, "ok"]);
    expect(relayedServer.state()).toBe("revoked");
  });

  it.each(["native", "bridge"])("give the %s route (todo 32's row) only to a process on the controller with the token: never a paired device, local or remote", async (endpoint) => {
    const ctx = await fleetServer({ token: "owner-token" });
    const target = `/api/fleet/machines/${ctx.key.id}/${endpoint}`;
    const get = (headers: Record<string, string>) => fetch(`${ctx.base}${target}`, { headers });
    expect((await get({})).status).toBe(401);
    // the machine is pending, so the owner on the controller is let in and told why it cannot be reached
    expect(await code(await get({ authorization: "Bearer owner-token" }))).toEqual([409, "machine_unreachable"]);
    for (const role of ["drive", "watch"] as const) {
      expect(await code(await get(ctx.cookie(role))), `a ${role} device on the LAN`).toEqual([403, "controller_only"]);
      expect(await (await relayed(ctx.fixture, role)).get(target), `a ${role} device through the relay`).toEqual([403, "controller_only"]);
    }
    expect(await code(await get({ authorization: "Bearer owner-token", "x-forwarded-for": "100.64.0.9" }))).toEqual([403, "controller_only"]);
    // the token in a cookie (a browser signed in on this PC) is not a command on the controller: only the header counts
    for (const cookie of ["ovis_token", "herdr_web_token"]) expect(await code(await get({ cookie: `${cookie}=owner-token` })), cookie).toEqual([403, "controller_only"]);
    const open = await fleetServer();
    expect(await code(await fetch(`${open.base}/api/fleet/machines/${open.key.id}/${endpoint}`))).toEqual([409, "fleet_token_required"]);
  });

  it("is no route of a machine session: HTTP_OPEN for the confirm route ends it protocol_error, and the batch stays pending", async () => {
    const ctx = await fleetServer({ token: "owner-token" });
    const key = await machineKey();
    ctx.relay.fleet.store.add({ machine_id: key.id, public_key: key.spki });
    ctx.relay.fleet.store.setState(key.id, "active");
    const machine = await machineConnection(ctx.fixture, ctx.relay.fleet, { machineSessions: ctx.relay.fleet, enrolment: ctx.relay.fleet });
    await machine.hello();
    await machine.signIn(key);
    // an HTTP_OPEN a device would send for the confirm, sent as it is by the machine
    const { encodeFrame, FrameType } = await import("../../shared/relay-mux.ts");
    machine.sendBytes(encodeFrame({ type: FrameType.HTTP_OPEN, flags: 0, stream_id: 1, payload: { device_id: "0".repeat(16), method: "POST", target: ctx.confirmPath, headers: [["x-herdr-update", "1"]], body: "none" } }));
    expect((await bounded(machine.error)).code).toBe("protocol_error");
    expect(ctx.state()).toBe("pending");
  });
});

describe("todo 31's rows: remove, re-admit, release, restore confirm, withdraw (fleet writes)", () => {
  /** Each new write, with a body its handler reads; what it answers past the access rule is the route's own answer. */
  const writes = (ctx: FleetServer): [string, string, string][] => [
    ["DELETE", `/api/fleet/machines/${"0".repeat(32)}`, ""],
    ["POST", `/api/fleet/machines/${ctx.key.id}/readmit`, "{}"],
    ["POST", "/api/fleet/slots/0/release", "{}"],
    ["POST", "/api/fleet/restore/confirm", JSON.stringify({ digest: "0".repeat(64) })],
    ["POST", "/api/fleet/invites/withdraw", JSON.stringify({ invite_id: "0".repeat(16) })],
  ];
  const call = (ctx: FleetServer, [method, path, body]: [string, string, string], headers: Record<string, string>) =>
    fetch(`${ctx.base}${path}`, { method, headers: { ...headers, ...WRITE, origin: ctx.base }, ...(body ? { body } : {}) });
  /** The route's own answer (not an access refusal) for each write, as an owner gets it. */
  const OWN = [[404, "unknown_machine"], [409, "not_removed"], [409, "slot_not_quarantined"], [409, "not_restored"], [404, "unknown_invite"]];

  it("answer an owner on the controller and a device paired to drive; refuse a watching device read_only, no token 401, an open LAN window owner_only", async () => {
    const gated = await fleetServer({ token: "owner-token" });
    const routes = writes(gated);
    for (const [index, route] of routes.entries()) {
      expect(await code(await call(gated, route, { authorization: "Bearer owner-token" })), `${route[0]} ${route[1]} owner`).toEqual(OWN[index]!);
      expect(await code(await call(gated, route, gated.cookie("drive"))), `${route[1]} drive`).toEqual(OWN[index]!);
      expect(await code(await call(gated, route, gated.cookie("watch"))), `${route[1]} watch`).toEqual([403, "read_only"]);
    }
    for (const route of routes) {
      const refused = await fleetServer({ token: "owner-token" });
      expect((await call(refused, [route[0], route[1].replace(gated.key.id, refused.key.id), route[2]], {})).status, `${route[1]} without the token`).toBe(401);
    }
    const open = await fleetServer();
    for (const route of writes(open)) expect(await code(await call(open, route, { "x-forwarded-for": "192.168.1.50" })), `${route[1]} LAN`).toEqual([403, "owner_only"]);
    // no token on this server (todo 60): the owner on it gets fleet_token_required from each, and nothing changes
    for (const route of writes(open)) expect(await code(await call(open, route, {})), `${route[1]} tokenless`).toEqual([409, "fleet_token_required"]);
    expect(open.state()).toBe("pending");
    // the app's own header is required, as for every fleet write
    const [, path, body] = writes(gated)[3]!;
    const noHeader = await fetch(`${gated.base}${path}`, { method: "POST", headers: { authorization: "Bearer owner-token", origin: gated.base, "content-type": "application/json" }, body });
    expect(await code(noHeader)).toEqual([403, "forbidden"]);
    expect(gated.state()).toBe("pending");
  });

  it("answer a device paired to drive through the relay, and refuse one that watches read_only", async () => {
    const ctx = await fleetServer({ token: "owner-token" });
    const watch = await relayed(ctx.fixture, "watch");
    const drive = await relayed(ctx.fixture, "drive");
    for (const [index, [method, path, body]] of writes(ctx).entries()) {
      if (method !== "POST") continue;
      expect(await watch.post(path, body), `${path} watch`).toEqual([403, "read_only"]);
      expect(await drive.post(path, body), `${path} drive`).toEqual(OWN[index]!);
    }
  });

  it("refuse a Portal visitor owner_only (a watching one read_only), and are no route of a machine session", async () => {
    const ctx = await fleetServer();
    for (const role of ["drive", "watch"] as const) {
      const service = new PortalService({ stateDir: ctx.fixture.stateDir });
      const vouches = spyOn(service, "vouches").mockReturnValue(true);
      const roleFor = spyOn(service, "roleFor").mockReturnValue(role);
      cleanups.push(() => { vouches.mockRestore(); roleFor.mockRestore(); });
      const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir: ctx.fixture.stateDir, token: "", tailscaleOwner: null, machines: false, sidecar: false, portal: service });
      cleanups.push(() => { void app.stop(); });
      const visitor: ServerContext = { ...app.context, requestIP: () => ({ address: "127.0.0.1" }), timeout() {}, upgrade() { throw new Error("Unexpected WebSocket upgrade"); } };
      const headers = { host: `127.0.0.1:${app.port}`, "x-portal-proof": "fixture", "x-portal-user": "visitor", "x-portal-auth": "credential" };
      for (const [method, path, body] of writes(ctx)) {
        const answer = await handleRequest(new Request(`http://127.0.0.1:${app.port}${path}`, { method, headers: { ...headers, ...WRITE }, ...(body ? { body } : {}) }), visitor);
        expect(await code(answer!), `${method} ${path} as a ${role} visitor`).toEqual([403, role === "watch" ? "read_only" : "owner_only"]);
      }
    }
    // a fleet signs machines in only with a token (todo 60)
    const tokened = await fleetServer({ token: "owner-token" });
    const key = await machineKey();
    tokened.relay.fleet.store.add({ machine_id: key.id, public_key: key.spki });
    tokened.relay.fleet.store.setState(key.id, "active");
    const machine = await machineConnection(tokened.fixture, tokened.relay.fleet, { machineSessions: tokened.relay.fleet, enrolment: tokened.relay.fleet });
    await machine.hello();
    await machine.signIn(key);
    const { encodeFrame, FrameType } = await import("../../shared/relay-mux.ts");
    machine.sendBytes(encodeFrame({ type: FrameType.HTTP_OPEN, flags: 0, stream_id: 1, payload: { device_id: "0".repeat(16), method: "DELETE", target: `/api/fleet/machines/${key.id}`, headers: [["x-herdr-update", "1"]], body: "none" } }));
    expect((await bounded(machine.error)).code).toBe("protocol_error");
    expect(tokened.relay.fleet.store.get(key.id)?.state).toBe("active");
  });
});
