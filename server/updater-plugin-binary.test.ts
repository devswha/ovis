import { afterEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_BINARY_REASON, pluginBinaryOf, Updater } from "./updater.ts";

// A herdr plugin checkout that scripts/plugin-launch.ts runs as the release's binary: the server's root is the release
// folder inside the checkout's .ovis/server, where git still finds the checkout. Settings must say the update runs
// through herdr, never that the source checkout should switch to main (following that builds a release the binary
// never runs), and nothing may be installed from the app.
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function pluginCheckout(): { checkout: string; root: string; stateDir: string } {
  const scratch = mkdtempSync(join(tmpdir(), "ovis-plugin-binary-"));
  dirs.push(scratch);
  const checkout = join(scratch, "checkout");
  mkdirSync(checkout);
  writeFileSync(join(checkout, "package.json"), '{"version":"0.5.4"}\n');
  const git = (...args: string[]) => Bun.spawnSync(["git", "-C", checkout, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { stdout: "ignore", stderr: "ignore" });
  git("init", "-q"); git("add", "-A"); git("commit", "-qm", "release"); git("checkout", "-q", "--detach");
  const root = join(checkout, ".ovis", "server", "releases", "0.5.4-abcd");
  mkdirSync(root, { recursive: true });
  return { checkout, root, stateDir: join(scratch, "state") };
}

it("marks only a compiled server under the plugin's launcher as the plugin's binary", () => {
  const { checkout } = pluginCheckout();
  expect(pluginBinaryOf(checkout, true)).toEqual({ checkout, version: "0.5.4" });
  expect(pluginBinaryOf(checkout, false)).toBeUndefined();
  expect(pluginBinaryOf(undefined, true)).toBeUndefined();
});

it("tells a plugin's compiled server to update through herdr, and offers no in-app update", async () => {
  const { checkout, root, stateDir } = pluginCheckout();
  const updater = new Updater({ root, stateDir, autoUpdate: false, pluginBinary: { checkout, version: "0.5.4" }, publish() {}, activate: async () => {} });
  await updater.initialize();
  expect(updater.status.managed).toBe(false);
  expect(updater.status.current_version).toBe("0.5.4");
  expect(updater.status.blocked_reason).toBe(PLUGIN_BINARY_REASON);
  expect(PLUGIN_BINARY_REASON).toContain("herdr plugin update");
  expect(updater.status.blocked_reason).not.toContain("main");
});
