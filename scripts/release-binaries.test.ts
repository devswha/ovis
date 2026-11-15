import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkBuilt, EXTRA_BINARIES, isExtraPlatform, RUST_TARGETS, writeBinaryManifest } from "./release-binaries.ts";
import { EXTRA_PLATFORMS, extraFile, type ExtraPlatform } from "./server-manifest.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-release-binaries-"));
  dirs.push(dir);
  return dir;
};
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const SOURCE = "c".repeat(40);

/** the first 64 bytes of an executable for `cpu`: an ELF header, or a thin Mach-O one */
function header(kind: "elf" | "macho", cpu: "x86_64" | "aarch64"): Buffer {
  const bytes = Buffer.alloc(64);
  if (kind === "elf") {
    bytes.writeUInt32BE(0x7f454c46, 0);
    bytes.writeUInt16LE(cpu === "x86_64" ? 0x3e : 0xb7, 18);
  } else {
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(cpu === "x86_64" ? 0x01000007 : 0x0100000c, 4);
  }
  return bytes;
}

describe("an extra binary's own manifest", () => {
  it("names every platform's file in the folder with its SHA-256 and size, the version and the source commit", () => {
    const dir = scratch();
    for (const platform of ["linux-x64", "darwin-arm64"] as const) writeFileSync(join(dir, extraFile("ovis-link", platform)), `link ${platform}\n`);
    // the other binaries built into the same folder are not this manifest's
    writeFileSync(join(dir, extraFile("other-binary", "linux-x64")), "other\n");
    const manifest = writeBinaryManifest(dir, "ovis-link", { version: "1.2.3", source: SOURCE });
    expect(JSON.parse(readFileSync(join(dir, "ovis-link.json"), "utf8"))).toEqual(manifest);
    expect(manifest).toEqual({
      version: "1.2.3",
      source: SOURCE,
      assets: {
        "linux-x64": { file: "ovis-link-linux-x64", sha256: sha256(join(dir, "ovis-link-linux-x64")), size: 15 },
        "darwin-arm64": { file: "ovis-link-darwin-arm64", sha256: sha256(join(dir, "ovis-link-darwin-arm64")), size: 18 },
      },
    });
    expect(Object.keys(manifest.assets)).toEqual(EXTRA_PLATFORMS.filter((platform) => platform in manifest.assets));
  });

  it("refuses a folder with no file of that binary, and a source that is not a full commit", () => {
    const dir = scratch();
    expect(() => writeBinaryManifest(dir, "ovis-link", { version: "1.2.3", source: SOURCE })).toThrow("no ovis-link-<platform>");
    writeFileSync(join(dir, extraFile("ovis-link", "linux-x64")), "link\n");
    expect(() => writeBinaryManifest(dir, "ovis-link", { version: "1.2.3", source: "main" })).toThrow("40-character commit");
    expect(existsSync(join(dir, "ovis-link.json"))).toBe(false);
  });
});

describe("a build is checked for the platform it is named after", () => {
  it("takes an executable for that CPU and OS, and refuses one for another", () => {
    const dir = scratch();
    const file = join(dir, "built");
    writeFileSync(file, header("elf", "x86_64"));
    expect(() => checkBuilt(file, "linux-x64")).not.toThrow();
    expect(() => checkBuilt(file, "linux-arm64")).toThrow("not elf-aarch64");
    expect(() => checkBuilt(file, "darwin-x64")).toThrow("not macho-x86_64");
    writeFileSync(file, header("macho", "aarch64"));
    expect(() => checkBuilt(file, "darwin-arm64")).not.toThrow();
  });

  it("builds Linux binaries static (musl) and each macOS CPU on its own target", () => {
    expect(RUST_TARGETS).toEqual({
      "linux-x64": "x86_64-unknown-linux-musl",
      "linux-arm64": "aarch64-unknown-linux-musl",
      "darwin-arm64": "aarch64-apple-darwin",
      "darwin-x64": "x86_64-apple-darwin",
    });
  });
});
