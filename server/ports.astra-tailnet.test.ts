import { expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTailscale, serveTailscale } from "./tailscale.ts";

const status = JSON.stringify({ BackendState: "Running", Self: { DNSName: "pc.example.ts.net." } });
it("the serve button makes no changes when it cannot inventory occupied ports", async () => {
  const dir = mkdtempSync(join(tmpdir(), "astra-ports-"));
  try {
    const bin = join(dir, "tailscale");
    const calls = join(dir, "mutation");
    writeFileSync(bin, `#!/bin/sh\ncase "$1:$2" in\nstatus:--json) printf '%s' '${status}';;\nserve:status) exit 1;;\n*) printf '%s' "$*" > "$(dirname "$0")/mutation"; exit 1;;\nesac\n`, { mode: 0o700 });
    await serveTailscale(7317, [443], bin);
    expect(existsSync(calls) ? readFileSync(calls, "utf8") : null).toBeNull();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("the first free allowed port excludes foreground Serve listeners", () => {
  const foreground = { TCP: { "443": { HTTPS: true } }, Web: { "pc.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8000" } } } } };
  const access = parseTailscale({ status, serve: JSON.stringify({ Foreground: { "session-id": foreground } }) }, 7317, [443, 8443]);
  expect(access.serve_command).toContain("--https=8443");
});
