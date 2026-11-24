import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACP_KEEPER, runsHere } from "./pty-sidecar.ts";
import { KEEPER_MANIFEST, type PtyAsset } from "./release-assets.ts";
import { checkKeeperManifest } from "./server-manifest.ts";
import { checked, download } from "./server-release-files.ts";

const BUDGET_MS = 12_000;
const MAX_KEEPER = 32 * 1024 * 1024;
export async function installKeeper(bin: string, build: PtyAsset, release: { at: string; version: string; publicKey: string; serverBytes: Uint8Array; fetchFile?: typeof fetch }) {
  const { at, version, fetchFile } = release;
  const end = performance.now() + BUDGET_MS;
  const signal = AbortSignal.timeout(BUDGET_MS);
  const remaining = () => {
    const ms = Math.floor(end - performance.now());
    if (ms < 1) throw new Error("ACP keeper deadline exceeded");
    return ms;
  };
  const target = join(bin, ACP_KEEPER.name);
  try {
    const document = await download(at + "/" + KEEPER_MANIFEST, 65536, KEEPER_MANIFEST, fetchFile, signal);
    if (!document) return "no " + KEEPER_MANIFEST + " in this release";
    const signature = await download(at + "/" + KEEPER_MANIFEST + ".sig", 1024, KEEPER_MANIFEST + ".sig", fetchFile, signal);
    if (!signature) return "no signature for " + KEEPER_MANIFEST;
    const assets = checkKeeperManifest(Buffer.from(document), Buffer.from(signature).toString(), release);
    if (typeof assets === "string") return "no ACP keeper: " + assets;
    const asset = assets[build];
    if (asset.size > MAX_KEEPER) return "ACP keeper exceeds the 32 MiB limit";
    const bytes = await checked(at, asset, fetchFile, signal);
    remaining();
    mkdirSync(bin, { recursive: true });
    writeFileSync(target, bytes, { mode: 0o755 });
    chmodSync(target, 0o755);
    if (!runsHere(target, ACP_KEEPER, Math.min(5000, remaining()))) throw new Error("not a runnable ACP keeper");
    remaining();
    writeFileSync(target + ".json", JSON.stringify({ sha256: asset.sha256, version }) + "\n");
    return "the ACP keeper checked against " + KEEPER_MANIFEST;
  } catch (error) {
    rmSync(target, { force: true }); rmSync(target + ".json", { force: true });
    return "the ACP keeper was not taken: " + (error instanceof Error ? error.message : String(error));
  }
}
