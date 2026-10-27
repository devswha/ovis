import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * install.sh's Rust PTY host check and its Node fallback, as the script defines them: the functions are
 * cut out of install.sh itself and run under /bin/sh with stand-in hosts, curl and tar, so nothing is
 * downloaded or installed.
 */

const INSTALLER = readFileSync(join(import.meta.dir, "..", "install.sh"), "utf8");
/** one top-level shell function from install.sh, by name, as written there */
function fn(name: string): string {
  const match = new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}$`, "m").exec(INSTALLER);
  if (!match) throw new Error(`install.sh defines no ${name}()`);
  return match[0];
}
const FUNCTIONS = ["say", "sha256", "kill_tree", "bounded", "rust_host_runs", "install_node", "node_link"].map(fn).join("\n");

const dir = mkdtempSync(join(tmpdir(), "ovis-install-node-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
function script(name: string, body: string): string {
  const path = join(dir, `${crypto.randomUUID()}-${name}`);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** runs `call` after install.sh's functions under /bin/sh with `set -eu`, as the script runs */
function sh(call: string, env: Record<string, string> = {}): { code: number; out: string; ms: number } {
  const started = performance.now();
  const run = Bun.spawnSync(["/bin/sh", "-c", `set -eu\n${FUNCTIONS}\n${call}`], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe", timeout: 20_000 });
  return { code: run.exitCode ?? -1, out: run.stdout.toString() + run.stderr.toString(), ms: performance.now() - started };
}

const USAGE = `if [ "$#" -eq 0 ]; then echo "pty-sidecar: usage: fixture" >&2; exit 2; fi`;

describe("rust_host_runs", () => {
  it("passes a host that answers both legs of the check", () => {
    expect(sh(`rust_host_runs ${script("host", `${USAGE}\nexit 0`)} && echo RUNS`).out).toContain("RUNS");
  });

  it("gives up on a host that hangs on its pty leg, within its deadline", () => {
    const hung = sh(`if rust_host_runs ${script("hangs", `${USAGE}\nexec sleep 60`)}; then echo RUNS; else echo REFUSED; fi`);
    expect(hung.out).toContain("REFUSED");
    expect(hung.ms).toBeLessThan(10_000);
  });

  it("gives up on a host that hangs before it answers at all", () => {
    const hung = sh(`if rust_host_runs ${script("silent", "exec sleep 60")}; then echo RUNS; else echo REFUSED; fi`);
    expect(hung.out).toContain("REFUSED");
    expect(hung.ms).toBeLessThan(10_000);
  });

  it("kills what a hung host started, not only the host", () => {
    const tag = `ovis-probe-child-${crypto.randomUUID()}`;
    // no exec: the child's own command line (its path, with the tag) stays visible to pgrep while it lives
    const child = script(tag, "sleep 60");
    const forking = script("forks", `${USAGE}\n${child} & wait`);
    const hung = sh(`if rust_host_runs ${forking}; then echo RUNS; else echo REFUSED; fi`);
    expect(hung.out).toContain("REFUSED");
    // the watcher kills the tree before rust_host_runs returns
    expect(Bun.spawnSync(["pgrep", "-f", tag]).stdout.toString().trim()).toBe("");
  });

  it("refuses another program and a missing file", () => {
    expect(sh(`rust_host_runs ${script("other", "exit 0")} || echo REFUSED`).out).toContain("REFUSED");
    expect(sh(`rust_host_runs ${join(dir, "absent")} || echo REFUSED`).out).toContain("REFUSED");
  });
});

describe("install_node", () => {
  /** a PC for one install: stand-in curl and tar on PATH, and where Node would go */
  function pc(curl: string, tar: string): Record<string, string> {
    const root = mkdtempSync(join(dir, "pc-"));
    const bin = join(root, "tools");
    mkdirSync(bin);
    writeFileSync(join(bin, "curl"), `#!/bin/sh\n${curl}\n`, { mode: 0o755 });
    writeFileSync(join(bin, "tar"), `#!/bin/sh\n${tar}\n`, { mode: 0o755 });
    return { PATH: `${bin}:${process.env["PATH"]}`, NODE_DIR: join(root, "node"), BIN_DIR: join(root, "bin"), NODE_VERSION: "v22.23.2", platform: "linux-x64" };
  }
  /** curl that writes `body` to its -o file */
  const download = (body: string) => `while [ "$#" -gt 0 ]; do [ "$1" = -o ] && { printf '%s' '${body}' > "$2"; exit 0; }; shift; done; exit 1`;
  /** install_node as install.sh runs it, a subshell in a condition, where set -e does nothing */
  const attempt = (env: Record<string, string>) => sh(`if ( install_node ); then echo INSTALLED; else echo FAILED; fi`, env);

  it("fails when tar fails, and leaves no half-made Node behind", () => {
    // a platform install_node has no digest for keeps the node_sha given here: the download passes its check, tar fails
    const env = { ...pc(download("x"), "exit 42"), platform: "fixture", node_sha: new Bun.CryptoHasher("sha256").update("x").digest("hex") };
    const result = attempt(env);
    expect(result.out).toContain("FAILED");
    expect(existsSync(env["NODE_DIR"]!)).toBe(false);
  });

  it("keeps an existing install when the new unpack fails", () => {
    const env = { ...pc(download("x"), `mkdir -p "$4/bin" && : > "$4/bin/node"; exit 42`), platform: "fixture", node_sha: new Bun.CryptoHasher("sha256").update("x").digest("hex") };
    const nodeDir = env["NODE_DIR"]!;
    mkdirSync(join(nodeDir, "bin"), { recursive: true });
    writeFileSync(join(nodeDir, "bin", "node"), "old node");
    expect(attempt(env).out).toContain("FAILED");
    expect(readFileSync(join(nodeDir, "bin", "node"), "utf8")).toBe("old node");
  });

  it("installs when every step succeeds, and puts no node on the user's PATH (#596)", () => {
    const env = { ...pc(download("x"), `mkdir -p "$4/bin" && : > "$4/bin/node" && chmod +x "$4/bin/node"`), platform: "fixture", node_sha: new Bun.CryptoHasher("sha256").update("x").digest("hex") };
    expect(attempt(env).out).toContain("INSTALLED");
    expect(existsSync(join(env["NODE_DIR"]!, "bin", "node"))).toBe(true);
    expect(existsSync(env["BIN_DIR"]!)).toBe(false);
  });

  it("fails when the download fails", () => {
    expect(attempt(pc("exit 22", "exit 0")).out).toContain("FAILED");
  });

  it("fails when the download does not match its SHA-256", () => {
    const result = attempt(pc(download("not node"), "exit 0"));
    expect(result.out).toContain("FAILED");
    expect(result.out).toContain("does not match its published SHA-256");
  });
});

describe("node_link", () => {
  /** a PC whose ~/.local/bin/node is `bin`, and the running code: one that finds the app's Node itself (`finds`), or an older one */
  function pc(finds: boolean, bin?: (env: Record<string, string>) => void): Record<string, string> {
    const root = mkdtempSync(join(dir, "link-"));
    const env = { NODE_DIR: join(root, "share/ovis/node"), LEGACY_NODE_DIR: join(root, "share/herdr-web-ui/node"), BIN_DIR: join(root, "bin"), CODE: join(root, "code"), installed_here: "" };
    mkdirSync(join(env.CODE, "server/pty"), { recursive: true });
    // as the release's server/pty/sidecar.ts names the app's Node, or before it did
    writeFileSync(join(env.CODE, "server/pty/sidecar.ts"), finds ? 'const APP_NODE_DIRS = [".local/share/ovis/node"];' : 'Bun.which("node")');
    mkdirSync(join(env.NODE_DIR, "bin"), { recursive: true });
    writeFileSync(join(env.NODE_DIR, "bin/node"), "app node", { mode: 0o755 });
    mkdirSync(env.BIN_DIR);
    bin?.(env);
    return env;
  }
  const link = (env: Record<string, string>, args = "") => sh(`node_link "$CODE" ${args}\necho "[$installed_here]"`, env);
  const node = (env: Record<string, string>) => join(env["BIN_DIR"]!, "node");

  it("removes the link an older install.sh made, to its Node or to the one from before the rename", () => {
    for (const target of ["NODE_DIR", "LEGACY_NODE_DIR"]) {
      const env = pc(true, (e) => symlinkSync(join(e[target]!, "bin/node"), node(e)));
      expect(link(env).code).toBe(0);
      expect(lstatSync(node(env), { throwIfNoEntry: false })).toBeUndefined();
    }
  });

  it("takes this checkout's own server for one that finds the app's Node itself", () => {
    // the real server/pty/sidecar.ts, not a stand-in: a server that stops naming the app's Node must fail here
    const env = { ...pc(true, (e) => symlinkSync(join(e["NODE_DIR"]!, "bin/node"), node(e))), CODE: join(import.meta.dir, "..") };
    expect(link(env).code).toBe(0);
    expect(lstatSync(node(env), { throwIfNoEntry: false })).toBeUndefined();
  });

  it("keeps a node of the user's own there, a link elsewhere or a file", () => {
    const linked = pc(true, (e) => symlinkSync("/usr/bin/env", node(e)));
    expect(link(linked).code).toBe(0);
    expect(Bun.spawnSync(["readlink", node(linked)]).stdout.toString().trim()).toBe("/usr/bin/env");
    const file = pc(true, (e) => writeFileSync(node(e), "user node"));
    expect(link(file).code).toBe(0);
    expect(readFileSync(node(file), "utf8")).toBe("user node");
  });

  it("links no Node it just installed for a release that finds it itself", () => {
    const env = pc(true);
    expect(link(env, "installed").out).toContain("[]");
    expect(existsSync(node(env))).toBe(false);
  });

  it("links a Node it just installed for a release that finds Node on the PATH only, and only then", () => {
    const untouched = pc(false);
    expect(link(untouched).out).toContain("[]");
    expect(existsSync(node(untouched))).toBe(false);
    const installed = pc(false);
    expect(link(installed, "installed").out).toContain("[ node]");
    expect(readFileSync(node(installed), "utf8")).toBe("app node");
  });
});
