import { afterAll, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolatedHcEnv, stopIsolatedCore, stopTestCores } from "./test-hc.ts";

// A stand-in hc that writes down how it was run: no real core is started or stopped.
const root = mkdtempSync(join(tmpdir(), "ovis-test-hc-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const record = join(root, "ran");
const bin = join(root, "hc");
writeFileSync(bin, `#!/bin/sh\nprintf '%s|%s|%s\\n' "$*" "$HC_SOCKET" "$OVIS_CANARY" > ${JSON.stringify(record)}\n`);
chmodSync(bin, 0o755);

it("never stops a core when the test's own core was never set up", async () => {
  await stopIsolatedCore(bin, {});
  expect(existsSync(record)).toBe(false);
});

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** A stand-in hc whose status names `pids` (the first as the core, the second as its holder; none: it prints nothing) and whose stop leaves them. */
function naming(name: string, [core, holder]: number[]): string {
  const path = join(root, name);
  const status = core === undefined ? "" : `echo '{"pid":${core},"holder":${holder === undefined ? "null" : `{"pid":${holder}}`}}'`;
  writeFileSync(path, `#!/bin/sh\n[ "$1 $2" = "server status" ] && ${status || ":"}\nexit 0\n`);
  chmodSync(path, 0o755);
  return path;
}

/** A sleep of the test's own, started in `env` and outside this process's group, as a core's daemon is. */
const sleeper = async (env: Record<string, string>) =>
  Number((await new Response(Bun.spawn(["sh", "-c", "sleep 60 >/dev/null 2>&1 & echo $!"], { env, stdout: "pipe" }).stdout).text()).trim());

// a pid is proven to be a core's only through /proc: where there is none, nothing is killed
it.skipIf(!existsSync("/proc/self/stat"))("reads the holder again before a stop, and kills and names what outlived the stop", async () => {
  // started in the core's environment, they stand in for the core and the holder it got after its start; this stand-in's stop leaves both
  const env = isolatedHcEnv(join(root, "stuck"));
  const [core, holder] = [await sleeper(env), await sleeper(env)];
  expect(await stopTestCores(naming("hc-stuck", [core, holder]), [{ env, pids: [core] }], 200)).toEqual({ stopped: [0], killed: [core, holder], unproven: [] });
  expect([core, holder].filter(alive)).toEqual([]);
});

it("kills no recorded pid that is now a process of another core, and names it unproven", async () => {
  const env = isolatedHcEnv(join(root, "intended"));
  // what a recorded pid would be once its number went to another core: the status names it, so its start time is recorded
  const stranger = Bun.spawn(["sleep", "30"], { env: isolatedHcEnv(join(root, "other")) });
  try {
    const result = await stopTestCores(naming("hc-other", [stranger.pid]), [{ env, pids: [stranger.pid] }], 200);
    expect({ result, alive: alive(stranger.pid) }).toEqual({ result: { stopped: [0], killed: [], unproven: [stranger.pid] }, alive: true });
  } finally {
    stranger.kill();
    await stranger.exited;
  }
});

it("kills no pid that no status named, even one started in the core's own environment, and names it unproven", async () => {
  const env = isolatedHcEnv(join(root, "unnamed"));
  // this stand-in's status prints nothing, so no start time is recorded for the pid the test passes in
  const stranger = Bun.spawn(["sleep", "30"], { env });
  try {
    const result = await stopTestCores(naming("hc-silent", []), [{ env, pids: [stranger.pid] }], 200);
    expect({ result, alive: alive(stranger.pid) }).toEqual({ result: { stopped: [0], killed: [], unproven: [stranger.pid] }, alive: true });
  } finally {
    stranger.kill();
    await stranger.exited;
  }
});

it("stops the test's own core, in its environment alone", async () => {
  process.env["OVIS_CANARY"] = "inherited";
  try {
    const env = isolatedHcEnv(join(root, "core"));
    await stopIsolatedCore(bin, env);
    expect(readFileSync(record, "utf8")).toBe(`server stop|${env["HC_SOCKET"]}|\n`);
  } finally {
    delete process.env["OVIS_CANARY"];
  }
});
