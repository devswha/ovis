import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processesWith } from "./processes.ts";

const CAPTURE = join(import.meta.dir, "herdr-reference.ts");
const TEST_MS = 60_000;
const scratch = mkdtempSync(join(realpathSync(tmpdir()), "herdr-ref-"));
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });

describe("the herdr reference capture, with a stand-in herdr", () => {
  it("ends a CLI call that is blocked when the capture gets SIGTERM, and leaves no process", async () => {
    const started = join(scratch, "version-started");
    const standIn = join(scratch, "herdr");
    // the server makes both sockets and runs until `server stop`; `--version` blocks (self-limited to 20 s)
    writeFileSync(standIn, `#!/bin/sh
state="$XDG_CONFIG_HOME/herdr/sessions/r32"
case "$3" in
  server)
    if [ "$4" = stop ]; then : > "$state/stop"; exit 0; fi
    mkdir -p "$state"; : > "$state/herdr.sock"; : > "$state/herdr-client.sock"
    while [ ! -e "$state/stop" ]; do sleep 0.05; done
    rm -f "$state/herdr.sock" "$state/herdr-client.sock"; exit 0 ;;
  --version) : > ${started}; exec sleep 20 ;;
esac
exit 3
`);
    chmodSync(standIn, 0o700);
    const capture = Bun.spawn([process.execPath, CAPTURE, standIn], {
      env: { PATH: "/usr/bin:/bin", HOME: scratch, TMPDIR: scratch }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const stdout = new Response(capture.stdout).text();
    const stderr = new Response(capture.stderr).text();
    const deadline = setTimeout(() => capture.kill("SIGKILL"), 40_000);
    try {
      const blocked = new Promise<void>((resolve) => {
        const watcher = watch(scratch, () => { if (existsSync(started)) { watcher.close(); resolve(); } });
        if (existsSync(started)) { watcher.close(); resolve(); }
      });
      await Promise.race([blocked, capture.exited.then(async () => { throw new Error(`the capture ended before --version blocked: ${await stderr}`); })]);
      capture.kill("SIGTERM");
      const code = await capture.exited;
      expect({ code, cleaned: (await stdout).includes("owned server exited"), left: processesWith(`NOMARK-${crypto.randomUUID()}`, scratch) }).toEqual({ code: 143, cleaned: true, left: [] });
    } finally {
      clearTimeout(deadline);
    }
  }, TEST_MS);
});
