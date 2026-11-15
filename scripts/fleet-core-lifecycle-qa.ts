/** Real-clock completion events and process tables prove the fleet bridge cannot auto-start hc. */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { coreFixture } from "../server/fleet/core-test-helpers.ts";
import { startProductBridge } from "../server/fleet/product-bridge.ts";
import { coreConnection } from "../server/herdr-core/runtime.ts";
import { bounded } from "../server/relay/test-helpers.ts";

const evidence = process.env["UI_EVIDENCE_DIR"];
const bin = process.env["OVIS_TEST_HC_BIN"];
if (!evidence || !bin) throw new Error("Set UI_EVIDENCE_DIR and OVIS_TEST_HC_BIN inside the isolated container");
mkdirSync(evidence, { recursive: true });
const core = coreFixture(bin);
Object.assign(process.env, core.env, { OVIS_FLEET_BRIDGE: "1", OVIS_RUNTIME: "herdr-core", OVIS_FLEET_HOME: join(core.root, "fleet"), OVIS_STATE_DIR: join(core.root, "own") });
const table = async () => {
  const invocation = ["ps", "-eo", "pid=,ppid=,stat=,comm=,args="];
  const child = Bun.spawn(invocation, { env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const rows = await new Response(child.stdout).text(); assert.equal(await child.exited, 0);
  const cores = rows.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+\d+\s+\S+\s+hc\s+.*\bserve\b/.exec(line);
    return match ? [Number(match[1])] : [];
  });
  return { invocation, rows, cores };
};
let checks = 0;
const waiters = new Set<() => void>();
const checked = (condition: () => boolean) => {
  const ready = Promise.withResolvers<void>();
  const check = () => { if (condition()) ready.resolve(); };
  waiters.add(check); check();
  return bounded(ready.promise, 20_000).finally(() => waiters.delete(check));
};
const before = await table(); assert.deepEqual(before.cores, []);
const bridge = await startProductBridge({ onRecheck: () => { checks++; for (const wake of waiters) wake(); } });
try {
  await checked(() => checks >= 5);
  const absent = await table(); assert.deepEqual(absent.cores, []); assert.equal(bridge.advert().runtime_down, true);
  const up = checked(() => !bridge.advert().runtime_down);
  const started = await core.start(); await up;
  const boot = bridge.advert().boot_id;
  const lineEnded = Promise.withResolvers<void>();
  await coreConnection().events({}, { onData: () => {}, onClose: () => lineEnded.resolve() });
  core.killCore(); await bounded(lineEnded.promise);
  const atDeath = checks;
  for (let request = 0; request < 5; request++) {
    await assert.rejects(coreConnection().call("terminal.list", {}));
    const response = await fetch(`http://127.0.0.1:${bridge.port}/api/session`, { headers: { authorization: `Bearer ${bridge.token}` } });
    assert.notEqual(response.status, 200);
  }
  await checked(() => checks >= atDeath + 5);
  const dead = await table(); assert.deepEqual(dead.cores, []); assert.equal(bridge.advert().runtime_down, true);
  const returned = checked(() => !bridge.advert().runtime_down && bridge.advert().boot_id !== boot);
  await core.start(); await returned;
  writeFileSync(join(evidence, "no-core-started.json"), JSON.stringify({ before, absent, started, after_death: dead, checks_before_start: 5, checks_after_death: checks - atDeath, dead_line_requests: 5, boot_before: boot, boot_after: bridge.advert().boot_id, runtime_id: bridge.advert().runtime_id }, null, 2));
  console.log("PASS: no core before or after five completed rechecks; five dead-line and HTTP requests started none; explicit core restart recovered with a new boot id");
} finally { await bridge.stop(); await core.close(); }
