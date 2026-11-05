import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awaitBuild, cacheKey, deliver, evict, releaseLock, restore, store, takeLock } from "./build-cache.ts";

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
  writeFileSync(join(root, ".gitignore"), "dist/\nnode_modules/\n.env\n*.log\n");
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

  it("is used in GitHub Actions only by pull request runs and pushes to main", () => {
    const root = checkout();
    expect("key" in cacheKey(root, { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "pull_request" }, [])).toBe(true);
    expect("key" in cacheKey(root, { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main" }, [])).toBe(true);
    for (const [event, ref] of [["push", "refs/tags/v1.0.0"], ["push", "refs/heads/other"], ["workflow_dispatch", "refs/heads/main"], ["pull_request_target", ""], [undefined, ""]] as const) {
      expect(cacheKey(root, { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: event, GITHUB_REF: ref }, [])).toEqual({ bypass: "only pull request runs and pushes to main use it" });
    }
  });

  it("never uses the cache when a .env file refers to other variables", () => {
    const root = checkout();
    writeFileSync(join(root, ".env"), "VITE_A=$HOME\n");
    expect(cacheKey(root, {}, [])).toEqual({ bypass: ".env refers to other variables" });
  });

  it("never uses the cache while ignored files sit where the build reads them", () => {
    const root = checkout();
    mkdirSync(join(root, "public"));
    writeFileSync(join(root, "public/extra.log"), "copied into dist/ by Vite");
    expect(cacheKey(root, {}, [])).toEqual({ bypass: "ignored files where the build reads" });
    rmSync(join(root, "public/extra.log"));
    writeFileSync(join(root, "top.log"), "not read by the build");
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

  it("refuses an entry whose files do not match its manifest: missing, changed or added", () => {
    const root = temp("ovis-build-cache-short-");
    const cache = join(root, "cache");
    const damage: ((entry: string) => void)[] = [
      (entry) => rmSync(join(entry, "assets"), { recursive: true }),
      (entry) => writeFileSync(join(entry, "index.html"), "<p>planted"),
      (entry) => writeFileSync(join(entry, "extra.js"), "planted"),
    ];
    for (const change of damage) {
      rmSync(cache, { recursive: true, force: true });
      store(cache, "k", dist(root, { "index.html": "<p>", "assets/a.js": "a" }), 1 << 30);
      change(join(cache, "k"));
      dist(root, { "index.html": "mine" });
      expect(() => restore(cache, "k", join(root, "dist"))).toThrow("the entry's files do not match its manifest");
      expect(files(join(root, "dist"))).toEqual({ "index.html": "mine" });
    }
    expect(readdirSync(join(root, "node_modules/.cache"))).toEqual([]);
  });

  it("restores dist/ readable by others, as a fresh build leaves it", () => {
    const root = temp("ovis-build-cache-mode-");
    const cache = join(root, "cache");
    store(cache, "k", dist(root, { "index.html": "<p>" }), 1 << 30);
    rmSync(join(root, "dist"), { recursive: true });
    expect(restore(cache, "k", join(root, "dist"))).toBe(true);
    expect(statSync(join(root, "dist")).mode & 0o777).toBe(0o755);
  });

  it("refuses an entry holding a link, even one its manifest names", () => {
    const root = temp("ovis-build-cache-link-");
    const cache = join(root, "cache");
    writeFileSync(join(root, "secret"), "token");
    const sum = new Bun.CryptoHasher("sha256").update("token").digest("hex");
    mkdirSync(join(cache, "k"), { recursive: true });
    symlinkSync(join(root, "secret"), join(cache, "k", "leak"));
    writeFileSync(join(cache, "k", ".manifest"), `${sum}  ./leak\n`);
    expect(() => restore(cache, "k", join(root, "dist"))).toThrow("./leak is not a file or a directory");
    expect(existsSync(join(root, "dist"))).toBe(false);
  });

  it("hands a build to the outbox without touching the cache", () => {
    const root = temp("ovis-build-cache-outbox-");
    const outbox = join(root, "outbox");
    mkdirSync(outbox);
    deliver(outbox, "k", dist(root, { "index.html": "<p>", "assets/a.js": "a" }), "123", "2");
    expect(readdirSync(outbox).sort()).toEqual(["k.claim", "k.tar"]);
    expect(readFileSync(join(outbox, "k.claim"), "utf8")).toBe("123 2\n");
    const listed = spawnSync("tar", ["-tf", join(outbox, "k.tar")], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).sort();
    expect(listed).toEqual(["./", "./assets/", "./assets/a.js", "./index.html"]);
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

describe("one build per key", () => {
  it("lets one job take a key's build, and another once it is released or left stale", () => {
    const cache = temp("ovis-build-cache-lock-");
    expect(takeLock(cache, "k")).toBe(true);
    expect(takeLock(cache, "k")).toBe(false);
    expect(takeLock(cache, "other")).toBe(true);
    releaseLock(cache, "k");
    expect(takeLock(cache, "k")).toBe(true);
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(cache, ".lock-k"), old, old);
    expect(takeLock(cache, "k", 30_000)).toBe(true);
  });

  it("waits for the job building a key until its entry is stored", async () => {
    const root = temp("ovis-build-cache-wait-");
    const cache = join(root, "cache");
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist/index.html"), "built");
    mkdirSync(cache);
    takeLock(cache, "k");
    const waited = awaitBuild(cache, "k", 30_000).then(() => existsSync(join(cache, "k")));
    store(cache, "k", join(root, "dist"), 1 << 30);
    expect(await waited).toBe(true);
  });

  it("stops waiting once the building job gives up, or at its deadline", async () => {
    const cache = temp("ovis-build-cache-giveup-");
    takeLock(cache, "k");
    const waited = awaitBuild(cache, "k", 30_000);
    releaseLock(cache, "k");
    await waited;
    takeLock(cache, "k");
    const started = Date.now();
    await awaitBuild(cache, "k", 300);
    expect(Date.now() - started).toBeLessThan(10_000);
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
if (process.env.EDIT_DURING_BUILD) fs.writeFileSync("main.ts", process.env.EDIT_DURING_BUILD);
`);
    chmodSync(join(bin, "vite"), 0o755);
    return { root, runs: () => existsSync(join(root, "node_modules/runs")) ? readFileSync(join(root, "node_modules/runs"), "utf8").length : 0 };
  }
  const build = (root: string, cache: string | null, extra: Record<string, string> = {}): string => {
    const env: Record<string, string | undefined> = { ...process.env, ...extra };
    // the run's own GitHub Actions variables would turn the cache off outside a pull request run
    for (const name of ["OVIS_BUILD_CACHE_DIR", "GITHUB_ACTIONS", "GITHUB_EVENT_NAME"]) delete env[name];
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

  it("stores nothing when the checkout changed while it built", () => {
    const { root, runs } = project();
    const cache = join(temp("ovis-build-cache-dir-"), "cache");
    expect(build(root, cache, { EDIT_DURING_BUILD: "export const a = 9;\n" })).toBe("export const a = 1;\n");
    git(root, "checkout", "-q", "--", "main.ts");
    expect(existsSync(cache) ? readdirSync(cache) : []).toEqual([]);
    build(root, cache);
    expect(runs()).toBe(2);
  }, 60_000);

  it("builds a commit once when its jobs start together", async () => {
    const { root, runs } = project();
    const cache = join(temp("ovis-build-cache-dir-"), "cache");
    const env: Record<string, string | undefined> = { ...process.env, OVIS_BUILD_CACHE_DIR: cache };
    for (const name of ["GITHUB_ACTIONS", "GITHUB_EVENT_NAME"]) delete env[name];
    const jobs = [0, 1, 2, 3].map(() => {
      const copy = temp("ovis-build-cache-job-");
      git(copy, "clone", "-q", root, ".");
      spawnSync("cp", ["-a", join(root, "node_modules"), copy]);
      return { copy, proc: Bun.spawn([process.execPath, script], { cwd: copy, env, stdout: "pipe", stderr: "pipe" }) };
    });
    for (const { proc } of jobs) expect(await proc.exited).toBe(0);
    const built = jobs.map(({ copy }) => existsSync(join(copy, "node_modules/runs")) ? readFileSync(join(copy, "node_modules/runs"), "utf8").length : 0);
    expect(built.reduce((a, b) => a + b, 0)).toBe(1);
    for (const { copy } of jobs) expect(readFileSync(join(copy, "dist/index.html"), "utf8")).toBe("export const a = 1;\n");
    expect(readdirSync(cache).filter((name) => name.startsWith(".lock-"))).toEqual([]);
    expect(runs()).toBe(0);
  }, 60_000);

  it("on the runner, writes only its own outbox, never the cache", () => {
    const { root, runs } = project();
    const base = temp("ovis-build-cache-runner-");
    const [cache, outbox, locks] = ["cache", "outbox", "locks"].map((name) => join(base, name));
    for (const dir of [cache, outbox, locks]) mkdirSync(dir);
    // as the runner mounts it: read-only
    chmodSync(cache, 0o555);
    try {
      expect(build(root, cache, { OVIS_BUILD_CACHE_OUTBOX: outbox, OVIS_BUILD_CACHE_LOCKS: locks, OVIS_BUILD_CACHE_PROMOTE_SECONDS: "0", GITHUB_RUN_ID: "7", GITHUB_RUN_ATTEMPT: "1" })).toBe("export const a = 1;\n");
    } finally {
      chmodSync(cache, 0o755);
    }
    expect(runs()).toBe(1);
    expect(readdirSync(cache)).toEqual([]);
    expect(readdirSync(outbox).map((name) => name.replace(/^[0-9a-f]{64}/, "<key>")).sort()).toEqual(["<key>.claim", "<key>.tar"]);
    expect(readdirSync(locks)).toEqual([]);
  }, 60_000);

  it("stops waiting as soon as the launcher has judged its build, taken in or not", async () => {
    const { root } = project();
    const base = temp("ovis-build-cache-refused-");
    const [cache, outbox, locks] = ["cache", "outbox", "locks"].map((name) => join(base, name));
    for (const dir of [cache, outbox, locks]) mkdirSync(dir);
    const env: Record<string, string | undefined> = { ...process.env, OVIS_BUILD_CACHE_DIR: cache, OVIS_BUILD_CACHE_OUTBOX: outbox, OVIS_BUILD_CACHE_LOCKS: locks, OVIS_BUILD_CACHE_PROMOTE_SECONDS: "120", GITHUB_RUN_ID: "7", GITHUB_RUN_ATTEMPT: "1" };
    for (const name of ["GITHUB_ACTIONS", "GITHUB_EVENT_NAME"]) delete env[name];
    const job = Bun.spawn([process.execPath, script], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    const claimed = (): string | undefined => readdirSync(outbox).find((name) => name.endsWith(".claim"));
    const deadline = Date.now() + 30_000;
    while (!claimed() && Date.now() < deadline) await Bun.sleep(25);
    // the launcher refuses it: it deletes the claim and the build
    for (const name of readdirSync(outbox)) rmSync(join(outbox, name));
    const refusedAt = Date.now();
    expect(await job.exited).toBe(0);
    expect(Date.now() - refusedAt).toBeLessThan(10_000);
    expect(await new Response(job.stdout).text()).toContain("was not taken in");
    expect(readdirSync(locks)).toEqual([]);
  }, 60_000);

  it("always builds without OVIS_BUILD_CACHE_DIR", () => {
    const { root, runs } = project();
    build(root, null);
    build(root, null);
    expect(runs()).toBe(2);
  }, 60_000);
});
