import { afterAll, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { version } from "../../../package.json";
import { stageServerArtifact } from "../../../scripts/server-artifact.ts";
import { acpKeeperBin } from "../../../server/acp/keeper-bin.ts";
import { installedHelpers } from "./native.ts";

const root = mkdtempSync(join(tmpdir(), "ovis-desktop-keeper-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

it.skipIf(process.platform === "win32")("stages an independently verified keeper where the app's server resolves it, even without a host", async () => {
  const bin = join(root, "bin");
  const dir = join(root, "stage", "server");
  const dist = join(root, "dist");
  mkdirSync(bin);
  mkdirSync(dist);
  writeFileSync(join(root, "package.json"), JSON.stringify({ version }));
  writeFileSync(join(dist, "index.html"), "<title>Ovis</title>");
  const binary = join(bin, "ovis-acp-keeper");
  const bytes = '#!/bin/sh\necho "Usage: ovis-acp-keeper ROOT" >&2\nexit 2\n';
  writeFileSync(binary, bytes);
  expect(installedHelpers(bin).acpKeeper).toBeUndefined();
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  writeFileSync(`${binary}.json`, JSON.stringify({ sha256, version }));
  await stageServerArtifact({ ...installedHelpers(bin), platform: "linux-x64", dir, dist, nodePty: false, build: async (_, out) => writeFileSync(out, "server") });
  // The compiled server uses its embedded version; the source resolver reads the same version here.
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version }));
  const installed = join(dir, "bin", "ovis-acp-keeper");
  expect(acpKeeperBin({}, { installed, build: join(root, "no-cargo-build") })).toBe(installed);
});
