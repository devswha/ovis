/**
 * `ovis-link run` (crates/fleet-link, todo 24) against a TypeScript controller: a RelaySession with the fleet extension
 * (server/relay/session.ts) on a server started with `port: 0` and a temp state folder, reached through a direct carrier
 * stand-in (what server/relay/direct.ts speaks: `/v1/ws`, `assigned`, then the Noise records), a relay stand-in that
 * records every frame it passes, and the real Bun relay (relay/bun.ts) with the controller signed in as its PC. The agent
 * reads only its state folder: fleet.json, advert.json and its machine key.
 *
 * Runs on the binary OVIS_LINK_BIN names (missing: a failure), else on the release build of the crate (missing: skipped).
 * Every wait is on an event (a sign-in, a status write, a connection) with a bound; the one timed window measures the
 * agent's CPU while nothing answers, where time is what is measured.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { startBunRelay } from "../../relay/bun.ts";
import { generateKeyPair, openDaemonSecureChannel, type Transport } from "../../shared/relay-e2ee.ts";
import { MuxStreamError } from "../../shared/relay-mux-engine.ts";
import type { Machine } from "../../shared/machines.ts";
import { answerServerChallenge, deriveServerId } from "../../shared/relay-server-proof.ts";
import type { MachineManager } from "../machines.ts";
import { RelaySession } from "../relay/session.ts";
import { bounded, deferred, relayFixture } from "../relay/test-helpers.ts";
import { machineFingerprint } from "./mux-ext.ts";
import type { PipeAdvert, PipeStream } from "./mux-ext.ts";
import type { Fleet } from "./sessions.ts";
import { memoryDirectory, testOwner } from "./test-helpers.ts";
import { FLEET_TEST_AUTH, fleetTestServer } from "./test-server.ts";

const BUILD = join(import.meta.dir, "..", "..", "crates", "fleet-link", "target", "release", "ovis-link");
const BINARY = process.env["OVIS_LINK_BIN"] ?? BUILD;
const AUTH = 0x03;
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), "ovis-link-run-"));
  chmodSync(dir, 0o700);
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function listen(server: Server): Promise<number> {
  cleanups.push(() => { server.close(); });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
}

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const server = createServer();
  const port = await new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
  await new Promise((resolve) => server.close(resolve));
  return port;
}

interface ServedSession { readonly session: RelaySession; readonly frames: number[]; readonly ended: Promise<string> }

/** The controller: a fleet of one machine, and a Noise responder with a RelaySession on every carrier handed to it. */
async function controller() {
  const fixture = relayFixture();
  cleanups.push(() => fixture.close());
  const keys = generateKeyPair();
  const serverId = deriveServerId(keys.publicKey);
  const machine = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const scalar = Buffer.from((await crypto.subtle.exportKey("jwk", machine.privateKey)).d!, "base64url");
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", machine.publicKey));
  const machineId = machineFingerprint(spki);
  const fleet = memoryDirectory([{ machine_id: machineId, public_key: Buffer.from(spki).toString("base64url"), state: "active" }]);
  /** every frame type the controller decrypted from the machine, across all its sessions */
  const frames: number[] = [];
  const sessions: ServedSession[] = [];
  const adverts: PipeAdvert[] = [];
  let advertWaiters: { count: number; resolve: () => void }[] = [];
  const signedIn: (() => void)[] = [];
  const serve = (transport: Transport): void => {
    let session: RelaySession | undefined;
    const ended = deferred<string>();
    void openDaemonSecureChannel(transport, {
      daemonKeyPair: keys,
      events: { onmessage: (data) => { frames.push(new Uint8Array(data as ArrayBuffer)[1]!); session?.receive(data); } },
    }).then((channel) => {
      session = new RelaySession({
        channel, services: fixture.app.context.services, port: fixture.app.port, serverId,
        serverVersion: "0.5.0", minSupportedClient: "0.4.21", routingOverhead: 0, maxWireMessageBytes: 256 * 1024, fleet,
        onClose: (code) => ended.resolve(code),
      });
      const receive = session.receive.bind(session);
      let last: PipeAdvert | undefined;
      session.receive = (data) => {
        receive(data);
        const advert = session!.pipeAdvert;
        if (advert && advert !== last) {
          last = advert;
          adverts.push(advert);
          for (const waiter of advertWaiters.filter((entry) => adverts.length >= entry.count)) waiter.resolve();
          advertWaiters = advertWaiters.filter((entry) => adverts.length < entry.count);
          for (const done of signedIn.splice(0)) done();
        }
      };
      sessions.push({ session, frames, ended: ended.promise });
    }).catch(() => transport.close(1011, "handshake failed"));
  };
  return {
    fixture, keys, serverId, scalar, spki, machineId, fleet, frames, sessions, adverts, serve,
    /** Resolves once `count` adverts in all have come. */
    advert(count = adverts.length + 1): Promise<PipeAdvert> {
      if (adverts.length >= count) return Promise.resolve(adverts[count - 1]!);
      return new Promise((resolve) => advertWaiters.push({ count, resolve: () => resolve(adverts[count - 1]!) }));
    },
    latest(): RelaySession { return sessions.at(-1)!.session; },
  };
}
type Controller = Awaited<ReturnType<typeof controller>>;

interface Carrier { url: string; port: number; connections: number; recorded: (string | Uint8Array)[]; close(): void; arrived: Promise<number> }

/**
 * A WebSocket listener on 127.0.0.1 that speaks to a client as server/relay/direct.ts and the relay do: `assigned`
 * first, then each frame to the controller. `relay` checks the query a relay client sends and records every frame.
 */
function carrier(c: Controller, kind: "direct" | "relay"): Carrier {
  type Data = { transport: Transport };
  const sockets = new Set<ServerWebSocket<Data>>();
  const first = deferred<number>();
  const state: Carrier = {
    url: "", port: 0, connections: 0, recorded: [], arrived: first.promise,
    close() { for (const socket of sockets) socket.close(1001, "controller restart"); },
  };
  const server = Bun.serve<Data>({
    hostname: "127.0.0.1", port: 0,
    fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname !== "/v1/ws") return new Response(null, { status: 404 });
      const query = Object.fromEntries(url.searchParams);
      const expected = kind === "relay" ? { server_id: c.serverId, role: "client", v: "1", lane: "paced" } : { v: "1" };
      if (JSON.stringify(query) !== JSON.stringify(expected)) return new Response(null, { status: 400 });
      return server.upgrade(request, { data: { transport: undefined as unknown as Transport } }) ? undefined : new Response(null, { status: 426 });
    },
    websocket: {
      maxPayloadLength: 2 * 1024 * 1024,
      open(socket) {
        sockets.add(socket);
        state.connections++;
        first.resolve(performance.now());
        const transport: Transport = {
          onmessage: null, onclose: null, onerror: null,
          send: (data) => { if (kind === "relay") state.recorded.push(typeof data === "string" ? data : new Uint8Array(data)); socket.send(data); },
          close: (code, reason) => socket.close(code, reason),
        };
        socket.data.transport = transport;
        socket.send(JSON.stringify({ type: "assigned", connection_id: randomBytes(16).toString("hex") }));
        c.serve(transport);
      },
      message(socket, message) {
        const data = typeof message === "string" ? message : message.buffer.slice(message.byteOffset, message.byteOffset + message.byteLength) as ArrayBuffer;
        if (kind === "relay") state.recorded.push(typeof message === "string" ? message : new Uint8Array(message));
        socket.data.transport.onmessage?.({ data, isBinary: typeof message !== "string" });
      },
      close(socket, code, reason) { sockets.delete(socket); socket.data.transport.onclose?.(code, reason); },
    },
  });
  cleanups.push(() => { server.stop(true); });
  state.port = server.port!;
  state.url = `ws://127.0.0.1:${server.port}`;
  return state;
}

/** The controller as the real Bun relay's PC: its control socket and a data socket per client, each proven. */
async function behindBunRelay(c: Controller) {
  const relay = startBunRelay({ port: 0, hostname: "127.0.0.1" });
  cleanups.push(() => relay.stop());
  const base = `ws://127.0.0.1:${relay.port}/v1/ws?server_id=${c.serverId}&role=server&v=1&proof=1&public_key=${hex(c.keys.publicKey)}`;
  const lanes: string[] = [];
  const open = (connectionId: string | null): WebSocket => {
    const socket = new WebSocket(connectionId ? `${base}&connection_id=${connectionId}` : base);
    socket.binaryType = "arraybuffer";
    cleanups.push(() => socket.close());
    let proven = false;
    let transport: Transport | undefined;
    socket.onmessage = (event) => {
      if (!proven) {
        const answer = answerServerChallenge(event.data, c.keys.secretKey, { server_id: c.serverId, role: connectionId ? "data" : "control", connection_id: connectionId });
        if (!answer) { socket.close(); return; }
        socket.send(answer);
        proven = true;
        if (connectionId) {
          transport = { onmessage: null, onclose: null, onerror: null, send: (data) => socket.send(data), close: (code, reason) => socket.close(code, reason) };
          c.serve(transport);
        }
        return;
      }
      if (connectionId) { transport?.onmessage?.({ data: event.data, isBinary: typeof event.data !== "string" }); return; }
      const value = JSON.parse(String(event.data)) as { type: string; connection_id?: string; connection_ids?: string[]; lane?: string };
      if (value.type === "connected" && value.connection_id) { lanes.push(value.lane ?? "default"); open(value.connection_id); }
      if (value.type === "sync") for (const id of value.connection_ids ?? []) open(id);
    };
    socket.onclose = (event) => transport?.onclose?.(event.code, event.reason);
    return socket;
  };
  const control = open(null);
  await bounded(new Promise((resolve) => { control.addEventListener("open", resolve, { once: true }); }));
  return { url: `ws://127.0.0.1:${relay.port}`, lanes };
}

interface Agent { dir: string; child: ReturnType<typeof Bun.spawn>; status(): Promise<Record<string, unknown>>; statusText(): Promise<string>; until(test: (status: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>; stderr(): Promise<string> }

function writePrivate(path: string, contents: string | Uint8Array): void {
  writeFileSync(`${path}.tmp`, contents, { mode: 0o600 });
  Bun.spawnSync(["mv", `${path}.tmp`, path]);
}

/** A state folder for `c`: the machine key, fleet.json naming `carriers`, and advert.json when given. */
function stateFolder(c: Controller, carriers: { relay?: string | null; direct?: string[] }, advert?: object, pin = c.keys.publicKey, serverId = c.serverId): string {
  const dir = folder();
  writeFileSync(join(dir, "machine.key"), c.scalar, { mode: 0o600 });
  writePrivate(join(dir, "fleet.json"), JSON.stringify({
    v: 1, controller: { server_id: serverId, server_public_key: Buffer.from(pin).toString("base64"), relay: carriers.relay ?? null, direct: carriers.direct ?? [] },
    owner: testOwner({ server_id: deriveServerId(pin), server_public_key: Buffer.from(pin).toString("base64") }),
    machine_key_file: join(dir, "machine.key"),
  }));
  if (advert) writePrivate(join(dir, "advert.json"), JSON.stringify(advert));
  return dir;
}

async function statusOf(dir: string): Promise<{ code: number; text: string }> {
  const child = Bun.spawn([BINARY, "status", "--state", dir, "--json"], { stdout: "pipe", stderr: "pipe" });
  const [code, text] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  return { code, text: text.trim() };
}

function run(dir: string): Agent {
  const child = Bun.spawn([BINARY, "run", "--state", dir], { stdout: "pipe", stderr: "pipe" });
  cleanups.push(async () => { if (child.exitCode === null) { child.kill(); await child.exited; } });
  const read = async () => JSON.parse((await statusOf(dir)).text) as Record<string, unknown>;
  return {
    dir, child, status: read, statusText: async () => (await statusOf(dir)).text,
    /** Resolves with the first status that passes `test`, looked at again on every write of status.json. */
    async until(test) {
      const watcher = watch(dir);
      try {
        const changed = (): Promise<void> => new Promise((resolve) => watcher.once("change", () => resolve()));
        return await bounded((async () => {
          for (;;) {
            const next = changed();
            const status = await read();
            if (test(status)) return status;
            await next;
          }
        })(), 10_000);
      } finally { watcher.close(); }
    },
    stderr: () => new Response(child.stderr as ReadableStream).text(),
  };
}

/** The machine's bridge stand-in: an echo server, and every byte it was sent. */
async function echoBridge() {
  const received: Buffer[] = [];
  const server = createServer((socket: Socket) => { socket.on("error", () => {}); socket.on("data", (data) => { received.push(data); socket.write(data); }); socket.on("end", () => socket.end()); });
  const port = await listen(server);
  return { port, received };
}

const advertFile = (bridgePort: number, change: Record<string, unknown> = {}) => ({
  v: 1, runtime_id: "rt-lifecycle", boot_id: "boot-1", bridge_port: bridgePort, bridge_token: randomBytes(32).toString("hex"),
  native_bearer: `ovb_${randomBytes(24).toString("base64url")}`, runtime_down: false, versions: { server: "0.5.0", agent: "0.5.0", runtime: "0.9.1" }, ...change,
});

async function openPipe(session: RelaySession, endpoint: string): Promise<PipeStream> {
  const pipe = session.openPipe(endpoint);
  const answered = deferred<void>();
  pipe.onAccept = () => answered.resolve();
  pipe.onDispose = (error) => answered.reject(error ?? new MuxStreamError("cancelled"));
  await bounded(answered.promise);
  return pipe;
}

const forms = (secret: Uint8Array) => [hex(secret), Buffer.from(secret).toString("base64"), Buffer.from(secret).toString("base64url")];
function holds(recorded: (string | Uint8Array)[], needle: Uint8Array): boolean {
  return recorded.some((frame) => typeof frame === "string"
    ? forms(needle).some((form) => frame.includes(form)) || frame.includes(Buffer.from(needle).toString("latin1"))
    : Buffer.from(frame).indexOf(Buffer.from(needle)) >= 0);
}

describe.skipIf(process.env["OVIS_LINK_BIN"] === undefined && !existsSync(BUILD))("ovis-link run against a TypeScript controller", () => {
  it("finds the binary it was given", () => {
    expect(existsSync(BINARY), `${BINARY} does not exist: build it with cargo build --release --manifest-path crates/fleet-link/Cargo.toml`).toBe(true);
  });

  it("signs in on a direct carrier, advertises, and reports connected direct", async () => {
    const c = await controller();
    const direct = carrier(c, "direct");
    const relay = carrier(c, "relay");
    const bridge = await echoBridge();
    const advert = advertFile(bridge.port);
    const agent = run(stateFolder(c, { relay: relay.url, direct: [direct.url] }, advert));
    const sent = await bounded(c.advert());
    expect(sent).toMatchObject({ endpoints: ["bridge", "native"], runtime_id: "rt-lifecycle", boot_id: "boot-1", bridge_token: advert.bridge_token, health: { runtime: "up", bridge: "up" } });
    const status = await agent.until((s) => s["state"] === "connected");
    expect(await agent.statusText()).toContain(`"state":"connected","path":"direct"`);
    expect(status).toMatchObject({ peer: c.serverId, machine_id: c.machineId, advert: "ok", error: null });
    expect(relay.connections).toBe(0);
  });

  it("reconnects after the controller closes the socket and sends PIPE_ADVERT again", async () => {
    const c = await controller();
    const direct = carrier(c, "direct");
    run(stateFolder(c, { direct: [direct.url] }, advertFile((await echoBridge()).port)));
    const first = await bounded(c.advert(1));
    direct.close();
    // the first wait after a loss is at most 1 s
    const second = await bounded(c.advert(2), 5_000);
    expect(direct.connections).toBe(2);
    expect(second.boot_id).toBe(first.boot_id);
    expect(c.sessions.length).toBe(2);
  });

  it("uses the relay when no direct carrier answers within 1.5 s, and a canary through a pipe never shows on the relay", async () => {
    const c = await controller();
    const relay = carrier(c, "relay");
    // accepts the TCP connection and never answers the upgrade
    const silent = createServer((socket) => { socket.on("error", () => {}); });
    const silentPort = await listen(silent);
    const bridge = await echoBridge();
    const advert = advertFile(bridge.port);
    const started = performance.now();
    const agent = run(stateFolder(c, { relay: relay.url, direct: [`ws://127.0.0.1:${silentPort}`] }, advert));
    const reached = await bounded(relay.arrived, 5_000);
    expect(reached - started).toBeGreaterThanOrEqual(1_400);
    await bounded(c.advert());
    await agent.until((s) => s["state"] === "connected");
    expect(await agent.statusText()).toContain(`"state":"connected","path":"relay"`);

    const canary = new TextEncoder().encode(`canary-${randomBytes(16).toString("hex")}`);
    const pipe = await openPipe(c.latest(), "bridge");
    const chunks: Uint8Array[] = [];
    const echoed = (async () => { for await (const chunk of pipe.readable) { chunks.push(chunk); if (Buffer.concat(chunks).length >= canary.length) return; } })();
    await pipe.write(canary);
    await bounded(echoed);
    expect(Buffer.concat(chunks).equals(Buffer.from(canary))).toBe(true);
    expect(Buffer.concat(bridge.received).equals(Buffer.from(canary))).toBe(true);
    expect(relay.recorded.length).toBeGreaterThan(5);
    for (const secret of [canary, Buffer.from(advert.bridge_token, "hex"), new TextEncoder().encode(advert.native_bearer), c.scalar]) {
      expect(holds(relay.recorded, secret)).toBe(false);
    }
  }, 20_000);

  it("signs in through the real Bun relay as a paced client", async () => {
    const c = await controller();
    const relay = await behindBunRelay(c);
    const agent = run(stateFolder(c, { relay: relay.url }, advertFile((await echoBridge()).port)));
    await bounded(c.advert(), 10_000);
    expect(relay.lanes).toEqual(["paced"]);
    await agent.until((s) => s["state"] === "connected");
    expect(await agent.statusText()).toContain(`"state":"connected","path":"relay"`);
  }, 20_000);

  it("replaces the advert mid-session when advert.json changes, and says bridge down when its port does not accept", async () => {
    const c = await controller();
    const direct = carrier(c, "direct");
    const bridge = await echoBridge();
    const first = advertFile(bridge.port);
    const agent = run(stateFolder(c, { direct: [direct.url] }, first));
    await bounded(c.advert(1));
    const pipe = await openPipe(c.latest(), "native").catch((error: unknown) => error);
    // no runtime listens at the resolved socket: refused or reset, the session stays
    expect(pipe).toBeDefined();
    const restarted = { ...first, boot_id: "boot-2", native_bearer: `ovb_${randomBytes(24).toString("base64url")}`, bridge_port: await closedPort() };
    writePrivate(join(agent.dir, "advert.json"), JSON.stringify(restarted));
    const second = await bounded(c.advert(2), 5_000);
    expect(second).toMatchObject({ boot_id: "boot-2", native_bearer: restarted.native_bearer, health: { bridge: "down", runtime: "up" } });
    expect(c.sessions.length).toBe(1);
    writePrivate(join(agent.dir, "advert.json"), JSON.stringify({ ...restarted, runtime_down: true }));
    expect((await bounded(c.advert(3), 5_000)).health).toEqual({ runtime: "down", bridge: "down" });
  });

  it("a bridge-only advert.json: the machine's roster row connects, through a pipe to its bridge", async () => {
    const c = await controller();
    // the controller's own fleet and roster (server/machines.ts) on a server started with port: 0, holding c's machine
    const fixture = fleetTestServer({ stateDir: folder() });
    cleanups.push(() => fixture.close());
    const fleet: Fleet = fixture.app.context.services.relay.fleet;
    const manager: MachineManager = fixture.app.context.services.core.machines!;
    fleet.store.add({ machine_id: c.machineId, public_key: Buffer.from(c.spki).toString("base64url"), name: "Bridge only" });
    fleet.store.setState(c.machineId, "active");
    const served = { ...c, serve: (transport: Transport) => {
      let session: RelaySession | undefined;
      void openDaemonSecureChannel(transport, { daemonKeyPair: c.keys, events: { onmessage: (data) => session?.receive(data) } }).then((channel) => {
        session = new RelaySession({
          channel, services: fixture.app.context.services, port: fixture.app.port, serverId: c.serverId, serverVersion: "0.5.0",
          minSupportedClient: "0.4.21", routingOverhead: 0, maxWireMessageBytes: 256 * 1024, fleet, machineSessions: fleet,
        });
      }).catch(() => transport.close(1011, "handshake failed"));
    } };
    const direct = carrier(served, "direct");
    // the machine's bridge stand-in: answers the roster's questions for its token only
    const token = randomBytes(32).toString("hex");
    const asked: string[] = [];
    const bridge = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch(request, bun) {
        if (request.headers.get("authorization") !== `Bearer ${token}`) return new Response(null, { status: 401 });
        const path = new URL(request.url).pathname;
        asked.push(path);
        if (request.headers.get("upgrade")?.toLowerCase() === "websocket") return bun.upgrade(request) ? undefined : new Response(null, { status: 400 });
        if (path === "/api/health") return Response.json({ herdr: { version: "0.9.1", protocol: 22 }, web_ui: { boot_id: "boot-bridge" } });
        if (path !== "/api/session") return new Response(null, { status: 404 });
        return Response.json({ snapshot: {
          version: "0.9.1", protocol: 22, agents: [], layouts: [], focused_pane_id: null,
          workspaces: [{ workspace_id: "w1", label: "Bridge only", number: 1, active_tab_id: "w1:t1", focused: false, agent_status: "unknown", pane_count: 1, tab_count: 1 }],
          tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "1", number: 1, focused: false, agent_status: "unknown", pane_count: 1 }],
          panes: [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", terminal_id: "t1", focused: false, agent_status: "unknown", cwd: "/", title: "Bridge only" }],
        } });
      },
      websocket: { message() {} },
    });
    cleanups.push(() => { bridge.stop(true); });
    const connected = bounded(new Promise<Machine>((resolve) => {
      const stop = manager.subscribe((event) => {
        const row = event.type === "machines" ? event.machines.find((machine) => machine.id === `fleet-${c.machineId}`) : undefined;
        if (row?.state === "connected") { queueMicrotask(() => stop()); resolve(row); }
      });
    }), 15_000);
    const { native_bearer: _bearer, ...bridgeOnly } = advertFile(bridge.port!, { bridge_token: token });
    run(stateFolder(served, { direct: [direct.url] }, bridgeOnly));

    const signedIn = deferred<void>();
    const unwatch = fleet.onSession(() => { if (fleet.advert(c.machineId)) signedIn.resolve(); });
    cleanups.push(unwatch);
    await bounded(signedIn.promise);
    expect(fleet.advert(c.machineId)).toMatchObject({ endpoints: ["bridge"], health: { runtime: "up", bridge: "up" } });
    const rows = (await (await fetch(`http://127.0.0.1:${fixture.app.port}/api/fleet/machines`, { headers: FLEET_TEST_AUTH })).json()) as { machines: { machine_id: string; cause: string | null }[] };
    expect(rows.machines.find((row) => row.machine_id === c.machineId)?.cause).toBeNull();
    const row = await connected;
    expect(row.fleet).toMatchObject({ machine_id: c.machineId, runtime_id: "rt-lifecycle", cause: null });
    expect(row.snapshot?.workspaces[0]?.label).toBe("Bridge only");
    expect(asked).toContain("/api/session");
  }, 30_000);

  it("dials nothing after auth_revoked, across a restart, until ovis-link rejoin", async () => {
    const c = await controller();
    const direct = carrier(c, "direct");
    const dir = stateFolder(c, { direct: [direct.url] }, advertFile((await echoBridge()).port));
    const first = run(dir);
    await bounded(c.advert(1));
    c.fleet.set(c.machineId, "revoked");
    expect(await bounded(c.sessions[0]!.ended)).toBe("auth_revoked");
    expect(await first.until((s) => s["state"] === "stopped")).toMatchObject({ error: "refused: auth_revoked (revoked)" });
    expect(readFileSync(join(dir, "stopped"), "utf8")).toBe("refused: auth_revoked (revoked)");
    first.child.kill();
    await first.child.exited;

    // a new agent on the same folder (a reboot, a service restart): stopped at once, and it dials nothing. The first
    // agent's status.json goes first, so the stopped state waited for is the second agent's own.
    rmSync(join(dir, "status.json"));
    const connections = direct.connections;
    const second = run(dir);
    await second.until((s) => s["state"] === "stopped");
    // fixed wait: that no dial happens is the behaviour, over two of the agent's 1 s looks at its state folder
    await Bun.sleep(2_500);
    expect(direct.connections).toBe(connections);
    expect(second.child.exitCode).toBeNull();

    c.fleet.set(c.machineId, "active");
    const rejoin = Bun.spawnSync([BINARY, "rejoin", "--state", dir]);
    expect(rejoin.exitCode).toBe(0);
    await bounded(c.advert(2), 5_000);
    expect(direct.connections).toBe(connections + 1);
  }, 20_000);

  it("stays stopped after auth_revoked when the stop mark cannot be written", async () => {
    const c = await controller();
    const direct = carrier(c, "direct");
    const dir = stateFolder(c, { direct: [direct.url] }, advertFile((await echoBridge()).port));
    const agent = run(dir);
    await bounded(c.advert(1));
    chmodSync(dir, 0o500);
    cleanups.push(() => chmodSync(dir, 0o700));
    c.fleet.set(c.machineId, "revoked");
    expect(await bounded(c.sessions[0]!.ended)).toBe("auth_revoked");
    const connections = direct.connections;
    // fixed wait: that no dial happens is the behaviour, over several of the agent's 1 s looks at its state folder
    await Bun.sleep(4_000);
    expect(direct.connections).toBe(connections);
    expect(existsSync(join(dir, "stopped"))).toBe(false);
    agent.child.kill();
    await agent.child.exited;
    expect(await agent.stderr()).toContain("ovis-link: stopped: authorization revoked; could not record it: the state folder is not writable\n");
  }, 20_000);

  it("never signs in with a pinned key that is not the controller's: no AUTH frame reaches the controller", async () => {
    const c = await controller();
    const direct = carrier(c, "direct");
    const other = generateKeyPair();
    // fleet.json's server_id with another key: refused before any dial
    const mismatched = stateFolder(c, { direct: [direct.url] }, undefined, other.publicKey);
    const refused = run(mismatched);
    expect(await bounded(refused.child.exited)).toBe(6);
    expect(await refused.stderr()).toBe("ovis-link: controller key mismatch\n");
    expect(JSON.parse((await statusOf(mismatched)).text)).toMatchObject({ state: "not_running", error: "controller key mismatch" });
    expect(direct.connections).toBe(0);

    // a consistent pin of another controller, dialed at this one's carrier: the handshake never completes
    const elsewhere = stateFolder(c, { direct: [direct.url] }, undefined, other.publicKey, deriveServerId(other.publicKey));
    const agent = run(elsewhere);
    const status = await agent.until((s) => s["error"] === "handshake refused");
    expect(status["state"]).not.toBe("connected");
    expect(direct.connections).toBeGreaterThanOrEqual(1);
    expect(c.frames).not.toContain(AUTH);
    expect(c.frames).toEqual([]);
  });

  it("exits with the documented codes", async () => {
    const c = await controller();
    const dir = stateFolder(c, { direct: [`ws://127.0.0.1:${await closedPort()}`] });
    const first = run(dir);
    await first.until((s) => s["state"] === "waiting" || s["state"] === "dialing");
    const second = Bun.spawnSync([BINARY, "run", "--state", dir]);
    expect(second.exitCode).toBe(7);
    expect(Bun.spawnSync([BINARY, "status", "--state", join(dir, "missing"), "--json"]).exitCode).toBe(8);
    expect(Bun.spawnSync([BINARY, "rejoin", "--state", join(dir, "missing")]).exitCode).toBe(8);
    expect(Bun.spawnSync([BINARY, "run"]).exitCode).toBe(2);
    writeFileSync(join(dir, "machine.key"), randomBytes(31), { mode: 0o600 });
    first.child.kill();
    await first.child.exited;
    expect(Bun.spawnSync([BINARY, "run", "--state", dir]).exitCode).toBe(6);
  });

  // the CPU count comes from /proc/<pid>/stat, which only Linux has; CI runs this file on ubuntu-24.04
  it.skipIf(process.platform !== "linux")("keeps trying within the backoff and barely uses the CPU while no controller answers", async () => {
    const c = await controller();
    const agent = run(stateFolder(c, { relay: `ws://127.0.0.1:${await closedPort()}`, direct: [`ws://127.0.0.1:${await closedPort()}`] }));
    await agent.until((s) => s["state"] === "waiting");
    const ticks = () => {
      const fields = readFileSync(`/proc/${agent.child.pid}/stat`, "utf8").split(") ")[1]!.split(" ");
      return Number(fields[11]) + Number(fields[12]);
    };
    const before = ticks();
    // fixed wait: time is what is measured here, the agent's CPU over 4 s of failed rounds
    await Bun.sleep(4_000);
    const used = ticks() - before;
    expect(used).toBeLessThanOrEqual(10);
    expect((await agent.status())["error"]).toBe("controller unreachable");
  }, 15_000);
});
