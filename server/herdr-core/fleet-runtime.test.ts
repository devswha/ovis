import { afterEach, expect, it, mock, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { bounded } from "../relay/test-helpers.ts";
import { encodeFrame, FRAME_DATA } from "./connection.ts";
import { coreConnection, setRuntime, startRuntime } from "./runtime.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function fixture() {
  // under root's sticky /tmp: a core socket is taken only on a path that no other account can write
  const root = mkdtempSync("/tmp/hc-policy-");
  const before = { ...process.env };
  Object.assign(process.env, { OVIS_RUNTIME: "herdr-core", OVIS_HC_BIN: "/must-not-start/hc", HC_SESSION: "policy-test", HC_SOCKET: join(root, "native.sock") });
  delete process.env["OVIS_HC_ENV"];
  delete process.env["OVIS_FLEET_BRIDGE"];
  cleanups.push(() => {
    coreConnection().close(); setRuntime(null, "ordinary");
    for (const name of Object.keys(process.env)) if (!(name in before)) delete process.env[name];
    Object.assign(process.env, before); rmSync(root, { recursive: true, force: true });
  });
  return root;
}

it.each([undefined, "1"])("guards existing-only startup before discovery or login, with bridge flag %s", async (flag) => {
  const root = fixture();
  if (flag) process.env["OVIS_FLEET_BRIDGE"] = flag;
  setRuntime("herdr-core", "existing-only");
  const find = mock(async () => ({ bin: "/must-not-start/hc", version: "0.1.18" }));
  const login = mock(async () => ({}));
  const spawn = spyOn(Bun, "spawn");
  const started: { adapter: Awaited<ReturnType<typeof startRuntime>> } = { adapter: null };
  try {
    await expect(startRuntime(join(root, "adapter"), find, login).then((value) => { started.adapter = value; return value; })).rejects.toThrow("not running");
    expect(find).not.toHaveBeenCalled(); expect(login).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled();
  } finally { started.adapter?.stop(); spawn.mockRestore(); }
});

it("refuses a core that dies during discovery after the first successful probe", async () => {
  const root = fixture();
  setRuntime("herdr-core", "existing-only");
  const core = Bun.listen({ unix: join(root, "native.sock"), socket: { data() {} } });
  cleanups.push(() => core.stop(true));
  const find = async () => { core.stop(true); return { bin: "/must-not-start/hc", version: "0.1.18" }; };
  const spawn = spyOn(Bun, "spawn");
  const started: { adapter: Awaited<ReturnType<typeof startRuntime>> } = { adapter: null };
  try {
    await expect(startRuntime(join(root, "adapter"), find, async () => ({})).then((value) => { started.adapter = value; return value; })).rejects.toThrow("stopped before");
    expect(spawn).not.toHaveBeenCalled();
  } finally { started.adapter?.stop(); spawn.mockRestore(); }
});

it("keeps background and replacement connections native without a bridge flag or adapter startup", async () => {
  const root = fixture();
  setRuntime("herdr-core", "existing-only");
  const spawn = spyOn(Bun, "spawn");
  const sync = spyOn(Bun, "spawnSync");
  let core: ReturnType<typeof Bun.listen> | undefined;
  try {
    await expect(coreConnection().hello()).rejects.toMatchObject({ kind: "unavailable" });
    core = Bun.listen({ unix: join(root, "native.sock"), socket: { data(socket, bytes) {
      if (bytes[0] === 123) socket.write(JSON.stringify({ jsonrpc: "2.0", id: 0, result: { generation: 1, framed: true, version: "0.1.18", core: { id: "policy-core", name: "test" }, methods: [], features: [] } }) + "\n");
      else {
        const request: unknown = JSON.parse(new TextDecoder().decode(bytes.subarray(9)));
        if (request === null || typeof request !== "object" || !("id" in request) || typeof request.id !== "number") throw new TypeError("Expected a framed request id");
        socket.write(encodeFrame(0, FRAME_DATA, JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { channel: 1 } })));
      }
    } } });
    expect((await coreConnection().hello()).core.id).toBe("policy-core");
    const ended = Promise.withResolvers<void>();
    await coreConnection().events({}, { onData() {}, onClose: () => ended.resolve() });
    core.stop(true); core = undefined;
    await bounded(ended.promise);
    for (let request = 0; request < 5; request++) await expect(Promise.resolve().then(() => coreConnection().call("terminal.list", {}))).rejects.toThrow();
    expect(spawn.mock.calls).toEqual([]); expect(sync.mock.calls).toEqual([]);
  } finally { coreConnection().close(); core?.stop(true); spawn.mockRestore(); sync.mockRestore(); }
});

it("keeps ordinary adapter startup available when the core is absent", async () => {
  const root = fixture();
  setRuntime("herdr-core", "ordinary");
  const find = mock(async () => ({ bin: "/must-not-start/hc", version: "0.1.18" }));
  const login = mock(async () => ({}));
  const adapter = await startRuntime(join(root, "adapter"), find, login);
  try {
    expect(adapter?.socketPath).toBe(join(root, "adapter/herdr-core.sock"));
    expect(find).toHaveBeenCalledTimes(1); expect(login).toHaveBeenCalledTimes(1);
  } finally { adapter?.stop(); }
});
