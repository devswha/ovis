import { expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { updateStateDir } from "../server/update-state.ts";

const repo = join(import.meta.dir, "..");

// Runs the POSIX launcher install.sh writes, which a Windows host cannot.
it.skipIf(process.platform === "win32")("uses the active release's non-destructive stop --help after a source update", () => {
  const home = mkdtempSync(join(tmpdir(), "launcher-upgrade-"));
  try {
    const checkout = join(home, ".local/share/ovis/app"), state = join(home, "state");
    const revision = execFileSync("git", ["rev-parse", "89c9e264c"], { cwd: repo, encoding: "utf8" }).trim();
    const release = join(updateStateDir(checkout, 7317, state), "release-review");
    for (const [commit, destination] of [[revision, checkout], ["HEAD", release]] as const) {
      mkdirSync(destination, { recursive: true });
      execFileSync("/bin/sh", ["-c", 'git archive "$1" scripts server shared package.json | tar -x -C "$2"', "archive", commit, destination], { cwd: repo });
    }
    execFileSync("git", ["clone", "-q", "--bare", "--shared", repo, join(checkout, ".git")]);
    execFileSync("git", ["--git-dir", join(checkout, ".git"), "update-ref", "--no-deref", "HEAD", revision]);
    writeFileSync(join(dirname(release), "current.json"), JSON.stringify({ source_revision: revision, directory: release }));
    const bin = join(home, "bin"); mkdirSync(bin); symlinkSync(process.execPath, join(bin, "bun"));
    const env = { HOME: home, HOST: "127.0.0.1", PORT: "7317", TMPDIR: tmpdir(), PATH: `${bin}:/usr/bin:/bin`, OVIS_STATE_DIR: state };
    const installer = readFileSync(join(repo, "install.sh"), "utf8");
    const functions = installer.slice(installer.indexOf("release_js() {"), installer.indexOf("find_other_ovis() {"));
    const launcher = join(bin, "ovis");
    execFileSync("/bin/sh", ["-c", `${functions}\nLAUNCHER_MARK='# test'; launcher_text >"$1"; chmod +x "$1"`, "make", launcher], { env });
    expect(execFileSync(process.execPath, [join(release, "scripts/plugin.ts"), "stop", "--help"], { env, encoding: "utf8" })).toContain("Usage: ovis stop");
    const output = execFileSync(launcher, ["stop", "--help"], { env, encoding: "utf8" });
    expect(output.trim()).toContain("Usage: ovis stop");
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 30_000);
