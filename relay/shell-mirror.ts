/**
 * Keeps a regional copy of the hosted app (`app.ovis.sh`) on a relay box, for the regional app
 * address (`app-ap.ovis.sh`, shared/relay-regions.ts). Each run asks `app.ovis.sh` which commit it
 * serves (its build.json), finds the GitHub release built from that commit, checks the release's
 * dist-shell.tar.gz against the SHA-256 published with it and against that commit, and makes it
 * current. The copy therefore only ever serves a build `app.ovis.sh` serves too: the same trust
 * root, not a second one. A run with nothing new does nothing.
 *
 *   bun relay/shell-mirror.ts --dir /opt/ovis-shell
 *
 * `<dir>/current` is the folder the web server serves; the last three releases stay beside it.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const APP = "https://app.ovis.sh";
export const REPOSITORY = "devswha/ovis";
const KEEP = 3;
const REVISION = /^[0-9a-f]{40}$/;

interface ReleaseAsset { readonly name: string; readonly browser_download_url: string }
interface Release { readonly tag_name: string; readonly assets: readonly ReleaseAsset[] }

export interface MirrorOptions {
  readonly dir: string;
  readonly fetch?: typeof fetch;
  /** Unpacks a tarball into an empty folder; `tar` by default. */
  readonly unpack?: (tarball: string, into: string) => Promise<void>;
}

export type MirrorResult = { readonly kind: "current"; readonly revision: string } | { readonly kind: "updated"; readonly tag: string; readonly revision: string };

async function json(fetcher: typeof fetch, url: string): Promise<unknown> {
  const response = await fetcher(url, { headers: { accept: "application/json", "user-agent": "ovis-shell-mirror" }, cache: "no-store" });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
}

async function bytes(fetcher: typeof fetch, url: string): Promise<Uint8Array> {
  const response = await fetcher(url, { headers: { "user-agent": "ovis-shell-mirror" }, redirect: "follow" });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function revisionOf(buildJson: unknown): string {
  const revision = typeof buildJson === "object" && buildJson !== null ? (buildJson as { revision?: unknown }).revision : undefined;
  if (typeof revision !== "string" || !REVISION.test(revision)) throw new Error("build.json names no commit");
  return revision;
}

function servedRevision(dir: string): string | null {
  try { return revisionOf(JSON.parse(readFileSync(join(dir, "current", "build.json"), "utf8"))); } catch { return null; }
}

async function tarUnpack(tarball: string, into: string): Promise<void> {
  // the same refusals as the Pages deploy (.github/workflows/release.yml): only plain files and folders, all inside
  const listing = await Bun.$`tar -tvzf ${tarball}`.text();
  if (listing.split("\n").some((line) => line !== "" && !/^[-d]/.test(line))) throw new Error("the tarball holds a link or a special file");
  const names = await Bun.$`tar -tzf ${tarball}`.text();
  if (names.split("\n").some((name) => name.startsWith("/") || /(^|\/)\.\.(\/|$)/.test(name))) throw new Error("the tarball holds a path outside it");
  await Bun.$`tar -xzf ${tarball} -C ${into} --no-same-owner --no-same-permissions`.quiet();
}

/** One run: brings `<dir>/current` to the build `app.ovis.sh` serves. */
export async function mirrorOnce(options: MirrorOptions): Promise<MirrorResult> {
  const fetcher = options.fetch ?? fetch;
  const unpack = options.unpack ?? tarUnpack;
  const live = revisionOf(await json(fetcher, `${APP}/build.json`));
  if (servedRevision(options.dir) === live) return { kind: "current", revision: live };
  const releases = await json(fetcher, `https://api.github.com/repos/${REPOSITORY}/releases?per_page=20`) as Release[];
  for (const release of releases) {
    const tarball = release.assets.find((asset) => asset.name === "dist-shell.tar.gz");
    const digest = release.assets.find((asset) => asset.name === "dist-shell.tar.gz.sha256");
    if (!tarball || !digest || !/^[\w.@+-]+$/.test(release.tag_name)) continue;
    const commit = await json(fetcher, `https://api.github.com/repos/${REPOSITORY}/commits/${encodeURIComponent(release.tag_name)}`) as { sha?: unknown };
    if (commit.sha !== live) continue;
    const expected = new TextDecoder().decode(await bytes(fetcher, digest.browser_download_url)).trim().split(/\s+/)[0] ?? "";
    const archive = await bytes(fetcher, tarball.browser_download_url);
    if (!/^[0-9a-f]{64}$/.test(expected) || createHash("sha256").update(archive).digest("hex") !== expected) {
      throw new Error(`${release.tag_name}: dist-shell.tar.gz does not match its published SHA-256`);
    }
    return install(options.dir, release.tag_name, live, archive, unpack);
  }
  throw new Error(`no release with a dist-shell.tar.gz was built from ${live}, the commit ${APP} serves`);
}

async function install(dir: string, tag: string, revision: string, archive: Uint8Array,
  unpack: NonNullable<MirrorOptions["unpack"]>): Promise<MirrorResult> {
  const releases = join(dir, "releases");
  mkdirSync(releases, { recursive: true });
  const staging = join(releases, `.staging-${tag}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging);
  const tarball = join(dir, `.${tag}.tar.gz`);
  writeFileSync(tarball, archive);
  try {
    await unpack(tarball, staging);
    const unpacked = revisionOf(JSON.parse(readFileSync(join(staging, "build.json"), "utf8")));
    if (unpacked !== revision) throw new Error(`${tag}: its build.json names ${unpacked}, not ${revision}`);
    const target = join(releases, tag);
    rmSync(target, { recursive: true, force: true });
    renameSync(staging, target);
    // swapped by a rename, so the web server never sees a missing `current`
    const link = join(dir, ".current-next");
    rmSync(link, { force: true });
    symlinkSync(join("releases", tag), link);
    renameSync(link, join(dir, "current"));
    prune(dir, releases, tag);
    return { kind: "updated", tag, revision };
  } finally {
    rmSync(tarball, { force: true });
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Keeps the newest KEEP releases by when they were installed, and always the current one. */
function prune(dir: string, releases: string, current: string): void {
  const kept = readdirSync(releases, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => ({ name: entry.name, at: Bun.file(join(releases, entry.name, "build.json")).lastModified }))
    .sort((a, b) => b.at - a.at);
  const serving = existsSync(join(dir, "current")) ? readlinkSync(join(dir, "current")) : null;
  for (const [index, entry] of kept.entries()) {
    if (index < KEEP || entry.name === current || serving === join("releases", entry.name)) continue;
    rmSync(join(releases, entry.name), { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const at = process.argv.indexOf("--dir");
  const dir = at === -1 ? undefined : process.argv[at + 1];
  if (!dir) throw new Error("Usage: bun relay/shell-mirror.ts --dir <folder>");
  const result = await mirrorOnce({ dir });
  console.log(result.kind === "current" ? `current: ${result.revision}` : `updated to ${result.tag} (${result.revision})`);
}
