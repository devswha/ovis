import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { reloadReason } from "../src/lib/updateNotes.ts";
import { releaseSupervisor } from "./managed.ts";
import { latestRelease, newerVersion, offeredRelease, releaseNames, stagedRelease } from "./update-artifact.ts";
import { updateStateDir } from "./update-state.ts";
import { COMPILED_RELEASE_REASON, runCommand, Updater } from "./updater.ts";
import { releaseSupervisor as shimOf } from "./update-artifact.ts";
import { hostPlatform } from "../scripts/server-install.ts";
import { DIST_ARCHIVE, generateKeyPair, MANIFEST, PTY_ASSETS, ptyFile, releaseFile, SERVER_PLATFORMS, type ServerPlatform, signManifest, writeManifest } from "../scripts/server-manifest.ts";

/**
 * The crossing from a source checkout to the release's compiled server: a release folder of `ovis-<version>/` names,
 * signed with a key made for the test (the updater takes it only as the option a test passes; the supervisor passes the
 * committed key), reached as a file:// address; a git checkout at version N; its update state in a folder of the test.
 */
const PLATFORM = hostPlatform() as ServerPlatform;
/** a port nothing listens on: the system's pick for a listener, given back */
const freePort = (): number => {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const { port } = listener;
  listener.stop(true);
  return port;
};
const REPO = resolve(import.meta.dir, "..");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-update-artifact-"));
  dirs.push(dir);
  return dir;
};
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const git = (cwd: string, ...args: string[]) => runCommand(cwd, ["git", "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args]);

/** `<base>/ovis-<version>/`: the host's binary `binary`, stand-ins for the others, the client, the manifest and its signature */
function publish(base: string, version: string, privateKeyPem: string, binary = `#!/bin/sh\necho ovis-server ${version}\n`, build?: string): string {
  const dir = join(base, `ovis-${version}`);
  mkdirSync(dir, { recursive: true });
  for (const platform of SERVER_PLATFORMS) writeFileSync(join(dir, releaseFile(platform)), platform === PLATFORM ? binary : `other ${platform}\n`);
  for (const build of PTY_ASSETS) writeFileSync(join(dir, ptyFile(build)), `pty host ${build}\n`);
  const client = join(base, `.client-${version}`);
  mkdirSync(client, { recursive: true });
  writeFileSync(join(client, "index.html"), `<!doctype html><title>${version}</title>`);
  // the commit the client was built from, as vite writes it (vite.config.ts)
  if (build !== undefined) writeFileSync(join(client, "build.json"), `${JSON.stringify({ revision: build, dirty: false })}\n`);
  expect(Bun.spawnSync(["tar", "-czf", join(dir, DIST_ARCHIVE), "-C", client, "."]).exitCode).toBe(0);
  rmSync(client, { recursive: true });
  writeManifest(dir, { version, sources: { server: "a".repeat(40), shared: "b".repeat(40) } });
  signManifest(dir, privateKeyPem);
  return dir;
}

/** every file under `dir` with its SHA-256 (links by their target): what must not change */
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    if (entry.isFile()) files[path.slice(dir.length)] = sha256(readFileSync(path));
    else if (entry.isSymbolicLink()) files[path.slice(dir.length)] = `-> ${readlinkSync(path)}`;
  }
  return files;
}

/** A source checkout at version `version`, its app state (paired devices, server id) and its update state */
async function checkout(version = "1.0.0") {
  const dir = scratch();
  const root = join(dir, "checkout");
  mkdirSync(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version }));
  await git(root, "init", "-q", "-b", "main");
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "N");
  const appState = join(dir, "state");
  mkdirSync(appState);
  writeFileSync(join(appState, "devices.json"), '{"devices":[{"id":"phone"}]}\n');
  writeFileSync(join(appState, "server-id"), "server-1234\n");
  const stateDir = updateStateDir(root, 4242, appState);
  const releases = join(dir, "release");
  mkdirSync(releases);
  const key = generateKeyPair();
  return { dir, root, appState, stateDir, releases, key, revision: await git(root, "rev-parse", "HEAD") };
}

function updater(fixture: Awaited<ReturnType<typeof checkout>>, extra: Partial<ConstructorParameters<typeof Updater>[0]> = {}) {
  return new Updater({ root: fixture.root, stateDir: fixture.stateDir, autoUpdate: false, publish() {},
    activate: async (_next, commit) => commit(),
    releases: { base: pathToFileURL(fixture.releases).href, publicKey: fixture.key.publicKey, platform: PLATFORM, ptyRuns: () => false }, ...extra });
}

describe("which release of the compiled server is on offer", () => {
  it("orders ovis-<version> names by version, a release after its betas, and keeps betas off stable", () => {
    const names = ["v9.9.9", "ovis-1.2.0", "ovis-1.10.0-beta.2", "ovis-1.10.0-beta.10", "ovis-1.9.0", "remote-v47", "ovis-1.10.0-rc.1"];
    expect(latestRelease(names, "stable")).toEqual({ tag: "ovis-1.9.0", version: "1.9.0" });
    expect(latestRelease(names, "beta")).toEqual({ tag: "ovis-1.10.0-beta.10", version: "1.10.0-beta.10" });
    expect(latestRelease([...names, "ovis-1.10.0"], "beta")?.tag).toBe("ovis-1.10.0");
    expect(latestRelease(["v1.0.0", "beta/v1.0.0-beta.1"], "beta")).toBeUndefined();
    expect(newerVersion("1.0.1", "1.0.0")).toBe(true);
    expect(newerVersion("1.0.0", "1.0.0-beta.9")).toBe(true);
    expect(newerVersion("1.0.0", "1.0.0")).toBe(false);
    expect(newerVersion("0.9.9", "1.0.0")).toBe(false);
    expect(newerVersion("1.0.1", "nonsense")).toBe(false);
  });

  it("lists releases in a file:// folder or through GitHub's API, and nowhere else", async () => {
    const { releases, key } = await checkout();
    publish(releases, "1.0.1", key.privateKeyPem);
    expect(await releaseNames(pathToFileURL(releases).href)).toEqual(["ovis-1.0.1"]);
    const asked: string[] = [];
    const github = (async (url: string) => {
      asked.push(String(url));
      return Response.json([{ tag_name: "ovis-1.0.1" }, { tag_name: "ovis-1.0.2", draft: true }, { tag_name: "v0.5.5" }]);
    }) as unknown as typeof fetch;
    expect(await releaseNames("https://github.com/devswha/ovis/releases/download", github)).toEqual(["ovis-1.0.1", "v0.5.5"]);
    expect(asked).toEqual(["https://api.github.com/repos/devswha/ovis/releases?per_page=100"]);
    await expect(releaseNames("https://mirror.example/ovis")).rejects.toThrow("lists releases only on GitHub or in a file:// folder");
  });

  it("refuses a manifest with a wrong signature before it downloads any file the manifest names", async () => {
    const { releases, key } = await checkout();
    const dir = publish(releases, "1.0.1", key.privateKeyPem);
    signManifest(dir, generateKeyPair().privateKeyPem);
    const asked: string[] = [];
    const served = (async (url: string) => {
      asked.push(String(url));
      if (String(url).startsWith("https://api.github.com/")) return Response.json([{ tag_name: "ovis-1.0.1" }]);
      const file = join(dir, String(url).split("/").at(-1)!);
      return existsSync(file) ? new Response(readFileSync(file)) : new Response(null, { status: 404 });
    }) as unknown as typeof fetch;
    await expect(offeredRelease({ base: "https://github.com/devswha/ovis/releases/download", channel: "stable", publicKey: key.publicKey, fetchFile: served }))
      .rejects.toThrow("is not a signature of this ovis-server.json");
    expect(asked.map((url) => url.split("/").at(-1))).toEqual(["releases?per_page=100", MANIFEST, `${MANIFEST}.sig`]);
  });

  it("refuses an older manifest signed by the right key under a newer release's name", async () => {
    const { releases, key } = await checkout();
    const dir = publish(releases, "1.0.1", key.privateKeyPem);
    writeManifest(dir, { version: "1.0.0", sources: { server: "a".repeat(40), shared: "b".repeat(40) } });
    signManifest(dir, key.privateKeyPem);
    await expect(offeredRelease({ base: pathToFileURL(releases).href, channel: "stable", publicKey: key.publicKey })).rejects.toThrow("is for version 1.0.0, not the expected 1.0.1");
  });
});

describe.skipIf(process.platform === "win32" || !hostPlatform())("crossing from a source checkout to the binary", () => {
  it("offers a newer binary release, installs it beside the checkout in the shape every launcher runs, and touches no state", async () => {
    const fixture = await checkout();
    const dir = publish(fixture.releases, "1.0.1", fixture.key.privateKeyPem);
    const appBefore = snapshot(fixture.appState.replace(/$/, ""));
    const checkoutBefore = snapshot(fixture.root);
    const update = updater(fixture);
    await update.initialize();
    expect(update.status.current_version).toBe("1.0.0");
    await update.request("check", true);
    const revision = sha256(readFileSync(join(dir, MANIFEST)));
    expect(update.status).toMatchObject({ available: true, latest_version: "1.0.1", latest_revision: revision, blocked_reason: null });
    await update.request("install", true, revision);
    expect(update.status).toMatchObject({ phase: "idle", error: null, current_revision: revision, current_version: "1.0.1", available: false });
    const current = JSON.parse(readFileSync(join(fixture.stateDir, "current.json"), "utf8"));
    expect(current).toMatchObject({ revision, source_revision: fixture.revision, distribution: "binary", version: "1.0.1", previous_version: "1.0.0" });
    // the launcher of the checkout runs the release's supervisor, which runs its binary
    expect(releaseSupervisor(fixture.root, fixture.stateDir)).toBe(join(current.directory, "server", "supervisor.ts"));
    expect(readFileSync(join(current.directory, "server", "supervisor.ts"), "utf8")).toContain('[binary, "supervisor"]');
    expect(sha256(readFileSync(join(current.directory, "bin", "ovis-server")))).toBe(sha256(readFileSync(join(dir, releaseFile(PLATFORM)))));
    expect(readFileSync(join(current.directory, "bin", "dist", "index.html"), "utf8")).toContain("1.0.1");
    // the paired devices, the server id and the checkout (which a rollback runs) are byte for byte as they were
    expect(Object.fromEntries(Object.entries(snapshot(fixture.appState)).filter(([path]) => !path.startsWith("/updates/")))).toEqual(appBefore);
    expect(snapshot(fixture.root)).toEqual(checkoutBefore);
    // the same release is not offered again, and a supervisor that starts now runs it
    await update.request("check", true);
    expect(update.status.available).toBe(false);
    const restarted = updater(fixture);
    expect((await restarted.initialize())?.directory).toBe(current.directory);
    expect(restarted.status.current_version).toBe("1.0.1");
  });

  it("tells pages the commit the release's client was built from, so a reload after the crossing asks for no other", async () => {
    const fixture = await checkout();
    const build = "e".repeat(40);
    const dir = publish(fixture.releases, "1.0.1", fixture.key.privateKeyPem, undefined, build);
    const update = updater(fixture);
    await update.initialize();
    await update.request("check", true);
    // the offer and the install name the release by its manifest, which a commit could not bind
    const id = sha256(readFileSync(join(dir, MANIFEST)));
    expect(update.status.latest_revision).toBe(id);
    await update.request("install", true, id);
    expect(update.status).toMatchObject({ phase: "idle", error: null, current_revision: build, current_version: "1.0.1" });
    expect(JSON.parse(readFileSync(join(fixture.stateDir, "current.json"), "utf8"))).toMatchObject({ revision: id, build_revision: build });
    // a page built from that client, reloaded once: no notice (src/lib/updateNotes.ts)
    expect(reloadReason(build, { current_revision: update.status.current_revision, served_revision: null }, false, false)).toBeNull();
    // a page of the version before still asks to reload, as after any update
    expect(reloadReason(fixture.revision, { current_revision: update.status.current_revision, served_revision: null }, false, false)).toBe("updated");
    // a supervisor that starts now, source or compiled, tells the same commit
    for (const extra of [{}, { compiled: { ownRelease: JSON.parse(readFileSync(join(fixture.stateDir, "current.json"), "utf8")).directory } }]) {
      const restarted = updater(fixture, extra);
      await restarted.initialize();
      expect(restarted.status.current_revision).toBe(build);
    }
  });

  it("runs a staged release only while its binary still checks: one changed after staging leaves the launcher to fall back", async () => {
    const fixture = await checkout();
    const ran = join(fixture.dir, "ran");
    publish(fixture.releases, "1.0.1", fixture.key.privateKeyPem, `#!/bin/sh\necho "$1" > "${ran}"\n`);
    const update = updater(fixture);
    await update.initialize();
    await update.request("check", true);
    await update.request("install", true, update.status.latest_revision!);
    const { directory } = JSON.parse(readFileSync(join(fixture.stateDir, "current.json"), "utf8"));
    const shim = (key = fixture.key.publicKey) => {
      writeFileSync(join(directory, "server", "supervisor.ts"), shimOf(key));
      const result = Bun.spawnSync([process.execPath, join(directory, "server", "supervisor.ts")], { cwd: fixture.root, env: { ...process.env, OVIS_SOURCE_ROOT: fixture.root }, stdout: "pipe", stderr: "pipe" });
      return { code: result.exitCode, out: result.stderr.toString() };
    };
    expect(shim().code).toBe(0);
    expect(readFileSync(ran, "utf8")).toBe("supervisor\n");
    rmSync(ran);
    // a manifest that another key signed is not the release's either
    const other = shim(generateKeyPair().publicKey);
    expect(other.code).toBe(3);
    expect(other.out).toContain("not signed by the release key");
    const binary = join(directory, "bin", "ovis-server");
    writeFileSync(binary, readFileSync(binary).map((byte, index) => (index === 5 ? byte ^ 1 : byte)));
    const changed = shim();
    expect(changed.code).toBe(3);
    expect(changed.out).toContain("does not match its SHA-256 in ovis-server.json");
    expect(existsSync(ran)).toBe(false);
  });

  it("leaves version N as it was when the binary fails its checksum, and says so", async () => {
    const fixture = await checkout();
    const dir = publish(fixture.releases, "1.0.1", fixture.key.privateKeyPem);
    const binary = join(dir, releaseFile(PLATFORM));
    writeFileSync(binary, readFileSync(binary).map((byte, index) => (index === 3 ? byte ^ 1 : byte)));
    const update = updater(fixture);
    await update.initialize();
    await update.request("check", true);
    const before = { checkout: snapshot(fixture.root), app: snapshot(fixture.appState) };
    await update.request("install", true, update.status.latest_revision!);
    expect(update.status.phase).toBe("error");
    expect(update.status.error).toContain("does not match its SHA-256 in ovis-server.json");
    expect(update.status.current_version).toBe("1.0.0");
    expect(update.status.current_revision).toBe(fixture.revision);
    expect(existsSync(join(fixture.stateDir, "current.json"))).toBe(false);
    expect(readdirSync(fixture.stateDir).filter((name) => name.startsWith("release-"))).toEqual([]);
    expect(snapshot(fixture.root)).toEqual(before.checkout);
    // only the record that keeps the timer from retrying the failed release is new
    expect(Object.keys(snapshot(fixture.appState)).filter((path) => !(path in before.app))).toEqual([`/updates/${fixture.stateDir.split("/").at(-1)}/failed.json`]);
  });

  it("offers nothing older or equal, and never a release when no manifest of it checks", async () => {
    const fixture = await checkout("1.0.1");
    publish(fixture.releases, "1.0.1", fixture.key.privateKeyPem);
    const update = updater(fixture);
    await update.initialize();
    await update.request("check", true);
    expect(update.status.available).toBe(false);
    mkdirSync(join(fixture.releases, "ovis-1.0.2"));
    await update.request("check", true);
    expect(update.status.phase).toBe("error");
    expect(update.status.error).toContain("ships no compiled server");
    expect(update.status.available).toBe(false);
  });

  it("in the compiled server, runs only the binary release it was started from, never a build of the sources", async () => {
    const fixture = await checkout();
    const dir = publish(fixture.releases, "1.0.1", fixture.key.privateKeyPem);
    const first = updater(fixture);
    await first.initialize();
    await first.request("check", true);
    await first.request("install", true, first.status.latest_revision!);
    const current = JSON.parse(readFileSync(join(fixture.stateDir, "current.json"), "utf8"));
    const compiled = updater(fixture, { compiled: { ownRelease: current.directory } });
    expect(await compiled.initialize()).toMatchObject({ directory: current.directory, distribution: "binary", version: "1.0.1", revision: sha256(readFileSync(join(dir, MANIFEST))) });
    expect(compiled.status).toMatchObject({ managed: true, current_version: "1.0.1", blocked_reason: null });
    // started from anything else (a build of the sources, a folder outside the update state): not managed
    for (const other of [fixture.root, join(fixture.dir, "elsewhere")]) {
      const stray = updater(fixture, { compiled: { ownRelease: other } });
      expect(await stray.initialize()).toBeNull();
      expect(stray.status).toMatchObject({ managed: false, blocked_reason: COMPILED_RELEASE_REASON });
    }
    // a binary whose bytes changed after it was staged is not run as that release
    writeFileSync(join(current.directory, "bin", "ovis-server"), "#!/bin/sh\necho swapped\n");
    expect(stagedRelease(current.directory, fixture.key.publicKey, "1.0.1", PLATFORM)).toBeNull();
    const tampered = updater(fixture, { compiled: { ownRelease: current.directory } });
    expect(await tampered.initialize()).toBeNull();
  });

  it("never follows tags or builds from source in the compiled server, whatever release it was given", async () => {
    const fixture = await checkout();
    const dir = publish(fixture.releases, "1.0.1", fixture.key.privateKeyPem);
    const first = updater(fixture);
    await first.initialize();
    await first.request("check", true);
    await first.request("install", true, sha256(readFileSync(join(dir, MANIFEST))));
    const { directory } = JSON.parse(readFileSync(join(fixture.stateDir, "current.json"), "utf8"));
    // without a source of releases, a compiled server has nothing it may install: not managed, so no check runs
    const compiled = updater(fixture, { releases: undefined, compiled: { ownRelease: directory } });
    expect(await compiled.initialize()).toBeNull();
    expect(compiled.status.managed).toBe(false);
    await git(fixture.root, "tag", "v9.0.0");
    await compiled.request("install", true, fixture.revision);
    expect(readdirSync(fixture.stateDir).filter((name) => name.startsWith("release-"))).toEqual([directory.split("/").at(-1)]);
  });
});

/**
 * Every launcher there has been since updates replaced the supervisor (`git log -- server/managed.ts
 * server/update-state.ts` from 64f6c56ab on), run from a checkout of its own commit: each takes the binary release
 * staged by this updater and ends on its binary, with the paired devices and the server id byte for byte as they were.
 * The two launchers before 64f6c56ab never run an installed release's code at all (their checkout's own supervisor
 * updates only the bridge), so no update can move them: only an update of the checkout itself does.
 */
const GENERATIONS = ["64f6c56ab", "00a6bf165", "47df81479", "4dd760ff7", "9aca793e8", "ef2733387", "6449e8af6", "6f19adc7f", "8604d29f0", "HEAD"];
const historyHere = Bun.spawnSync(["git", "-C", REPO, "cat-file", "-e", "64f6c56ab^{commit}"]).exitCode === 0;

describe.skipIf(process.platform === "win32" || !hostPlatform() || !historyHere)("every launcher generation reaches the binary", () => {
  for (const generation of GENERATIONS) {
    it(`the launcher of ${generation} starts the binary release`, async () => {
      const dir = scratch();
      const root = join(dir, "checkout");
      mkdirSync(root);
      // the checkout of that commit: the launcher and what it imports (it loads no package)
      if (generation === "HEAD") {
        expect(Bun.spawnSync(["sh", "-c", `tar -C "${REPO}" -cf - server shared package.json | tar -C "${root}" -xf -`]).exitCode).toBe(0);
      } else {
        expect(Bun.spawnSync(["sh", "-c", `git -C "${REPO}" archive ${generation} server shared package.json | tar -C "${root}" -xf -`]).exitCode).toBe(0);
      }
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
      await git(root, "init", "-q", "-b", "main");
      await git(root, "add", ".");
      await git(root, "commit", "-qm", "N");
      const port = freePort();
      const home = join(dir, "home");
      const appState = join(dir, "state");
      mkdirSync(appState, { recursive: true });
      writeFileSync(join(appState, "devices.json"), '{"devices":[{"id":"phone"}]}\n');
      writeFileSync(join(appState, "server-id"), "server-1234\n");
      const before = snapshot(appState);
      // the release's binary: a stand-in that serves the version it is, says it is ready, and records how it ran
      const record = join(dir, "record.json");
      const standIn = join(dir, "stand-in.ts");
      writeFileSync(standIn, `
        import { writeFileSync } from "node:fs";
        writeFileSync(${JSON.stringify(record)}, JSON.stringify({ binary: process.env.STAND_IN_BINARY, argv: process.argv.slice(2), root: process.env.OVIS_SOURCE_ROOT ?? null, cwd: process.cwd(), bunBeBun: process.env.BUN_BE_BUN ?? null }));
        const server = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.PORT), fetch: () => Response.json({ ok: true, version: "1.0.1" }) });
        process.send?.({ type: "supervisor-ready" });
        process.on("SIGTERM", () => { server.stop(true); process.exit(0); });
      `);
      const releases = join(dir, "release");
      const key = generateKeyPair();
      publish(releases, "1.0.1", key.privateKeyPem, `#!/bin/sh\n[ "$1" = supervisor ] || exit 2\nSTAND_IN_BINARY="$0" exec "${process.execPath}" "${standIn}" "$@"\n`);
      // what the updater of this commit stages and records
      const fixture = { dir, root, appState, stateDir: updateStateDir(root, port, appState), releases, key, revision: await git(root, "rev-parse", "HEAD") };
      const update = updater(fixture);
      await update.initialize();
      await update.request("check", true);
      await update.request("install", true, update.status.latest_revision!);
      expect(update.status.error).toBeNull();
      const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), PORT: String(port), HOST: "127.0.0.1",
        OVIS_STATE_DIR: appState, HERDR_WEB_STATE_DIR: appState, BUN_BE_BUN: "1" };
      const launcher = Bun.spawn([process.execPath, join(root, "server", "managed.ts")], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
      const output = Promise.all([new Response(launcher.stdout).text(), new Response(launcher.stderr).text()]);
      try {
        const deadline = Date.now() + 20_000;
        let health: { version?: string } | null = null;
        while (health === null && Date.now() < deadline && launcher.exitCode === null) {
          try { health = await (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) })).json() as { version?: string }; }
          catch { await Bun.sleep(100); }
        }
        if (health === null) {
          launcher.kill("SIGKILL");
          throw new Error(`the launcher of ${generation} never served:\n${(await output).join("\n")}`);
        }
        expect(health.version).toBe("1.0.1");
        const ran = JSON.parse(readFileSync(record, "utf8")) as { binary: string; argv: string[]; root: string; bunBeBun: string | null };
        const current = JSON.parse(readFileSync(join(fixture.stateDir, "current.json"), "utf8"));
        expect(ran.binary).toBe(join(current.directory, "server", "..", "bin", "ovis-server"));
        expect(ran.root).toBe(root);
        expect(ran.bunBeBun).toBeNull();
        expect(snapshot(appState)).toMatchObject(before);
      } finally {
        launcher.kill("SIGTERM");
        await launcher.exited;
      }
    }, 40_000);
  }
});
