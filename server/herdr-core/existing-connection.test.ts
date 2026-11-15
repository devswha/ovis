import { afterEach, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HcConnection, spawnHcConnect } from "./connection.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it("never spawns hc connect for an absent fleet core, including replacement lines after a live line dies", async () => {
  // under root's sticky /tmp: a core socket is taken only on a path that no other account can write
  const dir = mkdtempSync("/tmp/hc-existing-"); dirs.push(dir);
  const path = join(dir, "core.sock");
  const env = { HOME: dir, XDG_CONFIG_HOME: dir, XDG_STATE_HOME: dir, XDG_RUNTIME_DIR: dir, HC_SESSION: "fleet-test", HC_SOCKET: path };
  const spawn = spyOn(Bun, "spawn");
  const hc = new HcConnection(() => spawnHcConnect("/must-not-run/hc", env, true));
  let server: ReturnType<typeof Bun.listen> | undefined;
  try {
    await expect(hc.hello()).rejects.toThrow();
    server = Bun.listen({ unix: path, socket: { data(socket) { socket.write(JSON.stringify({ jsonrpc: "2.0", id: 0, result: { generation: 1, framed: true, version: "0.1.18", core: { id: "durable-core", name: "test" }, methods: [], features: [] } }) + "\n"); } } });
    expect((await hc.hello()).core.id).toBe("durable-core");
    server.stop(true); server = undefined;
    hc.close();
    for (let request = 0; request < 5; request++) await expect(hc.call("terminal.list", {})).rejects.toThrow();
    expect(spawn.mock.calls).toEqual([]);
  } finally { hc.close(); server?.stop(true); spawn.mockRestore(); }
});

it("does not fall back to a subprocess when the native core dies during hello", async () => {
  // under root's sticky /tmp: a core socket is taken only on a path that no other account can write
  const dir = mkdtempSync("/tmp/hc-hello-death-"); dirs.push(dir);
  const path = join(dir, "core.sock");
  const env = { HOME: dir, XDG_CONFIG_HOME: dir, XDG_STATE_HOME: dir, XDG_RUNTIME_DIR: dir, HC_SESSION: "hello-test", HC_SOCKET: path };
  const spawn = spyOn(Bun, "spawn");
  const sync = spyOn(Bun, "spawnSync");
  const hc = new HcConnection(() => spawnHcConnect("/must-not-run/hc", env, true));
  const server = Bun.listen({ unix: path, socket: { data() { server.stop(true); } } });
  try {
    await expect(hc.hello()).rejects.toThrow("ended");
    for (let request = 0; request < 5; request++) await expect(hc.hello()).rejects.toThrow();
    expect(spawn.mock.calls).toEqual([]); expect(sync.mock.calls).toEqual([]);
  } finally { hc.close(); server.stop(true); spawn.mockRestore(); sync.mockRestore(); }
});
