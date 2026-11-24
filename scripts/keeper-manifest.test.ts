import { afterAll, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIST_ARCHIVE, generateKeyPair, PTY_ASSETS, ptyFile, releaseFile, SERVER_PLATFORMS, signManifest, SUMS, verifyRelease, writeManifest } from "./server-manifest.ts";

const dir = mkdtempSync(join(tmpdir(), "ovis-keeper-manifest-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

it("signs every keeper and checks its size and digest, without accepting an unsigned extra in an older release", () => {
  const { publicKey, privateKeyPem } = generateKeyPair();
  const sources = { server: "a".repeat(40), shared: "b".repeat(40) };
  for (const file of [...SERVER_PLATFORMS.map(releaseFile), DIST_ARCHIVE, ...PTY_ASSETS.map(ptyFile)]) writeFileSync(join(dir, file), file);
  writeManifest(dir, { version: "1.2.3", sources });
  signManifest(dir, privateKeyPem);
  expect(verifyRelease(dir, publicKey).ok).toBe(true);
  const name = (build: string) => `ovis-acp-keeper-${build}`;
  for (const build of PTY_ASSETS) writeFileSync(join(dir, name(build)), `keeper for ${build}`);
  expect(verifyRelease(dir, publicKey).ok).toBe(false);
  const manifest = writeManifest(dir, { version: "1.2.3", sources });
  for (const build of PTY_ASSETS) {
    const file = name(build);
    const digest = createHash("sha256").update(readFileSync(join(dir, file))).digest("hex");
    expect(manifest.acpKeeper?.[build]).toEqual({ file, sha256: digest, size: statSync(join(dir, file)).size });
    expect(readFileSync(join(dir, SUMS), "utf8")).toContain(`${digest}  ${file}\n`);
  }
  signManifest(dir, privateKeyPem);
  expect(verifyRelease(dir, publicKey)).toEqual({ ok: true, problems: [] });
  writeFileSync(join(dir, name("linux-x64")), "changed keeper");
  expect(verifyRelease(dir, publicKey).problems).toEqual([expect.stringContaining(`${name("linux-x64")} does not match`)]);
  rmSync(join(dir, name("linux-arm64")));
  expect(() => writeManifest(dir, { version: "1.2.3", sources })).toThrow(name("linux-arm64"));
});
