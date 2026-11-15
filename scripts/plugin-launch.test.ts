import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { main } from "./plugin-launch.ts";
import type { installServer } from "./server-install.ts";
import { EXTRA_PLATFORMS, extraFile, generateKeyPair, MANIFEST, releaseFile, PTY_ASSETS, ptyFile, SERVER_PLATFORMS, signManifest, writeManifest } from "./server-manifest.ts";
import { EXTRA_BINARIES } from "./release-binaries.ts";

/**
 * scripts/plugin-launch.ts's choice between the release's binary and this checkout's sources (INSTALL.md, "Binary or
 * source"): sources only when this version's release has no ovis-server.json at all. The source path is a
 * stand-in that records its call (the real one would build the checkout and run scripts/plugin.ts), and every install
 * goes into a folder of the test's own.
 */
const version = (JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as { version: string }).version;
let scratch = "";
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "ovis-plugin-launch-"));
  saved = { OVIS_RELEASES_URL: process.env["OVIS_RELEASES_URL"], OVIS_FROM_SOURCE: process.env["OVIS_FROM_SOURCE"] };
  delete process.env["OVIS_FROM_SOURCE"];
});
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});

/** runs `args` with the source path recorded; what it returned, and each call the source path got */
const BUILT_FROM = { server: "a".repeat(40), shared: "b".repeat(40) };
async function launch(args: string[], fetchFile?: typeof fetch): Promise<{ code: number; sourced: string[][]; home: string }> {
  const home = join(scratch, "server");
  const sourced: string[][] = [];
  const code = await main(args, { home, fetchFile, source: async (command, rest) => { sourced.push([command, ...rest]); return 7; } });
  return { code, sourced, home };
}

describe("the herdr plugin's launcher", () => {
  it("builds from source, saying so, when this version's release folder has no ovis-server.json, and remembers it", async () => {
    process.env["OVIS_RELEASES_URL"] = pathToFileURL(join(scratch, "release")).href;
    mkdirSync(join(scratch, "release", `v${version}`), { recursive: true });
    const first = await launch(["status", "--json"]);
    expect(first).toMatchObject({ code: 7, sourced: [["status", "--json"]] });
    expect(readFileSync(join(first.home, "from-source"), "utf8")).toBe(`${version}\n`);
    // a later command asks no server: an address it could not even use changes nothing
    process.env["OVIS_RELEASES_URL"] = "http://nowhere.invalid";
    expect(await launch(["stop"])).toMatchObject({ code: 7, sourced: [["stop"]] });
    expect(existsSync(join(first.home, "bin"))).toBe(false);
  });

  it("builds from source when GitHub answers 404 for this version's ovis-server.json", async () => {
    delete process.env["OVIS_RELEASES_URL"];
    const asked: string[] = [];
    const notFound = (async (url: string | URL | Request) => { asked.push(String(url)); return new Response(null, { status: 404 }); }) as typeof fetch;
    expect(await launch(["install"], notFound)).toMatchObject({ code: 7, sourced: [["install"]] });
    expect(asked).toEqual([`https://github.com/devswha/ovis/releases/download/v${version}/ovis-server.json`]);
  });

  it("fails, and never builds from source, on a server error", async () => {
    delete process.env["OVIS_RELEASES_URL"];
    const broken = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch;
    const result = await launch(["start"], broken);
    expect(result).toMatchObject({ code: 1, sourced: [] });
    expect(existsSync(join(result.home, "from-source"))).toBe(false);
  });

  it("fails, and never builds from source, on a manifest that is there but not signed by the pinned key", async () => {
    const dir = join(scratch, "release", `v${version}`);
    mkdirSync(dir, { recursive: true });
    for (const platform of SERVER_PLATFORMS) writeFileSync(join(dir, releaseFile(platform)), `binary for ${platform}\n`);
    for (const build of PTY_ASSETS) writeFileSync(join(dir, ptyFile(build)), `pty host ${build}\n`);
    for (const binary of EXTRA_BINARIES) for (const platform of EXTRA_PLATFORMS) writeFileSync(join(dir, extraFile(binary, platform)), `${binary} ${platform}\n`);
    writeFileSync(join(dir, "ovis-dist.tar.gz"), "client\n");
    writeManifest(dir, { version, sources: BUILT_FROM, binaries: EXTRA_BINARIES });
    signManifest(dir, generateKeyPair().privateKeyPem);
    process.env["OVIS_RELEASES_URL"] = pathToFileURL(join(scratch, "release")).href;
    const result = await launch(["start"]);
    expect(result).toMatchObject({ code: 1, sourced: [] });
    expect(existsSync(join(result.home, "from-source"))).toBe(false);
    rmSync(join(dir, MANIFEST));
    expect((await launch(["start"])).sourced).toEqual([["start"]]);
  });

  it("asks the release again at the build step, so a release that gained its binary is taken", async () => {
    process.env["OVIS_RELEASES_URL"] = pathToFileURL(join(scratch, "release")).href;
    mkdirSync(join(scratch, "release", `v${version}`), { recursive: true });
    await launch(["status"]);
    process.env["OVIS_RELEASES_URL"] = "http://nowhere.invalid";
    // the build step drops what was remembered and asks again; this address is refused, so it fails
    expect(await launch(["install"])).toMatchObject({ code: 1, sourced: [] });
  });

  it("takes the source path at once with OVIS_FROM_SOURCE=1", async () => {
    process.env["OVIS_FROM_SOURCE"] = "1";
    process.env["OVIS_RELEASES_URL"] = "http://nowhere.invalid";
    expect(await launch(["phone-setup"])).toMatchObject({ code: 7, sourced: [["phone-setup"]] });
  });

  it("keeps the build step's source choice for every later command herdr runs without the variable", async () => {
    process.env["OVIS_FROM_SOURCE"] = "1";
    const install = await launch(["install"]);
    expect(install).toMatchObject({ code: 7, sourced: [["install"]] });
    delete process.env["OVIS_FROM_SOURCE"];
    // the release answers a server error: a start that asked it would fail, not run the sources the install built
    const broken = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch;
    expect(await launch(["start"], broken)).toMatchObject({ code: 7, sourced: [["start"]] });
  });

  it("ignores a source choice made for another version, and a build step without the variable drops it", async () => {
    const home = join(scratch, "server");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "from-source"), "0.0.1\n");
    const broken = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch;
    expect(await launch(["start"], broken)).toMatchObject({ code: 1, sourced: [] });
    writeFileSync(join(home, "from-source"), `${version}\n`);
    expect(await launch(["install"], broken)).toMatchObject({ code: 1, sourced: [] });
    expect(existsSync(join(home, "from-source"))).toBe(false);
  });

});

/**
 * An installed release's binary as a stand-in: a script that records how it was run (in `ran`) and writes a pairing QR
 * code and its link to whatever output it has.
 */
function release(): { binary: string; ran: string } {
  const binary = join(scratch, "ovis-server");
  const ran = `${binary}.ran`;
  writeFileSync(binary, `#!/bin/sh\necho "$@" > ${JSON.stringify(ran)}\nprintf '█▀▀▀█ https://app.ovis.sh/s/x/#offer=abc\\n'\n`);
  chmodSync(binary, 0o755);
  return { binary, ran };
}

describe("the pairing commands and an installed release", () => {
  it.skipIf(process.platform === "win32")("run add, link, login, pair and phone-setup from this checkout's code with a release installed, and every other command by the release's binary", async () => {
    const installed = release();
    // the release's install, which a pairing command never even asks for
    let asked = 0;
    const server = (async () => { asked++; return { installed: false, message: "", binary: installed.binary }; }) as unknown as typeof installServer;
    for (const command of ["add", "link", "login", "pair", "phone-setup"]) {
      const handed: string[][] = [];
      const code = await main([command, "--print"], { home: join(scratch, "server"), server, checkout: async (name, rest) => { handed.push([name, ...rest]); return 5; } });
      expect([command, code, handed, asked]).toEqual([command, 5, [[command, "--print"]], 0]);
      expect(existsSync(installed.ran)).toBe(false);
    }
    // status pairs nothing: the release's binary runs it, as before
    expect(await main(["status"], { home: join(scratch, "server"), server, checkout: async () => 5 })).toBe(0);
    expect([asked, readFileSync(installed.ran, "utf8")]).toEqual([1, "plugin status\n"]);
  });

  it.skipIf(process.platform === "win32")("writes no pairing QR code into a pipe with a release installed whose command line would: this checkout's add refuses instead", async () => {
    const old = release();
    // the PC's server, on a port of this test's own: in no account, so add would show a code
    const calls: string[] = [];
    const pc = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      const path = new URL(request.url).pathname;
      calls.push(`${request.method} ${path}`);
      if (path === "/api/health") return Response.json({ ok: true, herdr: { version: "0.9.3", protocol: 1 }, auth: { required: false, authenticated: true } });
      if (path === "/api/account/status") return Response.json({ account: null, unlinked: [], removals: [], adds: [], blocked: [] });
      return new Response(null, { status: 404 });
    } });
    try {
      const config = join(scratch, "config");
      mkdirSync(config);
      writeFileSync(join(config, ".env"), `PORT=${pc.port}\n`);
      const driver = join(scratch, "driver.ts");
      writeFileSync(driver, `const { main } = await import(${JSON.stringify(join(import.meta.dir, "plugin-launch.ts"))});
process.exit(await main(["add"], { home: ${JSON.stringify(join(scratch, "server"))}, server: async () => ({ installed: false, message: "", binary: ${JSON.stringify(old.binary)} }) }));\n`);
      const child = Bun.spawn([process.execPath, driver], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: {
        ...process.env, HOME: scratch, HOST: "127.0.0.1", PORT: undefined, OVIS_TOKEN: "", HERDR_PLUGIN_CONFIG_DIR: config,
        HERDR_PLUGIN_STATE_DIR: join(scratch, "plugin-state"), OVIS_STATE_DIR: join(scratch, "app-state"), XDG_CONFIG_HOME: undefined, XDG_STATE_HOME: undefined,
      } });
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect([out, code], err).toEqual(["Adding this PC needs a terminal: the QR code and the code to type are a key to this PC, so they are never written to a pipe, a file or a log. Run ovis add in a terminal (over ssh, run ssh -t).\n", 1]);
      expect(out + err).not.toContain("#offer=");
      expect(out + err).not.toContain("█");
      expect(existsSync(old.ran)).toBe(false);
      // it asked this PC's server what it reads, and wrote nothing to it
      expect(calls.filter((call) => !call.startsWith("GET "))).toEqual([]);
    } finally { await pc.stop(true); }
  });
});

describe("the launcher's child", () => {
  // POSIX signals: on Windows herdr runs scripts/plugin.ps1, and no SIGTERM or SIGHUP reaches a launcher there
  it.skipIf(process.platform === "win32")("gets the SIGTERM sent to the launcher, and the launcher exits as the child did", async () => {
    const ready = join(scratch, "ready");
    const got = join(scratch, "got");
    const script = `const { run } = await import(${JSON.stringify(join(import.meta.dir, "plugin-launch.ts"))});
process.exit(await run(["sh", "-c", 'trap "echo got > ${got}; exit 3" TERM; : > ${ready}; while :; do sleep 0.05; done']));`;
    const launcher = Bun.spawn([process.execPath, "-e", script], { stdout: "ignore", stderr: "pipe" });
    const deadline = Date.now() + 10_000;
    while (!existsSync(ready)) { if (Date.now() > deadline) throw new Error("the child never started"); await Bun.sleep(20); }
    launcher.kill("SIGTERM");
    expect(await launcher.exited).toBe(3);
    expect(readFileSync(got, "utf8")).toBe("got\n");
  });
});
