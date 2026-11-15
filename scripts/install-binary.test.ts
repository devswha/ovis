import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXTRA_PLATFORMS, extraFile, DIST_ARCHIVE, generateKeyPair, MANIFEST, RELEASE_PUBLIC_KEY, releaseFile, PTY_ASSETS, ptyFile, SERVER_PLATFORMS, signManifest, writeManifest } from "./server-manifest.ts";
import { RELEASE_BINARIES } from "./release-binaries.ts";

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

function release(base: string, version: string, privateKeyPem: string, host?: string): string {
  const dir = join(base, `v${version}`);
  mkdirSync(dir, { recursive: true });
  for (const platform of SERVER_PLATFORMS) writeFileSync(join(dir, releaseFile(platform)), `#!/bin/sh\necho ovis-server ${version} "$@"\n`);
  for (const build of PTY_ASSETS) writeFileSync(join(dir, ptyFile(build)), host ?? `pty host ${build}\n`, { mode: 0o755 });
  for (const binary of RELEASE_BINARIES) for (const platform of EXTRA_PLATFORMS) writeFileSync(join(dir, extraFile(binary, platform)), `#!/bin/sh\necho ${binary} ${version} ${platform}\n`, { mode: 0o755 });
  const client = join(base, `client-${version}`);
  mkdirSync(client, { recursive: true });
  writeFileSync(join(client, "index.html"), `<!doctype html><title>${version}</title>`);
  expect(Bun.spawnSync(["tar", "-czf", join(dir, DIST_ARCHIVE), "-C", client, "."]).exitCode).toBe(0);
  rmSync(client, { recursive: true });
  writeManifest(dir, { version, sources, binaries: RELEASE_BINARIES });
  signManifest(dir, privateKeyPem);
  return dir;
}

/** One PC: a HOME, a release folder, and a bin of stand-ins put before the system's on PATH */
/** `<base>/v<version>/` as main's release step (todo 5) writes it: ovis-server.json holds only version, sources and
 * assets, signed by `privateKeyPem`; `edit` changes the manifest before it is signed */
function oldShape(base: string, version: string, privateKeyPem: string, edit: (manifest: Record<string, unknown>) => void = () => {}): string {
  const dir = join(base, `v${version}`);
  mkdirSync(dir, { recursive: true });
  const assets: Record<string, { file: string; sha256: string }> = {};
  for (const platform of SERVER_PLATFORMS) {
    writeFileSync(join(dir, releaseFile(platform)), `old binary ${platform}\n`);
    assets[platform] = { file: releaseFile(platform), sha256: createHash("sha256").update(`old binary ${platform}\n`).digest("hex") };
  }
  const manifest: Record<string, unknown> = { version, sources: { server: "a".repeat(40), shared: "b".repeat(40) }, assets };
  edit(manifest);
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(dir, "ovis-server.json"), bytes);
  writeFileSync(join(dir, "ovis-server.json.sig"), `${sign(null, bytes, createPrivateKey(privateKeyPem)).toString("base64")}\n`);
  return dir;
}

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
  // sourced from a file: the script is longer than one argument may be (Linux's 128 KiB)
  const script = join(scratch, "install.sh");
  writeFileSync(script, copy);
  const argv = (call: string) => ["/bin/sh", "-c", `set -eu\nos=${PLATFORM.split("-")[0]}; arch=${PLATFORM.split("-")[1]}; platform=${PLATFORM}\n. '${script}'\n${call}`];
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
  /**
   * GitHub's own address, the default with no OVIS_RELEASES_URL, served from this PC's release folder: a curl that
   * reads GitHub's download address as that folder, so install.sh's GitHub path runs with no network
   */
  const github = () => {
    const curl = Bun.which("curl", { PATH: process.env["PATH"] ?? "" });
    expect(curl).not.toBeNull();
    standIn("curl", `for a do shift; case $a in https://github.com/devswha/ovis/releases/download/*) a="file://${releases}/\${a#https://github.com/devswha/ovis/releases/download/}" ;; esac; set -- "$@" "$a"; done; exec '${curl}' "$@"`);
    return { OVIS_RELEASES_URL: "" };
  };
  return { home, releases, key, run, start, standIn, dropStandIn, github, binary: join(home, ".local/share/ovis/bin/ovis-server"), ovis: join(home, ".local/share/ovis") };
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
      writeManifest(dir, { version: "1.2.2", sources, binaries: RELEASE_BINARIES });
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
    writeManifest(dir, { version: "1.2.3", sources, binaries: RELEASE_BINARIES });
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
    writeManifest(dir, { version: "1.2.4", sources, binaries: RELEASE_BINARIES });
    signManifest(dir, key.privateKeyPem);
    const result = run("install_binary 1.2.4");
    expect(result.code).not.toBe(0);
    expect(result.out).toContain("something other than files and folders");
    expect(snapshot(ovis)).toEqual(before);
  });

  it("refuses a manifest of a schema it does not know, though the right key signed it", () => {
    const { releases, key, run, ovis } = pc();
    const dir = release(releases, "1.2.3", key.privateKeyPem);
    writeFileSync(join(dir, "ovis-server.json"), readFileSync(join(dir, "ovis-server.json"), "utf8").replace('"schema": 2,', '"schema": 3,'));
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

  for (const mkdirExcludes of [true, false]) it(`lets a second install in only after the first has swapped bin, not into its window${mkdirExcludes ? "" : ", with a mkdir that never refuses"}`, async () => {
    const { releases, key, start, standIn, ovis, home } = pc();
    // some mkdir commands report success to two callers at once (uutils coreutils): the lock may not rest on it
    if (!mkdirExcludes) standIn("mkdir", `exec "${Bun.which("mkdir")}" -p "$@"`);
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

  it("lets six waiters take a dead holder's lock one at a time, with a mkdir that never refuses", async () => {
    const { releases, key, start, standIn, ovis, home } = pc();
    release(releases, "1.2.3", key.privateKeyPem);
    release(releases, "1.2.4", key.privateKeyPem);
    standIn("mkdir", `exec "${Bun.which("mkdir")}" -p "$@"`);
    const sync = join(home, "sync");
    mkdirSync(sync);
    // inside the locked section (the archive is read there): a second run inside at once marks an overlap
    standIn("tar", `if [ "$1" = -tzf ]; then
  if (set -C; : > "${sync}/inside") 2>/dev/null; then sleep 0.05; rm -f "${sync}/inside"; else : > "${sync}/overlap"; fi
fi
exec "${Bun.which("tar")}" "$@"`);
    const dead = Bun.spawn(["sh", "-c", "exit 0"]);
    await dead.exited;
    mkdirSync(join(ovis, ".install.lock"), { recursive: true });
    writeFileSync(join(ovis, ".install.lock", "pid"), `${dead.pid}\n`);
    const barrier = join(home, "barrier");
    const runs = [0, 1, 2, 3, 4, 5].map((n) => start(`while [ ! -e "${barrier}" ]; do sleep 0.01; done; install_binary ${n % 2 ? "1.2.4" : "1.2.3"}`));
    writeFileSync(barrier, "");
    const results = await Promise.all(runs);
    for (const result of results) expect(result.code, result.out).toBe(0);
    expect(existsSync(join(sync, "overlap")), "two installs inside the lock at once").toBe(false);
    expect(existsSync(join(ovis, ".install.lock"))).toBe(false);
    expect(existsSync(join(ovis, ".install.lock.break"))).toBe(false);
    expect(readFileSync(join(ovis, "bin", "dist", "index.html"), "utf8")).toMatch(/1\.2\.[34]/);
  }, 60_000);

  it("leaves the lock to a waiter that claims it while the holder removes it, and both succeed", async () => {
    const { releases, key, start, standIn, ovis, home } = pc();
    release(releases, "1.2.3", key.privateKeyPem);
    release(releases, "1.2.4", key.privateKeyPem);
    const sync = join(home, "sync");
    mkdirSync(sync);
    const lock = join(ovis, ".install.lock");
    // the first run reads the archive only while it holds the lock: the mark stays, so the second run cannot miss it
    standIn("tar", `[ "$RUN" != first ] || [ "$1" != -tzf ] || : > "${sync}/first-holds"
exec "${Bun.which("tar")}" "$@"`);
    // the first removal of a lock folder pauses where rm -rf does, between the pid it unlinks and the folder it
    // removes, until another run holds the lock; then, as rm -f, it takes a folder already gone as removed
    standIn("rm", `case "$*" in "-rf ${lock}"*) if [ -d "$2" ] && (set -C; : > "${sync}/paused") 2>/dev/null; then
  "${Bun.which("rm")}" -f "$2/pid"
  end=$(($(date +%s) + 20)); until [ -s "${lock}/pid" ] || [ "$(date +%s)" -ge "$end" ]; do sleep 0.01; done
  [ ! -s "${lock}/pid" ] || : > "${sync}/claimed"
  rmdir "$2" 2>/dev/null || [ ! -e "$2" ] || exec rmdir "$2"
  exit 0
fi ;; esac
exec "${Bun.which("rm")}" "$@"`);
    const first = start("install_binary 1.2.3", { RUN: "first" });
    const second = start(`end=$(($(date +%s) + 20)); until [ -e "${sync}/first-holds" ]; do
  [ "$(date +%s)" -lt "$end" ] || { echo "the first run never held the lock: no ${sync}/first-holds after 20 s" >&2; exit 3; }; sleep 0.01
done; install_binary 1.2.4`);
    const [one, two] = await Promise.all([first, second]);
    expect(two.code, two.out).toBe(0);
    expect(existsSync(join(sync, "claimed")), "the second run never claimed the lock during the first's release").toBe(true);
    expect(one.code, one.out).toBe(0);
    expect(readFileSync(join(ovis, "bin", "ovis-server.json"), "utf8")).toContain('"version": "1.2.4"');
    expect(readdirSync(ovis).filter((name) => name.startsWith(".install.lock"))).toEqual([]);
    // its two 20 s waits may follow one another, each install around them
  }, 90_000);

  for (const paused of ["release", "sweep"] as const) it(`fails no run when the holder's sweep and a release remove the same folder at once, with an rm that refuses a folder removed meanwhile (busybox), the ${paused} inside it first`, async () => {
    const { releases, key, start, standIn, ovis, home } = pc();
    release(releases, "1.2.3", key.privateKeyPem);
    release(releases, "1.2.4", key.privateKeyPem);
    const sync = join(home, "sync");
    mkdirSync(sync);
    const lock = join(ovis, ".install.lock");
    const rm = Bun.which("rm");
    standIn("tar", `[ "$RUN" != first ] || [ "$1" != -tzf ] || : > "${sync}/first-holds"
exec "${Bun.which("tar")}" "$@"`);
    // the first run's release, or the second's sweep, removes its folder as busybox rm -rf does: it unlinks what is
    // inside, then fails on the folder if the other run removed it meanwhile. The other removes it only once that one
    // is inside it, so the two meet
    const inside = paused === "release" ? "first" : "second";
    standIn("rm", `case "$*" in "-rf ${lock}.gone-"*) if [ -d "$2" ]; then
  end=$(($(date +%s) + 20))
  if [ "$RUN" = ${inside} ] && (set -C; : > "${sync}/inside") 2>/dev/null; then
    "${rm}" -f "$2/pid"
    until [ ! -e "$2" ] || [ "$(date +%s)" -ge "$end" ]; do sleep 0.01; done
    [ ! -e "$2" ] || exec rmdir "$2"
    : > "${sync}/refused"
    echo "rm: can't remove '$2': No such file or directory" >&2
    exit 1
  elif [ "$RUN" != ${inside} ] && (set -C; : > "${sync}/other") 2>/dev/null; then
    until { [ -e "${sync}/inside" ] && [ ! -e "$2/pid" ]; } || [ "$(date +%s)" -ge "$end" ]; do sleep 0.01; done
  fi
fi ;; esac
exec "${rm}" "$@"`);
    const first = start("install_binary 1.2.3", { RUN: "first" });
    const second = start(`end=$(($(date +%s) + 20)); until [ -e "${sync}/first-holds" ]; do
  [ "$(date +%s)" -lt "$end" ] || { echo "the first run never held the lock: no ${sync}/first-holds after 20 s" >&2; exit 3; }; sleep 0.01
done; install_binary 1.2.4`, { RUN: "second" });
    const [one, two] = await Promise.all([first, second]);
    expect(one.code, one.out).toBe(0);
    expect(two.code, two.out).toBe(0);
    expect(existsSync(join(sync, "refused")), "the two removals never met in the same folder").toBe(true);
    expect(readFileSync(join(ovis, "bin", "ovis-server.json"), "utf8")).toContain('"version": "1.2.4"');
    expect(readdirSync(ovis).filter((name) => name.startsWith(".install.lock"))).toEqual([]);
    // the second's 20 s wait, then the first's, each install around them
  }, 90_000);

  it("removes the lock folder a run cut off while it released the lock left, and fails no run whose pid it names", () => {
    const { releases, key, run, ovis } = pc();
    release(releases, "1.2.3", key.privateKeyPem);
    // a run killed between its lock's rename and its removal, long ago
    mkdirSync(join(ovis, ".install.lock.gone-1"), { recursive: true });
    writeFileSync(join(ovis, ".install.lock.gone-1", "pid"), "1\n");
    // one that had this run's pid, with a lock inside it that the rename of this run's lock could not replace
    const result = run(`mkdir -p "${ovis}/.install.lock.gone-$$/.install.lock" && echo 1 > "${ovis}/.install.lock.gone-$$/.install.lock/pid" && install_binary 1.2.3`);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("installed Ovis 1.2.3");
    expect(readdirSync(ovis).filter((name) => name.startsWith(".install.lock"))).toEqual([]);
  });

  it("lets one waiter at a time break a stale lock, with a mkdir that never refuses", async () => {
    const { releases, key, start, standIn, ovis, home } = pc();
    release(releases, "1.2.3", key.privateKeyPem);
    standIn("mkdir", `exec "${Bun.which("mkdir")}" -p "$@"`);
    const sync = join(home, "sync");
    mkdirSync(sync);
    const lock = join(ovis, ".install.lock");
    // a lock naming no holder, older than a minute: the breaker asks find its age, so a second breaker at once shows there
    standIn("find", `if [ "$1" = "${lock}" ]; then
  if (set -C; : > "${sync}/breaking") 2>/dev/null; then sleep 0.1; rm -f "${sync}/breaking"; else : > "${sync}/two-breakers"; fi
fi
exec "${Bun.which("find")}" "$@"`);
    // an empty pid file: nobody can claim the lock, and nobody is named as its holder, so only breaking it frees it
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "pid"), "");
    utimesSync(lock, new Date(Date.now() - 300_000), new Date(Date.now() - 300_000));
    const barrier = join(home, "barrier");
    const runs = [0, 1, 2, 3, 4, 5].map(() => start(`while [ ! -e "${barrier}" ]; do sleep 0.01; done; install_binary 1.2.3`));
    writeFileSync(barrier, "");
    const results = await Promise.all(runs);
    for (const result of results) expect(result.code, result.out).toBe(0);
    expect(existsSync(join(sync, "two-breakers")), "two waiters broke the lock at once").toBe(false);
  }, 60_000);

  it("leaves a fresh holder's lock to it when a slow breaker judged the lock before it stale", async () => {
    const { releases, key, start, standIn, ovis, home } = pc({ lockWait: 1 });
    release(releases, "1.2.3", key.privateKeyPem);
    standIn("mkdir", `exec "${Bun.which("mkdir")}" -p "$@"`);
    const sync = join(home, "sync");
    mkdirSync(sync);
    const lockPid = join(ovis, ".install.lock", "pid");
    // the breaker's first read of the holder pauses, after it, until the test has put a fresh holder in place
    standIn("cat", `if [ "$1" = "${lockPid}" ] && [ ! -e "${sync}/judged" ]; then
  "${Bun.which("cat")}" "$1"; : > "${sync}/judged"
  until [ -e "${sync}/fresh" ]; do sleep 0.01; done; exit 0
fi
exec "${Bun.which("cat")}" "$@"`);
    const dead = Bun.spawn(["sh", "-c", "exit 0"]);
    await dead.exited;
    mkdirSync(join(ovis, ".install.lock"), { recursive: true });
    writeFileSync(lockPid, `${dead.pid}\n`);
    const breaker = start("install_binary 1.2.3");
    const deadline = Date.now() + 20_000;
    while (!existsSync(join(sync, "judged"))) { if (Date.now() > deadline) throw new Error("the breaker never read the holder"); await Bun.sleep(10); }
    writeFileSync(lockPid, `${process.pid}\n`);
    writeFileSync(join(sync, "fresh"), "");
    const result = await breaker;
    expect(result.code, result.out).not.toBe(0);
    expect(result.out).toContain(`(pid ${process.pid})`);
    expect(readFileSync(lockPid, "utf8")).toBe(`${process.pid}\n`);
  }, 60_000);

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
    const { releases, key, run, home, github, standIn } = pc();
    release(releases, "1.2.3", key.privateKeyPem);
    release(releases, "1.10.0", key.privateKeyPem);
    mkdirSync(join(releases, "v1.9.9"));
    const pick = (env: Record<string, string> = {}) => run('pick_install; echo "PICKED binary=$binary version=${version:-} ref=$ref"', { PATH: `${join(home, "no-herdr")}:/usr/bin:/bin`, ...env }).out;
    expect(pick()).toContain("PICKED binary=1 version=1.10.0 ref=v1.10.0");
    expect(pick({ OVIS_REF: "v1.2.3" })).toContain("PICKED binary=1 version=1.2.3");
    // a mirror's release without ovis-server.json is refused; only GitHub's own address reads it as one from before the
    // compiled server and installs its source
    const refused = pick({ OVIS_REF: "v1.9.9" });
    expect(refused).toContain("has no signed release v1.9.9");
    expect(refused).not.toContain("PICKED");
    standIn("herdr", "exit 1");
    const old = run('pick_install; echo "PICKED binary=$binary version=${version:-} ref=$ref"', { ...github(), OVIS_REF: "v1.9.9" }).out;
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

  it("installs again a release whose client went missing, and brings the client back", () => {
    const { releases, key, run, ovis } = pc();
    release(releases, "1.2.3", key.privateKeyPem);
    expect(run("install_binary 1.2.3").code).toBe(0);
    rmSync(join(ovis, "bin", "dist", "index.html"));
    const again = run("install_binary 1.2.3");
    expect(again.code).toBe(0);
    expect(again.out).toContain("installed Ovis 1.2.3");
    expect(readFileSync(join(ovis, "bin", "dist", "index.html"), "utf8")).toContain("1.2.3");
  });

  it("gives the installed binary a PATH with ~/.local/bin, where the installer puts herdr", () => {
    const { releases, key, run, home, ovis } = pc();
    release(releases, "1.2.3", key.privateKeyPem);
    expect(run("install_binary 1.2.3").code).toBe(0);
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    writeFileSync(join(home, ".local", "bin", "herdr"), "#!/bin/sh\n", { mode: 0o755 });
    // the binary the launcher runs reports the herdr it finds, as herdrConfigDir() asks Bun.which
    const binary = realpathSync(join(ovis, "bin", "ovis-server"));
    rmSync(binary);
    writeFileSync(binary, "#!/bin/sh\ncommand -v herdr || echo none\n", { mode: 0o755 });
    const launcher = join(home, "ovis");
    expect(run(`launcher_text > "${launcher}" && chmod 755 "${launcher}"`).code).toBe(0);
    const result = Bun.spawnSync([launcher, "status"], { env: { HOME: home, PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" });
    expect(result.stdout.toString().trim()).toBe(join(home, ".local", "bin", "herdr"));
  });

  it("runs only the PTY host the signed manifest names, whatever ovis-pty-sidecar.json says", () => {
    const { releases, key, run, ovis, home } = pc();
    const ranAt = join(home, "host-ran");
    const dir = release(releases, "1.2.3", key.privateKeyPem, `#!/bin/sh\n: > "${ranAt}"\n[ $# -gt 0 ] && exit 0\necho "pty-sidecar: usage: ovis-pty-sidecar" >&2\nexit 2\n`);
    const host = join(dir, ptyFile(PLATFORM.startsWith("darwin") ? "darwin-universal" : PLATFORM as "linux-x64"));
    // the unsigned manifest of the hosts names another file's hash: it is not read
    writeFileSync(join(dir, "ovis-pty-sidecar.json"), JSON.stringify({ version: "1.2.3", crate: "c".repeat(40), assets: {} }));
    const result = run("install_binary 1.2.3");
    expect(result.code, result.out).toBe(0);
    expect(existsSync(ranAt), result.out).toBe(true);
    expect(sha256(join(ovis, "bin", "bin", "ovis-pty-sidecar"))).toBe(sha256(host));
    expect(JSON.parse(readFileSync(join(ovis, "bin", "bin", "ovis-pty-sidecar.json"), "utf8"))).toEqual({ sha256: sha256(host), version: "1.2.3" });
  });

  it("refuses a release whose PTY host is not the one the signed manifest names, runs it never and leaves the install as it was", () => {
    const { releases, key, run, ovis, home } = pc();
    const ranAt = join(home, "host-ran");
    const signed = (marker: string) => `#!/bin/sh\n: > "${marker}"\n[ $# -gt 0 ] && exit 0\necho "pty-sidecar: usage: ovis-pty-sidecar" >&2\nexit 2\n`;
    release(releases, "1.2.2", key.privateKeyPem, signed(join(home, "host-RAN")));
    expect(run("install_binary 1.2.2").code).toBe(0);
    const before = snapshot(ovis);
    const dir = release(releases, "1.2.3", key.privateKeyPem, signed(join(home, "host-RAN")));
    // a mirror's host of the very same size: it would run, and say so, were it taken
    for (const build of PTY_ASSETS) writeFileSync(join(dir, ptyFile(build)), signed(ranAt), { mode: 0o755 });
    expect(signed(ranAt).length).toBe(signed(join(home, "host-RAN")).length);
    const result = run("install_binary 1.2.3");
    expect(result.code, result.out).not.toBe(0);
    expect(result.out).toContain("does not match its SHA-256 in ovis-server.json");
    expect(result.out).toContain("nothing was changed");
    expect(existsSync(ranAt)).toBe(false);
    expect(snapshot(ovis)).toEqual(before);
  });

  it("installs from source a release whose signed manifest has the shape from before schema 1, and refuses one badly signed or of an unknown schema", () => {
    const { releases, key, run, ovis, github, standIn } = pc();
    oldShape(releases, "0.5.4", key.privateKeyPem);
    oldShape(releases, "0.5.5", generateKeyPair().privateKeyPem);
    oldShape(releases, "0.5.6", key.privateKeyPem, (manifest) => { manifest["schema"] = 3; });
    // on a mirror a release with no compiled server is refused, however it is signed
    const mirrored = run('pick_install; echo "binary=$binary"', { OVIS_REF: "v0.5.4" });
    expect(mirrored.code).toBe(1);
    expect(mirrored.out).toContain("has no signed release v0.5.4");
    standIn("herdr", "exit 1");
    const old = run('pick_install; echo "binary=$binary"', { ...github(), OVIS_REF: "v0.5.4" });
    expect(old.code, old.out).toBe(0);
    expect(old.out).toContain("v0.5.4's signed ovis-server.json has the shape from before this installer");
    expect(old.out).toContain("ships no compiled server, so it is installed from source");
    expect(old.out).toContain("binary=0");
    const bad = run('pick_install; echo "binary=$binary"', { OVIS_REF: "v0.5.5" });
    expect(bad.code).not.toBe(0);
    expect(bad.out).toContain("is not signed by the key");
    const newer = run('pick_install && install_binary "$version"', { OVIS_REF: "v0.5.6" });
    expect(newer.code).not.toBe(0);
    expect(newer.out).toContain("of a schema this installer does not know");
    expect(existsSync(join(ovis, "bin"))).toBe(false);
  });

  it("refuses a source install over the release's binary before installing anything, and says how to move", () => {
    const { releases, key, run, ovis } = pc();
    release(releases, "1.2.3", key.privateKeyPem);
    expect(run("install_binary 1.2.3").code).toBe(0);
    const before = snapshot(ovis);
    for (const env of [{ OVIS_FROM_SOURCE: "1" }, { OVIS_REF: "feature/x" }, { OVIS_REF: "v1.2.2" }]) {
      if (env.OVIS_REF === "v1.2.2") mkdirSync(join(releases, "v1.2.2"), { recursive: true });
      const result = run("pick_install; echo picked", env);
      expect(result.code, result.out).not.toBe(0);
      expect(result.out).toContain("installed here as the release's binary");
      expect(result.out).toContain("herdr plugin uninstall devswha.ovis");
      expect(result.out).not.toContain("picked");
    }
    expect(snapshot(ovis)).toEqual(before);
  });

  it("keeps a binary install as it is when the latest release cannot be checked", () => {
    const { releases, key, run, ovis } = pc();
    release(releases, "1.2.3", key.privateKeyPem);
    expect(run("install_binary 1.2.3").code).toBe(0);
    const before = snapshot(ovis);
    // the newest release folder answers no manifest: a failed probe, not a request for source
    mkdirSync(join(releases, "v1.2.9"), { recursive: true });
    const result = run("pick_install; echo picked");
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("the installed Ovis stays as it is, nothing was changed");
    expect(result.out).not.toContain("picked");
    expect(snapshot(ovis)).toEqual(before);
  });

  it("installs no extra binary, even from a release whose signed manifest names one", () => {
    const { releases, key, run, ovis } = pc();
    const dir = release(releases, "1.2.3", key.privateKeyPem);
    const extra = ["ovis-link"];
    for (const binary of extra) for (const platform of EXTRA_PLATFORMS) writeFileSync(join(dir, extraFile(binary, platform)), `${binary} ${platform}\n`, { mode: 0o755 });
    writeManifest(dir, { version: "1.2.3", sources, binaries: extra });
    signManifest(dir, key.privateKeyPem);
    const result = run("install_binary 1.2.3");
    expect(result.code, result.out).toBe(0);
    expect(readdirSync(join(ovis, "bin")).sort()).toEqual(["dist", "ovis-server", "ovis-server.json", "ovis-server.json.sig"]);
    expect(result.out).not.toContain("ovis-link");
    expect(run("install_binary 1.2.3").out).toContain("nothing to do");
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

/**
 * A release mirror (OVIS_RELEASES_URL): a file:// folder, or an https
 * address served here with a certificate made for the test (curl trusts it through CURL_CA_BUNDLE). The mirror is not
 * trusted: only what the test key signed for the version asked for is installed, and its latest never goes back.
 */
describe.skipIf(process.platform === "win32")("install.sh from a release mirror", () => {
  const tls = mkdtempSync(join(tmpdir(), "ovis-mirror-tls-"));
  const root = { dir: "" };
  let server: ReturnType<typeof Bun.serve> | undefined;
  beforeAll(() => {
    const made = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1",
      "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", join(tls, "key.pem"), "-out", join(tls, "cert.pem")], { stdout: "pipe", stderr: "pipe" });
    expect(made.exitCode, made.stderr.toString()).toBe(0);
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: { cert: readFileSync(join(tls, "cert.pem"), "utf8"), key: readFileSync(join(tls, "key.pem"), "utf8") },
      fetch(request) {
        const path = join(root.dir, decodeURIComponent(new URL(request.url).pathname));
        return path.startsWith(root.dir) && existsSync(path) && lstatSync(path).isFile() ? new Response(Bun.file(path)) : new Response("Not Found", { status: 404 });
      },
    });
  });
  afterAll(() => {
    server?.stop(true);
    rmSync(tls, { recursive: true, force: true });
  });

  /** one PC whose mirror is `scheme`'s: run() resolves the latest release as install.sh's main does, then installs it */
  function mirrored(scheme: "file" | "https") {
    const machine = pc();
    root.dir = machine.releases;
    // the PC's own herdr must not decide the install; git would mean GitHub's tags were asked
    machine.standIn("herdr", "exit 1");
    machine.standIn("git", "echo git-was-asked >&2; exit 1");
    const url = scheme === "https" ? `https://127.0.0.1:${server!.port}` : `file://${machine.releases}`;
    const install = (env: Record<string, string> = {}) =>
      machine.start('pick_install; [ "$binary" = 1 ] || exit 9; install_binary "$version"', { OVIS_RELEASES_URL: url, CURL_CA_BUNDLE: join(tls, "cert.pem"), ...env });
    // an https mirror names its latest; a file:// one is read from its folders
    const latest = (version: string) => {
      writeFileSync(join(machine.releases, "latest"), `v${version}\n`);
      if (scheme === "file") for (const entry of readdirSync(machine.releases)) if (/^v\d/.test(entry) && entry !== `v${version}`) rmSync(join(machine.releases, entry), { recursive: true });
    };
    return { ...machine, url, install, latest };
  }

  for (const scheme of ["file", "https"] as const) {
    it(`${scheme}: installs the mirror's latest release, then updates to the next, never asking GitHub`, async () => {
      const { releases, key, install, latest, binary } = mirrored(scheme);
      release(releases, "1.2.0", key.privateKeyPem);
      latest("1.2.0");
      const first = await install();
      expect(first.code, first.out).toBe(0);
      expect(first.out).toContain("installed Ovis 1.2.0");
      release(releases, "1.3.0", key.privateKeyPem);
      latest("1.3.0");
      const update = await install();
      expect(update.code, update.out).toBe(0);
      expect(update.out).toContain("installed Ovis 1.3.0");
      expect(sha256(binary)).toBe(sha256(join(releases, "v1.3.0", releaseFile(PLATFORM))));
      expect(`${first.out}${update.out}`).not.toContain("git-was-asked");
    });

    it(`${scheme}: takes no older release the mirror names as its latest, though signed, unless OVIS_REF asks for it`, async () => {
      const { releases, key, install, latest, ovis } = mirrored(scheme);
      release(releases, "1.3.0", key.privateKeyPem);
      latest("1.3.0");
      expect((await install()).code).toBe(0);
      const before = snapshot(ovis);
      release(releases, "1.2.0", key.privateKeyPem);
      latest("1.2.0");
      const back = await install();
      expect(back.code, back.out).toBe(0);
      expect(back.out).toContain("older than the installed 1.3.0; the installed Ovis stays as it is, nothing was changed");
      expect(snapshot(ovis)).toEqual(before);
      const asked = await install({ OVIS_REF: "v1.2.0" });
      expect(asked.code, asked.out).toBe(0);
      expect(asked.out).toContain("installed Ovis 1.2.0");
    });

    it(`${scheme}: refuses a tampered binary and a tampered manifest, and changes nothing`, async () => {
      const { releases, key, install, latest, ovis } = mirrored(scheme);
      release(releases, "1.2.0", key.privateKeyPem);
      latest("1.2.0");
      expect((await install()).code).toBe(0);
      const before = snapshot(ovis);
      const dir = release(releases, "1.3.0", key.privateKeyPem);
      latest("1.3.0");
      // the same size, one byte changed: only the SHA-256 the signed manifest names tells it apart
      writeFileSync(join(dir, releaseFile(PLATFORM)), readFileSync(join(dir, releaseFile(PLATFORM))).map((byte, index) => (index === 12 ? byte ^ 1 : byte)));
      const binary = await install();
      expect(binary.code).not.toBe(0);
      expect(binary.out).toContain("does not match its SHA-256");
      release(releases, "1.3.0", key.privateKeyPem);
      writeFileSync(join(dir, MANIFEST), readFileSync(join(dir, MANIFEST), "utf8").replace(/"sha256": "[0-9a-f]{64}"/, `"sha256": "${"0".repeat(64)}"`));
      const manifest = await install();
      expect(manifest.code).not.toBe(0);
      expect(manifest.out).toContain("is not a valid signature");
      expect(snapshot(ovis)).toEqual(before);
    });

    it(`${scheme}: refuses a fresh machine whose mirror has no ovis-server.json for its latest, never installing from source`, async () => {
      const { releases, install, latest, home } = mirrored(scheme);
      // the latest names a folder with no signed manifest: a mirror's, not a release from before the compiled server
      mkdirSync(join(releases, "v1.3.0"), { recursive: true });
      writeFileSync(join(releases, "v1.3.0", releaseFile(PLATFORM)), "#!/bin/sh\necho unsigned\n");
      latest("1.3.0");
      const result = await install();
      expect(result.code, result.out).toBe(1);
      expect(result.out).toContain(`has no signed release v1.3.0`);
      expect(result.out).not.toContain("from source");
      expect(result.out).not.toContain("git-was-asked");
      expect(existsSync(join(home, ".local/share/ovis"))).toBe(false);
    });

    it(`${scheme}: a refused first install leaves no releases folder behind`, async () => {
      const { releases, key, install, latest, ovis } = mirrored(scheme);
      const dir = release(releases, "1.3.0", key.privateKeyPem);
      latest("1.3.0");
      writeFileSync(join(dir, releaseFile(PLATFORM)), readFileSync(join(dir, releaseFile(PLATFORM))).map((byte, index) => (index === 12 ? byte ^ 1 : byte)));
      const result = await install();
      expect(result.code).not.toBe(0);
      expect(result.out).toContain("does not match its SHA-256");
      expect(existsSync(join(ovis, "releases"))).toBe(false);
      expect(existsSync(join(ovis, "bin"))).toBe(false);
    });

    it(`${scheme}: refuses a release missing one of its files, and a mirror that names no latest`, async () => {
      const { releases, key, install, latest, ovis } = mirrored(scheme);
      release(releases, "1.2.0", key.privateKeyPem);
      latest("1.2.0");
      expect((await install()).code).toBe(0);
      const before = snapshot(ovis);
      const dir = release(releases, "1.3.0", key.privateKeyPem);
      latest("1.3.0");
      rmSync(join(dir, DIST_ARCHIVE));
      const missing = await install();
      expect(missing.code).not.toBe(0);
      expect(missing.out).toContain(`could not download`);
      expect(snapshot(ovis)).toEqual(before);
      for (const entry of readdirSync(releases)) rmSync(join(releases, entry), { recursive: true });
      const none = await install();
      expect(none.code).not.toBe(0);
      expect(none.out).toContain("could not find the latest release in");
    });
  }
});

/**
 * GitHub's own address is not a mirror: its behaviour stays main's. A PC whose installed release is newer than the
 * public repository's highest tag goes on to that tag's release, as before (its download is cut here by a proxy that
 * answers nothing, so the test reaches no network and stops at the download it was about to make).
 */
describe.skipIf(process.platform === "win32")("install.sh from GitHub's own address", () => {
  it("goes on to the public repository's highest tag even when the installed release is newer, as main does", () => {
    const { releases, key, run, standIn } = pc();
    release(releases, "1.3.0", key.privateKeyPem);
    expect(run("install_binary 1.3.0").code).toBe(0);
    standIn("herdr", "exit 1");
    standIn("git", `printf '%s\\trefs/tags/v1.1.0\\n%s\\trefs/tags/v1.2.0\\n' ${"a".repeat(40)} ${"b".repeat(40)}`);
    const offline = { https_proxy: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", no_proxy: "", NO_PROXY: "" };
    for (const address of ["", "https://github.com/devswha/ovis/releases/download", "https://github.com/devswha/ovis/releases/download/"]) {
      const result = run('pick_install; echo "PICKED binary=$binary version=$version"', { OVIS_RELEASES_URL: address, ...offline });
      expect(result.out).not.toContain("older than the installed");
      expect(result.out).toContain("could not reach https://github.com/devswha/ovis/releases/download/v1.2.0");
      expect(result.code).toBe(1);
    }
  });
});
