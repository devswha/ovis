import { expect, it } from "bun:test";
import { join } from "node:path";
import { ping } from "../herdr/client.ts";

// The preload's test herdr session is shared by every file of one `bun test` process and left running
// on purpose (scripts/test-herdr.ts). The real-core contract runs here in a bun process of its own on
// this session, as it would before another file: what it leaves must keep the session answering.
// Its teardown runs whether or not OVIS_TEST_HC_BIN enables the real-core cases, so they stay skipped.
const shared = process.env["HERDR_TEST_MODE"] !== "unit" && process.env["HERDR_TEST_LIVE"] !== "1";

it.skipIf(!shared)("leaves the shared test herdr session answering after the real-core contract", async () => {
  const socket = process.env["HERDR_SOCKET"];
  if (!socket) throw new TypeError("The test preload sets HERDR_SOCKET");
  await ping(socket, 3000);
  const env = { ...process.env };
  delete env["OVIS_TEST_HC_BIN"];
  const child = Bun.spawnSync([process.execPath, "test", "./server/fleet/core-product-bridge.contract.test.ts"], {
    cwd: join(import.meta.dir, "../.."), env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 50_000,
  });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  expect(await ping(socket, 3000)).toBeDefined();
}, 60_000);
