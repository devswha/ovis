import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { version as packageVersion } from "../../package.json";
import { KitError, kitCommand, kitLine, makeKit } from "./kit.ts";

const origins = { url: "https://kit.join.test:7443/kit", relay: "wss://relay.join.test:8443", account: "https://account.join.test:9443", app: "https://app.join.test:7441" };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** two programs that answer as the server and the terminal host do when run with no argument */
function programs(): { server: string; pty: string; at: string } {
  const at = mkdtempSync(join(process.env["TMPDIR"] ?? tmpdir(), "join-kit-"));
  dirs.push(at);
  const server = join(at, "ovis-server");
  const pty = join(at, "ovis-pty-sidecar");
  // the version string a server built from this checkout carries
  writeFileSync(server, `#!/bin/sh\n# version ${JSON.stringify(packageVersion)}\necho 'usage: ovis-server <serve|plugin>' >&2\nexit 2\n`);
  writeFileSync(pty, "#!/bin/sh\necho 'pty-sidecar: usage: ovis-pty-sidecar <cols> <rows> <command>' >&2\nexit 2\n");
  chmodSync(server, 0o755);
  chmodSync(pty, 0o755);
  return { server, pty, at };
}

describe.skipIf(process.platform !== "linux" || process.arch !== "x64")("kit line", () => {
  test("the line printed again from an existing kit folder is the line its making printed", () => {
    const { server, pty, at } = programs();
    const made = makeKit({ server, pty, out: join(at, "kit"), ...origins });
    expect(kitLine(join(at, "kit"), origins).line).toBe(made.line);
    // the trial kit's join.sh refuses to join without --trial: the line hands it over
    expect(made.line).toContain(' --trial "$@"');
  });

  test("join.sh parses as POSIX sh (sh -n), as every kit carries it", () => {
    const parsed = Bun.spawnSync(["sh", "-n", resolve(import.meta.dir, "join.sh")], { stderr: "pipe" });
    expect(parsed.stderr.toString()).toBe("");
    expect(parsed.exitCode).toBe(0);
  });

  test("only a kit made with --test-kit carries TEST-KIT, listed in its SHA256SUMS", () => {
    const { server, pty, at } = programs();
    const owner = makeKit({ server, pty, out: join(at, "owner"), ...origins });
    const tested = makeKit({ server, pty, out: join(at, "tested"), ...origins, testKit: true });
    expect(readdirSync(owner.dir)).not.toContain("TEST-KIT");
    expect(readFileSync(join(owner.dir, "SHA256SUMS"), "utf8")).not.toContain("TEST-KIT");
    expect(readFileSync(join(tested.dir, "SHA256SUMS"), "utf8")).toMatch(/^[0-9a-f]{64}  TEST-KIT$/m);
    expect(kitLine(tested.dir, origins).line).toBe(tested.line);
    expect(tested.sums).not.toBe(owner.sums);
  });

  test("the command: make prints the line on stdout, line prints the same line again; a bad flag is exit 2, stdout empty", () => {
    const { server, pty, at } = programs();
    const flags = ["--url", origins.url, "--relay", origins.relay, "--account", origins.account, "--app", origins.app];
    const run = (argv: string[]) => {
      let stdout = "";
      let stderr = "";
      const code = kitCommand(argv, (text) => { stdout += text; }, (text) => { stderr += text; });
      return { code, stdout, stderr };
    };
    const made = run(["make", "--server", server, "--pty", pty, "--out", join(at, "cmd"), ...flags]);
    expect(made.code).toBe(0);
    expect(made.stdout).toBe(`${kitLine(join(at, "cmd"), origins).line}\n`);
    expect(run(["line", "--kit", join(at, "cmd"), ...flags]).stdout).toBe(made.stdout);
    for (const argv of [["make", "--server", server, "--pty", pty, "--out", join(at, "cmd2"), ...flags, "--bogus"], ["line", ...flags], ["unknown"]]) {
      const refused = run(argv);
      expect(refused.code).toBe(2);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toStartWith("kit: ");
    }
  });

  test("make refuses an --out whose parent does not exist, and a server built from another version, as kit errors", () => {
    const { server, pty, at } = programs();
    expect(() => makeKit({ server, pty, out: join(at, "no", "such", "kit"), ...origins })).toThrow(KitError);
    const other = join(at, "other-server");
    writeFileSync(other, "#!/bin/sh\n# version \"0.0.0-other\"\necho 'usage: ovis-server <serve|plugin>' >&2\nexit 2\n");
    chmodSync(other, 0o755);
    expect(() => makeKit({ server: other, pty, out: join(at, "kit-other"), ...origins })).toThrow(/was not built from this checkout's version/);
    expect(readdirSync(at)).not.toContain("kit-other");
  });

  test("make refuses a folder that already holds something, and leaves what is there as it was", () => {
    const { server, pty, at } = programs();
    const out = join(at, "full");
    mkdirSync(out);
    writeFileSync(join(out, "keep.txt"), "his file\n");
    expect(() => makeKit({ server, pty, out, ...origins })).toThrow(KitError);
    expect(readdirSync(out)).toEqual(["keep.txt"]);
    expect(readFileSync(join(out, "keep.txt"), "utf8")).toBe("his file\n");
  });

  test("make refuses this checkout and any folder inside it, and writes nothing there", () => {
    const { server, pty } = programs();
    const repo = resolve(import.meta.dir, "..", "..");
    const before = readdirSync(repo).sort();
    expect(() => makeKit({ server, pty, out: repo, ...origins })).toThrow(KitError);
    expect(readdirSync(repo).sort()).toEqual(before);
    // an empty folder inside the checkout: only the checkout's own guard can refuse it
    const inside = mkdtempSync(join(repo, ".kit-test-"));
    dirs.push(inside);
    expect(() => makeKit({ server, pty, out: inside, ...origins })).toThrow(KitError);
    expect(readdirSync(inside)).toEqual([]);
  });

  test("a kit folder whose file differs from SHA256SUMS, or that holds another file, gets no line", () => {
    const { server, pty, at } = programs();
    makeKit({ server, pty, out: join(at, "kit"), ...origins });
    writeFileSync(join(at, "kit", "extra"), "x");
    expect(() => kitLine(join(at, "kit"), origins)).toThrow(KitError);
    rmSync(join(at, "kit", "extra"));
    appendFileSync(join(at, "kit", "bin", "ovis-server"), "x");
    expect(() => kitLine(join(at, "kit"), origins)).toThrow(KitError);
  });
});
