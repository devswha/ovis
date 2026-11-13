/**
 * The release's server, installed for one platform: what scripts/plugin-launch.ts runs before it hands a command to
 * the binary (install.sh and install.ps1 do the same in shell and PowerShell). Nothing in the install changes until the
 * manifest's signature by the committed key (RELEASE_PUBLIC_KEY), its version, and the size and SHA-256 of every file
 * it names have been checked; then one rename makes the new release the one that runs:
 *
 *   <home>/bin -> releases/<version>-<id>   the release that runs: ovis-server(.exe), dist/, the manifest and its
 *                                           signature as they were checked, and bin/ovis-pty-sidecar(.json): the
 *                                           Rust PTY host the signed manifest names, when it runs here
 *   <home>/releases/.stage-<id>             a download in progress; one an interrupted run left is removed first
 *
 * On Windows, where a link needs rights a user may not have, bin is the release folder itself, moved in by two
 * renames (the old one aside, the new one in); a run cut off between them finds the old one and moves it back.
 *
 * One install at a time: <home>/.install.lock, claimed as install.sh and install.ps1 claim it, by its pid file created
 * only where none is (EEXIST: held), with the holder's start time beside it. Another install waits for it (at most
 * LOCK_WAIT_MS), then finds that version installed and has nothing to do, or installs its own; a lock whose holder is
 * gone (its pid does not run, or runs a process started at another time) is broken, one breaker at a time, and only
 * while it still holds the record judged stale. Only the lock holder makes a stage, so what the holder removes of
 * releases/ belongs to no other run.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runsHere } from "./pty-sidecar.ts";
import { binaryName, checkManifest, DIST_ARCHIVE, MANIFEST, oldShapeRelease, ptyAssetFor, RELEASE_PUBLIC_KEY, type ReleaseAsset, releaseFile, SERVER_PLATFORMS, type ServerManifest, type ServerPlatform, SIGNATURE } from "./server-manifest.ts";

export const DEFAULT_RELEASES = "https://github.com/devswha/ovis/releases/download";
const MANIFEST_LIMIT = 64 * 1024;
const SIGNATURE_LIMIT = 1024;
const WINDOWS = process.platform === "win32";

/** Where releases come from: OVIS_RELEASES_URL when set (https://, or a file:// folder for tests), else GitHub's. */
export function releasesBase(value: string | undefined): string {
  const base = (value === undefined || value === "" ? DEFAULT_RELEASES : value).replace(/\/+$/, "");
  if (/^https:\/\/[^/]/.test(base) || base.startsWith("file:///")) return base;
  throw new Error(`OVIS_RELEASES_URL must be an https:// address or a file:// folder (file:///path); ${base} is neither`);
}

/** The release platform this process runs on, or null where no release has a binary. */
export function hostPlatform(): ServerPlatform | null {
  const platform = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
  return (SERVER_PLATFORMS as readonly string[]).includes(platform) ? platform as ServerPlatform : null;
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * The release of this version ships no compiled server: its ovis-server.json is not there (HTTP 404, or no such file in
 * a file:// folder). Only this, never a manifest that exists and fails a check, a server error or a network failure,
 * lets a caller fall back to building from source.
 */
export class NoBinaryRelease extends Error {}

/**
 * The bytes at `url`, refused once they pass `limit` (a file larger than its manifest says is never read whole), or
 * null where there is no such file (HTTP 404). Redirects are followed by hand: one to anything but https is refused
 * before a request is made to it.
 */
export async function download(url: string, limit: number, name: string, fetchFile: typeof fetch = fetch): Promise<Uint8Array | null> {
  const tooLarge = () => new Error(`${name} is larger than the ${limit} bytes ${MANIFEST} names; nothing was changed`);
  if (url.startsWith("file://")) {
    const path = fileURLToPath(url);
    if (!existsSync(path)) return null;
    if (statSync(path).size > limit) throw tooLarge();
    return readFileSync(path);
  }
  let response: Response;
  let at = url;
  for (let hops = 0; ; hops++) {
    response = await fetchFile(at, { redirect: "manual", signal: AbortSignal.timeout(600_000) });
    if (response.status < 300 || response.status > 399) break;
    const next = new URL(response.headers.get("location") ?? "", at).href;
    if (!next.startsWith("https://")) throw new Error(`${url} redirected to ${next}, which is not https; nothing was changed`);
    if (hops >= 10) throw new Error(`${url} redirected more than 10 times; nothing was changed`);
    at = next;
  }
  if (response.status === 404) return null;
  if (!response.ok || !response.body) throw new Error(`${url}: HTTP ${response.status}; nothing was changed`);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > limit) throw tooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** `asset` from the release at `at`, only when its size and SHA-256 are what the checked manifest names. */
/**
 * The Rust PTY host the signed manifest names for `platform`, into `bin` with the record server/pty/host.ts checks, and
 * only after its size and SHA-256 match the manifest and it runs here: no other file's word for a host is taken. Any
 * failure leaves no host, and terminals mirrored; it never fails the install. What it did, in a few words.
 */
async function ptyHost(at: string, hosts: Record<string, ReleaseAsset>, platform: ServerPlatform, version: string, bin: string, options: Pick<InstallServerOptions, "fetchFile" | "ptyRuns">): Promise<string> {
  const build = ptyAssetFor(platform);
  if (!build) return "no Rust PTY host on this platform";
  let bytes: Uint8Array;
  try { bytes = await checked(at, hosts[build]!, options.fetchFile); }
  catch (error) { return `the Rust PTY host was not taken (${(error as Error).message}), so terminals are mirrored`; }
  mkdirSync(bin, { recursive: true });
  const target = join(bin, "ovis-pty-sidecar");
  writeFileSync(target, bytes, { mode: 0o755 });
  chmodSync(target, 0o755);
  if (!(options.ptyRuns ?? runsHere)(target)) {
    rmSync(bin, { recursive: true, force: true });
    return "the Rust PTY host does not run on this PC, so terminals are mirrored";
  }
  writeFileSync(`${target}.json`, `${JSON.stringify({ sha256: hosts[build]!.sha256, version })}\n`);
  return "the Rust PTY host checked against ovis-server.json";
}

async function checked(at: string, asset: ReleaseAsset, fetchFile?: typeof fetch): Promise<Uint8Array> {
  const bytes = await download(`${at}/${asset.file}`, asset.size, asset.file, fetchFile);
  if (!bytes) throw new Error(`${at}/${asset.file} does not exist; nothing was changed`);
  if (bytes.length !== asset.size) throw new Error(`${asset.file} is ${bytes.length} bytes, not the ${asset.size} ${MANIFEST} names; nothing was changed`);
  const digest = sha256(bytes);
  if (digest !== asset.sha256) throw new Error(`${asset.file} does not match its SHA-256 in ${MANIFEST} (got ${digest}); nothing was changed`);
  return bytes;
}

/**
 * Unpacks the client archive into `into`, after its listing shows only plain files and folders inside it: no absolute
 * path, no `..`, no link, so a crafted archive cannot write outside the release folder.
 */
function unpack(archive: string, into: string): void {
  const tar = (...args: string[]) => {
    const result = Bun.spawnSync(["tar", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 120_000 });
    if (result.exitCode !== 0) throw new Error(`tar ${args[0]} ${DIST_ARCHIVE} failed: ${result.stderr.toString().trim() || `exit ${result.exitCode}`}; nothing was changed`);
    return result.stdout.toString();
  };
  for (const name of tar("-tzf", archive).split("\n").filter(Boolean)) {
    if (/^([/\\]|[A-Za-z]:)/.test(name) || name.split(/[/\\]/).includes("..")) throw new Error(`${DIST_ARCHIVE} holds ${name}, a path outside its folder; nothing was changed`);
  }
  for (const line of tar("-tzvf", archive).split("\n").filter(Boolean)) {
    if (!/^[-d]/.test(line)) throw new Error(`${DIST_ARCHIVE} holds something other than files and folders (${line.trim()}); nothing was changed`);
  }
  mkdirSync(into, { recursive: true });
  tar("-xzf", archive, "-C", into, "--no-same-owner");
  for (const entry of readdirSync(into, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() && !entry.isDirectory()) throw new Error(`${DIST_ARCHIVE} unpacked something other than files and folders; nothing was changed`);
  }
  if (!existsSync(join(into, "index.html"))) throw new Error(`${DIST_ARCHIVE} holds no index.html; nothing was changed`);
}

/** Windows: a run cut off between its two renames left no bin; the release it moved aside is put back. */
function recover(home: string): void {
  const current = join(home, "bin");
  if (existsSync(current)) return;
  const aside = readdirSync(home).filter((name) => name.startsWith("bin.old-")).sort();
  if (aside.length > 0) renameSync(join(home, aside.at(-1)!), current);
}

/** Makes releases/`name` the release that runs, in one rename (two on Windows). */
function swap(home: string, name: string): void {
  const current = join(home, "bin");
  const release = join(home, "releases", name);
  if (WINDOWS) {
    const aside = `${current}.old-${randomBytes(4).toString("hex")}`;
    if (existsSync(current)) renameSync(current, aside);
    try {
      renameSync(release, current);
    } catch (error) {
      if (existsSync(aside)) renameSync(aside, current);
      throw error;
    }
    rmSync(aside, { recursive: true, force: true });
    return;
  }
  if (existsSync(current) && !lstatSync(current).isSymbolicLink()) {
    throw new Error(`${current} is a folder this installer did not make, so it was left as it is; move it away and try again. Nothing was changed`);
  }
  const link = join(home, `.bin-${randomBytes(4).toString("hex")}`);
  symlinkSync(join("releases", name), link);
  try {
    renameSync(link, current);
  } catch (error) {
    rmSync(link, { force: true });
    throw error;
  }
}

export const LOCK_WAIT_MS = 600_000;
/** a lock folder or breaker without a pid this long is one whose maker died before it wrote it */
const UNCLAIMED_MS = 60_000;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * When process `pid` started, as `ps -o lstart=` prints it (the same words on Linux and macOS, and in install.sh), or
 * null where that cannot be told (no such process, no ps: Windows). A pid alone is reused: one that runs a process
 * started at another time than the holder's is not the holder.
 */
export function startedAt(pid: number): string | null {
  if (WINDOWS) return null;
  try {
    const result = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, timeout: 5_000 });
    const text = result.stdout.toString().trim().replace(/\s+/g, " ");
    return result.exitCode === 0 && text !== "" ? text : null;
  } catch {
    return null;
  }
}

/** The lock's record: its holder's pid (the claim, in `pid`) and, where written, when that process started (`started`). */
const recordOf = (lock: string): { pid: number | null; started: string | null } => {
  let pid: number | null = null;
  let started: string | null = null;
  try {
    const value = Number(readFileSync(join(lock, "pid"), "utf8").trim());
    pid = Number.isInteger(value) && value > 0 ? value : null;
  } catch { /* no claim yet */ }
  try { started = readFileSync(join(lock, "started"), "utf8").trim().replace(/\s+/g, " ") || null; } catch { /* an older installer's, or not written yet */ }
  return { pid, started };
};

/**
 * Whether `lock`'s holder is gone: its pid does not run, or runs a process started at another time than the one the
 * lock records, or it never wrote a pid and that was long ago.
 */
function stale(lock: string): boolean {
  const { pid, started } = recordOf(lock);
  if (pid !== null) {
    if (!alive(pid)) return true;
    const now = started === null ? null : startedAt(pid);
    return now !== null && now !== started;
  }
  try { return Date.now() - statSync(lock).mtimeMs > UNCLAIMED_MS; } catch { return false; }
}

/**
 * Creates `path` holding `text` only where nothing is (O_EXCL): false when something is there already, or when its
 * folder went meanwhile (a holder released the lock between this run's mkdir and its claim: the next round makes it).
 */
function claim(path: string, text: string): boolean {
  try {
    writeFileSync(path, text, { flag: "wx" });
    return true;
  } catch (error) {
    if (["EEXIST", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

/**
 * Runs `run` holding `<home>/.install.lock`, claimed by its pid file, made only where none is: the folder's mkdir alone
 * does not exclude (some mkdir commands, and two callers of one that is not, both see it succeed), so install.sh and
 * install.ps1 claim the same lock by the same file. A lock found stale is broken under `.install.lock.break`, a file
 * claimed the same way, so two waiters that both saw it stale cannot both remove it; and it is removed only while it
 * still holds the record judged stale, so a fresh holder that took it meanwhile keeps it.
 * `beforeBreak` runs between the judgement and that re-read: tests.
 */
export async function withInstallLock<T>(home: string, run: () => Promise<T>, waitMs = LOCK_WAIT_MS, onWait?: () => void, beforeBreak?: () => void): Promise<T> {
  mkdirSync(home, { recursive: true });
  const lock = join(home, ".install.lock");
  const breaker = `${lock}.break`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    mkdirSync(lock, { recursive: true });
    if (claim(join(lock, "pid"), `${process.pid}\n`)) break;
    if (!existsSync(lock)) continue;
    let broke = false;
    if (claim(breaker, `${process.pid}\n`)) {
      try {
        const judged = JSON.stringify(recordOf(lock));
        if (stale(lock)) {
          beforeBreak?.();
          if (JSON.stringify(recordOf(lock)) === judged) {
            rmSync(lock, { recursive: true, force: true });
            broke = true;
          }
        }
      } finally {
        rmSync(breaker, { recursive: true, force: true });
      }
    } else {
      try { if (Date.now() - statSync(breaker).mtimeMs > UNCLAIMED_MS) rmSync(breaker, { recursive: true, force: true }); } catch { /* gone meanwhile */ }
    }
    if (broke) continue;
    onWait?.();
    if (Date.now() >= deadline) throw new Error(`another install is running in ${home} (pid ${recordOf(lock).pid ?? "unknown"}); try again once it ends. Nothing was changed`);
    await Bun.sleep(200);
  }
  const started = startedAt(process.pid);
  if (started !== null) writeFileSync(join(lock, "started"), `${started}\n`);
  try {
    return await run();
  } finally {
    // only its own: a lock broken under it (judged stale by mistake) is another holder's now
    if (recordOf(lock).pid === process.pid) rmSync(lock, { recursive: true, force: true });
  }
}

/**
 * The folders of `folders` that a running process was started from, or still holds a file of: Linux reads every
 * /proc/<pid>/exe (the file it runs, as it was when it started); macOS asks lsof for the processes with a file open
 * under the folder, its running binary included (ps would give the path it was started by, through bin's link, which
 * names another release once bin was swapped). Elsewhere (Windows), none is told: removing a running .exe fails,
 * which the prune already leaves for the next install.
 */
export function foldersInUse(folders: string[]): Set<string> {
  const used = new Set<string>();
  if (process.platform === "darwin") {
    for (const folder of folders) {
      try {
        const listed = Bun.spawnSync(["lsof", "-t", "+D", realpathSync(folder)], { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 10_000 });
        if (listed.stdout.toString().trim() !== "") used.add(folder);
      } catch { /* none told */ }
    }
    return used;
  }
  if (process.platform !== "linux") return used;
  const executables: string[] = [];
  try {
    for (const pid of readdirSync("/proc")) {
      if (!/^\d+$/.test(pid)) continue;
      try { executables.push(readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, "")); } catch { /* gone, or another user's */ }
    }
  } catch { /* none told */ }
  for (const folder of folders) {
    let real: string;
    try { real = realpathSync(folder); } catch { continue; }
    if (executables.some((path) => path.startsWith(`${real}/`))) used.add(folder);
  }
  return used;
}

/**
 * The binary of the release installed in `home`, when it is `version`'s and still what its manifest vouches for: the
 * manifest kept beside it is signed by `publicKey` and names `version`, and the binary has its SHA-256. A folder that
 * fails any of these is never run.
 */
/**
 * Whether `binary` has the SHA-256 `digest`. Hashing a whole binary costs about 100 ms, on every plugin command, so a
 * match is remembered in <home>/.verified.json with the file's size, mtime and inode: the hash is taken again whenever
 * any of them, or the digest asked for, differs.
 */
function binaryMatches(home: string, binary: string, digest: string): boolean {
  const { size, mtimeMs, ino } = statSync(binary);
  const seen = join(home, ".verified.json");
  const stamp = JSON.stringify({ digest, size, mtimeMs, ino });
  try { if (readFileSync(seen, "utf8") === stamp) return true; } catch { /* none remembered */ }
  if (sha256(readFileSync(binary)) !== digest) return false;
  remember(home, binary, digest);
  return true;
}

/** Notes that `binary`, as it is now, has the SHA-256 `digest` (binaryMatches); a failure only costs a hash later. */
function remember(home: string, binary: string, digest: string): void {
  try {
    const { size, mtimeMs, ino } = statSync(binary);
    writeFileSync(join(home, ".verified.json"), JSON.stringify({ digest, size, mtimeMs, ino }));
  } catch { /* hashed again next time */ }
}

export function verifiedInstall(home: string, version: string, platform: ServerPlatform, publicKey = RELEASE_PUBLIC_KEY): string | null {
  const current = join(home, "bin");
  try {
    const manifest = checkManifest(readFileSync(join(current, MANIFEST)), readFileSync(join(current, SIGNATURE), "utf8"), publicKey, { version });
    const binary = join(current, binaryName(platform));
    // the client it serves too: a release whose dist/ went missing is installed again
    if (typeof manifest !== "string" && binaryMatches(home, binary, manifest.assets[platform].sha256) && existsSync(join(current, "dist", "index.html"))) return binary;
  } catch { /* nothing installed there, or not whole */ }
  return null;
}

/** A release's manifest as checked: its exact bytes, its signature, and what it names. */
export interface SignedManifest { manifest: ServerManifest; bytes: Uint8Array; signature: Uint8Array }

/**
 * The manifest of the release at `at` (named `tag`), once its signature by `publicKey` holds over its exact bytes, it is in
 * its canonical form and it names `version`: nothing else is downloaded before this passes. Throws NoBinaryRelease where
 * the release has no ovis-server.json, or has one of the shape from before schema 1; any other failure is an Error.
 */
export async function signedManifest(at: string, tag: string, version: string, publicKey: string, fetchFile?: typeof fetch): Promise<SignedManifest> {
  const bytes = await download(`${at}/${MANIFEST}`, MANIFEST_LIMIT, MANIFEST, fetchFile);
  if (!bytes) throw new NoBinaryRelease(`the release ${tag} ships no compiled server (${at}/${MANIFEST} does not exist)`);
  const signature = await download(`${at}/${SIGNATURE}`, SIGNATURE_LIMIT, SIGNATURE, fetchFile);
  if (!signature) throw new Error(`${at}/${SIGNATURE} does not exist; nothing was changed`);
  const manifest = checkManifest(Buffer.from(bytes), new TextDecoder().decode(signature), publicKey, { version });
  if (typeof manifest === "string") {
    if (oldShapeRelease(Buffer.from(bytes), new TextDecoder().decode(signature), publicKey, version)) {
      throw new NoBinaryRelease(`the release ${tag} ships no compiled server this installer runs (its signed ${MANIFEST} has the shape from before schema 1)`);
    }
    throw new Error(`${manifest}; nothing was changed`);
  }
  return { manifest, bytes, signature };
}

/**
 * Fills the empty folder `into` with what runs the release at `at` on `platform`, each file checked against `signed`
 * first: the binary, the client unpacked into dist/, the manifest and its signature as they were checked, and the Rust
 * PTY host the manifest names (bin/), where it runs here. Throws on the first check that fails, leaving `into` to the
 * caller to remove; says in a few words what became of the PTY host.
 */
export async function fetchRelease(at: string, signed: SignedManifest, platform: ServerPlatform, into: string, options: Pick<InstallServerOptions, "fetchFile" | "ptyRuns"> = {}): Promise<string> {
  const { manifest } = signed;
  writeFileSync(join(into, binaryName(platform)), await checked(at, manifest.assets[platform], options.fetchFile), { mode: 0o755 });
  chmodSync(join(into, binaryName(platform)), 0o755);
  writeFileSync(join(into, DIST_ARCHIVE), await checked(at, manifest.dist, options.fetchFile));
  unpack(join(into, DIST_ARCHIVE), join(into, "dist"));
  rmSync(join(into, DIST_ARCHIVE));
  writeFileSync(join(into, MANIFEST), signed.bytes);
  writeFileSync(join(into, SIGNATURE), signed.signature);
  return await ptyHost(at, manifest.pty, platform, manifest.version, join(into, "bin"), options);
}

export interface InstallServerOptions {
  /** the install's folder: bin/ and releases/ live in it */
  home: string;
  /** the version to install; a manifest for another one is refused */
  version: string;
  platform?: ServerPlatform;
  /** where releases come from; OVIS_RELEASES_URL, else GitHub's */
  releases?: string;
  /** a test's own key; the launcher passes none, so only RELEASE_PUBLIC_KEY is trusted */
  publicKey?: string;
  /** whether a downloaded Rust PTY host runs on this PC (scripts/pty-sidecar.ts runsHere), and a call made once every
   * file is checked and before anything moves: tests */
  ptyRuns?: (path: string) => boolean;
  inWindow?: () => Promise<void>;
  /** the git trees of the checkout that asks (scripts/plugin-launch.ts): its binary only when the manifest names them */
  sources?: { server: string; shared: string } | { error: string };
  /** how long to wait for another install's lock, how a file is fetched, and a call made when the lock is found held: tests */
  lockWaitMs?: number;
  onLockWait?: () => void;
  fetchFile?: typeof fetch;
}

/**
 * Installs the server of `version` into `home` unless that release already runs there, verified. Throws, with one line
 * that says why and nothing in `home` changed, on any check that fails; throws NoBinaryRelease, before anything is
 * written, when the release of `version` has no ovis-server.json at all.
 */
export async function installServer(options: InstallServerOptions): Promise<{ installed: boolean; message: string; binary: string }> {
  const platform = options.platform ?? hostPlatform();
  if (!platform) throw new Error(`no release has a server binary for ${process.platform}-${process.arch}`);
  const base = releasesBase(options.releases ?? process.env["OVIS_RELEASES_URL"]);
  const { home, version } = options;
  const publicKey = options.publicKey ?? RELEASE_PUBLIC_KEY;
  const current = join(home, "bin");
  const binary = join(current, binaryName(platform));
  if (verifiedInstall(home, version, platform, publicKey)) return { installed: false, message: `Ovis ${version} is installed already in ${current}; nothing to do`, binary };
  return await withInstallLock(home, () => installLocked(options, platform, base, publicKey), options.lockWaitMs, options.onLockWait);
}

async function installLocked(options: InstallServerOptions, platform: ServerPlatform, base: string, publicKey: string): Promise<{ installed: boolean; message: string; binary: string }> {
  const { home, version } = options;
  const releases = join(home, "releases");
  mkdirSync(releases, { recursive: true });
  recover(home);
  // only the lock holder makes a stage: one found now was left by a run that died
  for (const leftover of readdirSync(releases).filter((name) => name.startsWith(".stage-"))) rmSync(join(releases, leftover), { recursive: true, force: true });
  const current = join(home, "bin");
  const binary = join(current, binaryName(platform));
  // the install this one waited for may have put this very version in place
  if (verifiedInstall(home, version, platform, publicKey)) return { installed: false, message: `Ovis ${version} is installed already in ${current}; nothing to do`, binary };

  const at = `${base}/v${version}`;
  const signed = await signedManifest(at, `v${version}`, version, publicKey, options.fetchFile);
  const { manifest } = signed;
  // a checkout of another commit with the same version (a branch, main between releases) runs its own sources
  const sources = options.sources;
  if (sources && ("error" in sources || sources.server !== manifest.sources.server || sources.shared !== manifest.sources.shared)) {
    throw new NoBinaryRelease(`this checkout's server/ and shared/ are not the ones v${version} was built from (${"error" in sources ? sources.error : "other git trees"})`);
  }

  const stage = mkdtempSync(join(releases, ".stage-"));
  const name = `${version}-${randomBytes(4).toString("hex")}`;
  let host = "";
  let previous: string | null = null;
  try {
    host = `; ${await fetchRelease(at, signed, platform, stage, options)}`;
    await options.inWindow?.();
    // the release bin names now: a server started from it may still run, so it stays until the next install
    try { previous = WINDOWS ? null : realpathSync(join(home, "bin")).split(/[/\\]/).at(-1)!; } catch { previous = null; }
    renameSync(stage, join(releases, name));
    try {
      swap(home, name);
      // just checked: the next command need not hash it again
      remember(home, join(home, "bin", binaryName(platform)), manifest.assets[platform].sha256);
    } catch (error) {
      rmSync(join(releases, name), { recursive: true, force: true });
      throw error;
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  // the releases that no longer run: never the one bin names, the one it named before, nor one a server still runs from
  // (it reads dist/ from there); such a release goes with the first install after that server stopped
  const old = readdirSync(releases).filter((entry) => entry !== name && entry !== previous && !entry.startsWith(".")).map((entry) => join(releases, entry));
  const running = foldersInUse(old);
  for (const folder of old.filter((entry) => !running.has(entry))) {
    try { rmSync(folder, { recursive: true, force: true }); } catch { /* still in use: the next install removes it */ }
  }
  return { installed: true, message: `installed Ovis ${version} (${releaseFile(platform)}, sha256 ${manifest.assets[platform].sha256}) in ${current}${host}`, binary };
}
