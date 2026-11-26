import { expect, it, onTestFinished } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { herdrRpc, ping } from "../server/herdr/client.ts";

// herdr runs every plugin the user installed (its plugins.json) in each server it starts: an installed Ovis's
// startup hook would start the user's own Ovis from inside the test session
it.skipIf(process.platform === "win32")("the test herdr runs none of the user's installed plugins, and stops as its session", async () => {
  // a short root: the session socket lives under it (104 bytes on macOS, 108 on Linux)
  const root = mkdtempSync(join("/tmp", "herdr-test-plugins-"));
  const user = join(root, "config");
  const plugin = join(root, "plugin");
  const ran = join(root, "startup-ran");
  const session = "plugins";
  const socket = join(user, "herdr", "sessions", session, "herdr.sock");
  const herdr = process.env["OVIS_HERDR_BIN"] || Bun.which("herdr")!;
  // a fresh run's environment, with this root as the user's config folder
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !/^(HERDR_|OVIS_TEST_USER_)/.test(entry[0]))),
    XDG_CONFIG_HOME: user, HERDR_TEST_SESSION: session,
  };
  const stop = () => Bun.spawnSync([herdr, "--session", session, "server", "stop"], { env, stdout: "pipe", stderr: "pipe" });
  onTestFinished(() => {
    if (existsSync(socket)) stop();
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(plugin);
  writeFileSync(join(plugin, "herdr-plugin.toml"), [
    'id = "example.user-plugin"', 'name = "User plugin"', 'version = "0.0.0"', 'min_herdr_version = "0.9.0"', 'platforms = ["linux", "macos"]',
    "[[startup]]", `command = ${JSON.stringify(["sh", "-c", `: > '${ran}'`])}`, "",
  ].join("\n"));
  const linked = Bun.spawnSync([herdr, "plugin", "link", plugin], { env, stdout: "pipe", stderr: "pipe" });
  expect(linked.stderr.toString()).toBe("");
  expect(linked.exitCode).toBe(0);

  // what every test run does first: the preload starts the session's herdr, which outlives it
  const started = Bun.spawnSync([process.execPath, join(import.meta.dir, "test-herdr.ts")], { env, cwd: root, stdout: "pipe", stderr: "pipe" });
  if (started.exitCode !== 0) throw new Error(`scripts/test-herdr.ts failed: ${started.stderr}`);

  const { plugins } = await herdrRpc<{ plugins: { plugin_id: string }[] }>("plugin.list", {}, socket);
  expect(plugins.map((entry) => entry.plugin_id)).toEqual([]);
  expect(existsSync(ran)).toBe(false);

  // the documented way to stop it, `herdr --session <name> server stop`, still reaches it
  expect(stop().exitCode).toBe(0);
  for (const deadline = Date.now() + 10_000; await ping(socket).then(() => true, () => false);) {
    if (Date.now() > deadline) throw new Error(`the test herdr at ${socket} did not stop`);
    await Bun.sleep(50);
  }
}, 30_000);
