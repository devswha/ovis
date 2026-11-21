import { afterEach, beforeEach, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "launcher-installer-")); });
afterEach(() => rmSync(home, { recursive: true, force: true }));
const ps = readFileSync(join(import.meta.dir, "install.ps1"), "utf8");
const command = ps.slice(ps.indexOf("function Write-OvisCommand {"), ps.indexOf("\n$newInstall ="));
const pwsh = Bun.which("pwsh") ?? join(tmpdir(), "launcher-pwsh", "pwsh");

function install(dir: string) {
  execFileSync(pwsh, ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop'; $ovisHome=$env:TEST_HOME; ${command}\nWrite-OvisCommand`], {
    cwd: home, env: { PATH: "/usr/bin:/bin", HOME: home, TMPDIR: tmpdir(), TEST_HOME: dir, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, DOTNET_CLI_HOME: home, DOTNET_EnableDiagnostics: "0", POWERSHELL_TELEMETRY_OPTOUT: "1", PSModuleAnalysisCachePath: join(home, "ps-cache") },
  });
}

it.skipIf(process.platform !== "linux")("leaves an existing unrelated Windows command file unchanged", () => {
  const dir = join(home, "ovis");
  mkdirSync(join(dir, "cmd"), { recursive: true });
  const shim = join(dir, "cmd", "ovis.cmd");
  writeFileSync(shim, "@echo unrelated\n");
  try { install(dir); } catch {}
  expect(readFileSync(shim, "utf8").split(/\r?\n/)[0]).toBe("@echo unrelated");
});

it.skipIf(process.platform !== "linux")("writes a usable Windows shim under a non-ASCII user path", () => {
  const dir = join(home, "東京", "ovis");
  install(dir);
  const shim = readFileSync(join(dir, "cmd", "ovis.cmd"), "utf8");
  expect(shim.includes("??"), "encoded 東京 as ?? in the executable path").toBe(false);
});
