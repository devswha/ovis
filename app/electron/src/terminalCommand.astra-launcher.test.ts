import { afterEach, beforeEach, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isFile } from "./children.ts";
import { installCommand, writeLauncher, type CommandHost } from "./terminalCommand.ts";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "launcher-desktop-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

function fixture() {
  const home = join(root, "home");
  const cli = join(home, "cli");
  mkdirSync(cli, { recursive: true });
  const places = { serverBinary: join(home, "ovis-server"), desktopJson: join(home, "desktop.json"), stateDir: join(home, "state"), configDir: join(home, "config"), accountService: null };
  writeFileSync(places.serverBinary, '#!/bin/sh\nexec "$TEST_BUN" "$TEST_SERVER" "$@"\n', { mode: 0o755 });
  const launcher = writeLauncher(cli, "darwin", places);
  const host: CommandHost = { platform: "darwin", home, launcher, shell: "/bin/zsh", isFile, terminalPath: async () => "/usr/bin:/bin", run: async () => null };
  const env = { HOME: home, PATH: "/usr/bin:/bin", TMPDIR: tmpdir(), TEST_BUN: process.execPath, TEST_SERVER: join(import.meta.dir, "../../../server/main.ts") };
  return { home, cli, host, places, env };
}

// Links in a POSIX ~/.local/bin, which a Windows host does not use.
it.skipIf(process.platform === "win32")("keeps a user's launcher out of a redirected shared bin", async () => {
  const { home, host } = fixture();
  const shared = join(root, "shared-bin");
  mkdirSync(shared); mkdirSync(join(home, ".local"));
  symlinkSync(shared, join(home, ".local/bin"));
  await installCommand(host).catch(() => undefined);
  expect(existsSync(join(shared, "ovis")), "launcher appeared outside home").toBe(false);
});

it.skipIf(process.platform === "win32")("finishes a partially installed off-PATH command on retry", async () => {
  const { home, host } = fixture();
  const profile = join(home, ".zprofile");
  mkdirSync(profile);
  await expect(installCommand(host)).rejects.toThrow();
  rmSync(profile, { recursive: true });
  await installCommand(host);
  expect(existsSync(profile), "retry did not create the missing PATH entry").toBe(true);
});

// Runs a real /bin/bash login shell and the POSIX launcher, which a Windows host has neither of.
it.skipIf(process.platform === "win32")("preserves the login profile bash was actually reading", async () => {
  const { home, env, host } = fixture();
  const login = () => execFileSync("/bin/bash", ["-lc", 'printf %s "${LOGIN_MARKER:-missing}"'], { env, encoding: "utf8" });
  writeFileSync(join(home, ".profile"), "export LOGIN_MARKER=original-profile\n");
  expect(login()).toBe("original-profile");
  await installCommand({ ...host, shell: "/bin/bash" });
  expect(login()).toBe("original-profile");
});
