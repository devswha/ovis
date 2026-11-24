import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { installServer } from "./server-install.ts";
import { DIST_ARCHIVE, generateKeyPair, PTY_ASSETS, RELEASE_PUBLIC_KEY, releaseFile, SERVER_PLATFORMS, signManifest, writeManifest } from "./server-manifest.ts";

const scratch = mkdtempSync(join(tmpdir(), "ovis-keeper-install-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const key = generateKeyPair();
const host = '#!/bin/sh\n[ "$#" != 0 ] && exit 0\necho "pty-sidecar: usage: fixture" >&2\nexit 2\n';
const keeper = '#!/bin/sh\necho "Usage: ovis-acp-keeper ROOT" >&2\nexit 2\n';
const version = "1.2.3";
const installer = readFileSync(join(import.meta.dir, "..", "install.sh"), "utf8")
  .replace(`RELEASE_PUBLIC_KEY="${RELEASE_PUBLIC_KEY}"`, `RELEASE_PUBLIC_KEY="${key.publicKey}"`)
  .replace(/\nmain "\$@"\n$/, '\n');

describe.skipIf(process.platform === "win32")("optional keeper in a signed server installation", () => {
  for (const via of ["shell", "plugin"]) {
    it.each(["good", "missing", "wrong hash", "wrong program", "old manifest"])(
      `${via}: %s keeper never takes down the server or PTY host`, async (state) => {
        const root = mkdtempSync(join(scratch, "pc-"));
        const probe = keeper.replace("echo", `: > "${join(root, "ran")}"; echo`);
        const dir = join(root, `v${version}`);
        mkdirSync(dir);
        for (const platform of SERVER_PLATFORMS) writeFileSync(join(dir, releaseFile(platform)), "#!/bin/sh\necho running\n");
        for (const build of PTY_ASSETS) {
          writeFileSync(join(dir, `ovis-pty-sidecar-${build}`), host);
          if (state !== "old manifest") writeFileSync(join(dir, `ovis-acp-keeper-${build}`), state === "wrong program" ? host : probe);
        }
        writeFileSync(join(root, "index.html"), "<title>Ovis</title>");
        expect(Bun.spawnSync(["tar", "-czf", join(dir, DIST_ARCHIVE), "-C", root, "index.html"]).exitCode).toBe(0);
        const manifest = writeManifest(dir, { version, sources: { server: "a".repeat(40), shared: "b".repeat(40) } });
        signManifest(dir, key.privateKeyPem);
        const asset = join(dir, "ovis-acp-keeper-linux-x64");
        if (state === "missing") rmSync(asset);
        if (state === "wrong hash" || state === "old manifest") writeFileSync(asset, probe.replace("ROOT", "FAKE"));
        const releases = pathToFileURL(root).href;
        const home = join(root, ".local/share/ovis");
        if (via === "shell") {
          if (!Bun.which("node")) symlinkSync(process.execPath, join(root, "node"));
          const result = Bun.spawnSync(["sh", "-c", `${installer}\nos=linux; arch=x64; platform=linux-x64; install_binary ${version}`],
            { env: { HOME: root, PATH: `${root}:${process.env["PATH"]}`, TMPDIR: tmpdir(), OVIS_RELEASES_URL: releases } });
          expect(result.exitCode, result.stderr.toString()).toBe(0);
        } else {
          expect((await installServer({ home, releases, version, publicKey: key.publicKey, platform: "linux-x64" })).installed).toBe(true);
        }
        const bin = join(home, "bin");
        expect(Bun.spawnSync([join(bin, "ovis-server")]).stdout.toString()).toBe("running\n");
        expect(readFileSync(join(bin, "bin/ovis-pty-sidecar"), "utf8")).toBe(host);
        const installed = join(bin, "bin/ovis-acp-keeper");
        expect(existsSync(join(root, "ran"))).toBe(state === "good");
        if (state === "good") {
          expect(Bun.spawnSync([installed]).stderr.toString()).toContain("Usage: ovis-acp-keeper ");
          expect(JSON.parse(readFileSync(`${installed}.json`, "utf8"))).toEqual({ sha256: manifest.acpKeeper?.["linux-x64"].sha256, version });
        } else {
          expect(existsSync(installed)).toBe(false);
          expect(existsSync(`${installed}.json`)).toBe(false);
        }
      },
    );
  }
});

it.skipIf(process.platform === "win32")("prepares the active herdr-core source checkout's helpers before starting the server", () => {
  const home = mkdtempSync(join(scratch, "core-"));
  mkdirSync(join(home, ".local/share/ovis/app/.git"), { recursive: true });
  mkdirSync(join(home, "active/scripts"), { recursive: true });
  writeFileSync(join(home, "active/scripts/pty-sidecar.ts"), "");
  const run = Bun.spawnSync(["sh", "-c", `${installer}
ref_not_moved() { :; }
core_settings() { settings_dir=$HOME; state_dir=$HOME; }
running_code() { echo "$HOME/active"; }
core_service() { :; }
bun() {
  case "$*" in
    "scripts/pty-sidecar.ts install") : > "$PWD/native-ready" ;;
    *"plugin.ts start") test -f "$HOME/active/native-ready" && echo ready-at-start ;;
    *) return 1 ;;
  esac
}
start_line=unused
install_core`], { env: { HOME: home, PATH: process.env["PATH"] } });
  expect(run.stdout.toString() + run.stderr.toString()).toContain("ready-at-start");
});
