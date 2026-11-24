import { expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../index.ts";
import { RunStore } from "./runs.ts";

it("a verified agent run token is not an HTTP credential", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "agent-access-"));
  const runs = new RunStore(join(stateDir, "agent-tools"));
  const key = runs.reserve();
  key.bind({ self: "t1", harness: "claude", root: key.id, started_by: null, depth: 0 });
  const token = readFileSync(key.tokenFile, "utf8");
  const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "not-an-agent-run", machines: false, sidecar: false, tailscaleOwner: null });
  try {
    expect(runs.verify(token)?.id).toBe(key.id);
    const reply = await fetch(`http://127.0.0.1:${app.port}/api/session`, { headers: { authorization: `Bearer ${token}` } });
    expect(reply.status).toBe(401);
  } finally { app.stop(); rmSync(stateDir, { recursive: true, force: true }); }
});
