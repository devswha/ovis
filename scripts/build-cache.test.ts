import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheKey, evict, restore, store } from "./build-cache.ts";

const made: string[] = [];
afterEach(() => { for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true }); });
const temp = (prefix: string): string => { const dir = mkdtempSync(join(tmpdir(), prefix)); made.push(dir); return dir; };

const identity = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
const git = (root: string, ...args: string[]): void => {
  const result = spawnSync("git", args, { cwd: root, env: { ...process.env, ...identity }, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
};

/** A committed checkout of its own, with dist/ and node_modules/ ignored as in the repository. */
function checkout(): string {
  const root = temp("ovis-build-cache-repo-");
  git(root, "init", "-q");
  writeFileSync(join(root, ".gitignore"), "dist/\nnode_modules/\n.env\n");
  writeFileSync(join(root, "main.ts"), "export const a = 1;\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "one");
  return root;
}

const keyOf = (root: string, env: Record<string, string | undefined> = {}, args: string[] = []): string => {
  const result = cacheKey(root, env, args);
  if (!("key" in result)) throw new Error(`expected a key, got bypass: ${result.bypass}`);
  return result.key;
};

describe("cacheKey", () => {
  it("names the same inputs the same way, whatever variables the build does not read", () => {
    const root = checkout();
    expect(keyOf(root, { PATH: "/a", HOME: "/x" })).toBe(keyOf(root, { PATH: "/b" }));
  });

  it("misses after any change to a build input", () => {
    const root = checkout();
    const base = keyOf(root);
    const keys = new Set([base]);
    const changed = (key: string): void => { expect(keys.has(key)).toBe(false); keys.add(key); };
    changed(keyOf(root, { VITE_FLAG: "1" }));
    changed(keyOf(root, { HERDR_TEST_HOOKS: "1" }));
    changed(keyOf(root, { NODE_ENV: "development" }));
    changed(keyOf(root, {}, ["--mode", "shell"]));
    writeFileSync(join(root, ".env"), "VITE_A=1\n");
    changed(keyOf(root));
    writeFileSync(join(root, ".env"), "VITE_A=2\n");
    changed(keyOf(root));
    rmSync(join(root, ".env"));
    expect(keyOf(root)).toBe(base);
    // a commit that changes a source file, and one that changes the lockfile
    writeFileSync(join(root, "main.ts"), "export const a = 2;\n");
    git(root, "commit", "-q", "-am", "two");
    changed(keyOf(root));
    writeFileSync(join(root, "bun.lock"), "{}\n");
    git(root, "add", "bun.lock");
    git(root, "commit", "-q", "-m", "lock");
    changed(keyOf(root));
    // same tree, new commit: the client embeds the commit's hash, so it is another build
    git(root, "commit", "-q", "--allow-empty", "-m", "empty");
    changed(keyOf(root));
  });

  it("never uses the cache for a checkout git has uncommitted changes in", () => {
    const root = checkout();
    writeFileSync(join(root, "main.ts"), "export const a = 3;\n");
    expect(cacheKey(root, {}, [])).toEqual({ bypass: "the checkout has uncommitted changes" });
    git(root, "checkout", "-q", "--", "main.ts");
    writeFileSync(join(root, "new.ts"), "export {};\n");
    expect(cacheKey(root, {}, [])).toEqual({ bypass: "the checkout has uncommitted changes" });
    rmSync(join(root, "new.ts"));
    git(root, "add", "-A");
    expect("key" in cacheKey(root, {}, [])).toBe(true);
  });

  it("does not use the cache outside a git checkout", () => {
    expect(cacheKey(temp("ovis-build-cache-nogit-"), {}, [])).toEqual({ bypass: "no git commit" });
  });
});

describe("store and restore", () => {
  const dist = (root: string, files: Record<string, string>): string => {
    const dir = join(root, "dist");
    rmSync(dir, { recursive: true, force: true });
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(join(dir, name, ".."), { recursive: true });
      writeFileSync(join(dir, name), content);
    }
    return dir;
  };
  const files = (dir: string): Record<string, string> => Object.fromEntries(
    (readdirSync(dir, { recursive: true }) as string[]).sort()
      .filter((name) => !name.endsWith("assets"))
      .map((name) => [name, readFileSync(join(dir, name), "utf8")]),
  );

  it("restores exactly the stored files, replacing whatever dist/ held", () => {
    const root = temp("ovis-build-cache-dist-");
    const cache = join(root, "cache");
    store(cache, "k", dist(root, { "index.html": "<p>", "assets/a.js": "a" }), 1 << 30);
    dist(root, { "stale.js": "old" });
    expect(restore(cache, "k", join(root, "dist"))).toBe(true);
    expect(files(join(root, "dist"))).toEqual({ "assets/a.js": "a", "index.html": "<p>" });
  });

  it("misses an entry that is absent or was never finished", () => {
    const root = temp("ovis-build-cache-miss-");
    const cache = join(root, "cache");
    mkdirSync(join(cache, "half"), { recursive: true });
    writeFileSync(join(cache, "half", "index.html"), "partial");
    dist(root, { "index.html": "mine" });
    expect(restore(cache, "absent", join(root, "dist"))).toBe(false);
    expect(restore(cache, "half", join(root, "dist"))).toBe(false);
    expect(files(join(root, "dist"))).toEqual({ "index.html": "mine" });
  });

  it("keeps the first entry written for a key", () => {
    const root = temp("ovis-build-cache-first-");
    const cache = join(root, "cache");
    store(cache, "k", dist(root, { "index.html": "first" }), 1 << 30);
    store(cache, "k", dist(root, { "index.html": "second" }), 1 << 30);
    restore(cache, "k", join(root, "dist"));
    expect(files(join(root, "dist"))).toEqual({ "index.html": "first" });
    expect(readdirSync(cache).sort()).toEqual(["k"]);
  });

  it("evicts the least recently used entries past the size limit", () => {
    const root = temp("ovis-build-cache-lru-");
    const cache = join(root, "cache");
    for (const key of ["old", "mid", "new"]) store(cache, key, dist(root, { "a.js": "x".repeat(1000) }), 1 << 30);
    const at = (key: string, seconds: number): void => { const t = new Date(seconds * 1000); utimesSync(join(cache, key), t, t); };
    at("old", 1_000); at("mid", 2_000); at("new", 3_000);
    // a restore counts as a use: "old" becomes the newest
    restore(cache, "old", join(root, "dist"));
    evict(cache, 2_500);
    expect(readdirSync(cache).sort()).toEqual(["new", "old"]);
  });
});

describe("bun scripts/build-cache.ts", () => {
  const script = join(import.meta.dir, "build-cache.ts");

  /** A checkout whose `vite` writes dist/ from main.ts and counts its runs. */
  function project(): { root: string; runs: () => number } {
    const root = checkout();
    const bin = join(root, "node_modules/.bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "vite"), `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync("node_modules/runs", "x");
fs.rmSync("dist", { recursive: true, force: true });
fs.mkdirSync("dist");
fs.writeFileSync("dist/index.html", fs.readFileSync("main.ts", "utf8") + (process.env.VITE_FLAG ?? ""));
`);
    chmodSync(join(bin, "vite"), 0o755);
    return { root, runs: () => existsSync(join(root, "node_modules/runs")) ? readFileSync(join(root, "node_modules/runs"), "utf8").length : 0 };
  }
  const build = (root: string, cache: string | null, extra: Record<string, string> = {}): string => {
    const env: Record<string, string | undefined> = { ...process.env, ...extra };
    delete env["OVIS_BUILD_CACHE_DIR"];
    if (cache) env["OVIS_BUILD_CACHE_DIR"] = cache;
    const result = spawnSync(process.execPath, [script], { cwd: root, env, encoding: "utf8" });
    expect(result.status).toBe(0);
    return readFileSync(join(root, "dist/index.html"), "utf8");
  };

  it("builds once per set of inputs and restores the same dist/ for the rest", () => {
    const { root, runs } = project();
    const cache = join(temp("ovis-build-cache-dir-"), "cache");
    expect(build(root, cache)).toBe("export const a = 1;\n");
    expect(runs()).toBe(1);
    rmSync(join(root, "dist"), { recursive: true });
    expect(build(root, cache)).toBe("export const a = 1;\n");
    expect(runs()).toBe(1);
    expect(build(root, cache, { VITE_FLAG: "!" })).toBe("export const a = 1;\n!");
    expect(runs()).toBe(2);
    writeFileSync(join(root, "main.ts"), "export const a = 2;\n");
    expect(build(root, cache)).toBe("export const a = 2;\n");
    expect(runs()).toBe(3);
    git(root, "commit", "-q", "-am", "two");
    expect(build(root, cache)).toBe("export const a = 2;\n");
    expect(runs()).toBe(4);
    expect(build(root, cache)).toBe("export const a = 2;\n");
    expect(runs()).toBe(4);
  }, 60_000);

  it("always builds without OVIS_BUILD_CACHE_DIR", () => {
    const { root, runs } = project();
    build(root, null);
    build(root, null);
    expect(runs()).toBe(2);
  }, 60_000);
});
