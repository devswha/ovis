/**
 * CI job `relay-skew` (.github/workflows/ci.yml): this commit's hosted shell against the oldest
 * server it supports, the tag equal to MIN_SERVER_VERSION (shared/relay-mux.ts), and against the
 * latest release, the newest `v*` tag. For each tag that holds server/relay/, in a worktree of it:
 * its own `readDeviceRegistry` reads the relay-device registry this commit's DeviceStore writes
 * (a phone paired by a newer PC survives a downgrade), then the relay end-to-end run
 * (scripts/relay-e2e-regression.ts) drives this shell against that tree's server, named in
 * RELAY_E2E_SERVER_DIR. A tag that does not exist or predates the relay is skipped with a notice.
 *
 *   bun scripts/relay-skew.ts
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { DeviceStore, readDeviceRegistry } from "../server/devices.ts";
import { MIN_SERVER_VERSION } from "../shared/relay-mux.ts";
import { compareVersions, parseVersion } from "../src/lib/relay/skew.ts";

const repo = join(import.meta.dir, "..");
const E2E = "scripts/relay-e2e-regression.ts";

/** The tags to run against: the minimum's, then the latest release, each once. Only `vX.Y.Z` tags are releases. */
export function skewTargets(tags: readonly string[], minimum: string): string[] {
  const releases = tags.filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag) && parseVersion(tag.slice(1)) !== null)
    .sort((a, b) => compareVersions(parseVersion(a.slice(1))!, parseVersion(b.slice(1))!));
  const latest = releases.at(-1);
  return [...new Set([`v${minimum}`, ...(latest === undefined ? [] : [latest])])];
}

const notice = (message: string): void => console.log(`::notice title=relay-skew::${message}`);

/** A devices.json with one relay-paired phone, written by this commit's DeviceStore. */
export async function registryFixture(dir: string): Promise<string> {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const spki = Buffer.from(await crypto.subtle.exportKey("spki", keys.publicKey)).toString("base64url");
  const store = new DeviceStore(dir);
  if (!store.pairRelay(store.startPairing().code, "Skew phone", spki)) throw new Error("the fixture phone did not pair");
  const path = join(dir, "devices.json");
  const own = readDeviceRegistry(path);
  if (own.kind !== "ok" || !own.devices.some((device) => device.relay_public_key === spki)) throw new Error(`this commit cannot read its own registry: ${own.kind}`);
  return path;
}

async function hasRelay(tag: string): Promise<boolean | null> {
  if ((await $`git rev-parse -q --verify ${`refs/tags/${tag}`}`.cwd(repo).quiet().nothrow()).exitCode !== 0) return null;
  return (await $`git cat-file -e ${`${tag}:server/relay`}`.cwd(repo).quiet().nothrow()).exitCode === 0;
}

export async function against(tag: string, registry: string, root: string): Promise<void> {
  const tree = join(root, tag);
  await $`git worktree add --detach ${tree} ${tag}`.cwd(repo).quiet();
  try {
    await $`bun install --frozen-lockfile`.cwd(tree);
    const read = `const { readDeviceRegistry } = await import(${JSON.stringify(join(tree, "server/devices.ts"))});
      const registry = readDeviceRegistry(${JSON.stringify(registry)});
      if (registry.kind !== "ok" || !registry.devices.some((device) => device.relay_public_key)) { console.error(JSON.stringify(registry)); process.exit(1); }
      console.log("${tag} reads the relay-device registry: " + registry.devices.length + " device(s)");`;
    await $`bun -e ${read}`.cwd(tree);
    if (!existsSync(join(repo, E2E))) throw new Error(`${tag} holds server/relay/, but ${E2E} is missing: the skew run has nothing to drive`);
    await $`bun ${E2E}`.cwd(repo).env({ ...process.env, RELAY_E2E_SERVER_DIR: tree });
  } finally {
    await $`git worktree remove --force ${tree}`.cwd(repo).quiet().nothrow();
  }
}

async function main(): Promise<void> {
  // the pattern goes as an argument: unquoted, Bun's shell would glob it against the checkout's files
  const tags = (await $`git tag -l ${"v*"}`.cwd(repo).text()).split("\n").filter(Boolean);
  if (tags.length === 0) throw new Error("no v* tags: check out with fetch-depth 0 so the release tags come along");
  const targets = skewTargets(tags, MIN_SERVER_VERSION);
  const root = mkdtempSync(join(tmpdir(), "ovis-relay-skew-"));
  try {
    const registry = await registryFixture(root);
    let built = false;
    for (const tag of targets) {
      const relay = await hasRelay(tag);
      if (relay === null) { notice(`${tag} does not exist yet: skipped`); continue; }
      if (!relay) { notice(`${tag} has no server/relay/: skipped`); continue; }
      if (!built) { await $`bun run build && bun run build:shell`.cwd(repo); built = true; }
      await against(tag, registry, root);
      console.log(`relay-skew: ${tag} passed`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}

if (import.meta.main) await main();
