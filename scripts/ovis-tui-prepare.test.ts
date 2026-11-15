import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PREPARE = join(import.meta.dir, "..", "crates", "ovis-tui", "prepare.sh");

let scratch = "";

/** git with a fixed identity, local submodules allowed, and none of the user's config */
function git(cwd: string, ...args: string[]): string {
  const run = Bun.spawnSync(["git", "-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "protocol.file.allow=always", "-C", cwd, ...args], {
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: scratch, GIT_CONFIG_NOSYSTEM: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
  return run.stdout.toString().trim();
}

/**
 * A crate folder holding prepare.sh, an hc-tui.pin that pins a local stand-in for hc-tui (with a
 * stand-in Ghostty submodule at vendor/ghostty), and `patches` patch files made against it.
 */
function crate(patches = 0): { dir: string; upstream: string } {
  const ghostty = join(scratch, "ghostty");
  mkdirSync(ghostty);
  git(ghostty, "init", "--quiet");
  writeFileSync(join(ghostty, "build.zig"), "// stand-in\n");
  writeFileSync(join(ghostty, ".gitignore"), "/zig-pkg/\n");
  git(ghostty, "add", "-A");
  git(ghostty, "commit", "--quiet", "-m", "ghostty");
  const hc = join(scratch, "hc-tui");
  mkdirSync(hc);
  git(hc, "init", "--quiet");
  writeFileSync(join(hc, "README.md"), "hc-tui\n");
  git(hc, "add", "-A");
  git(hc, "submodule", "--quiet", "add", ghostty, "vendor/ghostty");
  git(hc, "commit", "--quiet", "-m", "hc-tui");
  const dir = join(scratch, "crate");
  mkdirSync(join(dir, "patches"), { recursive: true });
  copyFileSync(PREPARE, join(dir, "prepare.sh"));
  writeFileSync(join(dir, "hc-tui.pin"), `HC_TUI_REPO=${hc}\nHC_TUI_TAG=v0\nHC_TUI_COMMIT=${git(hc, "rev-parse", "HEAD")}\nGHOSTTY_COMMIT=${git(ghostty, "rev-parse", "HEAD")}\n`);
  for (let n = 1; n <= patches; n += 1) addPatch(dir, n);
  return { dir, upstream: join(dir, "upstream") };
}

/** patch number `n`: a new file patch-n.txt, made against the pin */
function addPatch(dir: string, n: number): void {
  const work = join(scratch, `patch-${n}`);
  git(scratch, "clone", "--quiet", join(scratch, "hc-tui"), work);
  writeFileSync(join(work, `patch-${n}.txt`), `patch ${n}\n`);
  git(work, "add", "-A");
  git(work, "commit", "--quiet", "-m", `patch ${n}`);
  writeFileSync(join(dir, "patches", `000${n}-patch.patch`), git(work, "format-patch", "-1", "--stdout") + "\n");
}

function prepare(dir: string, extra: Record<string, string> = {}): { code: number; out: string } {
  const run = Bun.spawnSync(["sh", join(dir, "prepare.sh")], {
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: scratch, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "protocol.file.allow", GIT_CONFIG_VALUE_0: "always", ...extra },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: run.exitCode ?? -1, out: run.stdout.toString() + run.stderr.toString() };
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "ovis-tui-prepare-"));
});

afterEach(() => rmSync(scratch, { recursive: true, force: true }));

describe("crates/ovis-tui/prepare.sh", () => {
  it("makes upstream/ where no file of the crate has that name in another case (macOS folders ignore case)", () => {
    const crateDir = join(import.meta.dir, "..", "crates", "ovis-tui");
    const tracked = Bun.spawnSync(["git", "ls-files", "--", "."], { cwd: crateDir, stdout: "pipe" }).stdout.toString().split("\n");
    expect(tracked.map((path) => path.split("/")[0]!).filter((name) => name.toLowerCase() === "upstream")).toEqual([]);
  });

  it("makes the pin with its patches, and leaves a tree that already is that alone", () => {
    const { dir, upstream } = crate(1);
    expect(prepare(dir).code).toBe(0);
    expect(readFileSync(join(upstream, "patch-1.txt"), "utf8")).toBe("patch 1\n");
    const made = git(upstream, "rev-parse", "HEAD");
    expect(prepare(dir).code).toBe(0);
    expect(git(upstream, "rev-parse", "HEAD")).toBe(made);
  });

  describe("never deletes work when the patches change", () => {
    const cases: [string, (upstream: string) => void, string][] = [
      ["a branch", (upstream) => git(upstream, "branch", "mywork"), "refs/heads/mywork"],
      ["a stash", (upstream) => {
        writeFileSync(join(upstream, "README.md"), "edited\n");
        git(upstream, "stash", "--quiet");
      }, "refs/stash"],
      ["an uncommitted change", (upstream) => writeFileSync(join(upstream, "README.md"), "edited\n"), "README.md"],
      ["an untracked file in the Ghostty submodule", (upstream) => writeFileSync(join(upstream, "vendor", "ghostty", "mine.zig"), "// mine\n"), "vendor/ghostty/mine.zig"],
    ];
    for (const [name, make, kept] of cases) {
      it(`keeps ${name}`, () => {
        const { dir, upstream } = crate(1);
        expect(prepare(dir).code).toBe(0);
        make(upstream);
        addPatch(dir, 2);
        const ran = prepare(dir);
        expect(ran.code, ran.out).toBe(1);
        expect(ran.out).toContain("has work of its own");
        if (kept.startsWith("refs/")) expect(git(upstream, "for-each-ref", "--format=%(refname)")).toContain(kept);
        else expect(existsSync(join(upstream, kept))).toBe(true);
      });
    }
  });

  it("does not count the Ghostty build's own ignored files as work", () => {
    const { dir, upstream } = crate(1);
    expect(prepare(dir).code).toBe(0);
    mkdirSync(join(upstream, "vendor", "ghostty", "zig-pkg"));
    writeFileSync(join(upstream, "vendor", "ghostty", "zig-pkg", "cache"), "x");
    addPatch(dir, 2);
    expect(prepare(dir).code).toBe(0);
    expect(existsSync(join(upstream, "patch-2.txt"))).toBe(true);
  });

  it("leaves the old tree as it was when the fetch fails, and no half-made tree beside it", () => {
    const { dir, upstream } = crate(1);
    expect(prepare(dir).code).toBe(0);
    const made = git(upstream, "rev-parse", "HEAD");
    addPatch(dir, 2);
    const ran = prepare(dir, { HC_TUI_REPO_OVERRIDE: join(scratch, "nowhere") });
    expect(ran.code).not.toBe(0);
    expect(git(upstream, "rev-parse", "HEAD")).toBe(made);
    expect(existsSync(join(upstream, "patch-1.txt"))).toBe(true);
    expect(readdirSync(dir).filter((name) => name.startsWith(".upstream.new"))).toEqual([]);
  });
});
