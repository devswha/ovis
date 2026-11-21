import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandState, installCommand, launcherText, shellPath, writeLauncher, type CommandHost, type LauncherPlaces } from "./terminalCommand.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function folder(): string {
  // a space and a quote, as in ~/Library/Application Support and a name with an apostrophe
  const dir = mkdtempSync(join(tmpdir(), "ovis-command '"));
  dirs.push(dir);
  return dir;
}

/** a server binary that prints the settings it was started with and its arguments, one per line */
function fakeServer(dir: string): string {
  const file = join(dir, "server", "ovis-server");
  mkdirSync(join(dir, "server"), { recursive: true });
  writeFileSync(file, [
    "#!/bin/sh",
    'for name in PORT OVIS_STATE_DIR HC_SESSION OVIS_DESKTOP_COMMAND HERDR_PLUGIN_CONFIG_DIR HOST OVIS_ACCOUNT_SERVICE_URL HC_SOCKET HERDR_PLUGIN_ROOT; do eval "printf \'%s=%s\\n\' $name \\"\\${$name-<unset>}\\""; done',
    'for word in "$@"; do printf "arg=%s\\n" "$word"; done',
  ].join("\n"), { mode: 0o755 });
  return file;
}

function places(dir: string, accountService: string | null): LauncherPlaces {
  return { serverBinary: fakeServer(dir), desktopJson: join(dir, "desktop.json"), stateDir: join(dir, "server state"), configDir: join(dir, "cli-settings"), accountService };
}

async function runLauncher(file: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  const child = Bun.spawn(["/bin/sh", file, ...args], { env: { PATH: "/usr/bin:/bin", HC_SOCKET: "/elsewhere.sock", HERDR_PLUGIN_ROOT: "/plugin", ...env }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, out, err };
}

describe("the launcher on a Mac or Linux", () => {
  it("runs the app's server as the command line, on the port desktop.json names and the app's own state", async () => {
    const dir = folder();
    const at = places(dir, "https://account-staging.example");
    writeFileSync(at.desktopJson, JSON.stringify({ port: 49152, server: { pid: 1, bun: at.serverBinary, started: null } }));
    const file = writeLauncher(join(dir, "cli"), "linux", at);
    expect(lstatSync(file).mode & 0o111).not.toBe(0);
    const { code, out } = await runLauncher(file, ["status", "two words"]);
    expect(code).toBe(0);
    expect(out.split("\n")).toEqual([
      "PORT=49152",
      `OVIS_STATE_DIR=${at.stateDir}`,
      "HC_SESSION=ovis",
      "OVIS_DESKTOP_COMMAND=1",
      `HERDR_PLUGIN_CONFIG_DIR=${at.configDir}`,
      "HOST=127.0.0.1",
      "OVIS_ACCOUNT_SERVICE_URL=https://account-staging.example",
      "HC_SOCKET=<unset>",
      "HERDR_PLUGIN_ROOT=<unset>",
      "arg=plugin",
      "arg=status",
      "arg=two words",
      "",
    ]);
  });

  it("leaves the account service to the command line's own default when the app was started without one", async () => {
    const dir = folder();
    const at = places(dir, null);
    writeFileSync(at.desktopJson, JSON.stringify({ port: 49152, server: null }));
    const { out } = await runLauncher(writeLauncher(join(dir, "cli"), "darwin", at), ["login"], { OVIS_ACCOUNT_SERVICE_URL: "https://from-the-shell.example" });
    expect(out).toContain("OVIS_ACCOUNT_SERVICE_URL=https://from-the-shell.example\n");
  });

  it("says to open the app, and runs nothing, before its server has a port or once its folder is gone", async () => {
    const dir = folder();
    const at = places(dir, null);
    const file = writeLauncher(join(dir, "cli"), "linux", at);
    for (const saved of [null, JSON.stringify({ port: null, server: null })]) {
      if (saved !== null) writeFileSync(at.desktopJson, saved);
      const { code, out, err } = await runLauncher(file, ["status"]);
      expect({ code, out }).toEqual({ code: 1, out: "" });
      expect(err).toContain("open the Ovis app first");
    }
    writeFileSync(at.desktopJson, JSON.stringify({ port: 49152, server: null }));
    rmSync(at.serverBinary);
    expect((await runLauncher(file, ["status"])).code).toBe(1);
  });
});

describe("the launcher on Windows", () => {
  const at: LauncherPlaces = {
    serverBinary: "C:\\Users\\Ann\\AppData\\Local\\Programs\\Ovis\\resources\\ovis\\server\\ovis-server.exe",
    desktopJson: "C:\\Users\\Ann\\AppData\\Roaming\\Ovis\\desktop.json",
    stateDir: "C:\\Users\\Ann\\AppData\\Roaming\\Ovis 100%\\server",
    configDir: "C:\\Users\\Ann\\AppData\\Roaming\\Ovis\\cli-settings",
    accountService: "https://account-staging.example/?a=1&b=2",
  };

  it("is a .cmd of CRLF lines that sets the app's settings and hands every argument to the server's command line", () => {
    const text = launcherText("win32", at);
    expect(text.endsWith("\r\n")).toBe(true);
    const lines = text.split("\r\n");
    expect(lines).toContain(`if exist "${at.desktopJson}" for /f "usebackq tokens=2 delims=:,}" %%p in ("${at.desktopJson}") do if not defined PORT set "PORT=%%p"`);
    expect(lines).toContain('set "OVIS_STATE_DIR=C:\\Users\\Ann\\AppData\\Roaming\\Ovis 100%%\\server"');
    expect(lines).toContain('set "HC_SESSION=ovis"');
    expect(lines).toContain('set "OVIS_DESKTOP_COMMAND=1"');
    expect(lines).toContain(`set "HERDR_PLUGIN_CONFIG_DIR=${at.configDir}"`);
    expect(lines).toContain('set "OVIS_ACCOUNT_SERVICE_URL=https://account-staging.example/?a=1&b=2"');
    expect(lines).toContain(`"${at.serverBinary}" plugin %*`);
    expect(launcherText("win32", { ...at, accountService: null })).not.toContain("OVIS_ACCOUNT_SERVICE_URL");
  });
});

describe("shellPath", () => {
  it("takes the PATH the login shell printed last, after whatever its profile printed", () => {
    expect(shellPath("Welcome!\n__OVIS_PATH__=/fake\nmore\n__OVIS_PATH__=/a:/b\n")).toBe("/a:/b");
    expect(shellPath("zsh: no job control\n")).toBeNull();
  });
});

interface Fake extends CommandHost { runs: { program: string; args: readonly string[]; env?: Record<string, string> }[] }

function posixHost(platform: "linux" | "darwin", dir: string, path: (home: string) => string, run: (program: string, args: readonly string[]) => number = () => 1): Fake {
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  const launcher = join(dir, "cli", "ovis");
  mkdirSync(join(dir, "cli"), { recursive: true });
  writeFileSync(launcher, "#!/bin/sh\n", { mode: 0o755 });
  const runs: Fake["runs"] = [];
  return {
    platform, home, launcher, runs,
    // a folder that is not there: never the real /usr/local/bin, and not writable even for root
    systemBin: join(dir, "usr-local", "bin"),
    isFile: (file) => { try { return lstatSync(file).isFile() || lstatSync(file).isSymbolicLink(); } catch { return false; } },
    terminalPath: async () => path(home),
    run: async (program, args, env) => { runs.push({ program, args, env }); return run(program, args); },
  };
}

describe("adding the command on Linux", () => {
  it("links ~/.local/bin/ovis to the launcher, and is then installed with nothing to say", async () => {
    const dir = folder();
    const host = posixHost("linux", dir, (home) => `${home}/.local/bin:/usr/bin`);
    expect(await commandState(host)).toEqual({ installed: false, at: null, note: null });
    const at = join(host.home, ".local", "bin", "ovis");
    expect(await installCommand(host)).toEqual({ installed: true, at, note: null });
    expect(readlinkSync(at)).toBe(host.launcher);
    expect(host.runs).toEqual([]);
  });

  it("says when ~/.local/bin is not on the terminal's PATH, and when another ovis (a .deb's app) comes first", async () => {
    const dir = folder();
    const debBin = join(dir, "usr-bin");
    mkdirSync(debBin);
    writeFileSync(join(debBin, "ovis"), "the app\n", { mode: 0o755 });
    const off = posixHost("linux", dir, () => "/nowhere");
    const at = join(off.home, ".local", "bin", "ovis");
    expect((await installCommand(off)).note).toEqual({ kind: "off-path", dir: join(off.home, ".local", "bin") });
    const behind = { ...off, terminalPath: async () => `${debBin}:${off.home}/.local/bin` };
    expect(await commandState(behind)).toEqual({ installed: true, at, note: { kind: "shadowed", path: join(debBin, "ovis") } });
  });

  it("never replaces an ovis it did not put there (install.sh's launcher), and asks for nothing", async () => {
    const dir = folder();
    const host = posixHost("linux", dir, (home) => `${home}/.local/bin`);
    const at = join(host.home, ".local", "bin", "ovis");
    mkdirSync(join(host.home, ".local", "bin"), { recursive: true });
    writeFileSync(at, "#!/bin/sh\n# install.sh\n", { mode: 0o755 });
    expect(await installCommand(host)).toEqual({ installed: false, at: null, note: { kind: "taken", path: at } });
    expect(readFileSync(at, "utf8")).toBe("#!/bin/sh\n# install.sh\n");
    expect(host.runs).toEqual([]);
  });
});

describe("adding the command on a Mac", () => {
  it("asks for an administrator's password to link it in /usr/local/bin, without replacing anything there", async () => {
    const dir = folder();
    const host = posixHost("darwin", dir, () => join(dir, "usr-local", "bin"), (program, args) => {
      // what the prompt's root shell does once the person agrees
      mkdirSync(join(dir, "usr-local", "bin"), { recursive: true });
      symlinkSync(join(dir, "cli", "ovis"), join(dir, "usr-local", "bin", "ovis"));
      return program === "/usr/bin/osascript" && args[1]!.endsWith("with administrator privileges") ? 0 : 1;
    });
    const at = join(host.systemBin, "ovis");
    expect(await installCommand(host)).toEqual({ installed: true, at, note: null });
    expect(host.runs).toHaveLength(1);
    const script = host.runs[0]!.args[1]!;
    expect(script).toContain("[ ! -e ");
    expect(script).toContain("ln -s ");
    expect(script).not.toContain("ln -sf");
  });

  it("puts it in ~/.local/bin when the password prompt is cancelled", async () => {
    const dir = folder();
    const host = posixHost("darwin", dir, (home) => `${home}/.local/bin`, () => 1);
    expect(await installCommand(host)).toEqual({ installed: true, at: join(host.home, ".local", "bin", "ovis"), note: null });
    expect(host.runs).toHaveLength(1);
  });

  it("goes straight to ~/.local/bin when /usr/local/bin already has another ovis, which stays", async () => {
    const dir = folder();
    const host = posixHost("darwin", dir, (home) => `${join(dir, "usr-local", "bin")}:${home}/.local/bin`);
    mkdirSync(host.systemBin, { recursive: true });
    writeFileSync(join(host.systemBin, "ovis"), "other\n");
    chmodSync(join(host.systemBin, "ovis"), 0o755);
    const state = await installCommand(host);
    expect(state).toEqual({ installed: true, at: join(host.home, ".local", "bin", "ovis"), note: { kind: "shadowed", path: join(host.systemBin, "ovis") } });
    expect(readFileSync(join(host.systemBin, "ovis"), "utf8")).toBe("other\n");
    expect(host.runs).toEqual([]);
  });
});

describe("adding the command on Windows", () => {
  const launcher = "C:\\Users\\Ann\\AppData\\Roaming\\Ovis\\cli\\ovis.cmd";
  function windowsHost(files: string[], userPath: string[]): Fake {
    const runs: Fake["runs"] = [];
    const path = ["C:\\Windows\\system32", ...userPath];
    return {
      platform: "win32", home: "C:\\Users\\Ann", systemBin: "", launcher, runs,
      isFile: (file) => files.includes(file) || file === launcher,
      terminalPath: async () => path.join(";"),
      run: async (program, args, env) => {
        runs.push({ program, args, env });
        path.push(env!["OVIS_COMMAND_DIR"]!);
        return 0;
      },
    };
  }

  it("adds the launcher's folder to the user's Path, as install.ps1 adds its own", async () => {
    const host = windowsHost([], ["C:\\Users\\Ann\\.local\\bin"]);
    expect(await commandState(host)).toEqual({ installed: false, at: null, note: null });
    expect(await installCommand(host)).toEqual({ installed: true, at: launcher, note: null });
    expect(host.runs.map(({ program, env }) => ({ program, env }))).toEqual([{ program: "powershell.exe", env: { OVIS_COMMAND_DIR: "C:\\Users\\Ann\\AppData\\Roaming\\Ovis\\cli" } }]);
    expect(host.runs[0]!.args.at(-1)).toContain("'User'");
  });

  it("leaves install.ps1's ovis as the one that runs, and changes no Path", async () => {
    const theirs = "C:\\Users\\Ann\\AppData\\Local\\ovis\\cmd\\ovis.cmd";
    const host = windowsHost([theirs], ["C:\\Users\\Ann\\AppData\\Local\\ovis\\cmd"]);
    expect(await installCommand(host)).toEqual({ installed: false, at: null, note: { kind: "taken", path: theirs } });
    expect(host.runs).toEqual([]);
  });
});
