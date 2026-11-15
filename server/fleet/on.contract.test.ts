/**
 * Slice 32-early-b of the relay-fleet plan: the route `GET /api/fleet/machines/<id>/native` (server/fleet/routes.ts),
 * against real servers started with `port: 0` on mkdtemp state folders and the fleet test token. It answers only a
 * process on this PC that presents the server token (todo 30's row): the forward's socket path and the machine's
 * runtime bearer, never to a paired device (directly or through the relay), a proxied request or a caller without the
 * token; a machine that cannot be reached is refused with the cause its row shows.
 */
import { afterEach, describe, expect, it, setDefaultTimeout, spyOn } from "bun:test";
import { handleRequest } from "../dispatch.ts";
import type { ServerContext } from "../dispatch.ts";
import { bounded, relayConnection, relayDevice } from "../relay/test-helpers.ts";
import { advertFrame, machineConnection, machineKey, testAdvert, turnFleetOn } from "./test-helpers.ts";
import { FLEET_TEST_AUTH, FLEET_TEST_TOKEN, fleetTestServer } from "./test-server.ts";

// synced store writes and real processes: on a loaded disk they can pass bun's 5 s default
setDefaultTimeout(30_000);

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const BEARER = testAdvert().native_bearer!;
const code = async (answer: Response) => [answer.status, answer.status >= 400 ? ((await answer.json()) as { error: { code: string } }).error.code : "ok"];

/** A server with one active machine "vm-a" signed in on an in-process session that advertised `endpoints`. */
async function nativeServer(options: { endpoints?: readonly ("bridge" | "native")[]; signIn?: boolean; state?: "active" | "pending" } = {}) {
  const fixture = fleetTestServer({ portal: undefined });
  cleanups.push(() => fixture.close());
  turnFleetOn(fixture.stateDir);
  const fleet = fixture.app.context.services.relay.fleet;
  const key = await machineKey();
  fleet.store.add({ machine_id: key.id, public_key: key.spki, name: "vm-a" });
  if ((options.state ?? "active") === "active") fleet.store.setState(key.id, "active");
  if (options.signIn ?? true) {
    const machine = await machineConnection(fixture, fleet, { machineSessions: fleet });
    await machine.hello();
    await machine.signIn(key);
    machine.mux.enqueueControl(advertFrame(testAdvert(options.endpoints ?? ["bridge", "native"])));
    await bounded(machine.mux.measure());
  }
  const base = `http://127.0.0.1:${fixture.app.port}`;
  const path = `/api/fleet/machines/${key.id}/native`;
  return {
    fixture, fleet, key, base, path,
    get: (headers: Record<string, string> = FLEET_TEST_AUTH, target = path) => fetch(`${base}${target}`, { headers }),
    cookie(role: "drive" | "watch") {
      const devices = fixture.app.context.services.devices;
      const device = devices.pair(devices.startPairing().code, `${role} device`, role);
      if (!device) throw new Error("Fixture pairing failed");
      return { cookie: `ovis_device=${device.token}` };
    },
  };
}

describe("GET /api/fleet/machines/<id>/native", () => {
  it("answers a process on this PC that presents the token: the forward's socket and the machine's runtime bearer, uncached", async () => {
    const ctx = await nativeServer();
    const forward = await ctx.fleet.forwardReady(ctx.key.id);
    const answer = await ctx.get();
    expect(answer.status).toBe(200);
    expect(answer.headers.get("cache-control")).toBe("no-store");
    expect(await answer.json()).toEqual({ machine_id: ctx.key.id, name: "vm-a", socket_path: forward!.socketPath, credential: BEARER, runtime_id: "rt-test", boot_id: "boot-1" });
  });

  it("refuses a caller without the token 401, and every paired device, a proxied request and a relayed one controller_only", async () => {
    const ctx = await nativeServer();
    expect((await ctx.get({})).status).toBe(401);
    expect(await code(await ctx.get(ctx.cookie("drive")))).toEqual([403, "controller_only"]);
    expect(await code(await ctx.get(ctx.cookie("watch")))).toEqual([403, "controller_only"]);
    // a proxy in front of the server (tailscale serve, a reverse proxy) is not this PC's own process
    expect(await code(await ctx.get({ ...FLEET_TEST_AUTH, "x-forwarded-for": "100.64.0.9", "x-forwarded-proto": "https" }))).toEqual([403, "controller_only"]);
    for (const role of ["drive", "watch"] as const) {
      const link = await relayConnection(ctx.fixture);
      await link.auth(await relayDevice(ctx.fixture, role));
      expect(await code(await link.open(ctx.path).response), `a ${role} device through the relay`).toEqual([403, "controller_only"]);
    }
  });

  it("refuses the token in a cookie, under either name, as typed or fetched by the app's own page: only the header counts", async () => {
    const ctx = await nativeServer();
    for (const cookie of ["ovis_token", "herdr_web_token"]) {
      for (const site of [{}, { "sec-fetch-site": "none" }, { "sec-fetch-site": "same-origin", origin: ctx.base }] as Record<string, string>[]) {
        const answer = await ctx.get({ cookie: `${cookie}=${FLEET_TEST_TOKEN}`, ...site });
        const body = await answer.text();
        expect([answer.status, (JSON.parse(body) as { error: { code: string } }).error.code], `${cookie} ${JSON.stringify(site)}`).toEqual([403, "controller_only"]);
        expect(body).not.toContain(BEARER);
      }
    }
    // the header still opens it, with or without the cookie beside it
    expect((await ctx.get({ ...FLEET_TEST_AUTH, cookie: `ovis_token=${FLEET_TEST_TOKEN}` })).status).toBe(200);
  });

  it("refuses the token from another address and on the LAN listener: the controller's own loopback only", async () => {
    const ctx = await nativeServer();
    const as = (address: string, lanHttps: boolean): ServerContext => ({
      ...ctx.fixture.app.context, ...(lanHttps ? { lanHttps } : {}), requestIP: () => ({ address }), timeout() {},
      upgrade() { throw new Error("Unexpected WebSocket upgrade"); },
    });
    const request = () => new Request(`${ctx.base}${ctx.path}`, { headers: { ...FLEET_TEST_AUTH, host: `127.0.0.1:${ctx.fixture.app.port}` } });
    expect(await code((await handleRequest(request(), as("127.0.0.1", false)))!), "loopback, the plain listener").toEqual([200, "ok"]);
    for (const [address, lanHttps] of [["192.168.1.50", false], ["100.64.0.9", false], ["192.168.1.50", true], ["127.0.0.1", true]] as const) {
      const answer = (await handleRequest(request(), as(address, lanHttps)))!;
      const body = await answer.text();
      expect(answer.status, `${address}${lanHttps ? " on the LAN listener" : ""}`).toBe(403);
      expect(body).not.toContain(BEARER);
    }
  });

  it("answers a server without a token fleet_token_required, and a page of another site invalid_origin", async () => {
    const ctx = await nativeServer();
    expect(await code(await ctx.get({ ...FLEET_TEST_AUTH, origin: "https://evil.example" }))).toEqual([403, "invalid_origin"]);
    const tokenless = fleetTestServer({ token: "", portal: undefined });
    cleanups.push(() => tokenless.close());
    turnFleetOn(tokenless.stateDir);
    expect(await code(await fetch(`http://127.0.0.1:${tokenless.app.port}${ctx.path}`))).toEqual([409, "fleet_token_required"]);
  });

  it("refuses an unknown machine 404 and one it cannot reach 409 machine_unreachable with the cause its row shows", async () => {
    const online = await nativeServer();
    expect(await code(await online.get(FLEET_TEST_AUTH, `/api/fleet/machines/${"0".repeat(32)}/native`))).toEqual([404, "unknown_machine"]);
    expect(await code(await fetch(`${online.base}${online.path}`, { method: "POST", headers: { ...FLEET_TEST_AUTH, "x-herdr-update": "1", origin: online.base } }))).toEqual([405, "method_not_allowed"]);
    for (const [label, options, cause] of [
      ["offline", { signIn: false }, "offline"],
      ["pending", { signIn: false, state: "pending" }, "pending_confirmation"],
      // signed in and advertising a bearer, but not confirmed yet
      ["pending and online", { state: "pending" }, "pending_confirmation"],
      ["without a runtime", { endpoints: ["bridge"] }, "runtime_down"],
    ] as const) {
      const ctx = await nativeServer(options);
      const answer = await ctx.get();
      const body = (await answer.json()) as { error: { code: string; cause: string; message: string } };
      expect([answer.status, body.error.code, body.error.cause], label).toEqual([409, "machine_unreachable", cause]);
      expect(JSON.stringify(body)).not.toContain(BEARER);
    }
  });

  it("writes no bearer to the server's log", async () => {
    const ctx = await nativeServer();
    const written: string[] = [];
    const spies = [spyOn(console, "log"), spyOn(console, "error"), spyOn(console, "warn"), spyOn(console, "info")]
      .map((spy) => spy.mockImplementation((...args: unknown[]) => { written.push(args.map(String).join(" ")); }));
    const streams = [spyOn(process.stdout, "write"), spyOn(process.stderr, "write")]
      .map((spy) => spy.mockImplementation((chunk: unknown) => { written.push(String(chunk)); return true; }));
    try {
      expect((await ctx.get()).status).toBe(200);
      expect((await ctx.get({})).status).toBe(401);
    } finally { for (const spy of [...spies, ...streams]) spy.mockRestore(); }
    expect(written.join("\n")).not.toContain(BEARER);
  });
});
