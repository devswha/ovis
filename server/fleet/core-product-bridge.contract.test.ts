import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coreConnection, setRuntime } from "../herdr-core/runtime.ts";
import { loadRelayIdentity } from "../relay/identity.ts";
import { bounded, relayFixture } from "../relay/test-helpers.ts";
import { coreFixture } from "./core-test-helpers.ts";
import { startProductBridge } from "./product-bridge.ts";
import { Fleet } from "./sessions.ts";
import { FleetStore } from "./store.ts";
import { advertFrame, machineConnection, machineKey, pipeToTarget, testAdvert } from "./test-helpers.ts";

// This test runs in Bun; the UI tsconfig also supplies the narrower DOM constructor.
declare const WebSocket: new (url: string, options?: Bun.WebSocketOptions) => WebSocket;

const bin = process.env["OVIS_TEST_HC_BIN"];
const cleanups: (() => unknown)[] = [];
// A bridge settles this process's runtime and engine policy, also one whose start fails: the files
// after this one in the same bun process start from neither.
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); setRuntime(null, "ordinary"); });
function environment(env: Record<string, string>) {
  const before = { ...process.env };
  for (const name of Object.keys(process.env)) if (name.startsWith("HC_") || name.startsWith("OVIS_HC_") || name.startsWith("HERDR_REMOTE_")) delete process.env[name];
  Object.assign(process.env, env, { OVIS_RUNTIME: "herdr-core", OVIS_FLEET_BRIDGE: "1", OVIS_FLEET_HOME: join(env.HOME!, "fleet"), OVIS_STATE_DIR: join(env.HOME!, "own") });
  delete process.env["OVIS_FLEET_STATE"];
  cleanups.push(() => { for (const name of Object.keys(process.env)) if (!(name in before)) delete process.env[name]; Object.assign(process.env, before); });
}
async function bridge() {
  let tick!: () => Promise<void>;
  let checks = 0;
  const result = await startProductBridge({ recheck: (next) => { tick = next; return () => {}; }, onRecheck: () => checks++ });
  cleanups.push(() => result.stop());
  return { ...result, tick: () => tick(), checks: () => checks, get: (route: string, token = result.token) => fetch(`http://127.0.0.1:${result.port}${route}`, { headers: { authorization: `Bearer ${token}` } }) };
}
async function forward(bridge: Awaited<ReturnType<typeof startProductBridge>>, root: string) {
  const relay = relayFixture(); cleanups.push(() => relay.close());
  const stateDir = join(root, "controller");
  const store = new FleetStore({ stateDir });
  const fleet = new Fleet({ stateDir, store, tokenConfigured: true }); fleet.start(); cleanups.push(() => fleet.close());
  const key = await machineKey(); store.add({ machine_id: key.id, public_key: key.spki, name: "Core machine" }); store.setState(key.id, "active");
  const machine = await machineConnection(relay, fleet, { machineSessions: fleet }, { onPipe: (pipe) => pipeToTarget(pipe, bridge.port) }); cleanups.push(() => machine.stop());
  await machine.hello(); await machine.signIn(key);
  const disk = bridge.advert();
  machine.mux.enqueueControl(advertFrame({ ...testAdvert(["bridge"]), runtime_id: disk.runtime_id, boot_id: disk.boot_id, bridge_token: bridge.token, versions: { ...disk.versions, link: "test" } }));
  await bounded(machine.mux.measure());
  const endpoint = await fleet.forwardReady(key.id);
  if (!endpoint) throw new Error("No controller fleet forward");
  return { port: endpoint.port, get: (route: string) => fetch(`http://127.0.0.1:${endpoint.port}${route}`, { headers: { authorization: `Bearer ${bridge.token}` } }) };
}

describe.skipIf(!bin)("fleet bridge on an existing real herdr-core", () => {
  it("ordinary serve may start an absent core through hc connect without a bridge flag", async () => {
    if (!bin) throw new TypeError("Set OVIS_TEST_HC_BIN to run the real-core contract");
    const core = coreFixture(bin); cleanups.push(() => core.close());
    const native = core.env.HC_SOCKET; if (!native) throw new TypeError("Missing fixture socket");
    expect(existsSync(native)).toBe(false);
    const appeared = Promise.withResolvers<void>();
    const watcher = watch(join(core.root, "run/herdr-core"), () => { if (existsSync(native)) appeared.resolve(); });
    cleanups.push(() => watcher.close());
    const listening = Promise.withResolvers<string>();
    const token = crypto.randomUUID();
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../index.ts")], {
      env: { ...core.env, OVIS_RUNTIME: "herdr-core", OVIS_STATE_DIR: join(core.root, "ordinary"), HOST: "127.0.0.1", PORT: "0", OVIS_TOKEN: token },
      stdin: "ignore", stdout: "pipe", stderr: Bun.file(join(core.root, "ordinary.log")),
    });
    const reading = (async () => {
      let output = "";
      for await (const chunk of child.stdout) {
        output += new TextDecoder().decode(chunk);
        const match = /Ovis listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
        if (match?.[1]) listening.resolve(match[1]);
      }
    })();
    cleanups.push(async () => { child.kill(); await bounded(child.exited, 15_000); await reading; });
    const base = await bounded(listening.promise, 30_000);
    await bounded(appeared.promise);
    expect((await core.hc.hello()).version).toMatch(/^0\./);
    const response = await fetch(base + "/api/health", { headers: { authorization: "Bearer " + token } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ herdr: { runtime: "herdr-core" } });
  }, 60_000);

  it("forwards a pre-existing terminal and hc health, refuses auto-start after death, and keeps PC identity across restarts", async () => {
    const core = coreFixture(bin!); cleanups.push(() => core.close());
    environment(core.env);
    const own = loadRelayIdentity(process.env["OVIS_STATE_DIR"]!).server_id;
    const app = await bridge();
    expect(app.advert()).toMatchObject({ runtime_id: own, boot_id: "awaiting-herdr-core", runtime_down: true });
    expect(app.advert()).not.toHaveProperty("native_socket");
    expect(app.advert()).not.toHaveProperty("native_bearer");
    const forwarded = await forward(app, core.root);
    const socket = new WebSocket(`ws://127.0.0.1:${forwarded.port}/ws`, { headers: { authorization: `Bearer ${app.token}` } });
    cleanups.push(() => socket.close());
    const painted = Promise.withResolvers<void>(); const echoed = Promise.withResolvers<void>();
    let output = "";
    let observedPane: string | undefined;
    const reported = Promise.withResolvers<void>();
    socket.onmessage = (event) => { const frame = JSON.parse(String(event.data)); if (frame.type === "pane-status" && frame.pane_id === observedPane && frame.agent_status === "working") reported.resolve(); if (frame.type === "pty-data") { output += frame.data; if (output.includes("ready-for-fleet")) painted.resolve(); if (output.includes("got:typed-through-fleet")) echoed.resolve(); } };
    await bounded(new Promise<void>((resolve) => { socket.onopen = () => resolve(); }));
    await core.start();
    const pane = await core.hc.call("terminal.run", { argv: ["bash", "-c", "stty -echo; echo ready-for-fleet; while IFS= read -r line; do printf '\\033]7501;state=working:app=claude\\033\\\\'; printf 'got:%s\\n' \"$line\"; done"], cwd: core.env.HOME });
    observedPane = pane.address;
    await app.tick();
    await bounded(app.statusReady);
    await app.tick();
    expect(app.advert().runtime_down).toBe(false);
    expect(app.advert().versions.runtime).toMatch(/^herdr-core-\d/);
    const before = app.advert();
    const session = await (await forwarded.get("/api/session")).json() as { snapshot: { herdr_lifetime?: string; panes: { pane_id: string }[] } };
    expect(session.snapshot.panes.map((p) => p.pane_id)).toContain(pane.address);
    expect(session.snapshot.herdr_lifetime).toBe(before.boot_id);
    expect(await (await forwarded.get("/api/health")).json()).toMatchObject({ herdr: { runtime: "herdr-core", terminal_attach: true } });
    expect(await (await forwarded.get("/api/health?scope=bridge")).json()).toMatchObject({ fleet_bridge: { engine: "herdr-core", socket_path: core.env.HC_SOCKET, terminal_mode: "attach", runtime_down: false } });
    expect((await app.get("/api/session", "wrong")).status).toBe(401);
    socket.send(JSON.stringify({ type: "attach", pane_id: pane.address, cols: 90, rows: 27 })); await bounded(painted.promise);
    socket.send(JSON.stringify({ type: "input", pane_id: pane.address, text: "start-working\r" }));
    await bounded(reported.promise);
    const sized = Promise.withResolvers<void>();
    const subscription = await core.hc.open("events.subscribe", { terminal: pane.address }, { onData: (bytes) => { if (new TextDecoder().decode(bytes).includes('"cols":111')) sized.resolve(); }, onClose: () => {} });
    socket.send(JSON.stringify({ type: "resize", pane_id: pane.address, cols: 111, rows: 33 })); await bounded(sized.promise);
    await subscription.channel.close();
    expect(await core.hc.call("terminal.get", { terminal: pane.address })).toMatchObject({ cols: 111, rows: 33 });
    socket.send(JSON.stringify({ type: "input", pane_id: pane.address, text: "typed-through-fleet\r" })); await bounded(echoed.promise);
    socket.close();
    // Establish a live bridge line, then kill its engine. Every subsequent request must fail without hc auto-start.
    const lineEnded = Promise.withResolvers<void>();
    await coreConnection().open("events.subscribe", {}, { onData: () => {}, onClose: () => lineEnded.resolve() });
    core.killCore(); await bounded(lineEnded.promise);
    const spawn = spyOn(Bun, "spawn"); const sync = spyOn(Bun, "spawnSync");
    try {
      for (let n = 0; n < 5; n++) {
        await expect(coreConnection().call("terminal.list", {})).rejects.toThrow();
        await app.tick();
        expect((await forwarded.get("/api/session")).status).not.toBe(200);
      }
      const commands = [...spawn.mock.calls, ...sync.mock.calls].map((call) => call[0]);
      expect(commands.filter((argv) => Array.isArray(argv) && argv.some((arg) => ["connect", "serve", "hold", "server", "stop", "update"].includes(String(arg))))).toEqual([]);
    } finally { spawn.mockRestore(); sync.mockRestore(); }
    expect(app.advert().runtime_down).toBe(true);
    expect(await (await app.get("/api/health?scope=bridge")).json()).toMatchObject({ fleet_bridge: { reason: "hc_session_gone" } });
    await core.start(); await app.tick();
    expect(app.advert()).toMatchObject({ runtime_id: own, runtime_down: false });
    expect(app.advert().boot_id).not.toBe(before.boot_id);
    expect((await forwarded.get("/api/session")).status).toBe(200);
    const next = app.advert(); await app.stop();
    const restarted = await bridge();
    expect(restarted.advert()).toMatchObject({ runtime_id: own, boot_id: next.boot_id, runtime_down: false });
    expect(restarted.token).not.toBe(app.token);
    expect(await (await restarted.get("/api/session")).json()).toMatchObject({ snapshot: { herdr_lifetime: next.boot_id } });
    const state = join(core.env.HOME!, "fleet/state");
    for (const name of ["advert.json", "bridge.json", "runtime-id.json"]) expect(statSync(join(state, name)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(state, "bridge.json"), "utf8")).socket_path).toBe(core.env.HC_SOCKET);
    expect(existsSync(join(core.env.HOME!, ".config/herdr-web-ui/bridges"))).toBe(false);
  }, 60_000);

  it("discovers no or multiple cores without defaulting, then pins the only one", async () => {
    const core = coreFixture(bin!); cleanups.push(() => core.close());
    // The fixture's default is inside its independent HOME/XDG roots, not the account's default.
    // Its helper still refuses every hc invocation outside those roots.
    environment({ ...core.env, OVIS_ALLOW_LIVE_HERDR: "1" });
    delete process.env["HC_SOCKET"]; delete process.env["HC_SESSION"];
    core.env.HC_SESSION = "default"; core.env.HC_SOCKET = join(core.root, "run/herdr-core/default.sock");
    const app = await bridge(); expect(app.advert().runtime_down).toBe(true);
    await core.start();
    const first = core.env.HC_SOCKET;
    core.env.HC_SESSION = "fleet-second"; core.env.HC_SOCKET = join(core.root, "run/herdr-core/fleet-second.sock");
    await core.start(); await app.tick();
    expect(await (await app.get("/api/health?scope=bridge")).json()).toMatchObject({ fleet_bridge: { socket_path: null, reason: "hc_sessions_found" } });
    await expect(coreConnection().call("terminal.list", {})).rejects.toThrow();
    const ended = Promise.withResolvers<void>();
    await core.hc.open("events.subscribe", {}, { onData: () => {}, onClose: () => ended.resolve() });
    core.killCore(); await bounded(ended.promise);
    await app.tick();
    await bounded(app.statusReady);
    await app.tick();
    expect(await (await app.get("/api/health?scope=bridge")).json()).toMatchObject({ fleet_bridge: { socket_path: first, runtime_down: false } });
    await core.start(); await app.tick();
    expect(await (await app.get("/api/health?scope=bridge")).json()).toMatchObject({ fleet_bridge: { socket_path: first, runtime_down: false } });
  }, 60_000);

  it("serves the compiled remote entry, transcript, card and reported status through a controller while own Ovis shares the core", async () => {
    const { buildBinary } = await import("../../scripts/server-artifact.ts");
    const dir = mkdtempSync(join(tmpdir(), "fleet-core-compiled-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const binary = join(dir, "ovis-server");
    const platform = `${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch}` as import("../../scripts/server-manifest.ts").ServerPlatform;
    await buildBinary(platform, binary);
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../../scripts/fleet-core-coexistence-qa.ts")], {
      env: { HOME: dir, PATH: process.env["PATH"] ?? "/usr/bin:/bin", TMPDIR: tmpdir(), OVIS_TEST_HC_BIN: bin!, OVIS_QA_SERVER: binary, OVIS_QA_HTTP_ONLY: "1", UI_EVIDENCE_DIR: join(dir, "evidence") },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    cleanups.push(async () => { child.kill(); await child.exited; });
    const [output, errors] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(await child.exited, output + errors).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "evidence/coexistence.json"), "utf8"))).toMatchObject({ http: { transcript: true, card_answer: true, osc_status: true }, "one-then-two": { both_live: true, both_type: true, held: false }, "two-then-one": { both_live: true, both_type: true, held: false } });
  }, 90_000);

  it("refuses a symlink selector in health and in every background core connection", async () => {
    const core = coreFixture(bin!); cleanups.push(() => core.close()); await core.start();
    const alias = join(core.root, "alias.sock"); symlinkSync(core.env.HC_SOCKET!, alias);
    environment({ ...core.env, HC_SOCKET: alias });
    const app = await bridge();
    expect(await (await app.get("/api/health?scope=bridge")).json()).toMatchObject({ fleet_bridge: { runtime_down: true, reason: "hc_socket_refused" } });
    await expect(coreConnection().call("terminal.list", {})).rejects.toThrow();
    expect((await app.get("/api/session")).status).not.toBe(200);
  }, 30_000);

  it.each([
    ["HC_SESSION", "../private-invalid-session"],
    ["HC_SOCKET", "relative/private-invalid.sock"],
  ])("keeps malformed %s settings down without echoing their value or choosing a live core", async (name, value) => {
    const core = coreFixture(bin!); cleanups.push(() => core.close()); await core.start();
    environment({ ...core.env, [name]: value });
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const app = await bridge();
      for (let n = 0; n < 5; n++) await app.tick();
      const response = await app.get("/api/health?scope=bridge");
      expect(response.status).toBe(200);
      const health = await response.json() as { fleet_bridge: { message: string } };
      expect(health).toMatchObject({ fleet_bridge: { runtime_down: true, reason: "hc_setting_invalid", socket_path: null } });
      expect(health.fleet_bridge.message).toContain(name);
      expect(JSON.stringify(health)).not.toContain(value);
      expect(errors.mock.calls.filter(([line]) => String(line).includes(name))).toEqual([[health.fleet_bridge.message]]);
      await expect(coreConnection().call("terminal.list", {})).rejects.toThrow();
      expect(await core.hc.call("terminal.list", {})).toBeDefined();
    } finally { errors.mockRestore(); }
  }, 30_000);

  it("freezes a minted identity when own Ovis appears and refuses a corrupt identity record", async () => {
    const core = coreFixture(bin!); cleanups.push(() => core.close()); environment(core.env);
    const app = await bridge(); const id = app.advert().runtime_id; await app.stop();
    const own = loadRelayIdentity(process.env["OVIS_STATE_DIR"]!).server_id; expect(own).not.toBe(id);
    const info = spyOn(console, "info").mockImplementation(() => {});
    try {
      const next = await bridge(); expect(next.advert().runtime_id).toBe(id);
      for (let n = 0; n < 5; n++) await next.tick();
      expect(info.mock.calls).toEqual([[`Own Ovis identity ${own} is now available; keeping recorded fleet runtime_id ${id}.`]]);
      await next.stop();
    } finally { info.mockRestore(); }
    const path = join(core.env.HOME!, "fleet/state/runtime-id.json");
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ v: 1, runtime_id: id, source: { kind: "minted" } });
    writeFileSync(path, "{invalid");
    await expect(bridge()).rejects.toThrow();
    expect(readFileSync(path, "utf8")).toBe("{invalid");
  }, 30_000);
});
