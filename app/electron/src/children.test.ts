import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { choosePort, coreEnv, endLeftover, installCore, layout, openLog, portFree, readSaved, serverEnv, startServer, stopServer, writeSaved } from "./children.ts";

const dirs: string[] = [];
const listeners: Server[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const listener of listeners.splice(0)) listener.close();
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ovis-desktop-"));
  dirs.push(dir);
  return dir;
}

/** a stand-in server: bin/bun is this Bun, server/server/index.ts the given script */
function fakeServer(script: string): ReturnType<typeof layout> {
  const root = tempDir();
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "server", "server"), { recursive: true });
  writeFileSync(join(root, "bin", "bun"), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
  chmodSync(join(root, "bin", "bun"), 0o755);
  writeFileSync(join(root, "server", "server", "index.ts"), script);
  return layout(root);
}

describe("environments", () => {
  it("gives hc the app's own session unless one is named", () => {
    expect(coreEnv({ PATH: "/bin" })["HC_SESSION"]).toBe("ovis");
    expect(coreEnv({ HC_SESSION: " test-1 " })["HC_SESSION"]).toBe("test-1");
    expect(coreEnv({ ELECTRON_RUN_AS_NODE: "1" })).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
  });

  it("runs the server on herdr-core through the bundled hc, on loopback, in the app's state folder", () => {
    const env = serverEnv({ PATH: "/bin", HOST: "0.0.0.0", HERDR_PLUGIN_ROOT: "/p", OVIS_MANAGED: "1", HERDR_SOCKET: "/s", OVIS_TOKEN: "t" }, { hc: "/app/bin/herdr-core", stateDir: "/data/server", port: 4321 });
    expect(env).toMatchObject({ PATH: "/bin", OVIS_RUNTIME: "herdr-core", OVIS_HC_BIN: "/app/bin/herdr-core", OVIS_STATE_DIR: "/data/server", HOST: "127.0.0.1", PORT: "4321", HC_SESSION: "ovis" });
    for (const name of ["HERDR_PLUGIN_ROOT", "OVIS_MANAGED", "HERDR_SOCKET", "OVIS_TOKEN"]) expect(env).not.toHaveProperty(name);
  });
});

describe("startServer", () => {
  it("resolves with the address the server says it listens on, and stops it", async () => {
    const programs = fakeServer(`console.log("Ovis listening on http://127.0.0.1:" + process.env.PORT); process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000);`);
    const log = openLog(join(tempDir(), "logs", "ovis.log"));
    const server = await startServer(programs, { ...process.env, PORT: "45678" }, log, 20_000);
    expect(server.url).toBe("http://127.0.0.1:45678");
    await stopServer(server, 5_000);
    expect(await server.exited).toBe(0);
    log.end();
  });

  it("fails with the end of the output when the server ends first", async () => {
    const programs = fakeServer(`console.error("Ovis cannot start: no herdr-core found."); process.exit(1);`);
    const log = openLog(join(tempDir(), "ovis.log"));
    await expect(startServer(programs, process.env, log, 20_000)).rejects.toThrow(/stopped \(exit code 1\)\nOvis cannot start: no herdr-core found\./);
    log.end();
  });

  it("fails when the server says nothing in time, and ends it", async () => {
    const programs = fakeServer(`setInterval(() => {}, 1000);`);
    const log = openLog(join(tempDir(), "ovis.log"));
    await expect(startServer(programs, process.env, log, 300)).rejects.toThrow(/did not start within/);
    log.end();
  });

  it("ends a server that ignores SIGTERM once the grace time is over", async () => {
    const programs = fakeServer(`process.on("SIGTERM", () => {}); console.log("Ovis listening on http://127.0.0.1:1"); setInterval(() => {}, 1000);`);
    const log = openLog(join(tempDir(), "ovis.log"));
    const server = await startServer(programs, process.env, log, 20_000);
    await stopServer(server, 200);
    expect(server.child.signalCode).toBe("SIGKILL");
    log.end();
  });
});

describe("installCore", () => {
  /** an hc that records how it was run, beside itself */
  function fakeHc(dir: string, tag: string): string {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "herdr-core");
    writeFileSync(path, `#!/bin/sh\n# ${tag}\necho "$@" >> "$(dirname "$0")/ran"\n`);
    chmodSync(path, 0o755);
    return path;
  }

  it("copies the bundled hc into the data folder, then leaves an identical copy alone", async () => {
    const root = tempDir();
    const bundled = fakeHc(join(root, "bundle"), "0.1.17");
    const log = openLog(join(root, "ovis.log"));
    const installed = await installCore(bundled, join(root, "data", "bin"), process.env, log);
    expect(installed).toBe(join(root, "data", "bin", "herdr-core"));
    expect(readFileSync(installed, "utf8")).toBe(readFileSync(bundled, "utf8"));
    expect(await installCore(bundled, join(root, "data", "bin"), process.env, log)).toBe(installed);
    expect(() => readFileSync(join(root, "data", "bin", "ran"))).toThrow();
    log.end();
  });

  it("swaps a different copy the way hc's installer does, with hc update --from", async () => {
    const root = tempDir();
    const bundled = fakeHc(join(root, "bundle"), "0.1.18");
    const installed = fakeHc(join(root, "data", "bin"), "0.1.17");
    const log = openLog(join(root, "ovis.log"));
    expect(await installCore(bundled, join(root, "data", "bin"), process.env, log)).toBe(installed);
    expect(readFileSync(join(root, "data", "bin", "ran"), "utf8")).toBe(`update --from ${bundled}\n`);
    log.end();
  });
});

describe("openLog", () => {
  it("keeps the previous run's log as .1", async () => {
    const path = join(tempDir(), "logs", "ovis.log");
    const first = openLog(path);
    await new Promise<void>((resolve) => first.end("first run\n", resolve));
    const second = openLog(path);
    await new Promise<void>((resolve) => second.end("second run\n", resolve));
    expect(readFileSync(`${path}.1`, "utf8")).toBe("first run\n");
    expect(readFileSync(path, "utf8")).toBe("second run\n");
  });
});

describe("choosePort", () => {
  it("keeps the saved port while it is free", async () => {
    const port = await choosePort(null);
    expect(await choosePort(port)).toBe(port);
  });

  it("takes another port when the saved one is in use", async () => {
    const taken = await new Promise<number>((resolve) => {
      const listener = createServer().listen({ host: "127.0.0.1", port: 0 }, () => {
        const address = listener.address();
        resolve(typeof address === "object" && address !== null ? address.port : 0);
      });
      listeners.push(listener);
    });
    expect(await portFree(taken)).toBe(false);
    const port = await choosePort(taken);
    expect(port).not.toBe(taken);
    expect(port).toBeGreaterThan(0);
  });
});

describe("saved settings", () => {
  it("round-trips, and reads a missing or broken file as nothing saved", () => {
    const dir = tempDir();
    const path = join(dir, "desktop.json");
    expect(readSaved(path)).toEqual({ port: null, server: null });
    writeSaved(path, { port: 4321, server: { pid: 99, bun: "/app/bin/bun" } });
    expect(readSaved(path)).toEqual({ port: 4321, server: { pid: 99, bun: "/app/bin/bun" } });
    writeFileSync(path, "{");
    expect(readSaved(path)).toEqual({ port: null, server: null });
  });
});

describe("endLeftover", () => {
  it("ends only a process that still runs this app's Bun on its server", async () => {
    const programs = fakeServer(`process.on("SIGTERM", () => process.exit(0)); console.log("Ovis listening on http://127.0.0.1:1"); setInterval(() => {}, 1000);`);
    const log = openLog(join(tempDir(), "ovis.log"));
    const server = await startServer(programs, process.env, log, 20_000);
    const pid = server.child.pid!;
    expect(await endLeftover({ pid, bun: programs.bun }, async () => `/other/bun ${programs.server}/server/index.ts`)).toBe(false);
    expect(await endLeftover({ pid, bun: programs.bun }, async () => null)).toBe(false);
    expect(server.child.exitCode).toBeNull();
    expect(await endLeftover({ pid, bun: programs.bun }, async () => `${programs.bun} ${programs.server}/server/index.ts`)).toBe(true);
    expect(await server.exited).toBe(0);
    log.end();
  });
});
