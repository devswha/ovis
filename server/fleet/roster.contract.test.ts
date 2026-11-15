/**
 * Fleet machines as PCs of the roster (server/machines.ts) on a server started with `port: 0` and a mkdtemp state
 * folder: machines sign in on live RelaySessions against that server's own fleet (test-helpers.ts machineConnection),
 * and each takes its `bridge` pipes to a stand-in bridge (Bun.serve on 127.0.0.1:0) that answers only the tokens it
 * was given, and logs which token asked for what.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { createServer as tcpServer } from "node:net";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FLEET_CAUSE_SENTENCE } from "../../shared/fleet-cause.ts";
import type { Machine } from "../../shared/machines.ts";
import { MachineRelay } from "../machine-relay.ts";
import { RemoteRedirectRefused } from "../machines.ts";
import type { MachineManager } from "../machines.ts";
import { bounded } from "../relay/test-helpers.ts";
import type { PipeAdvert } from "./mux-ext.ts";
import type { Fleet } from "./sessions.ts";
import { advertFrame, machineConnection, machineKey, pipeToTarget, testAdvert } from "./test-helpers.ts";
import { FLEET_TEST_AUTH, fleetTestServer } from "./test-server.ts";
import type { MachineKey } from "./test-helpers.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const linuxIt = it.skipIf(process.platform !== "linux");

/** A roster snapshot naming `name` in its one workspace and pane: a row shows whose bridge answered it. */
function snapshotOf(name: string) {
  return {
    version: "0.9.1", protocol: 22, agents: [], layouts: [], focused_pane_id: null,
    workspaces: [{ workspace_id: "w1", label: name, number: 1, active_tab_id: "w1:t1", focused: false, agent_status: "unknown", pane_count: 1, tab_count: 1 }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "1", number: 1, focused: false, agent_status: "unknown", pane_count: 1 }],
    panes: [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", terminal_id: "t1", focused: false, agent_status: "unknown", cwd: "/", title: name }],
  };
}

interface Asked { readonly path: string; readonly name: string; readonly upgrade: boolean }

/**
 * A stand-in machine bridge: each token it knows names a machine, whose roster it answers; any other token is 401.
 * `session` replaces the answer to /api/session (a redirect, say), `health` the answer to the nth /api/health.
 */
function standInBridge(tokens: ReadonlyMap<string, string>, session?: (name: string) => Response, health?: (name: string, nth: number) => Response | Promise<Response>) {
  const asked: Asked[] = [];
  const sockets = new Set<Bun.ServerWebSocket<{ name: string }>>();
  const watchers = new Set<() => void>();
  const changed = () => { for (const watch of [...watchers]) watch(); };
  let healths = 0;
  const server = Bun.serve<{ name: string }>({
    hostname: "127.0.0.1", port: 0, idleTimeout: 0,
    fetch(request, bun) {
      const given = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
      const name = given === undefined ? undefined : tokens.get(given);
      if (name === undefined) return new Response(null, { status: 401 });
      const path = new URL(request.url).pathname;
      const upgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket";
      asked.push({ path, name, upgrade });
      changed();
      if (upgrade) return bun.upgrade(request, { data: { name } }) ? undefined : new Response(null, { status: 400 });
      if (path === "/api/session") return session?.(name) ?? Response.json({ snapshot: snapshotOf(name) });
      if (path === "/api/health" && health) return health(name, ++healths);
      if (path === "/api/health") return Response.json({ herdr: { version: "0.9.1", protocol: 22 }, web_ui: { boot_id: `boot-${name}` } });
      return new Response(null, { status: 404 });
    },
    websocket: { open(ws) { sockets.add(ws); changed(); }, message() {}, close(ws) { sockets.delete(ws); changed(); } },
  });
  cleanups.push(() => server.stop(true));
  /** Resolves once `n` sockets are open at this bridge, as they open and close. */
  const holding = (n: number): Promise<void> => bounded(new Promise<void>((resolve) => {
    const watch = () => { if (sockets.size === n) { watchers.delete(watch); resolve(); } };
    watchers.add(watch);
    watch();
  }));
  /** Resolves once the bridge was asked for something `check` matches. */
  const askedFor = (check: (asked: Asked[]) => boolean): Promise<void> => bounded(new Promise<void>((resolve) => {
    const watch = () => { if (check(asked)) { watchers.delete(watch); resolve(); } };
    watchers.add(watch);
    watch();
  }));
  return { port: server.port!, asked, sockets, holding, askedFor };
}

async function controller(before?: (stateDir: string) => void) {
  const stateDir = mkdtempSync(join(tmpdir(), "fleet-roster-"));
  before?.(stateDir);
  const fixture = fleetTestServer({ stateDir });
  cleanups.push(() => fixture.close());
  const fleet: Fleet = fixture.app.context.services.relay.fleet;
  const manager: MachineManager = fixture.app.context.services.core.machines!;
  return {
    fixture, fleet, manager, stateDir,
    origin: `http://127.0.0.1:${fixture.app.port}`,
    async enrol(name: string): Promise<MachineKey> {
      const key = await machineKey();
      fleet.store.add({ machine_id: key.id, public_key: key.spki, name });
      fleet.store.setState(key.id, "active");
      return key;
    },
    /** `key` signed in, its advert sent and read; its bridge pipes go to `bridge`. */
    async signIn(key: MachineKey, advert: PipeAdvert, bridge: number) {
      const connection = await machineConnection(fixture, fleet, { machineSessions: fleet }, { onPipe: (pipe) => pipeToTarget(pipe, bridge) });
      await connection.hello();
      await connection.signIn(key);
      connection.mux.enqueueControl(advertFrame(advert));
      await bounded(connection.mux.measure());
      return connection;
    },
    /** Resolves once the roster, as its events tell it, satisfies `check`. */
    until(check: (machines: Machine[]) => boolean, ms = 15_000): Promise<Machine[]> {
      return bounded(new Promise<Machine[]>((resolve) => {
        const stop = manager.subscribe((event) => {
          if (event.type !== "machines" || !check(event.machines)) return;
          queueMicrotask(() => stop());
          resolve(event.machines);
        });
      }), ms);
    },
  };
}

const advertFor = (token: string, runtime = "rt-test"): PipeAdvert => ({ ...testAdvert(["bridge"]), runtime_id: runtime, bridge_token: token });
const rowOf = (machines: Machine[], key: MachineKey) => machines.find((machine) => machine.id === `fleet-${key.id}`);
const token = () => randomBytes(32).toString("hex");

/** How many processes `pgrep -c` counts with `args`. */
async function pgrep(...args: string[]): Promise<number> {
  const run = Bun.spawn(["pgrep", "-c", ...args], { stdout: "pipe" });
  const text = await new Response(run.stdout).text();
  await run.exited;
  return Number(text.trim());
}
/** The child processes of this process. */
const children = () => pgrep("-P", String(process.pid));

/** This process's listening sockets: TCP (IPv4 and IPv6) and Unix stream, by the inodes of its open descriptors. */
function listeners(): { tcp: number; unix: number; fds: number } {
  const inodes = new Set<string>();
  const fds = readdirSync("/proc/self/fd");
  for (const fd of fds) {
    try { const link = readlinkSync(`/proc/self/fd/${fd}`); const inode = /^socket:\[(\d+)\]$/.exec(link)?.[1]; if (inode) inodes.add(inode); } catch { /* closed meanwhile */ }
  }
  const listening = (file: string, column: number, state: (fields: string[]) => boolean) => readFileSync(file, "utf8").split("\n").slice(1)
    .map((line) => line.trim().split(/\s+/)).filter((fields) => fields.length > column && state(fields) && inodes.has(fields[column]!)).length;
  const tcp = ["/proc/self/net/tcp", "/proc/self/net/tcp6"].filter(existsSync).reduce((total, file) => total + listening(file, 9, (fields) => fields[3] === "0A"), 0);
  // a listening Unix stream socket: flags __SO_ACCEPTCON (00010000), state 01
  const unix = listening("/proc/self/net/unix", 6, (fields) => fields[3] === "00010000" && fields[4] === "0001");
  return { tcp, unix, fds: fds.length };
}

/** Another host a redirect could name: it counts every request that reaches it. */
async function elsewhere() {
  const reached: { path: string; auth: string | null }[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) { reached.push({ path: new URL(request.url).pathname, auth: request.headers.get("authorization") }); return Response.json({ web_ui: { boot_id: "stolen" } }); } });
  cleanups.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}/stolen`, reached };
}
/** A roster as a real bridge sends it: with its server's order evidence, which has this server ask that bridge's /api/health. */
const ordered = (name: string) => Response.json({ snapshot: { ...snapshotOf(name), order_epoch: `boot-${name}`, read_seq: 1 } });

describe("fleet machines in the roster", () => {
  it("adds nothing to the roster or GET /api/machines while the fleet has no machine", async () => {
    const ctx = await controller();
    expect(ctx.manager.list().map((machine) => machine.kind)).toEqual(["local"]);
    const body = await (await fetch(`${ctx.origin}/api/machines`, { headers: FLEET_TEST_AUTH })).text();
    expect(body).not.toContain("fleet");
    expect((JSON.parse(body) as { machines: Machine[] }).machines.map((machine) => machine.id)).toEqual(["local"]);
  });

  it("makes a signed-in machine one connected row over its forward, and shows it Offline with its cause once its session drops", async () => {
    const ctx = await controller();
    const key = await ctx.enrol("Build box");
    const secret = token();
    const bridge = standInBridge(new Map([[secret, "Build box"]]));
    // enrolled but never signed in: a row, offline, that says why
    const offline = rowOf(await ctx.until((machines) => rowOf(machines, key) !== undefined), key)!;
    expect(offline).toMatchObject({ kind: "fleet", name: "Build box", state: "disconnected", fleet: { machine_id: key.id, runtime_id: null, cause: "offline" } });
    expect(offline.error).toBe(FLEET_CAUSE_SENTENCE.offline);
    expect(ctx.manager.endpoint(offline.id)).toBeUndefined();

    const connection = await ctx.signIn(key, advertFor(secret, "rt-build"), bridge.port);
    const connected = rowOf(await ctx.until((machines) => rowOf(machines, key)?.state === "connected"), key)!;
    expect(connected.snapshot?.workspaces[0]?.label).toBe("Build box");
    expect(connected.fleet).toEqual({ machine_id: key.id, runtime_id: "rt-build", cause: null });
    // the runtime id its advert named is the store's from now on (todo 26 names rows by it)
    expect(ctx.fleet.store.get(key.id)?.runtime_id).toBe("rt-build");
    // its status socket, over the forward, to its own bridge
    await bridge.holding(1);
    expect(bridge.asked.some((asked) => asked.upgrade && asked.path === "/ws")).toBe(true);
    // a terminal of that PC goes the same way
    const terminal = new MachineRelay(ctx.manager, connected.id, true, (snapshot) => snapshot);
    await bounded(terminal.ready);
    expect(bridge.sockets.size).toBe(2);
    const terminalClosed = new Promise<void>((resolve) => { const close = terminal.close.bind(terminal); terminal.close = (...args) => { close(...args); resolve(); }; });

    // every state the row passes through from the drop on: the fleet's own notice takes it offline, so no try to
    // reconnect (a timer and its "Reconnecting…") ever comes between
    const states: string[] = [];
    const stopWatching = ctx.manager.subscribe((event) => { if (event.type === "machines") states.push(rowOf(event.machines, key)!.state); });
    states.length = 0;
    connection.stop();
    const dropped = rowOf(await ctx.until((machines) => rowOf(machines, key)?.state === "disconnected"), key)!;
    stopWatching();
    expect(states).not.toContain("reconnecting");
    expect(dropped.error).toBe(FLEET_CAUSE_SENTENCE.offline);
    expect(dropped.fleet?.cause).toBe("offline");
    expect(ctx.manager.endpoint(dropped.id)).toBeUndefined();
    // its terminals end with it
    await bounded(terminalClosed);
    await bridge.holding(0);
  });

  it("lets each row reach only its own machine: roster, status socket, API routes and terminals", async () => {
    const ctx = await controller();
    const [keyA, keyB] = [await ctx.enrol("A"), await ctx.enrol("B")];
    const [secretA, secretB] = [token(), token()];
    // each bridge knows its own machine's token only
    const [bridgeA, bridgeB] = [standInBridge(new Map([[secretA, "A"]])), standInBridge(new Map([[secretB, "B"]]))];
    await ctx.signIn(keyA, advertFor(secretA, "rt-a"), bridgeA.port);
    await ctx.signIn(keyB, advertFor(secretB, "rt-b"), bridgeB.port);
    const machines = await ctx.until((list) => rowOf(list, keyA)?.state === "connected" && rowOf(list, keyB)?.state === "connected");
    expect(rowOf(machines, keyA)!.snapshot?.workspaces[0]?.label).toBe("A");
    expect(rowOf(machines, keyB)!.snapshot?.workspaces[0]?.label).toBe("B");
    // an API route of each PC
    for (const [key, name] of [[keyA, "A"], [keyB, "B"]] as const) {
      const response = await fetch(`${ctx.origin}/api/machines/fleet-${key.id}/session`, { headers: FLEET_TEST_AUTH });
      expect(response.status).toBe(200);
      expect(((await response.json()) as { snapshot: { workspaces: { label: string }[] } }).snapshot.workspaces[0]!.label).toBe(name);
    }
    // a terminal of each
    const terminals = [new MachineRelay(ctx.manager, `fleet-${keyA.id}`, true, (snapshot) => snapshot), new MachineRelay(ctx.manager, `fleet-${keyB.id}`, true, (snapshot) => snapshot)];
    await bounded(Promise.all(terminals.map((terminal) => terminal.ready)));
    for (const terminal of terminals) terminal.close();
    // a bridge answers only its token: any request of the other row would have been a 401 and failed its row
    expect(bridgeA.asked.every((asked) => asked.name === "A")).toBe(true);
    expect(bridgeB.asked.every((asked) => asked.name === "B")).toBe(true);
    expect(bridgeA.asked.map((asked) => asked.path)).toEqual(expect.arrayContaining(["/api/health", "/api/session", "/ws"]));
    expect(bridgeA.asked.filter((asked) => asked.upgrade).length).toBe(2);
    expect(bridgeB.asked.filter((asked) => asked.upgrade).length).toBe(2);
    expect(ctx.manager.list().filter((machine) => machine.kind === "fleet").map((machine) => machine.state)).toEqual(["connected", "connected"]);
  });

  it("never talks to whoever listens on a removed machine's old forward port", async () => {
    const ctx = await controller();
    const key = await ctx.enrol("Gone");
    const [secret, restarted] = [token(), token()];
    const bridge = standInBridge(new Map([[secret, "Gone"], [restarted, "Gone"]]));
    const connection = await ctx.signIn(key, advertFor(secret), bridge.port);
    const row = rowOf(await ctx.until((machines) => rowOf(machines, key)?.state === "connected"), key)!;
    expect(ctx.manager.endpoint(row.id)?.token).toBe(secret);
    // its bridge restarted with a new token: the row's endpoint is what the fleet says now, never one kept from before
    connection.mux.enqueueControl(advertFrame({ ...advertFor(restarted), boot_id: "boot-2" }));
    await bounded(connection.mux.measure());
    await ctx.until((machines) => rowOf(machines, key)?.state === "connected" && ctx.manager.endpoint(row.id) !== undefined);
    expect(ctx.manager.endpoint(row.id)?.token).toBe(restarted);
    const old = ctx.manager.endpoint(row.id)!;
    const port = Number(new URL(old.url).port);
    expect(port).toBe(ctx.fleet.forward(key.id)!.port);
    ctx.fleet.store.remove(key.id);
    await bounded(ctx.fleet.idle());
    // another machine's forward takes the port: here a listener that counts who connects to it
    const reached: Socket[] = [];
    const other = tcpServer((socket) => { reached.push(socket); socket.destroy(); });
    await new Promise<void>((resolve, reject) => { other.once("error", reject); other.listen(port, "127.0.0.1", resolve); });
    cleanups.push(() => other.close());
    await ctx.until((machines) => rowOf(machines, key) === undefined);
    expect(ctx.manager.endpoint(row.id)).toBeUndefined();
    ctx.manager.retryNow(row.id);
    // answered here as for any PC that is not connected
    expect((await fetch(`${ctx.origin}/api/machines/${row.id}/session`, { headers: FLEET_TEST_AUTH })).status).toBe(503);
    expect(() => new MachineRelay(ctx.manager, row.id, true, (snapshot) => snapshot)).toThrow("This PC is disconnected");
    expect(reached.length).toBe(0);
  });

  it("fails a row whose bridge answers with a redirect, with a typed error, and never follows it to this server", async () => {
    const ctx = await controller();
    const key = await ctx.enrol("Redirecting");
    const secret = token();
    const bridge = standInBridge(new Map([[secret, "Redirecting"]]), () => new Response(null, { status: 302, headers: { location: `${ctx.origin}/api/devices` } }));
    await ctx.signIn(key, advertFor(secret), bridge.port);
    const failed = rowOf(await ctx.until((machines) => rowOf(machines, key)?.state === "error"), key)!;
    expect(failed.error).toBe(new RemoteRedirectRefused(302).message);
    expect(bridge.asked.some((asked) => asked.path === "/api/session")).toBe(true);
    // this server's request log: nothing asked for its devices
    const log = readFileSync(`${ctx.stateDir}/http-requests.jsonl`, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { route: string });
    expect(log.some((line) => line.route.includes("devices"))).toBe(false);
  });

  it("fails a row whose bridge redirects /api/health, and sends nothing where the redirect points", async () => {
    const ctx = await controller();
    const key = await ctx.enrol("Health redirect");
    const secret = token();
    const outside = await elsewhere();
    const bridge = standInBridge(new Map([[secret, "Health redirect"]]), ordered, () => new Response(null, { status: 302, headers: { location: outside.url } }));
    await ctx.signIn(key, advertFor(secret), bridge.port);
    const failed = rowOf(await ctx.until((machines) => rowOf(machines, key)?.state === "error"), key)!;
    expect(failed.error).toBe(new RemoteRedirectRefused(302).message);
    expect(outside.reached).toEqual([]);
  });

  it("never follows a redirect of the source check's /api/health, which every ordered roster asks for", async () => {
    const ctx = await controller();
    const key = await ctx.enrol("Source check");
    const secret = token();
    const outside = await elsewhere();
    const redirect = Promise.withResolvers<void>();
    // the first health read (what runs its terminals) answers; the source check's is held, then redirected
    const bridge = standInBridge(new Map([[secret, "Source check"]]), ordered, async (_name, nth) => {
      if (nth === 1) return Response.json({ herdr: { version: "0.9.1", protocol: 22 }, web_ui: { boot_id: "boot-Source check" } });
      await redirect.promise;
      return new Response(null, { status: 302, headers: { location: outside.url } });
    });
    await ctx.signIn(key, advertFor(secret), bridge.port);
    const row = rowOf(await ctx.until((machines) => rowOf(machines, key)?.state === "connected"), key)!;
    await bridge.askedFor((asked) => asked.filter((one) => one.path === "/api/health").length === 2);
    // joins the check in flight, and settles only once it has read its answer
    const proof = ctx.manager.verifySourceBoot(row.id);
    redirect.resolve();
    expect(await bounded(proof)).toEqual({ refused: "unverified" });
    expect(outside.reached).toEqual([]);
    // the roster read with that evidence is not taken on the redirect's word
    expect(rowOf(ctx.manager.list(), key)!.snapshot).toBeNull();
  });

  it("shows the cause GET /api/fleet/machines gives, and follows it as it changes: a report, a refusal, the advert's health", async () => {
    const ctx = await controller();
    const key = await ctx.enrol("Causes");
    const secret = token();
    const bridge = standInBridge(new Map([[secret, "Causes"]]));
    const apiCause = async () => ((await (await fetch(`${ctx.origin}/api/fleet/machines`, { headers: FLEET_TEST_AUTH })).json()) as { machines: { machine_id: string; cause: string | null }[] })
      .machines.find((machine) => machine.machine_id === key.id)!.cause;
    const causeIs = async (cause: string | null, state: Machine["state"]) => {
      const row = rowOf(await ctx.until((machines) => rowOf(machines, key)?.fleet?.cause === cause && rowOf(machines, key)?.state === state), key)!;
      expect(row.error === null ? null : row.error).toBe(cause === null ? null : FLEET_CAUSE_SENTENCE[cause as keyof typeof FLEET_CAUSE_SENTENCE]);
      expect(await apiCause()).toBe(cause);
    };
    await causeIs("offline", "disconnected");
    // a cause a later todo reports (Fleet.report) reaches the row at once, and so does its clearing
    ctx.fleet.report(key.id, "relay_unreachable");
    await causeIs("relay_unreachable", "disconnected");
    ctx.fleet.report(key.id, null);
    await causeIs("offline", "disconnected");
    // a sign-in this controller had no place for
    ctx.fleet.refused(key.id, "controller_limit");
    await causeIs("controller_limit", "disconnected");
    // signed in: nothing stops it any more
    const connection = await ctx.signIn(key, advertFor(secret), bridge.port);
    await causeIs(null, "connected");
    // its advert says the Ovis server there is down: the row goes offline with that cause, then back once it is up
    connection.mux.enqueueControl(advertFrame({ ...advertFor(secret), health: { runtime: "up", bridge: "down" } }));
    await causeIs("bridge_down", "disconnected");
    connection.mux.enqueueControl(advertFrame({ ...advertFor(secret), boot_id: "boot-2" }));
    await causeIs(null, "connected");
  });

  it("merges a machine also added over SSH into that PC's one row naming both routes, and saves no fleet row", async () => {
    const serverId = randomBytes(16).toString("hex");
    const sshId = randomUUID();
    const ctx = await controller((stateDir) => writeFileSync(`${stateDir}/machines.json`, JSON.stringify([
      // disabled: no SSH connection is tried in a test
      { id: sshId, name: "Lab over SSH", enabled: false, target: { destination: "qa@lab.invalid" }, server_id: serverId, snapshot: null },
    ]), { mode: 0o600 }));
    const before = await children();
    const lab = await ctx.enrol("Lab");
    const solo = await ctx.enrol("Solo");
    const [labSecret, soloSecret] = [token(), token()];
    const bridge = standInBridge(new Map([[labSecret, "Lab"], [soloSecret, "Solo"]]));
    await ctx.signIn(lab, advertFor(labSecret, serverId), bridge.port);
    await ctx.signIn(solo, advertFor(soloSecret, "rt-solo"), bridge.port);
    const machines = await ctx.until((list) => list.find((machine) => machine.id === sshId)?.fleet !== undefined && rowOf(list, solo)?.state === "connected");
    // one row for the lab, the SSH one, naming its fleet route too
    expect(machines.filter((machine) => machine.id === sshId || machine.fleet?.machine_id === lab.id).map((machine) => ({ id: machine.id, kind: machine.kind, fleet: machine.fleet })))
      .toEqual([{ id: sshId, kind: "ssh", fleet: { machine_id: lab.id, runtime_id: serverId } }]);
    expect(rowOf(machines, lab)).toBeUndefined();
    // a save writes the registrations: the SSH PC as it was, no fleet row and no fleet route
    ctx.manager.patch(sshId, { name: "Lab" });
    const saved = JSON.parse(readFileSync(`${ctx.stateDir}/machines.json`, "utf8")) as Record<string, unknown>[];
    expect(saved.map((machine) => machine["id"])).toEqual([sshId]);
    expect(JSON.stringify(saved)).not.toContain("fleet");
    expect(existsSync(`${ctx.stateDir}/relay-pcs.json`)).toBe(false);
    // a fleet row is the fleet's: not renamed, turned off or removed here
    expect(() => ctx.manager.patch(`fleet-${solo.id}`, { name: "x" })).toThrow();
    expect(() => ctx.manager.remove(`fleet-${solo.id}`)).toThrow();
    // nothing started for any of them (no ssh, no bridge process)
    expect(await children()).toBe(before);
  });

  linuxIt("makes 100 machine sessions 100 rows with no child process and no listener beyond the forwards, and GET /api/machines answers within 500 ms at p95 over 200 calls", async () => {
    const ctx = await controller();
    const names = Array.from({ length: 100 }, (_, index) => `m${String(index).padStart(3, "0")}`);
    const secrets = names.map(() => token());
    const bridge = standInBridge(new Map(names.map((name, index) => [secrets[index]!, name])));
    const childrenBefore = await children();
    const sshBefore = await pgrep("ssh");
    const at = { ...listeners(), rss: process.memoryUsage().rss };
    const keys: MachineKey[] = [];
    for (const name of names) keys.push(await ctx.enrol(name));
    await bounded(ctx.fleet.idle());
    const enrolled = listeners();
    // a TCP forward and a Unix socket forward per machine, nothing else
    expect({ tcp: enrolled.tcp - at.tcp, unix: enrolled.unix - at.unix }).toEqual({ tcp: 100, unix: 100 });
    for (const [index, key] of keys.entries()) await ctx.signIn(key, advertFor(secrets[index]!, `rt-${names[index]}`), bridge.port);
    const machines = await ctx.until((list) => list.filter((machine) => machine.kind === "fleet" && machine.state === "connected").length === 100, 60_000);
    // each row shows its own machine's roster
    for (const [index, key] of keys.entries()) expect(rowOf(machines, key)!.snapshot?.workspaces[0]?.label).toBe(names[index]);
    const connected = { ...listeners(), rss: process.memoryUsage().rss };
    expect({ tcp: connected.tcp - at.tcp, unix: connected.unix - at.unix }).toEqual({ tcp: 100, unix: 100 });
    expect(await children()).toBe(childrenBefore);
    const sshAfter = await pgrep("ssh");
    const times: number[] = [];
    for (let call = 0; call < 200; call++) {
      const started = performance.now();
      const response = await fetch(`${ctx.origin}/api/machines`, { headers: FLEET_TEST_AUTH });
      const body = (await response.json()) as { machines: Machine[] };
      times.push(performance.now() - started);
      expect(body.machines.filter((machine) => machine.kind === "fleet").length).toBe(100);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.ceil(times.length * 0.95) - 1]!;
    console.log(JSON.stringify({
      fleet_rows: 100, children_before: childrenBefore, children_after: await children(), ssh_before: sshBefore, ssh_after: sshAfter,
      listeners_added: { tcp: connected.tcp - at.tcp, unix: connected.unix - at.unix }, fds_added: connected.fds - at.fds,
      rss_added_mib: Math.round((connected.rss - at.rss) / 1024 / 1024 * 10) / 10, machines_p95_ms: Math.round(p95 * 10) / 10,
    }));
    expect(p95).toBeLessThan(500);
  }, 120_000);
});
