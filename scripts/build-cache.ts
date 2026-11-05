/**
 * `bun run build`: the client build (`vite build` into dist/), reused from a cache shared by the
 * self-hosted runner's jobs when OVIS_BUILD_CACHE_DIR names one (scripts/self-hosted-runner/run.sh
 * --build-cache). Fast checks, Integration and both browser jobs build the same commit; with the
 * cache only the first pays for it. Without the variable this is `vite build`, nothing else.
 *
 * An entry is named after everything the build reads: the commit (every tracked file, bun.lock and
 * the patches included; the client also embeds its hash), Bun's version, the platform, the build's
 * arguments, the variables Vite or vite.config.ts read, and any .env file. A checkout with changes
 * git has not committed (tracked or untracked) never reads or writes the cache: its files are not
 * the commit's. node_modules is what `bun install --frozen-lockfile` makes of bun.lock.
 *
 * Entries are written whole under a private name and renamed into place; the least recently used
 * ones go once the total passes OVIS_BUILD_CACHE_MAX_MB (default 2048). Any cache failure builds.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Raise when the entry layout or what the key covers changes: older entries then simply miss. */
const FORMAT = "1";
const SIZE_FILE = ".size";

export type Key = { key: string } | { bypass: string };

const git = (root: string, args: string[]): string | null => {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
  return result.status === 0 ? result.stdout : null;
};

/** The variables that change what Vite writes: its VITE_* (import.meta.env), NODE_ENV, and vite.config.ts's own. */
const buildVariable = (name: string): boolean => name.startsWith("VITE_") || name === "NODE_ENV" || name === "HERDR_TEST_HOOKS";

export function cacheKey(root: string, env: Record<string, string | undefined>, args: readonly string[]): Key {
  // Jobs share the cache read-write, so one of them could plant an entry for another commit's key.
  // Only pull request runs read it: main's pushes and release.yml's validation always build.
  if (env["GITHUB_ACTIONS"] === "true" && env["GITHUB_EVENT_NAME"] !== "pull_request") return { bypass: "only pull request runs use it" };
  const head = git(root, ["rev-parse", "--verify", "HEAD^{commit}"])?.trim();
  if (!head) return { bypass: "no git commit" };
  const status = git(root, ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"]);
  if (status === null) return { bypass: "git status failed" };
  if (status !== "") return { bypass: "the checkout has uncommitted changes" };
  const hash = createHash("sha256");
  const part = (label: string, value: string | Buffer): void => { hash.update(`${label}\0${value.length}\0`).update(value); };
  part("format", FORMAT);
  part("commit", head);
  part("bun", `${Bun.version} ${Bun.revision}`);
  part("platform", `${process.platform} ${process.arch}`);
  part("args", JSON.stringify(args));
  for (const name of Object.keys(env).filter(buildVariable).sort()) part(`env ${name}`, env[name] ?? "");
  // Vite's envDir is the root: .env, .env.local, .env.<mode> and .env.<mode>.local (.env is ignored by git)
  for (const name of readdirSync(root).filter((entry) => entry.startsWith(".env")).sort()) {
    const path = join(root, name);
    part(`file ${name}`, statSync(path).isFile() ? readFileSync(path) : "(not a file)");
  }
  return { key: hash.digest("hex") };
}

/** Puts the entry's files at `dist`, replacing what is there; false when there is no complete entry. */
export function restore(cacheDir: string, key: string, dist: string): boolean {
  const entry = join(cacheDir, key);
  if (!existsSync(join(entry, SIZE_FILE))) return false;
  const staging = mkdtempSync(`${dist}.cache-`);
  try {
    cpSync(entry, staging, { recursive: true });
    rmSync(join(staging, SIZE_FILE), { force: true });
    rmSync(dist, { recursive: true, force: true });
    renameSync(staging, dist);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  const now = new Date();
  // its last use, which eviction goes by; another job may have evicted it since the copy
  try { utimesSync(entry, now, now); } catch { /* gone already */ }
  return true;
}

const treeSize = (path: string): number => {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(path).reduce((total, name) => total + treeSize(join(path, name)), 0);
};

/** Copies `dist` in as the entry for `key` (unless another job has written it first), then evicts. */
export function store(cacheDir: string, key: string, dist: string, maxBytes: number): void {
  mkdirSync(cacheDir, { recursive: true });
  const entry = join(cacheDir, key);
  if (!existsSync(entry)) {
    const staging = mkdtempSync(join(cacheDir, `.new-${process.pid}-`));
    try {
      cpSync(dist, staging, { recursive: true });
      writeFileSync(join(staging, SIZE_FILE), `${treeSize(staging)}\n`);
      renameSync(staging, entry);
    } catch {
      // another job renamed the same entry into place first, or the cache is full: theirs stands
      rmSync(staging, { recursive: true, force: true });
    }
  }
  evict(cacheDir, maxBytes);
}

/** Removes the least recently used entries until the rest fit in `maxBytes`, and staging left by a crash. */
export function evict(cacheDir: string, maxBytes: number): void {
  const entries: { path: string; used: number; size: number }[] = [];
  for (const name of readdirSync(cacheDir)) {
    const path = join(cacheDir, name);
    try {
      const stat = statSync(path);
      if (name.startsWith(".new-")) {
        if (Date.now() - stat.mtimeMs > 3_600_000) rmSync(path, { recursive: true, force: true });
        continue;
      }
      entries.push({ path, used: stat.mtimeMs, size: Number(readFileSync(join(path, SIZE_FILE), "utf8")) || 0 });
    } catch { /* removed by another job meanwhile, or not an entry */ }
  }
  entries.sort((a, b) => b.used - a.used);
  let total = 0;
  for (const entry of entries) {
    total += entry.size;
    if (total > maxBytes) rmSync(entry.path, { recursive: true, force: true });
  }
}

function viteBuild(args: readonly string[]): number {
  const result = spawnSync(process.execPath, ["--bun", "vite", "build", ...args], { stdio: "inherit" });
  return result.status ?? 1;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const cacheDir = process.env["OVIS_BUILD_CACHE_DIR"];
  if (!cacheDir) process.exit(viteBuild(args));
  const root = process.cwd();
  const dist = join(root, "dist");
  const maxBytes = Number(process.env["OVIS_BUILD_CACHE_MAX_MB"] ?? "2048") * 1024 * 1024;
  // only the build into dist/: another outDir or mode is built as asked
  const key: Key = args.length === 0 ? cacheKey(root, process.env, args) : { bypass: "build arguments given" };
  if ("bypass" in key) {
    console.log(`build cache: not used (${key.bypass})`);
    process.exit(viteBuild(args));
  }
  try {
    if (restore(cacheDir, key.key, dist)) {
      console.log(`build cache: hit ${key.key.slice(0, 12)}, dist/ restored without building`);
      process.exit(0);
    }
  } catch (error) {
    console.log(`build cache: could not restore ${key.key.slice(0, 12)} (${(error as Error).message}); building`);
  }
  console.log(`build cache: miss ${key.key.slice(0, 12)}; building`);
  const code = viteBuild(args);
  if (code !== 0) process.exit(code);
  try { store(cacheDir, key.key, dist, maxBytes); } catch (error) { console.log(`build cache: could not store (${(error as Error).message})`); }
  process.exit(0);
}
