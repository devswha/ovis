/**
 * The extra binaries that can be built beside ovis-server (EXTRA_BINARIES), and which ones a release carries
 * (RELEASE_BINARIES: the build of the signed ovis-server.json names them; this file is not exported, the manifest's
 * reader takes the names the release gives), as their builds write them:
 *
 *   bun scripts/build-link.ts <platform> <dir>                ovis-link-<platform> and ovis-link.json
 *   bun scripts/release-binaries.ts manifest <binary> <dir>   <binary>.json again, over every platform's file in <dir>
 *                                                             (each workflow's manifest job, once the four builds are in)
 *
 * <binary>.json holds the release version, the source commit the binary was built from and each platform's file with
 * its SHA-256 and size. It is what a reader of one binary looks at; installers trust only the signed ovis-server.json,
 * which names the same files. Platforms: linux-x64 and linux-arm64 (static, musl), darwin-arm64 and darwin-x64.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { architectures, expectedArchitectures } from "./pty-sidecar.ts";
import { EXTRA_PLATFORMS, extraFile, type ExtraPlatform, type ReleaseAsset } from "./server-manifest.ts";

const root = resolve(import.meta.dir, "..");

/** What can be built, by its workflow run by hand: the link agent (crates/fleet-link, MIT, for M1's test build). */
export const EXTRA_BINARIES = ["ovis-link"] as const;
export type ExtraBinary = typeof EXTRA_BINARIES[number];
/**
 * What a release built now carries beside the server and the PTY host: none of them. A machine of the account runs the
 * server and the PTY host alone (todo 66), so the signed manifest names no extra binary.
 */
export const RELEASE_BINARIES: readonly ExtraBinary[] = [];

/** The Rust target each platform's binary is built for. */
export const RUST_TARGETS: Record<ExtraPlatform, string> = {
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
};

export interface BinaryManifest {
  version: string;
  /** the commit the binary was built from: this repository's */
  source: string;
  assets: Partial<Record<ExtraPlatform, ReleaseAsset>>;
}

export const isExtraPlatform = (value: string | undefined): value is ExtraPlatform => (EXTRA_PLATFORMS as readonly string[]).includes(value ?? "");
export const packageVersion = (): string => (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Throws unless `file` is an executable for `platform`'s OS and CPU. */
export function checkBuilt(file: string, platform: ExtraPlatform): void {
  const want = expectedArchitectures([RUST_TARGETS[platform]]);
  const have = architectures(file).sort();
  if (JSON.stringify(have) !== JSON.stringify(want)) throw new Error(`${file} is for ${have.join("+")}, not ${want.join("+")}`);
}

/** Writes `<binary>.json` in `dir` for every `<binary>-<platform>` there; other files are other binaries' and left alone. */
export function writeBinaryManifest(dir: string, binary: ExtraBinary, release: { version: string; source: string }): BinaryManifest {
  if (!/^[0-9a-f]{40}$/.test(release.source)) throw new Error(`${binary}: the source must be a full 40-character commit, not ${release.source}`);
  const assets: BinaryManifest["assets"] = {};
  for (const platform of EXTRA_PLATFORMS) {
    const file = extraFile(binary, platform);
    if (!existsSync(join(dir, file))) continue;
    const bytes = readFileSync(join(dir, file));
    assets[platform] = { file, sha256: sha256(bytes), size: bytes.length };
  }
  if (Object.keys(assets).length === 0) throw new Error(`${dir} holds no ${binary}-<platform> to write ${binary}.json for`);
  const manifest: BinaryManifest = { version: release.version, source: release.source, assets };
  writeFileSync(join(dir, `${binary}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** `argv`'s stdout, its stderr passed through; throws naming `what` when it fails. */
export function run(argv: string[], what: string, options: { cwd?: string; env?: Record<string, string | undefined> } = {}): string {
  const result = Bun.spawnSync(argv, { cwd: options.cwd ?? root, env: { ...process.env, ...options.env }, stdout: "pipe", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`${what} failed (${argv.join(" ")} exited ${result.exitCode})`);
  return result.stdout.toString().trim();
}

/** Adds `target` to the toolchain where rustup manages it; a toolchain without rustup must already have it. */
export function addTarget(target: string, cwd?: string): void {
  if (Bun.which("rustup", { PATH: process.env["PATH"] ?? "" })) run(["rustup", "target", "add", target], `adding the Rust target ${target}`, cwd === undefined ? {} : { cwd });
}

/** This checkout's commit, refused when `paths` have changes it does not hold: the binary would not be built from it. */
export function committedSource(...paths: string[]): string {
  const status = Bun.spawnSync(["git", "status", "--porcelain", "--untracked-files=all", "--", ...paths], { cwd: root, stdout: "pipe", stderr: "ignore" });
  if (status.exitCode !== 0) throw new Error("not a git checkout, so the binary cannot be tied to its sources");
  if (status.stdout.toString().trim() !== "") throw new Error(`${paths.join(", ")} have changes that are not committed, so the binary would not be built from HEAD`);
  return run(["git", "rev-parse", "HEAD"], "reading HEAD");
}

/** The source commit a binary's manifest names, as its build names it. */
export async function sourceOf(_binary: ExtraBinary): Promise<string> {
  return committedSource("crates/fleet-link");
}

if (import.meta.main) {
  const [verb, binary, dir, ...rest] = process.argv.slice(2);
  if (verb !== "manifest" || !(EXTRA_BINARIES as readonly string[]).includes(binary ?? "") || dir === undefined || rest.length > 0) {
    console.error(`Usage: bun scripts/release-binaries.ts manifest <${EXTRA_BINARIES.join("|")}> <dir>`);
    process.exit(2);
  }
  try {
    const name = binary as ExtraBinary;
    console.log(JSON.stringify(writeBinaryManifest(resolve(dir), name, { version: packageVersion(), source: await sourceOf(name) }), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
