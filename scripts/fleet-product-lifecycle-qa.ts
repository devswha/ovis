/** Real-clock, event-driven no-engine-start check. Run in an isolated container with no engine process. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bounded } from "../server/relay/test-helpers.ts";
import { startProductBridge } from "../server/fleet/product-bridge.ts";

const evidence = process.env["UI_EVIDENCE_DIR"];
if (!evidence) throw new Error("Set UI_EVIDENCE_DIR inside the isolated QA container");
mkdirSync(evidence, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "fleet-no-engine-"));
Object.assign(process.env, {
  HOME: root, SHELL: "/bin/bash", OVIS_FLEET_HOME: root, OVIS_FLEET_STATE: join(root, "state"),
  OVIS_STATE_DIR: join(root, "own"), HERDR_REMOTE_SOCKET: join(root, "missing", "herdr.sock"), HERDR_REMOTE_SESSION: "",
});
const table = async () => {
  const command = ["ps", "-eo", "pid=,comm=,args="];
  const child = Bun.spawn(command, { env: process.env, stdin: "ignore", stdout: "pipe" });
  const rows = await new Response(child.stdout).text();
  assert.equal(await child.exited, 0);
  const engines = rows.split("\n").filter((line) => /^\s*\d+\s+(?:herdr|hc)\s/.test(line));
  return { invocation: command, rows, engines };
};
const before = await table();
assert.equal(before.engines.length, 0);
let resolve!: () => void;
const checked = new Promise<void>((done) => { resolve = done; });
let checks = 0;
const bridge = await startProductBridge({ onRecheck: () => { if (++checks === 5) resolve(); } });
try {
  // Each completion is signalled by the real recheck loop after its engine probe and advert update.
  await bounded(checked, 20_000);
  const after = await table();
  assert.deepEqual(after.engines, []);
  assert.equal(bridge.advert().runtime_down, true);
  writeFileSync(join(evidence, "no-engine-rechecks.json"), JSON.stringify({ checks, before, after, runtime_down: bridge.advert().runtime_down }, null, 2));
  console.log("PASS no engine process before or after 5 completed real rechecks; runtime_down remained true");
} finally { await bridge.stop(); rmSync(root, { recursive: true, force: true }); }
