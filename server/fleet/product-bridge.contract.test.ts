import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { chromePath } from "../../scripts/chrome-path.ts";
import { herdrRpc } from "../herdr/client.ts";
import { loadRelayIdentity } from "../relay/identity.ts";
import { bounded, relayFixture } from "../relay/test-helpers.ts";
import { Fleet } from "./sessions.ts";
import { FleetStore } from "./store.ts";
import { advertFrame, machineConnection, machineKey, pipeToTarget, testAdvert } from "./test-helpers.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const root = () => {
  const path = mkdtempSync(join(tmpdir(), "fleet-product-"));
  cleanups.push(() => rmSync(path, { recursive: true, force: true }));
  return path;
};
async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(20);
  }
}
interface Advert {
  v: number; bridge_port: number; bridge_token: string; runtime_id: string; boot_id: string; runtime_down: boolean;
  versions: { server: string; runtime: string; agent: string }; native_socket?: string; native_bearer?: string;
}
async function start(socket: string, home = root(), env: Record<string, string> = {}) {
  mkdirSync(home, { recursive: true });
  const state = join(home, "state");
  const log = join(home, `remote-${crypto.randomUUID()}.log`);
  const path = join(state, "advert.json");
  const previous = existsSync(path) ? readFileSync(path, "utf8") : null;
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../remote-entry.ts")], {
    env: { ...process.env, OVIS_FLEET_BRIDGE: "1", OVIS_RUNTIME: "herdr", OVIS_FLEET_HOME: home, OVIS_FLEET_STATE: state, HERDR_REMOTE_SOCKET: socket, ...env },
    stdin: "ignore", stdout: Bun.file(log), stderr: Bun.file(log),
  });
  cleanups.push(async () => { proc.kill(); await proc.exited; });
  await until(() => existsSync(path) && readFileSync(path, "utf8") !== previous || proc.exitCode !== null, `advert from remote; log ${log}`);
  if (proc.exitCode !== null) throw new Error(readFileSync(log, "utf8"));
  const advert = () => JSON.parse(readFileSync(path, "utf8")) as Advert;
  const get = (route: string, token = advert().bridge_token) => fetch(`http://127.0.0.1:${advert().bridge_port}${route}`, { headers: { authorization: `Bearer ${token}` } });
  return { proc, state, path, advert, get, home, log };
}

async function forward(bridge: Awaited<ReturnType<typeof start>>) {
  const fixture = relayFixture();
  cleanups.push(() => fixture.close());
  const stateDir = root();
  const store = new FleetStore({ stateDir });
  const fleet = new Fleet({ stateDir, store, tokenConfigured: true });
  fleet.start();
  cleanups.push(() => fleet.close());
  const key = await machineKey();
  store.add({ machine_id: key.id, public_key: key.spki, name: "Classic herdr" });
  store.setState(key.id, "active");
  const connection = await machineConnection(fixture, fleet, { machineSessions: fleet }, { onPipe: (pipe) => pipeToTarget(pipe, bridge.advert().bridge_port) });
  cleanups.push(() => connection.stop());
  await connection.hello();
  await connection.signIn(key);
  const advert = bridge.advert();
  connection.mux.enqueueControl(advertFrame({ ...testAdvert(["bridge"]), runtime_id: advert.runtime_id, boot_id: advert.boot_id, bridge_token: advert.bridge_token, versions: { ...advert.versions, link: "test" } }));
  await bounded(connection.mux.measure());
  const endpoint = await fleet.forwardReady(key.id);
  if (!endpoint) throw new Error("No fleet forward");
  return { fleet, key, port: endpoint.port, get: (path: string) => fetch(`http://127.0.0.1:${endpoint.port}${path}`, { headers: { authorization: `Bearer ${advert.bridge_token}` } }) };
}

describe("classic herdr's fleet bridge", () => {
  it("serves a pre-existing pane through a real controller fleet forward and keeps files in fleet state", async () => {
    const cwd = root();
    const made = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>("workspace.create", { cwd, label: "fleet-existing", focus: false });
    cleanups.push(() => herdrRpc("workspace.close", { workspace_id: made.workspace.workspace_id }));
    const bridge = await start(process.env["HERDR_SOCKET"]!);
    const advert = bridge.advert();
    expect(advert.runtime_down).toBe(false);
    expect(advert.native_bearer).toBeUndefined();
    expect(advert.native_socket).toBeUndefined();
    expect(advert.versions.runtime).toMatch(/^herdr-/);
    expect(statSync(bridge.path).mode & 0o777).toBe(0o600);
    expect(statSync(join(bridge.state, "bridge.json")).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(bridge.state, "bridge.json"), "utf8")).socket_path).toBe(process.env["HERDR_SOCKET"]);
    expect((await bridge.get("/api/session", "wrong")).status).toBe(401);
    const controller = await forward(bridge);
    const session = await (await controller.get("/api/session")).json() as { snapshot: { panes: { pane_id: string }[] } };
    expect(session.snapshot.panes.some((pane) => pane.pane_id === made.root_pane.pane_id)).toBe(true);
    const health = await (await controller.get("/api/health?scope=bridge")).json();
    expect(health).toMatchObject({ runtime: "herdr", fleet_bridge: { engine: "herdr", socket_path: process.env["HERDR_SOCKET"], runtime_id: advert.runtime_id, boot_id: advert.boot_id, runtime_down: false, reason: null } });
    const noAuth = await fetch(`http://127.0.0.1:${advert.bridge_port}/api/health?scope=bridge`);
    expect(await noAuth.json()).not.toHaveProperty("fleet_bridge");
  });

  it("waits for a missing selected session without starting an engine, and exposes the reason without a native endpoint", async () => {
    const home = root();
    const socket = join(home, "absent", "herdr.sock");
    const bridge = await start(socket, home);
    expect(bridge.proc.exitCode).toBeNull();
    expect(bridge.advert().runtime_down).toBe(true);
    expect(existsSync(socket)).toBe(false);
    const health = await (await bridge.get("/api/health?scope=bridge")).json();
    expect(health).toMatchObject({ fleet_bridge: { engine: "herdr", socket_path: socket, runtime_down: true, reason: "herdr_session_gone" } });
  });

  it.each([
    { socket: "relative/herdr.sock", session: "", setting: "HERDR_REMOTE_SOCKET" },
    { socket: "/absolute/not-herdr.sock", session: "", setting: "HERDR_REMOTE_SOCKET" },
    { socket: "", session: "../evil", setting: "HERDR_REMOTE_SESSION" },
  ])("keeps a malformed selector running with private health: %j", async ({ socket, session, setting }) => {
    const bridge = await start(socket, root(), { HERDR_REMOTE_SESSION: session });
    expect(bridge.proc.exitCode).toBeNull();
    expect(bridge.advert().runtime_down).toBe(true);
    const health = await (await bridge.get("/api/health?scope=bridge")).json();
    expect(health).toMatchObject({ fleet_bridge: { runtime_down: true, reason: "herdr_setting_invalid", socket_path: null } });
    expect(health.fleet_bridge.message).toContain(setting);
    expect(health.fleet_bridge.message).not.toContain("\n");
    expect(readFileSync(bridge.log, "utf8").split("\n").filter((line) => line.includes(setting))).toEqual([health.fleet_bridge.message]);
    expect(await (await bridge.get("/api/health?scope=bridge", "wrong")).json()).not.toHaveProperty("fleet_bridge");
  });

  it("pushes a pane's first status change to a client connected before the engine starts", async () => {
    const home = root();
    const config = join(home, "config");
    const name = "fleet-late";
    const socket = join(config, "herdr/sessions", name, "herdr.sock");
    const env = { HOME: home, XDG_CONFIG_HOME: config, OVIS_STATE_DIR: join(home, "own"), HERDR_REMOTE_SESSION: "" };
    const bridge = await start(socket, home, env);
    expect(bridge.advert().runtime_down).toBe(true);
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    cleanups.push(() => browser.close());
    const context = await browser.newContext();
    const base = `http://127.0.0.1:${bridge.advert().bridge_port}`;
    expect((await context.request.post(`${base}/api/auth`, { data: { token: bridge.advert().bridge_token } })).ok()).toBe(true);
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    // A real page carries its auth cookie on the upgrade, before herdr exists.
    await page.goto(`${base}/api/health`);
    const frames: { type: string; pane_id?: string; agent_status?: string }[] = [];
    page.on("websocket", (socket) => socket.on("framereceived", ({ payload }) => frames.push(JSON.parse(String(payload)))));
    const ws = await page.evaluateHandle(() => new WebSocket(`${location.origin.replace("http:", "ws:")}/ws`));
    await page.waitForFunction((socket) => socket.readyState === WebSocket.OPEN, ws);
    const binary = process.env["OVIS_HERDR_BIN"] || Bun.which("herdr");
    if (!binary) throw new Error("This contract requires real herdr");
    const engine = Bun.spawn([binary, "--session", name, "server"], { env: { ...process.env, ...env }, stdin: "ignore", stdout: "ignore", stderr: "inherit" });
    cleanups.push(async () => { engine.kill(); await engine.exited; });
    await until(() => existsSync(socket), "late engine socket");
    const made = await herdrRpc<{ root_pane: { pane_id: string } }>("workspace.create", { cwd: home, focus: false }, socket);
    const pane = made.root_pane.pane_id;
    await until(() => !bridge.advert().runtime_down, "bridge observes late engine");
    await herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "claude", state: "working" }, socket);
    await until(() => frames.some((frame) => frame.type === "pane-status" && frame.pane_id === pane && frame.agent_status === "working"), "FIRST pane status after late engine start");
    expect(await ws.evaluate((socket) => socket.readyState)).toBe(WebSocket.OPEN);
  }, 12 * 10_000); // browser setup, five bounded waits and two RPC calls

  it("refuses another bridge for the same state folder without changing its token or stopping its engine", async () => {
    const bridge = await start(process.env["HERDR_SOCKET"]!);
    const before = readFileSync(bridge.path, "utf8");
    const second = Bun.spawn([process.execPath, join(import.meta.dir, "../remote-entry.ts")], {
      env: { ...process.env, OVIS_FLEET_BRIDGE: "1", OVIS_RUNTIME: "herdr", OVIS_FLEET_HOME: bridge.home, OVIS_FLEET_STATE: bridge.state, HERDR_REMOTE_SOCKET: process.env["HERDR_SOCKET"] },
      stdin: "ignore", stdout: "ignore", stderr: "pipe",
    });
    cleanups.push(async () => { second.kill(); await second.exited; });
    const error = await new Response(second.stderr).text();
    expect(await second.exited).not.toBe(0);
    expect(error).toContain("Another bridge");
    expect(readFileSync(bridge.path, "utf8")).toBe(before);
    expect((await bridge.get("/api/session")).status).toBe(200);
  });
});


it("keeps a durable PC id across bridge and engine restarts without starting an engine", async () => {
  const home = root();
  const config = join(home, "config");
  const name = `fleet-life-${crypto.randomUUID().slice(0, 8)}`;
  const socket = join(config, "herdr", "sessions", name, "herdr.sock");
  const env = { HOME: home, XDG_CONFIG_HOME: config, OVIS_STATE_DIR: join(home, "own-state"), HERDR_REMOTE_SESSION: "" };
  const binary = process.env["OVIS_HERDR_BIN"] || Bun.which("herdr");
  if (!binary) throw new Error("This contract requires real herdr");
  const boot = async () => {
    mkdirSync(config, { recursive: true });
    const child = Bun.spawn([binary, "--session", name, "server"], { env: { ...process.env, ...env }, stdin: "ignore", stdout: "ignore", stderr: "inherit" });
    cleanups.push(async () => { child.kill(); await child.exited; });
    await until(() => existsSync(socket), "fixture engine socket");
    return child;
  };
  const bridge = await start(socket, home, env);
  expect(bridge.advert().runtime_down).toBe(true);
  expect(existsSync(socket)).toBe(false);
  const fallback = JSON.parse(readFileSync(join(bridge.state, "runtime-id.json"), "utf8"));
  expect(bridge.advert().runtime_id).toBe(fallback.runtime_id);
  expect(statSync(join(bridge.state, "runtime-id.json")).mode & 0o777).toBe(0o600);
  const first = await boot();
  await until(() => !bridge.advert().runtime_down, "bridge finds selected engine");
  const before = bridge.advert();
  const controller = await forward(bridge);
  expect((await controller.get("/api/session")).status).toBe(200);
  first.kill("SIGKILL"); await first.exited;
  await until(() => bridge.advert().runtime_down, "advert marks stopped engine");
  // The separate tick-driven test below proves repeated rechecks never start an engine.
  const pgrep = Bun.spawn(["pgrep", "-af", `herdr --session ${name} server`], { env: process.env, stdin: "ignore", stdout: "pipe" });
  const processes = await new Response(pgrep.stdout).text();
  expect(await pgrep.exited).toBe(1);
  expect(processes).toBe("");
  expect(bridge.advert().runtime_down).toBe(true);
  expect(bridge.proc.exitCode).toBeNull();
  const next = await boot();
  await until(() => !bridge.advert().runtime_down, "same bridge reconnects after engine restart");
  expect(bridge.advert().runtime_id).toBe(before.runtime_id);
  expect(bridge.advert().boot_id).not.toBe(before.boot_id);
  expect((await controller.get("/api/session")).status).toBe(200);
  const restartedEngine = bridge.advert();
  bridge.proc.kill(); await bridge.proc.exited;
  expect(next.exitCode).toBeNull();
  const replacement = await start(socket, home, env);
  expect(replacement.advert().runtime_id).toBe(before.runtime_id);
  expect(replacement.advert().boot_id).toBe(restartedEngine.boot_id);
  expect(replacement.advert().bridge_token).not.toBe(restartedEngine.bridge_token);
}, 60_000);


it("freezes the first own Ovis identity even when a later service environment hides it", async () => {
  const home = root();
  const ownState = join(home, "own-ovis");
  const own = loadRelayIdentity(ownState).server_id;
  const socket = process.env["HERDR_SOCKET"]!;
  for (const visible of [true, false, true]) {
    const bridge = await start(socket, home, { OVIS_STATE_DIR: visible ? ownState : join(home, "hidden-own-ovis") });
    expect(bridge.advert().runtime_id).toBe(own);
    expect(JSON.parse(readFileSync(join(bridge.state, "runtime-id.json"), "utf8"))).toMatchObject({ v: 1, runtime_id: own, source: { kind: "own-ovis", state_dir: ownState } });
    bridge.proc.kill(); await bridge.proc.exited;
  }
});

it("keeps the first minted PC identity when an own Ovis identity appears later", async () => {
  const home = root();
  const ownState = join(home, "own-ovis");
  const socket = process.env["HERDR_SOCKET"]!;
  const first = await start(socket, home, { OVIS_STATE_DIR: ownState });
  const id = first.advert().runtime_id;
  expect(JSON.parse(readFileSync(join(first.state, "runtime-id.json"), "utf8"))).toMatchObject({ v: 1, runtime_id: id, source: { kind: "minted" } });
  first.proc.kill(); await first.proc.exited;
  const own = loadRelayIdentity(ownState).server_id;
  expect(own).not.toBe(id);
  const second = await start(socket, home, { OVIS_STATE_DIR: ownState });
  expect(second.advert().runtime_id).toBe(id);
  expect(readFileSync(second.log, "utf8")).toContain(`Own Ovis identity ${own} is now available; keeping recorded fleet runtime_id ${id}.`);
});


it("never invokes an engine spawner across explicitly advanced recheck ticks", async () => {
  const home = root();
  const before = { ...process.env };
  const names = ["HOME", "SHELL", "OVIS_FLEET_HOME", "OVIS_FLEET_STATE", "OVIS_STATE_DIR", "HERDR_REMOTE_SOCKET", "HERDR_REMOTE_SESSION", "HERDR_SOCKET"];
  Object.assign(process.env, { HOME: home, SHELL: "/bin/bash", OVIS_FLEET_HOME: home, OVIS_FLEET_STATE: join(home, "state"), OVIS_STATE_DIR: join(home, "own"), HERDR_REMOTE_SOCKET: join(home, "missing", "herdr.sock"), HERDR_REMOTE_SESSION: "" });
  cleanups.push(() => { for (const name of names) { if (before[name] === undefined) delete process.env[name]; else process.env[name] = before[name]; } });
  // the bridge settles this process's runtime and engine policy: the files after this one start from neither
  const { setRuntime } = await import("../herdr-core/runtime.ts");
  cleanups.push(() => setRuntime(null, "ordinary"));
  const spawn = spyOn(Bun, "spawn");
  const sync = spyOn(Bun, "spawnSync");
  const info = spyOn(console, "info").mockImplementation(() => {});
  let advance: (() => Promise<void>) | undefined;
  let checks = 0;
  let cancelled = false;
  try {
    const { startProductBridge } = await import("./product-bridge.ts");
    const bridge = await startProductBridge({ recheck: (tick) => { advance = tick; return () => { cancelled = true; }; }, onRecheck: () => checks++ });
    try {
      const record = readFileSync(join(home, "state/runtime-id.json"), "utf8");
      const own = loadRelayIdentity(join(home, "own")).server_id;
      for (let tick = 0; tick < 5; tick++) await advance!();
      expect(info.mock.calls).toEqual([[`Own Ovis identity ${own} is now available; keeping recorded fleet runtime_id ${bridge.advert().runtime_id}.`]]);
      expect(readFileSync(join(home, "state/runtime-id.json"), "utf8")).toBe(record);
      expect(checks).toBe(5);
      expect(bridge.advert().runtime_down).toBe(true);
      const starts = [...spawn.mock.calls, ...sync.mock.calls].map((call) => call[0]).filter((command) => Array.isArray(command) && /(?:^|\/)(?:herdr|hc)$/.test(String(command[0])) && command.slice(1).some((arg) => arg === "server" || arg === "connect"));
      expect(starts).toEqual([]);
      expect(existsSync(process.env["HERDR_REMOTE_SOCKET"]!)).toBe(false);
    } finally { await bridge.stop(); }
    expect(cancelled).toBe(true);
  } finally { spawn.mockRestore(); sync.mockRestore(); info.mockRestore(); }
});


it("waits on no or several sessions, selects the only running session, then keeps that selection", async () => {
  const home = root();
  const config = join(home, "config");
  const env = { HOME: home, XDG_CONFIG_HOME: config, OVIS_STATE_DIR: join(home, "own"), HERDR_REMOTE_SESSION: "" };
  const binary = process.env["OVIS_HERDR_BIN"] || Bun.which("herdr");
  if (!binary) throw new Error("This contract requires real herdr");
  const engine = async (name: string) => {
    const child = Bun.spawn([binary, "--session", name, "server"], { env: { ...process.env, ...env }, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    cleanups.push(async () => { child.kill(); await child.exited; });
    const socket = join(config, "herdr/sessions", name, "herdr.sock");
    await until(() => existsSync(socket), "fixture session ready");
    return { child, socket };
  };
  const absent = await start("", join(home, "absent-bridge"), env);
  expect(absent.advert().runtime_down).toBe(true);
  expect((await (await absent.get("/api/health?scope=bridge")).json() as { fleet_bridge: { socket_path: string | null } }).fleet_bridge.socket_path).toBeNull();
  absent.proc.kill(); await absent.proc.exited;
  const first = await engine("fleet-one");
  const second = await engine("fleet-two");
  const bridge = await start("", join(home, "two-bridge"), env);
  const health = () => bridge.get("/api/health?scope=bridge").then((response) => response.json()) as Promise<{ fleet_bridge: { socket_path: string | null; reason: string | null } }>;
  expect((await health()).fleet_bridge.reason).toBe("herdr_sessions_found");
  first.child.kill(); await first.child.exited;
  await until(() => !bridge.advert().runtime_down, "only running session selected");
  expect((await health()).fleet_bridge.socket_path).toBe(second.socket);
  await engine("fleet-three");
  expect((await health()).fleet_bridge.socket_path).toBe(second.socket);
  expect(bridge.advert().runtime_down).toBe(false);
});


describe("compiled classic fleet bridge", () => {
  const PHASE_MS = 20_000;
  // The child bounds fixture startup, each of two handovers, and the prompt answer
  // separately. Its named phase deadline wins; 10 seconds then cover child cleanup.
  const CHILD_MS = 4 * PHASE_MS + 10_000;
  // Each test outlasts its child's bounded work and output/exit collection.
  const TEST_MS = CHILD_MS + 5_000;
  // Compilation is a separate hook, never charged to the scenario's budget.
  const BUILD_MS = 60_000;
  let dir: string;
  let binary: string;
  beforeAll(async () => {
    const { buildBinary } = await import("../../scripts/server-artifact.ts");
    const { binaryName } = await import("../../scripts/server-manifest.ts");
    const platform = `${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch}` as import("../../scripts/server-manifest.ts").ServerPlatform;
    dir = mkdtempSync(join(tmpdir(), "fleet-compiled-"));
    binary = join(dir, binaryName(platform));
    await buildBinary(platform, binary);
    copyFileSync(join(import.meta.dir, "../pty/pty-host.mjs"), join(dir, "pty-host.mjs"));
    // CI uses the supported Node fallback; container browser QA stages the verified Rust host.
    symlinkSync(join(import.meta.dir, "../../node_modules"), join(dir, "node_modules"), "dir");
  }, BUILD_MS);
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("serves chat, prompt answers, status, live typing and resize through the compiled bridge and preserves both attach orders", async () => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../../scripts/fleet-product-qa.ts")], {
      env: { ...process.env, OVIS_QA_SERVER: binary, OVIS_QA_EARLY_ONLY: "1", OVIS_QA_PHASE_MS: String(PHASE_MS), UI_EVIDENCE_DIR: join(dir, "evidence") },
      stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: CHILD_MS, detached: true,
    });
    const exited = child.exited.then((code) => {
      // Only this fixture's group; also retire children if a named deadline failed.
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* the fixture already cleaned up */ }
      return code;
    });
    cleanups.push(async () => { child.kill(); await exited; });
    const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), exited]);
    expect(code, `Compiled fleet QA (child bound ${CHILD_MS} ms):\n${output}${errors}`).toBe(0);
    const result = JSON.parse(readFileSync(join(dir, "evidence/results.json"), "utf8"));
    expect(result).toMatchObject({ bare_login: true, prompt_answer: true, live_terminal: { typed: "z", resized: "111x33", held_input_and_resize_refused: true, held_status_read: true }, own_then_fleet: { chat: true, prompt: true, listing: true, held_submit_refused: true } });
  }, TEST_MS);

  it("names the bounded QA phase instead of being killed by the test runner", async () => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../../scripts/fleet-product-qa.ts")], {
      env: { ...process.env, OVIS_QA_SERVER: binary, OVIS_QA_EARLY_ONLY: "1", OVIS_QA_PHASE_MS: "1", UI_EVIDENCE_DIR: join(dir, "deadline-evidence") },
      stdin: "ignore", stdout: "ignore", stderr: "pipe", timeout: 10_000, detached: true,
    });
    const exited = child.exited.then((code) => {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already cleaned up */ }
      return code;
    });
    cleanups.push(async () => { child.kill(); await exited; });
    const errors = await new Response(child.stderr).text();
    expect(await exited, errors).toBe(1);
    expect(child.signalCode).toBeNull();
    expect(errors).toContain("Timed out: fixture startup, waiting for controller engine (1 ms phase budget)");
  });

});
