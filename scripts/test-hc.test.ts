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

it("reads the holder again before a stop, and kills and names what outlived the stop", async () => {
  // detached sleepers stand in for a core and the holder it got after its start; this stand-in's stop leaves both
  const sleeper = async () => Number((await new Response(Bun.spawn(["sh", "-c", "sleep 60 >/dev/null 2>&1 & echo $!"], { stdout: "pipe" }).stdout).text()).trim());
  const [core, holder] = [await sleeper(), await sleeper()];
  const stuck = join(root, "hc-stuck");
  writeFileSync(stuck, `#!/bin/sh\n[ "$1 $2" = "server status" ] && echo '{"pid":${core},"holder":{"pid":${holder}}}'\nexit 0\n`);
  chmodSync(stuck, 0o755);
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  expect(await stopTestCores(stuck, [{ env: isolatedHcEnv(join(root, "stuck")), pids: [core] }], 200)).toEqual({ stopped: [0], killed: [core, holder] });
  expect([core, holder].filter(alive)).toEqual([]);
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
