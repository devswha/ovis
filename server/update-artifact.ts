/**
 * Updates that install the release's compiled server (todo 7), from a source checkout as from a release of it. The
 * bridge release (the last `v*` tag, a full-source commit, which every older install builds as it always did) brings
 * the updater that reads releases instead of tags: a release named `ovis-<version>` (the beta channel also takes
 * `ovis-<version>-beta.<n>`), whose `ovis-server.json` is signed by the committed key (RELEASE_PUBLIC_KEY) and names that
 * very version, and whose files match it. A schema-1 manifest is the binary distribution: every such release ships
 * the compiled server, so no other field says so.
 *
 * A binary release is staged where every launcher since updates replaced the supervisor looks for a release
 * (server/managed.ts: `<update state>/release-*`, recorded in current.json with the checkout's revision):
 *
 *   release-XXXX/bin/                 ovis-server(.exe), dist/, the manifest and its signature as checked, and
 *                                     bin/ovis-pty-sidecar(.json) where the release's Rust PTY host runs here
 *   release-XXXX/server/supervisor.ts a few lines a launcher runs with its Bun, which run bin/ovis-server supervisor
 *
 * Nothing of the source checkout or the state folder changes: a failed check removes the stage and leaves the release
 * that runs as it is, and the checkout stays for the launcher to fall back to.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { REVISION, type UpdateChannel } from "../shared/update.ts";
import { fetchRelease, NoBinaryRelease, releasesBase, signedManifest, type SignedManifest } from "../scripts/server-install.ts";
import { binaryName, checkManifest, MANIFEST, type ServerPlatform, SIGNATURE } from "../scripts/server-manifest.ts";

/** A release of the compiled server: `ovis-0.6.0`, or on the beta channel `ovis-0.6.0-beta.3`. */
const RELEASE_NAME = /^ovis-(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/;

/** A version's order: X.Y.Z, then its beta number, a release after every beta of it; null for anything else. */
function versionKey(version: string): number[] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? Infinity : Number(match[4])] : null;
}

/** Whether version `a` comes after `b`; false when either is not a version this updater orders. */
export function newerVersion(a: string, b: string): boolean {
  const [first, second] = [versionKey(a), versionKey(b)];
  if (!first || !second) return false;
  const i = first.findIndex((part, j) => part !== second[j]);
  return i !== -1 && first[i]! > second[i]!;
}

/** The newest release name the channel takes, by version: a release outranks every beta of its version; stable takes no beta. */
export function latestRelease(names: string[], channel: UpdateChannel): { tag: string; version: string } | undefined {
  let best: { tag: string; version: string } | undefined;
  for (const tag of names) {
    const match = RELEASE_NAME.exec(tag);
    if (!match || (match[4] !== undefined && channel !== "beta")) continue;
    const version = tag.slice("ovis-".length);
    if (!best || newerVersion(version, best.version)) best = { tag, version };
  }
  return best;
}

const GITHUB_DOWNLOADS = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/releases\/download$/;

/**
 * The release names at `base` (OVIS_RELEASES_URL, or GitHub's): the folders of a file:// folder, or the published
 * releases GitHub's API lists for that repository. Another https address has no list to read, so it is refused.
 */
export async function releaseNames(base: string, fetchFile: typeof fetch = fetch): Promise<string[]> {
  if (base.startsWith("file://")) {
    return readdirSync(fileURLToPath(base), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  }
  const github = GITHUB_DOWNLOADS.exec(base);
  if (!github) throw new Error(`the updater lists releases only on GitHub or in a file:// folder, and ${base} is neither`);
  const response = await fetchFile(`https://api.github.com/repos/${github[1]}/${github[2]}/releases?per_page=100`, {
    headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`could not list the releases of ${github[1]}/${github[2]}: HTTP ${response.status}`);
  const releases = await response.json() as Array<{ tag_name?: unknown; draft?: unknown }>;
  return Array.isArray(releases) ? releases.filter((release) => release.draft !== true && typeof release.tag_name === "string").map((release) => release.tag_name as string) : [];
}

/** A binary release on offer: where it is, its manifest as checked, and its id (the SHA-256 of the manifest's bytes). */
export interface BinaryOffer { tag: string; version: string; at: string; revision: string; signed: SignedManifest }

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * The newest release the channel takes at `base`, once its manifest is signed by `publicKey` and names the version its
 * name gives (an older manifest, also signed, put under a newer name is refused); null where there is none. Only the
 * manifest and its signature are read: no file it names is downloaded here.
 */
export async function offeredRelease(options: { base: string | undefined; channel: UpdateChannel; publicKey: string; fetchFile?: typeof fetch }): Promise<BinaryOffer | null> {
  const base = releasesBase(options.base);
  const latest = latestRelease(await releaseNames(base, options.fetchFile), options.channel);
  if (!latest) return null;
  const at = `${base}/${latest.tag}`;
  let signed: SignedManifest;
  try { signed = await signedManifest(at, latest.tag, latest.version, options.publicKey, options.fetchFile); }
  catch (error) {
    // a release of this name with no manifest is not one the updater can take: a failure, never a source build
    throw error instanceof NoBinaryRelease ? new Error(error.message) : error;
  }
  return { tag: latest.tag, version: latest.version, at, revision: sha256(signed.bytes), signed };
}

/**
 * The few lines every launcher runs as a release's supervisor (`<Bun> <release>/server/supervisor.ts`, its cwd the
 * source checkout). Before anything of the release runs, they check what lies in bin/ now: the manifest's signature by
 * `publicKey` (the key the release was checked with when it was staged), that it names `version` (the one staged: a
 * manifest of another release, signed too, is not this one's) and the binary's SHA-256 in it. A file changed since
 * then makes them exit before the supervisor is ready, so the launcher falls back to the checkout's own supervisor.
 * The binary is hashed, then started by its path: a writer swapping the file between the two still gets its bytes run,
 * as one who can write the state folder can also rewrite these lines; this guards against a change at rest, not that. Then they run the release's binary as the supervisor, pass its IPC messages ("ready") up to the
 * launcher and the launcher's stop signals down, and exit as it does, HANDOVER_EXIT included. A launcher from before
 * the rename names the checkout HERDR_WEB_SOURCE_ROOT. Plain JavaScript a Bun of any version runs.
 */
export function releaseSupervisor(publicKey: string, version: string): string {
  return `// Written by the update that installed this compiled release (server/update-artifact.ts): the launcher of the source
// checkout runs this file with its Bun, and this runs the release's binary as the supervisor, once it still checks.
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const KEY = ${JSON.stringify(publicKey)};
const VERSION = ${JSON.stringify(version)};
const windows = process.platform === "win32";
const bin = join(import.meta.dir, "..", "bin");
const binary = join(bin, windows ? "ovis-server.exe" : "ovis-server");
try {
  const manifest = readFileSync(join(bin, "ovis-server.json"));
  const signature = Buffer.from(readFileSync(join(bin, "ovis-server.json.sig"), "utf8").trim(), "base64");
  const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(KEY, "base64")]), format: "der", type: "spki" });
  if (!verify(null, manifest, key, signature)) throw new Error("ovis-server.json is not signed by the release key");
  const platform = (windows ? "windows" : process.platform) + "-" + process.arch;
  const named = JSON.parse(manifest.toString("utf8"));
  if (named.version !== VERSION) throw new Error("ovis-server.json is for version " + named.version + ", not the " + VERSION + " staged here");
  const expected = named.assets?.[platform]?.sha256;
  if (createHash("sha256").update(readFileSync(binary)).digest("hex") !== expected) throw new Error(binary + " does not match its SHA-256 in ovis-server.json");
} catch (error) {
  console.error("Ovis: this update's server was not run (" + (error instanceof Error ? error.message : String(error)) + "); the launcher falls back to the source checkout.");
  process.exit(3);
}
const root = process.env.OVIS_SOURCE_ROOT || process.env.HERDR_WEB_SOURCE_ROOT || process.cwd();
const env = { ...process.env, OVIS_SOURCE_ROOT: root };
delete env.BUN_BE_BUN;
const child = Bun.spawn([binary, "supervisor"], {
  cwd: root, windowsHide: true, stdin: "ignore", stdout: "inherit", stderr: "inherit", env,
  ipc(message) { try { process.send?.(message); } catch {} },
});
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { try { child.kill(signal); } catch {} });
const code = await child.exited;
process.exit(child.signalCode ? 1 : code ?? 1);
`;
}

/**
 * Stages the offered release for `platform` in a new `<stateDir>/release-*`: every file checked against the manifest
 * before it is kept, then the supervisor launchers run. The folder is returned only whole; on any failure it is
 * removed and the error says why. `signal` stops it between files.
 */
export async function stageBinaryRelease(offer: BinaryOffer, options: { stateDir: string; platform: ServerPlatform; publicKey: string; signal?: AbortSignal; fetchFile?: typeof fetch; ptyRuns?: (path: string) => boolean }): Promise<{ directory: string; host: string }> {
  const directory = mkdtempSync(join(options.stateDir, "release-"));
  try {
    const bin = join(directory, "bin");
    mkdirSync(bin);
    options.signal?.throwIfAborted();
    const host = await fetchRelease(offer.at, offer.signed, options.platform, bin, { fetchFile: options.fetchFile, ptyRuns: options.ptyRuns });
    options.signal?.throwIfAborted();
    mkdirSync(join(directory, "server"));
    writeFileSync(join(directory, "server", "supervisor.ts"), releaseSupervisor(options.publicKey, offer.version));
    return { directory, host };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

/**
 * The binary release in `directory` as it was staged: its manifest still signed by `publicKey` for `version`, its id
 * that manifest's SHA-256, the binary still what the manifest names, its client and its supervisor there; else null.
 * What a supervisor checks before it runs a release current.json names.
 */
export function stagedRelease(directory: string, publicKey: string, version: string, platform: ServerPlatform): { revision: string; version: string; build_revision?: string } | null {
  try {
    const bin = join(directory, "bin");
    const bytes = readFileSync(join(bin, MANIFEST));
    const manifest = checkManifest(bytes, readFileSync(join(bin, SIGNATURE), "utf8"), publicKey, { version });
    if (typeof manifest === "string") return null;
    if (sha256(readFileSync(join(bin, binaryName(platform)))) !== manifest.assets[platform].sha256) return null;
    if (!existsSync(join(bin, "dist", "index.html")) || !existsSync(join(directory, "server", "supervisor.ts"))) return null;
    const build = buildCommit(directory);
    return { revision: sha256(bytes), version: manifest.version, ...(build ? { build_revision: build } : {}) };
  } catch {
    return null;
  }
}

/**
 * The commit the release's client was built from (the build.json vite writes into dist/), or undefined. A page compares
 * its own build's commit with the revision the server reports (src/lib/updateNotes.ts reloadReason): reported as the
 * manifest's SHA-256, a binary release would ask for a reload that never helps.
 */
export function buildCommit(directory: string): string | undefined {
  try {
    const revision = (JSON.parse(readFileSync(join(directory, "bin", "dist", "build.json"), "utf8")) as { revision?: unknown }).revision;
    return typeof revision === "string" && REVISION.test(revision) ? revision : undefined;
  } catch {
    return undefined;
  }
}
