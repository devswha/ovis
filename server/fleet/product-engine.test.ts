import { afterEach, expect, it, spyOn } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setRuntime } from "../herdr-core/runtime.ts";
import { bounded } from "../relay/test-helpers.ts";
import { productEngine } from "./product-engine.ts";
import { startProductBridge } from "./product-bridge.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "product-selection-"));
  const before = { ...process.env };
  for (const name of Object.keys(process.env)) if (name.startsWith("HC_") || name.startsWith("OVIS_HC_") || name.startsWith("HERDR_REMOTE_")) delete process.env[name];
  Object.assign(process.env, {
    HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"), XDG_RUNTIME_DIR: join(root, "run"),
    OVIS_RUNTIME: "herdr-core", OVIS_FLEET_BRIDGE: "1", OVIS_FLEET_HOME: join(root, "fleet"), OVIS_STATE_DIR: join(root, "own"),
  });
  delete process.env["OVIS_FLEET_STATE"];
  cleanups.push(() => {
    setRuntime(null, "ordinary");
    for (const name of Object.keys(process.env)) if (!(name in before)) delete process.env[name];
    Object.assign(process.env, before); rmSync(root, { recursive: true, force: true });
  });
  return root;
}

it.each(["\n", "\r"])("keeps health available and does not echo a core socket containing %j", async (control) => {
  const root = fixture();
  const value = join(root, `private${control}native.sock`);
  process.env["HC_SOCKET"] = value;
  const bridge = await startProductBridge({ recheck: () => () => {} });
  cleanups.push(() => bridge.stop());
  const response = await fetch(`http://127.0.0.1:${bridge.port}/api/health?scope=bridge`, { headers: { authorization: `Bearer ${bridge.token}` } });
  expect(response.status).toBe(200);
  const health: unknown = await response.json();
  expect(health).toMatchObject({ fleet_bridge: { runtime_down: true, reason: "hc_setting_invalid", socket_path: null } });
  expect(JSON.stringify(health)).not.toContain(JSON.stringify(value).slice(1, -1));
});

it("keeps health available when unselected core session directories cannot be read", async () => {
  const root = fixture();
  const directory = join(root, "run/herdr-core");
  mkdirSync(directory, { recursive: true }); chmodSync(directory, 0o000);
  cleanups.push(() => chmodSync(directory, 0o700));
  const bridge = await startProductBridge({ recheck: () => () => {} });
  cleanups.push(() => bridge.stop());
  const response = await fetch(`http://127.0.0.1:${bridge.port}/api/health?scope=bridge`, { headers: { authorization: `Bearer ${bridge.token}` } });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ fleet_bridge: { runtime_down: true, reason: "hc_discovery_refused", socket_path: null } });
});

it.each([false, true])("keeps classic herdr down when it dies during the socket probe or protocol ping (ping=%s)", async (onPing) => {
  const root = fixture();
  const directory = join(root, "config/herdr/sessions/probe-death");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "herdr.sock");
  Object.assign(process.env, { OVIS_RUNTIME: "herdr", HERDR_REMOTE_SOCKET: path });
  setRuntime("herdr", "existing-only");
  const died = Promise.withResolvers<void>();
  const server = Bun.listen({ unix: path, socket: {
    open() { if (!onPing) { server.stop(true); died.resolve(); } },
    data() { if (onPing) { server.stop(true); died.resolve(); } },
  } });
  cleanups.push(() => server.stop(true));
  const engine = productEngine(join(root, "bridge"), "fixture-runtime", false);
  cleanups.push(() => engine.stop());
  const spawn = spyOn(Bun, "spawn"); const sync = spyOn(Bun, "spawnSync");
  try {
    await engine.probe(); await bounded(died.promise);
    for (let tick = 0; tick < 5; tick++) await engine.probe();
    expect(engine.health).toMatchObject({ runtime_down: true, reason: "herdr_session_gone", boot_id: "awaiting-herdr", runtime_id: "fixture-runtime" });
    const commands = [...spawn.mock.calls, ...sync.mock.calls].map((call) => call[0]);
    expect(commands.filter((argv) => Array.isArray(argv) && argv.some((arg) => ["server", "connect", "update", "stop"].includes(String(arg))))).toEqual([]);
  } finally { spawn.mockRestore(); sync.mockRestore(); }
});
