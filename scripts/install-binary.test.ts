import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIST_ARCHIVE, generateKeyPair, RELEASE_PUBLIC_KEY, releaseFile, SERVER_PLATFORMS, signManifest, writeManifest } from "./server-manifest.ts";

/**
 * install.sh's binary install (install_binary), run under /bin/sh from a copy of the script whose one pinned key line
 * names a key made for the test: the shipped script reads no key from anywhere else, so only a copy can trust another.
 * The release is a file:// folder laid out as GitHub's downloads are (<base>/v<version>/<file>).
 */
const ROOT = join(import.meta.dir, "..");
const INSTALLER = readFileSync(join(ROOT, "install.sh"), "utf8");
const KEY_LINE = `\nRELEASE_PUBLIC_KEY="${RELEASE_PUBLIC_KEY}"\n`;
const PLATFORM = `${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}` as const;
const sources = { server: "a".repeat(40), shared: "b".repeat(40) };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** install.sh with its key line naming `publicKey`, and without the last line that runs main */
function testCopy(publicKey: string): string {
  expect(INSTALLER).toContain(KEY_LINE);
  expect(INSTALLER.endsWith('\nmain "$@"\n')).toBe(true);
  return INSTALLER.replace(KEY_LINE, `\nRELEASE_PUBLIC_KEY="${publicKey}"\n`).slice(0, -'main "$@"\n'.length);
}

function release(base: string, version: string, privateKeyPem: string): string {
  const dir = join(base, `v${version}`);
  mkdirSync(dir, { recursive: true });
  for (const platform of SERVER_PLATFORMS) writeFileSync(join(dir, releaseFile(platform)), `#!/bin/sh\necho ovis-server ${version} "$@"\n`);
  const client = join(base, `client-${version}`);
  mkdirSync(client, { recursive: true });
  writeFileSync(join(client, "index.html"), `<!doctype html><title>${version}</title>`);
  expect(Bun.spawnSync(["tar", "-czf", join(dir, DIST_ARCHIVE), "-C", client, "."]).exitCode).toBe(0);
  rmSync(client, { recursive: true });
  writeManifest(dir, { version, sources });
  signManifest(dir, privateKeyPem);
  return dir;
}

/** One PC: a HOME, a release folder, and a bin of stand-ins put before the system's on PATH */
function pc({ lockWait }: { lockWait?: number } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), "ovis-install-binary-"));
  dirs.push(scratch);
  const home = join(scratch, "home");
  const releases = join(scratch, "release");
  const stand = join(scratch, "stand-ins");
  mkdirSync(home);
  mkdirSync(stand);
  const key = generateKeyPair();
  const copy = lockWait === undefined ? testCopy(key.publicKey) : testCopy(key.publicKey).replace("\nINSTALL_LOCK_WAIT=600\n", `\nINSTALL_LOCK_WAIT=${lockWait}\n`);
  if (lockWait !== undefined) expect(copy).toContain(`\nINSTALL_LOCK_WAIT=${lockWait}\n`);
  const argv = (call: string) => ["/bin/sh", "-c", `set -eu\nos=${PLATFORM.split("-")[0]}; arch=${PLATFORM.split("-")[1]}; platform=${PLATFORM}\n${copy}\n${call}`];
  const environment = (env: Record<string, string>) => ({ HOME: home, PATH: `${stand}:${process.env["PATH"]}`, OVIS_RELEASES_URL: `file://${releases}`, ...env });
  const run = (call: string, env: Record<string, string> = {}) => {
    const result = Bun.spawnSync(argv(call), { env: environment(env), stdout: "pipe", stderr: "pipe", timeout: 60_000 });
    return { code: result.exitCode, signal: result.signalCode, out: result.stdout.toString() + result.stderr.toString() };
  };
  /** the same run, started now and awaited later: two of them overlap */
  const start = async (call: string, env: Record<string, string> = {}) => {
    const child = Bun.spawn(argv(call), { env: environment(env), stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, out: out + err };
  };
  const standIn = (name: string, script: string) => writeFileSync(join(stand, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  // a PC without node (macOS out of the box, whose openssl is LibreSSL) would fetch the official Node build for every
  // check: Bun's node:crypto stands in, so these tests never reach the network
  if (!Bun.which("node")) standIn("node", `exec "${process.execPath}" "$@"`);
  const dropStandIn = (name: string) => rmSync(join(stand, name));
  return { home, releases, key, run, start, standIn, dropStandIn, binary: join(home, ".local/share/ovis/bin/ovis-server"), ovis: join(home, ".local/share/ovis") };
}

/** every file and link under `dir`, with its SHA-256 or target */
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    if (entry.isSymbolicLink()) files[path] = `-> ${readlinkSync(path)}`;
    else if (entry.isFile()) files[path] = sha256(path);
  }
  return files;
}

describe.skipIf(process.platform === "win32")("install.sh installs the release's verified binary", () => {
  it("checks the signature and every SHA-256, then swaps bin in one rename; a second run has nothing to do", () => {
    const { releases, key, run, binary, ovis } = pc();
    const dir = release(releases, "1.2.3", key.privateKeyPem);
    const first = run("install_binary 1.2.3");
    expect(first.out).toContain("installed Ovis 1.2.3");
    expect(first.code).toBe(0);
    expect(sha256(binary)).toBe(sha256(join(dir, releaseFile(PLATFORM))));
    expect(lstatSync(join(ovis, "bin")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(ovis, "bin/dist/index.html"), "utf8")).toContain("1.2.3");
    const before = snapshot(ovis);
    const again = run("install_binary 1.2.3");
    expect(again.code).toBe(0);
    expect(again.out).toContain("nothing to do");
    expect(snapshot(ovis)).toEqual(before);
  });

  const spoilers: [string, (dir: string, privateKeyPem: string) => void, string][] = [
    ["a corrupt binary", (dir) => writeFileSync(join(dir, releaseFile(PLATFORM)), readFileSync(join(dir, releaseFile(PLATFORM))).map((byte, index) => (index === 12 ? byte ^ 1 : byte))), "does not match its SHA-256"],
    ["a truncated binary", (dir) => writeFileSync(join(dir, releaseFile(PLATFORM)), "#!/bin"), "bytes, not the"],
    ["a binary larger than the manifest says", (dir) => writeFileSync(join(dir, releaseFile(PLATFORM)), Buffer.concat([readFileSync(join(dir, releaseFile(PLATFORM))), Buffer.alloc(8192)])), "larger than"],
    ["a corrupt client archive", (dir) => writeFileSync(join(dir, DIST_ARCHIVE), "x"), DIST_ARCHIVE],
    ["a manifest signed by another key", (dir) => signManifest(dir, generateKeyPair().privateKeyPem), "signature"],
    ["a manifest for another version", (dir, privateKeyPem) => {
      writeManifest(dir, { version: "1.2.2", sources });
      signManifest(dir, privateKeyPem);
    }, "is for version 1.2.2, not 1.2.4"],
    ["a manifest edited after it was signed", (dir) => writeFileSync(join(dir, "ovis-server.json"), readFileSync(join(dir, "ovis-server.json"), "utf8").replace('"version": "1.2.4"', '"version": "1.2.5"')), "signature"],
  ];
  for (const [what, spoil, says] of spoilers) {
    it(`refuses ${what} and leaves the previous install byte for byte as it was`, () => {
      const { releases, key, run, binary, ovis } = pc();
      release(releases, "1.2.3", key.privateKeyPem);
      expect(run("install_binary 1.2.3").code).toBe(0);
      const before = snapshot(ovis);
      const kept = sha256(binary);
      spoil(release(releases, "1.2.4", key.privateKeyPem), key.privateKeyPem);
      const result = run("install_binary 1.2.4");
      expect(result.code).not.toBe(0);
      expect(result.out).toContain(says);
      expect(result.out).toContain("nothing was changed");
      expect(sha256(binary)).toBe(kept);
      expect(snapshot(ovis)).toEqual(before);
    });
  }

  it("keeps the release bin named before an install, for a server still running from it, and drops it at the next", () => {
    const { releases, key, run, ovis } = pc();
    const kept = () => readdirSync(join(ovis, "releases")).sort().map((name) => name.split("-")[0]);
    for (const version of ["1.2.3", "1.2.4", "1.2.5"]) release(releases, version, key.privateKeyPem);
    expect(run("install_binary 1.2.3").code).toBe(0);
    expect(run("install_binary 1.2.4").code).toBe(0);
    expect(kept()).toEqual(["1.2.3", "1.2.4"]);
    expect(run("install_binary 1.2.5").code).toBe(0);
    expect(kept()).toEqual(["1.2.4", "1.2.5"]);
  });

  it("refuses a client archive with a member outside its folder, though the right key signed it", () => {
    const { releases, key, run, ovis } = pc();
    const dir = release(releases, "1.2.3", key.privateKeyPem);
    const evil = join(releases, "evil", "inner");
    mkdirSync(evil, { recursive: true });
    writeFileSync(join(evil, "..", "escaped"), "x");
    expect(Bun.spawnSync(["tar", "-czPf", join(dir, DIST_ARCHIVE), "-C", evil, "../escaped"]).exitCode).toBe(0);
    writeManifest(dir, { version: "1.2.3", sources });
    signManifest(dir, key.privateKeyPem);
    const result = run("install_binary 1.2.3");
    expect(result.code).not.toBe(0);
    expect(result.out).toContain("outside");
    expect(existsSync(join(ovis, "bin"))).toBe(false);
    expect(existsSync(join(ovis, "escaped"))).toBe(false);
  });

  it("refuses a client archive holding a link, though the right key signed it, and leaves the install as it was", () => {
    const { releases, key, run, ovis } = pc();
    release(releases, "1.2.3", key.privateKeyPem);
    expect(run("install_binary 1.2.3").code).toBe(0);
    const before = snapshot(ovis);
    const dir = release(releases, "1.2.4", key.privateKeyPem);
    const client = join(releases, "linked-client");
    mkdirSync(client);
    writeFileSync(join(client, "index.html"), "<!doctype html>");
    symlinkSync("/etc/passwd", join(client, "passwd"));
    expect(Bun.spawnSync(["tar", "-czf", join(dir, DIST_ARCHIVE), "-C", client, "."]).exitCode).toBe(0);
    writeManifest(dir, { version: "1.2.4", sources });
    signManifest(dir, key.privateKeyPem);
    const result = run("install_binary 1.2.4");
    expect(result.code).not.toBe(0);
    expect(result.out).toContain("something other than files and folders");
    expect(snapshot(ovis)).toEqual(before);
  });

  it("refuses a manifest of a schema it does not know, though the right key signed it", () => {
    const { releases, key, run, ovis } = pc();
    const dir = release(releases, "1.2.3", key.privateKeyPem);
    writeFileSync(join(dir, "ovis-server.json"), readFileSync(join(dir, "ovis-server.json"), "utf8").replace('"schema": 1,', '"schema": 2,'));
    signManifest(dir, key.privateKeyPem);
    const result = run("install_binary 1.2.3");
    expect(result.code).not.toBe(0);
    expect(result.out).toContain("schema");
    expect(existsSync(join(ovis, "bin"))).toBe(false);
  });

  it("never leaves bin without a whole release when two installs overlap, and at least one of them succeeds", async () => {
    const { releases, key, start, ovis, home } = pc();
    const shas = new Map(["1.2.3", "1.2.4"].map((version) => [sha256(join(release(releases, version, key.privateKeyPem), releaseFile(PLATFORM))), version]));
    for (let pair = 0; pair < 20; pair++) {
      // both start, then both wait for the barrier, so their installs begin together
      const barrier = join(home, `barrier-${pair}`);
      const wait = `while [ ! -e "${barrier}" ]; do sleep 0.01; done; `;
      const [first, second] = [pair % 2 ? "1.2.3" : "1.2.4", pair % 2 ? "1.2.4" : "1.2.3"];
      const runs = [start(`${wait}install_binary ${first}`), start(`${wait}install_binary ${second}`)];
      writeFileSync(barrier, "");
      const results = await Promise.all(runs);
      expect(results.some((result) => result.code === 0), results.map((result) => result.out).join("\n")).toBe(true);
      for (const result of results) if (result.code !== 0) expect(result.out).toContain("another install is running");
      const running = join(ovis, "bin");
      const version = shas.get(sha256(join(running, "ovis-server")));
      expect(version, `pair ${pair}: bin holds no whole release`).toBeDefined();
      expect(readFileSync(join(running, "ovis-server.json"), "utf8")).toContain(`"version": "${version}"`);
      expect(readFileSync(join(running, "dist", "index.html"), "utf8")).toContain(version!);
      expect(readdirSync(join(ovis, "releases")).filter((name) => name.startsWith("."))).toEqual([]);
      expect(existsSync(join(ovis, ".install.lock"))).toBe(false);
    }
  }, 120_000);

  it("lets a second install in only after the first has swapped bin, not into its window", async () => {
    const { releases, key, start, standIn, ovis, home } = pc();
    release(releases, "1.2.3", key.privateKeyPem);
    release(releases, "1.2.4", key.privateKeyPem);
    const sync = join(home, "sync");
    mkdirSync(sync);
    // the first run, in its window (both files checked, nothing moved yet), goes on only once the second run says it
    // waits for the lock, or has reached that window itself, which only a missing lock allows
    standIn("tar", `if [ "$RUN" = first ] && [ "$1" = -tzf ]; then
  : > "${sync}/first-in"
  n=0; until [ -e "${sync}/second-in" ] || grep -qs "waiting for it" "${sync}/second.out"; do n=$((n + 1)); [ "$n" -lt 3000 ] || break; sleep 0.01; done
fi
[ "$RUN" != second ] || [ "$1" != -tzf ] || : > "${sync}/second-in"
exec "${Bun.which("tar")}" "$@"`);
    const first = start("install_binary 1.2.3", { RUN: "first" });
    const second = start(`until [ -e "${sync}/first-in" ]; do sleep 0.01; done; install_binary 1.2.4 > "${sync}/second.out" 2>&1`, { RUN: "second" });
    const [one, two] = await Promise.all([first, second]);
    const said = readFileSync(join(sync, "second.out"), "utf8");
    expect(one.code, one.out).toBe(0);
    expect(two.code, said).toBe(0);
    expect(said).toContain("waiting for it");
    expect(existsSync(join(sync, "second-in"))).toBe(true);
    expect(readFileSync(join(ovis, "bin", "ovis-server.json"), "utf8")).toContain('"version": "1.2.4"');
  });

  it("takes over the lock of an install that died, and waits out a live one's, then says who holds it", () => {
    const { releases, key, run, ovis } = pc();
    release(releases, "1.2.3", key.privateKeyPem);
    const lock = join(ovis, ".install.lock");
    const dead = Bun.spawnSync(["sh", "-c", "echo $$"]).stdout.toString().trim();
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "pid"), `${dead}\n`);
    const taken = run("install_binary 1.2.3");
    expect(taken.code, taken.out).toBe(0);
    expect(existsSync(lock)).toBe(false);
    const waiting = pc({ lockWait: 2 });
    release(waiting.releases, "1.2.3", waiting.key.privateKeyPem);
    const holder = Bun.spawn(["sleep", "30"]);
    try {
      mkdirSync(join(waiting.ovis, ".install.lock"), { recursive: true });
      writeFileSync(join(waiting.ovis, ".install.lock", "pid"), `${holder.pid}\n`);
      const refused = waiting.run("install_binary 1.2.3");
      expect(refused.code).not.toBe(0);
      expect(refused.out).toContain(`another install is running in ${waiting.ovis} (pid ${holder.pid})`);
      expect(readFileSync(join(waiting.ovis, ".install.lock", "pid"), "utf8").trim()).toBe(String(holder.pid));
      expect(existsSync(join(waiting.ovis, "bin"))).toBe(false);
    } finally {
      holder.kill();
    }
  });

  it("takes releases only from https:// or a file:// folder", () => {
    const { run } = pc();
    for (const url of ["http://mirror.example/ovis", "ftp://mirror.example", "/srv/release"]) {
      const result = run("install_binary 1.2.3", { OVIS_RELEASES_URL: url });
      expect(result.code).not.toBe(0);
      expect(result.out).toContain("OVIS_RELEASES_URL");
    }
  });

  it("leaves a working install when it is killed between the download and the rename, and the next run finishes", () => {
    const { releases, key, run, standIn, dropStandIn, binary, ovis } = pc();
    release(releases, "1.2.3", key.privateKeyPem);
    expect(run("install_binary 1.2.3").code).toBe(0);
    const kept = sha256(binary);
    release(releases, "1.2.4", key.privateKeyPem);
    // tar unpacks the client once both downloads have been checked: killed there, nothing has been renamed yet
    standIn("tar", 'kill -9 "$INSTALLER_PID"; exit 1');
    const killed = run("INSTALLER_PID=$$; export INSTALLER_PID; install_binary 1.2.4");
    expect(killed.signal).toBe("SIGKILL");
    expect(sha256(binary)).toBe(kept);
    expect(Bun.spawnSync([binary, "plugin", "status"]).stdout.toString()).toContain("ovis-server 1.2.3 plugin status");
    dropStandIn("tar");
    const next = run("install_binary 1.2.4");
    expect(next.code).toBe(0);
    expect(Bun.spawnSync([binary]).stdout.toString()).toContain("ovis-server 1.2.4");
    expect(readdirSync(join(ovis, "releases")).filter((name) => name.startsWith("."))).toEqual([]);
  });

  it("does not take an openssl that verifies anything: it checks a signature that must fail too, then uses node", () => {
    const { releases, key, run, standIn } = pc();
    release(releases, "1.2.3", key.privateKeyPem);
    standIn("openssl", 'case "$1" in pkeyutl) echo "Signature Verified Successfully"; exit 0 ;; *) exec /usr/bin/openssl "$@" ;; esac');
    const result = run("install_binary 1.2.3");
    expect(result.code).toBe(0);
    // node on the PATH, or (a PC with none, such as macOS out of the box) the official Node build fetched for the check
    expect(result.out).toMatch(/checked the signature with (node|Node v\d)/);
    const corrupt = pc();
    const dir = release(corrupt.releases, "1.2.3", corrupt.key.privateKeyPem);
    signManifest(dir, generateKeyPair().privateKeyPem);
    corrupt.standIn("openssl", 'case "$1" in pkeyutl) echo "Signature Verified Successfully"; exit 0 ;; *) exec /usr/bin/openssl "$@" ;; esac');
    expect(corrupt.run("install_binary 1.2.3").code).not.toBe(0);
  });

  it("picks the binary for a release that ships it, the newest in a file:// folder, and the source path otherwise", () => {
    const { releases, key, run, home } = pc();
    release(releases, "1.2.3", key.privateKeyPem);
    release(releases, "1.10.0", key.privateKeyPem);
    mkdirSync(join(releases, "v1.9.9"));
    const pick = (env: Record<string, string> = {}) => run('pick_install; echo "PICKED binary=$binary version=${version:-} ref=$ref"', { PATH: `${join(home, "no-herdr")}:/usr/bin:/bin`, ...env }).out;
    expect(pick()).toContain("PICKED binary=1 version=1.10.0 ref=v1.10.0");
    expect(pick({ OVIS_REF: "v1.2.3" })).toContain("PICKED binary=1 version=1.2.3");
    const old = pick({ OVIS_REF: "v1.9.9" });
    expect(old).toContain("ships no compiled server, so it is installed from source");
    expect(old).toContain("PICKED binary=0");
    expect(pick({ OVIS_REF: "main" })).toContain("PICKED binary=0");
    expect(pick({ OVIS_FROM_SOURCE: "1" })).toContain("PICKED binary=0");
    expect(pick({ OVIS_RELEASES_URL: "http://mirror.example" })).toContain("OVIS_RELEASES_URL must be");
  });

  it("writes an ovis command that runs the installed binary with no Bun on the PATH", () => {
    const { releases, key, run, home, ovis } = pc();
    release(releases, "1.2.3", key.privateKeyPem);
    expect(run("install_binary 1.2.3").code).toBe(0);
    const launcher = join(home, "ovis");
    expect(run(`launcher_text > "${launcher}" && chmod 755 "${launcher}"`).code).toBe(0);
    const result = Bun.spawnSync([launcher, "status", "--json"], { env: { HOME: home, PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" });
    expect(result.stdout.toString()).toBe("ovis-server 1.2.3 plugin status --json\n");
    expect(result.exitCode).toBe(0);
    expect(Bun.spawnSync(["find", ovis, "-name", "*.ts"]).stdout.toString()).toBe("");
  });

  it("replaces nothing that is not its own: a bin folder someone made stays", () => {
    const { releases, key, run, ovis } = pc();
    release(releases, "1.2.3", key.privateKeyPem);
    mkdirSync(join(ovis, "bin"), { recursive: true });
    writeFileSync(join(ovis, "bin", "mine"), "x");
    const result = run("install_binary 1.2.3");
    expect(result.code).not.toBe(0);
    expect(readFileSync(join(ovis, "bin", "mine"), "utf8")).toBe("x");
  });
});
