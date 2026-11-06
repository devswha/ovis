import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { herdrRpc, herdrSocketPath } from "./client.ts";

// A script that names a test session but never ran scripts/test-herdr.ts (an import Bun drops
// because its binding is unused) is left on herdr's default socket: the user's own session.
// HOME is a temp folder here, so the default socket is nobody's and nothing live is reached.
const saved = { HOME: process.env["HOME"], HERDR_SOCKET: process.env["HERDR_SOCKET"], HERDR_TEST_SESSION: process.env["HERDR_TEST_SESSION"], OVIS_ALLOW_LIVE_HERDR: process.env["OVIS_ALLOW_LIVE_HERDR"] };
const home = mkdtempSync(join(tmpdir(), "ovis-live-guard-"));
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
});

it("refuses herdr's default socket to a process that names a test session", async () => {
  try {
    process.env["HOME"] = home;
    delete process.env["HERDR_SOCKET"];
    delete process.env["OVIS_ALLOW_LIVE_HERDR"];
    process.env["HERDR_TEST_SESSION"] = "ovis-test-guard";
    expect(herdrSocketPath()).toBe(join(home, ".config", "herdr", "herdr.sock"));
    const refused = await herdrRpc("ping", {}).then(() => null, (error: unknown) => error);
    expect((refused as { code?: string } | null)?.code).toBe("live_herdr_refused");
    // said out loud, the live session may be used
    process.env["OVIS_ALLOW_LIVE_HERDR"] = "1";
    const reached = await herdrRpc("ping", {}).then(() => null, (error: unknown) => error);
    expect((reached as { code?: string } | null)?.code).not.toBe("live_herdr_refused");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
