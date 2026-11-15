/**
 * The fleet link agent (crates/fleet-link) as a release ships it:
 *
 *   bun scripts/build-link.ts <linux-x64|linux-arm64|darwin-arm64|darwin-x64> <dir>
 *
 * A release build (`cargo build --release --locked`) for the platform's Rust target (scripts/release-binaries.ts
 * RUST_TARGETS: static musl on Linux), checked to be for that OS and CPU and, where it runs here, to answer
 * `--version`; then <dir>/ovis-link-<platform> and <dir>/ovis-link.json (version, this checkout's commit, SHA-256 and
 * size per platform). Cargo comes from PATH, and CARGO_TARGET_DIR is honoured; the crate's sources must be committed.
 */
import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { addTarget, checkBuilt, committedSource, isExtraPlatform, packageVersion, run, RUST_TARGETS, writeBinaryManifest } from "./release-binaries.ts";
import { extraFile, type ExtraPlatform } from "./server-manifest.ts";

const root = resolve(import.meta.dir, "..");
const CRATE = "crates/fleet-link";

export function buildLink(platform: ExtraPlatform, out: string): string {
  const source = committedSource(CRATE);
  const target = RUST_TARGETS[platform];
  addTarget(target);
  run(["cargo", "build", "--release", "--locked", "--target", target, "--manifest-path", join(CRATE, "Cargo.toml")], `cargo build of ${CRATE} for ${target}`);
  const targetDir = process.env["CARGO_TARGET_DIR"] ? resolve(process.env["CARGO_TARGET_DIR"]) : join(root, CRATE, "target");
  mkdirSync(out, { recursive: true });
  const file = join(out, extraFile("ovis-link", platform));
  copyFileSync(join(targetDir, target, "release", "ovis-link"), file);
  chmodSync(file, 0o755);
  checkBuilt(file, platform);
  if (platform === `${process.platform}-${process.arch}`) console.log(run([file, "--version"], `${file} --version`));
  writeBinaryManifest(out, "ovis-link", { version: packageVersion(), source });
  return file;
}

if (import.meta.main) {
  const [platform, out, ...rest] = process.argv.slice(2);
  if (!isExtraPlatform(platform) || out === undefined || rest.length > 0) {
    console.error("Usage: bun scripts/build-link.ts <linux-x64|linux-arm64|darwin-arm64|darwin-x64> <dir>");
    process.exit(2);
  }
  try {
    console.log(buildLink(platform, resolve(out)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
