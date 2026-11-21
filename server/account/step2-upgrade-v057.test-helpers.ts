import { symlinkSync } from "node:fs";
import { join } from "node:path";
import type { createServer } from "../index.ts";
import { DEVICE_COOKIE } from "../auth.ts";

export const V057 = "acab7685663bebc0ce2e93c75b4e3c4048d9f0bb";

/** Run the release's own writers in disposable state, not Step 2 with an option flipped. */
export async function v057Fixture(checkout: string) {
  const repo = join(import.meta.dir, "../..");
  const archive = Bun.spawnSync(["git", "archive", V057], { cwd: repo, env: { ...process.env, GIT_MASTER: "1" } });
  if (archive.exitCode !== 0) throw new Error(`Need the v0.5.7 release object (git fetch origin tag v0.5.7): ${archive.stderr.toString()}`);
  await new Bun.Archive(archive.stdout).extract(checkout);
  symlinkSync(join(repo, "node_modules"), join(checkout, "node_modules"), "junction");
  const release: { readonly createServer: typeof createServer } = await import(join(checkout, "server/index.ts"));
  return (stateDir: string) => release.createServer({
    port: 0, hostname: "127.0.0.1", stateDir, token: "matrix-owner", sidecar: false,
    tailscaleOwner: null, accountOpensAll: false, accountService: { url: "off" },
  });
}

export function credentialStatus(port: number, token: string): Promise<number> {
  return fetch(`http://127.0.0.1:${port}/api/devices`, { headers: {
    cookie: `${DEVICE_COOKIE}=${token}`, "x-forwarded-for": "100.64.0.9",
  } }).then(async response => { await response.arrayBuffer(); return response.status; });
}
