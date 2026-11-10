import { afterAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * install.sh's `ovis` command and its `--add` step. The launcher's functions are cut out of install.sh
 * itself and run under /bin/sh with a HOME of their own; the whole script is run as `curl … | sh` runs
 * it, on a PATH that holds only what it needs. herdr, node, curl and the plugin's script are stand-ins,
 * so nothing is installed, no herdr is touched, nothing is fetched and no account is asked.
 */

const ROOT = join(import.meta.dir, "..");
const INSTALLER = readFileSync(join(ROOT, "install.sh"), "utf8");
const MARK = "# ovis launcher, written by install.sh";
const ADD_LINE = "to add this PC to your Ovis account: ";
const HINT_LINE = "to add this PC to your Ovis account, run in a terminal on this PC: ";
const TOKEN_LINE = "on a PC other people log in to, set OVIS_TOKEN first: without it any local user counts as this PC";
const CTRL_C = "\x03";
/** a run of install.sh ends in about a second alone, in many on a PC busy with other checks */
const RUN_ENDS_WITHIN_MS = 45_000;
setDefaultTimeout(RUN_ENDS_WITHIN_MS + 15_000);

/** one top-level shell function from install.sh, by name, as written there (one line or a block) */
function fn(name: string): string {
  const match = new RegExp(`^${name}\\(\\) \\{.*\\}$`, "m").exec(INSTALLER) ?? new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}$`, "m").exec(INSTALLER);
  if (!match) throw new Error(`install.sh defines no ${name}()`);
  return match[0];
}
const CONSTANTS = ["REPO", "BIN_DIR", "LAUNCHER_MARK"].map((name) => {
  const line = new RegExp(`^${name}=.*$`, "m").exec(INSTALLER)?.[0];
  if (!line) throw new Error(`install.sh sets no ${name}`);
  return line;
}).join("\n");
const FUNCTIONS = ["say", "link", "launcher_text", "write_launcher", "ovis_command", "add_pc", "token_line", "closing_lines"].map(fn).join("\n");

const dir = mkdtempSync(join(tmpdir(), "ovis-install-command-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/**
 * The plugin's script, as a stand-in: it says where it ran from, what it was given and the dirs it
 * was handed. `add` (and `link`) leave a record, with whether their input is a terminal. `knows` is
 * the release: one with `add`, one from before it (only `link`), or one from before both.
 */
function pluginScript(knows: "add" | "link" | "neither" = "add"): string {
  const record = `{
  const { appendFileSync, existsSync } = await import("node:fs");
  appendFileSync(process.env.SCRATCH + "/add.calls", JSON.stringify({ command, rest, terminal: process.stdin.isTTY === true }) + "\\n");
  console.log("the add step");
  if (existsSync(process.env.SCRATCH + "/add-waits")) { console.log("waiting for an approval"); await Bun.sleep(60_000); }
  process.exit(existsSync(process.env.SCRATCH + "/add-fails") ? 1 : 0);
}`;
  return `${knows === "add" ? "// COMMAND_ALIASES: this release knows add and login\n" : ""}const [command = "status", ...rest] = process.argv.slice(2);
if (command === "phone") console.log("the phone step");
else if (${knows === "neither" ? "false" : knows === "add" ? `["add", "login", "link"].includes(command)` : `command === "link"`}) ${record}
else console.log(JSON.stringify({ root: import.meta.dir, command, rest, config: process.env.HERDR_PLUGIN_CONFIG_DIR ?? null, state: process.env.HERDR_PLUGIN_STATE_DIR ?? null }));
`;
}

const STAND_INS: Record<string, string> = {
  // the plugin installed already, under the id (and at the root) the test's files name; herdr itself not running
  herdr: `case "$*" in
  --version) echo "herdr 0.9.3" ;;
  "plugin list") echo "$(cat "$SCRATCH/plugin-id") 0.0.0" ;;
  "plugin list --json") printf '{"result":{"plugins":[{"plugin_id":"someone.else","plugin_root":"/nowhere"},{"plugin_id":"%s","plugin_root":"%s"}]}}\\n' "$(cat "$SCRATCH/plugin-id")" "$(cat "$SCRATCH/plugin-root")" ;;
  "plugin config-dir "*) echo "$SCRATCH/herdr-config/$3" ;;
  "status server --json") echo '{"running":false}' ;;
  *) echo "unexpected herdr $*" >&2; exit 1 ;;
esac`,
  node: `case "$1" in -p) case "$(uname -m)" in aarch64 | arm64) echo "22 arm64" ;; *) echo "22 x64" ;; esac ;; *) echo v22.0.0 ;; esac`,
  // a rerun fetches nothing
  curl: `echo "unexpected curl $*" >&2; exit 1`,
};

/** One PC per test: a home directory, and a PATH that holds only what install.sh and the launcher run. */
class Pc {
  readonly scratch = mkdtempSync(join(dir, "pc-"));
  readonly bin = join(this.scratch, "bin");
  readonly launcher = join(this.scratch, ".local", "bin", "ovis");
  readonly app = join(this.scratch, ".local", "share", "ovis", "app");

  /** `herdr: false`: a PC without herdr (Ovis on herdr-core, or nothing installed) */
  constructor(options: { herdr?: boolean } = {}) {
    mkdirSync(this.bin);
    for (const tool of ["sh", "cat", "uname", "ldd", "grep", "git", "tar", "awk", "sed", "mktemp", "rm", "sleep", "mv", "mkdir", "cp", "chmod", "ps", "tail", "readlink"]) {
      const real = Bun.which(tool);
      if (real) symlinkSync(real, join(this.bin, tool));
    }
    symlinkSync(process.execPath, join(this.bin, "bun"));
    for (const name of options.herdr === false ? ["node", "curl"] : ["herdr", "node", "curl"]) {
      writeFileSync(join(this.bin, name), `#!/bin/sh\n${STAND_INS[name]!}\n`, { mode: 0o755 });
    }
    this.plugin("plugin");
  }

  /** herdr lists the plugin at `name` under `id`; `knows` is what its script does */
  plugin(name: string, knows: "add" | "link" | "neither" = "add", id = "devswha.ovis"): string {
    const root = join(this.scratch, name);
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "scripts", "plugin.ts"), pluginScript(knows));
    writeFileSync(join(this.scratch, "plugin-id"), id);
    writeFileSync(join(this.scratch, "plugin-root"), root);
    return root;
  }
  /** herdr lists no Ovis plugin */
  noPlugin(): this { writeFileSync(join(this.scratch, "plugin-id"), "someone.other"); return this; }
  /** Ovis on herdr-core: its own checkout, where install.sh puts it */
  core(): string {
    mkdirSync(join(this.app, "scripts"), { recursive: true });
    writeFileSync(join(this.app, "scripts", "plugin.ts"), pluginScript());
    return this.app;
  }
  flag(name: "add-fails" | "add-waits"): this { writeFileSync(join(this.scratch, name), ""); return this; }
  /** what the add step was run with, one record per run */
  addCalls(): { command: string; rest: string[]; terminal: boolean }[] {
    const log = join(this.scratch, "add.calls");
    return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  }
  environment(extra: Record<string, string> = {}): Record<string, string> {
    return { PATH: this.bin, HOME: this.scratch, SCRATCH: this.scratch, SHELL: "/bin/sh", TERM: "xterm", ...extra };
  }

  /** runs `call` after install.sh's constants and functions under sh with `set -eu`, as the script runs */
  sh(call: string, extra?: Record<string, string>): { code: number; out: string } {
    const run = Bun.spawnSync(["/bin/sh", "-c", `set -eu\n${CONSTANTS}\n${FUNCTIONS}\n${call}`], { cwd: this.scratch, env: this.environment(extra), stdout: "pipe", stderr: "pipe", timeout: 20_000 });
    return { code: run.exitCode ?? -1, out: run.stdout.toString() + run.stderr.toString() };
  }
  /** the launcher install.sh writes, written */
  written(): this {
    const { code, out } = this.sh("write_launcher");
    if (code !== 0 || !existsSync(this.launcher)) throw new Error(`write_launcher wrote no launcher: ${out}`);
    return this;
  }
  /** runs the written launcher as a shell would, by its path */
  ovis(args: string[], extra?: Record<string, string>): { code: number; out: string } {
    const run = Bun.spawnSync([this.launcher, ...args], { cwd: this.scratch, env: this.environment(extra), stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20_000 });
    return { code: run.exitCode ?? -1, out: run.stdout.toString() + run.stderr.toString() };
  }

  /** the whole installer as a script or an agent runs it: the script on stdin, and no terminal */
  async unattended(args: string[] = [], extra?: Record<string, string>): Promise<{ out: string; exitCode: number }> {
    const child = Bun.spawn(["sh", "-s", "--", ...args], { cwd: this.scratch, env: this.environment(extra), stdin: Bun.file(join(ROOT, "install.sh")), stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), RUN_ENDS_WITHIN_MS);
    const [out, err, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    clearTimeout(timer);
    return { out: out + err, exitCode };
  }

  /**
   * The whole installer at a terminal (script(1) gives one), the script on stdin as under `curl … | sh`.
   * `typed` goes to the terminal once `after` is on it. The wrapping shell survives Ctrl-C as the
   * user's own shell does, and reports the installer's exit code.
   */
  async atTerminal(args: string, extra?: Record<string, string>, typed?: { after: string; text: string }): Promise<{ out: string; exitCode: number }> {
    const command = `trap : INT; cat "${join(ROOT, "install.sh")}" | sh -s -- ${args}; echo "exit=$?"`;
    const child = Bun.spawn([Bun.which("script")!, "-qec", command, "/dev/null"], { cwd: this.scratch, env: this.environment(extra), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), RUN_ENDS_WITHIN_MS);
    let out = "";
    let again: ReturnType<typeof setInterval> | undefined;
    // as script(1) exits, a write to its pipe throws EPIPE: nobody is left to read the keys
    const type = (text: string) => {
      try { child.stdin.write(text); child.stdin.flush(); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EPIPE") throw error;
      }
    };
    const decoder = new TextDecoder();
    try {
      for await (const chunk of child.stdout) {
        out += decoder.decode(chunk, { stream: true });
        if (again !== undefined || typed === undefined || !out.includes(typed.after)) continue;
        // Ctrl-C is a signal, and the add step's own handlers come a moment after its first words: pressed until it lands
        type(typed.text);
        again = setInterval(() => type(typed.text), 100);
      }
      await child.exited;
    } finally {
      clearInterval(again);
      clearTimeout(timer);
    }
    child.stdin.end();
    return { out, exitCode: Number(/exit=(\d+)/.exec(out)?.[1] ?? -1) };
  }
}

// install.sh is the Linux and macOS installer: Windows has install.ps1, and no launcher yet
describe.skipIf(platform() === "win32")("the ovis launcher install.sh writes", () => {
  it("is an executable sh script with the installer's mark on its second line", () => {
    const pc = new Pc().written();
    const text = readFileSync(pc.launcher, "utf8");
    expect(text.split("\n").slice(0, 2)).toEqual(["#!/bin/sh", MARK]);
    expect(statSync(pc.launcher).mode & 0o777).toBe(0o755);
    expect(existsSync(`${pc.launcher}.new`)).toBe(false);
    expect(Bun.spawnSync(["/bin/sh", "-n", pc.launcher]).exitCode).toBe(0);
  });

  it("holds no path of the install that wrote it", () => {
    const pc = new Pc().written();
    const text = readFileSync(pc.launcher, "utf8");
    expect(text).not.toContain(pc.scratch);
    // the same words whichever PC wrote it
    expect(readFileSync(new Pc().written().launcher, "utf8")).toBe(text);
  });

  it("finds the herdr plugin each time it runs, and hands on the command and its flags", () => {
    const pc = new Pc().written();
    const first = pc.ovis(["pair", "--approve"]);
    expect(first.code, first.out).toBe(0);
    expect(JSON.parse(first.out)).toMatchObject({ root: join(pc.scratch, "plugin", "scripts"), command: "pair", rest: ["--approve"] });
    // the plugin reinstalled somewhere else: the same launcher follows it
    const moved = pc.plugin("plugin-moved");
    expect(JSON.parse(pc.ovis([]).out)).toMatchObject({ root: join(moved, "scripts"), command: "status", rest: [] });
  });

  it("finds a plugin still installed under the id before the rename", () => {
    const pc = new Pc().written();
    const root = pc.plugin("legacy-plugin", "add", "devswha.herdr-web-ui");
    expect(JSON.parse(pc.ovis(["status"]).out)).toMatchObject({ root: join(root, "scripts") });
  });

  it("runs Ovis on herdr-core from its checkout, with the dirs its service gives it", () => {
    // with herdr on the PC or without it, while herdr lists no Ovis plugin
    const without = new Pc({ herdr: false }).written();
    const alone = without.core();
    expect(JSON.parse(without.ovis(["status"]).out)).toMatchObject({ root: join(alone, "scripts") });
    const pc = new Pc().noPlugin().written();
    const app = pc.core();
    const ran = JSON.parse(pc.ovis(["status"]).out);
    expect(ran).toMatchObject({ root: join(app, "scripts"), config: join(pc.scratch, ".config", "ovis"), state: join(pc.scratch, ".local", "state", "ovis") });
    // the names from before the rename, while only those exist
    mkdirSync(join(pc.scratch, ".config", "herdr-web-ui"), { recursive: true });
    mkdirSync(join(pc.scratch, ".local", "state", "herdr-web-ui"), { recursive: true });
    expect(JSON.parse(pc.ovis(["status"]).out)).toMatchObject({ config: join(pc.scratch, ".config", "herdr-web-ui"), state: join(pc.scratch, ".local", "state", "herdr-web-ui") });
    // dirs that are given are kept
    expect(JSON.parse(pc.ovis(["status"], { HERDR_PLUGIN_CONFIG_DIR: "/given/config", HERDR_PLUGIN_STATE_DIR: "/given/state" }).out)).toMatchObject({ config: "/given/config", state: "/given/state" });
  });

  it("runs the herdr plugin where an earlier herdr-core checkout is still there beside it", () => {
    // OVIS_RUNTIME=herdr over an earlier herdr-core install: the installer's own steps run the plugin, so the command does
    const pc = new Pc().written();
    pc.core();
    const ran = JSON.parse(pc.ovis(["status"]).out);
    expect(ran).toMatchObject({ root: join(pc.scratch, "plugin", "scripts"), config: null, state: null });
    expect(pc.ovis(["add"]).code).toBe(0);
    expect(pc.addCalls()).toEqual([{ command: "add", rest: [], terminal: false }]);
    // the plugin removed: the checkout is the install again
    pc.noPlugin();
    expect(JSON.parse(pc.ovis(["status"]).out)).toMatchObject({ root: join(pc.app, "scripts") });
  });

  it("tells a release by words the real scripts/plugin.ts has", () => {
    // install.sh and the launcher grep the installed script for these: a refactor that drops them would
    // make --add print its hint, and the launcher say link, with every stand-in here still passing
    const real = readFileSync(join(ROOT, "scripts", "plugin.ts"), "utf8");
    expect(real).toContain("COMMAND_ALIASES");
    expect(real).toContain('"link"');
    expect(real).toContain('"phone"');
    for (const [name, pattern] of [["add_pc", "grep -qs 'COMMAND_ALIASES' "], ["add_pc", `grep -qs '"link"' `], ["launcher_text", "grep -qs COMMAND_ALIASES "]] as const) {
      expect(fn(name)).toContain(pattern);
    }
  });

  it("a launcher that cannot be written does not end the install", () => {
    const blocked = new Pc();
    mkdirSync(`${blocked.launcher}.new`, { recursive: true });
    const readOnly = new Pc();
    mkdirSync(join(readOnly.scratch, ".local", "bin"), { recursive: true });
    chmodSync(join(readOnly.scratch, ".local", "bin"), 0o555);
    const noFolder = new Pc();
    writeFileSync(join(noFolder.scratch, ".local"), "");
    for (const pc of [blocked, readOnly, noFolder]) {
      const { code, out } = pc.sh(`root=/plugin/root; original_path=$PATH; write_launcher; echo "ours=$launcher_ours"; echo "command=$(ovis_command)"`);
      expect(code, out).toBe(0);
      expect(out).toContain(`Ovis: could not write ${pc.launcher}, so no ovis command was installed`);
      expect(out).toContain("ours=0");
      expect(out).toContain("command=bun /plugin/root/scripts/plugin.ts");
      expect(existsSync(pc.launcher)).toBe(false);
    }
    chmodSync(join(readOnly.scratch, ".local", "bin"), 0o755);
  });

  it("runs add on a release that knows it, and as link on a checkout from before add", () => {
    const pc = new Pc().written();
    expect(pc.ovis(["add", "--google"]).code).toBe(0);
    expect(pc.ovis(["login"]).code).toBe(0);
    pc.plugin("old-plugin", "link");
    expect(pc.ovis(["add", "--google"]).code).toBe(0);
    expect(pc.ovis(["login"]).code).toBe(0);
    expect(pc.addCalls().map((call) => [call.command, ...call.rest])).toEqual([["add", "--google"], ["login"], ["link", "--google"], ["link"]]);
  });

  it("finds herdr and Bun where the installer puts them, on a PATH without either", () => {
    const pc = new Pc().written();
    const tools = join(pc.scratch, "tools");
    mkdirSync(tools);
    for (const tool of ["sh", "cat", "grep"]) symlinkSync(Bun.which(tool)!, join(tools, tool));
    symlinkSync(join(pc.bin, "herdr"), join(pc.scratch, ".local", "bin", "herdr"));
    mkdirSync(join(pc.scratch, ".bun", "bin"), { recursive: true });
    symlinkSync(process.execPath, join(pc.scratch, ".bun", "bin", "bun"));
    const ran = pc.ovis(["status"], { PATH: tools });
    expect(ran.code, ran.out).toBe(0);
    expect(JSON.parse(ran.out)).toMatchObject({ command: "status" });
  });

  it("says so in one line when Ovis is not installed", () => {
    for (const pc of [new Pc({ herdr: false }).written(), new Pc().written()]) {
      // no herdr at all, and a herdr that lists no Ovis plugin
      pc.noPlugin();
      const ran = pc.ovis(["add"]);
      expect(ran.code).toBe(1);
      expect(ran.out.trim().split("\n")).toEqual(["ovis: Ovis is not installed on this PC. Install it with: curl -fsSL https://ovis.sh/install.sh | sh"]);
      expect(pc.addCalls()).toEqual([]);
    }
  });

  it("is written again over a launcher of the installer's own", () => {
    const pc = new Pc().written();
    writeFileSync(pc.launcher, `#!/bin/sh\n${MARK}\necho "an older launcher"\n`, { mode: 0o700 });
    const { out } = pc.sh(`write_launcher; echo "ours=$launcher_ours"`);
    expect(out).toContain("ours=1");
    expect(readFileSync(pc.launcher, "utf8")).not.toContain("an older launcher");
    expect(statSync(pc.launcher).mode & 0o777).toBe(0o755);
  });

  it("leaves an ovis the installer did not write as it is, and says so", () => {
    const own = "#!/bin/sh\necho \"someone's own ovis\"\n";
    const file = new Pc();
    mkdirSync(join(file.scratch, ".local", "bin"), { recursive: true });
    writeFileSync(file.launcher, own, { mode: 0o755 });
    // a link is never followed: what it points at is not the installer's to replace, mark or not
    const linked = new Pc();
    mkdirSync(join(linked.scratch, ".local", "bin"), { recursive: true });
    writeFileSync(join(linked.scratch, "elsewhere"), `#!/bin/sh\n${MARK}\n`, { mode: 0o755 });
    symlinkSync(join(linked.scratch, "elsewhere"), linked.launcher);
    const folder = new Pc();
    mkdirSync(folder.launcher, { recursive: true });
    for (const pc of [file, linked, folder]) {
      const { code, out } = pc.sh(`root=/plugin/root; original_path=$PATH; write_launcher; echo "ours=$launcher_ours"; echo "command=$(ovis_command)"`);
      expect(code, out).toBe(0);
      expect(out).toContain(`Ovis: ${pc.launcher} is there already and is not this installer's, so it is left as it is and no ovis command was installed`);
      expect(out).toContain("ours=0");
      // what the closing lines name instead of a command that is not there
      expect(out).toContain("command=bun /plugin/root/scripts/plugin.ts");
    }
    expect(readFileSync(file.launcher, "utf8")).toBe(own);
    expect(lstatSync(linked.launcher).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(linked.scratch, "elsewhere"), "utf8")).toBe(`#!/bin/sh\n${MARK}\n`);
    expect(lstatSync(folder.launcher).isDirectory()).toBe(true);
  });

  it("is named ovis where the user's PATH finds it, and by its path where it does not", () => {
    const pc = new Pc().written();
    const named = (path: string) => pc.sh(`launcher_ours=1; root=/plugin/root; original_path='${path}'; ovis_command`).out;
    expect(named(`${pc.bin}:${join(pc.scratch, ".local", "bin")}`)).toBe("ovis");
    expect(named(pc.bin)).toBe(pc.launcher);
    // another ovis comes first on the PATH: the name would run that one
    writeFileSync(join(pc.bin, "ovis"), "#!/bin/sh\n", { mode: 0o755 });
    expect(named(`${pc.bin}:${join(pc.scratch, ".local", "bin")}`)).toBe(pc.launcher);
  });
});

describe.skipIf(platform() === "win32")("install.sh --add", () => {
  it.concurrent("fails on an option it does not know, with the usage, before it installs anything", async () => {
    for (const args of [["--ad"], ["--add", "extra"], ["add"]]) {
      const pc = new Pc();
      const { out, exitCode } = await pc.unattended(args);
      expect(exitCode, out).toBe(1);
      expect(out.trim()).toBe(`Ovis: does not know the option '${args.at(-1)}'. usage: curl -fsSL https://ovis.sh/install.sh | sh -s -- [--add]`);
      expect(existsSync(pc.launcher)).toBe(false);
    }
  });

  it.concurrent("installs the launcher and names ovis add, with nothing asked", async () => {
    const pc = new Pc();
    const { out, exitCode } = await pc.unattended();
    expect(exitCode, out).toBe(0);
    expect(out).toContain("the phone step");
    // ~/.local/bin is not on this PC's PATH, so the line gives the path
    expect(out).toContain(`Ovis: ${ADD_LINE}${pc.launcher} add\n`);
    expect(out).not.toContain(HINT_LINE);
    expect(out).toContain(`Ovis: ${TOKEN_LINE} (https://github.com/devswha/ovis/blob/main/docs/relay.md#a-pc-with-no-screen)`);
    expect(pc.addCalls()).toEqual([]);
    // the launcher it wrote runs this PC's plugin
    expect(JSON.parse(pc.ovis(["status"]).out)).toMatchObject({ root: join(pc.scratch, "plugin", "scripts"), command: "status" });
    // and where the PATH has ~/.local/bin, the line names the command alone
    const onPath = await pc.unattended([], { PATH: `${pc.bin}:${join(pc.scratch, ".local", "bin")}` });
    expect(onPath.out).toContain(`Ovis: ${ADD_LINE}ovis add\n`);
  });

  it.concurrent("without a terminal, --add and OVIS_ADD=1 say what to run and add nothing", async () => {
    for (const [args, extra] of [[["--add"], {}], [[], { OVIS_ADD: "1" }]] as const) {
      const pc = new Pc();
      const { out, exitCode } = await pc.unattended([...args], extra);
      expect(exitCode, out).toBe(0);
      expect(out).toContain(`Ovis: ${HINT_LINE}${pc.launcher} add\n`);
      expect(out).not.toContain(ADD_LINE);
      expect(out).toContain(TOKEN_LINE);
      expect(pc.addCalls()).toEqual([]);
    }
  });

  it("does not run at a screen that shows its words when there is no terminal to answer at", () => {
    // stdout a terminal, as the installer found it, in a session with no controlling terminal: /dev/tty does not open
    const pc = new Pc();
    symlinkSync(Bun.which("perl")!, join(pc.bin, "perl"));
    const call = `add=1; terminal=1; launcher_ours=1; original_path=$PATH; root='${join(pc.scratch, "plugin")}'; code=$root; add_pc; echo "result=$add_result"; closing_lines`;
    const run = Bun.spawnSync(["perl", "-MPOSIX", "-e", "if (fork) { wait; exit($? >> 8) } POSIX::setsid(); exec @ARGV or exit 127", "/bin/sh", "-c", `set -eu\n${CONSTANTS}\n${FUNCTIONS}\n${call}`],
      { cwd: pc.scratch, env: pc.environment(), stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20_000 });
    const out = run.stdout.toString() + run.stderr.toString();
    expect(run.exitCode, out).toBe(0);
    expect(out).toContain("result=none");
    expect(out).toContain(HINT_LINE);
    expect(pc.addCalls()).toEqual([]);
  });

  // script(1) as util-linux has it
  describe.skipIf(platform() !== "linux" || Bun.which("script") === null)("at a terminal", () => {
    it.concurrent("ends the install with the add step, reading from the terminal itself", async () => {
      const pc = new Pc();
      const { out, exitCode } = await pc.atTerminal("--add");
      expect(exitCode, out).toBe(0);
      // under `curl | sh` stdin is the script: the add step's input is the terminal all the same
      expect(pc.addCalls()).toEqual([{ command: "add", rest: [], terminal: true }]);
      expect(out.indexOf("the phone step")).toBeLessThan(out.indexOf("the add step"));
      // added: the line that says how to add it is not printed
      expect(out).not.toContain("to add this PC to your Ovis account");
      // who counts as this PC is said once, before the add starts: "set OVIS_TOKEN first" can still be done
      expect(out.split(TOKEN_LINE)).toHaveLength(2);
      expect(out.indexOf(TOKEN_LINE)).toBeGreaterThan(out.indexOf("the phone step"));
      expect(out.indexOf(TOKEN_LINE)).toBeLessThan(out.indexOf("the add step"));
    });

    it.concurrent("OVIS_ADD=1 means the same as --add", async () => {
      const pc = new Pc();
      const { exitCode, out } = await pc.atTerminal("", { OVIS_ADD: "1" });
      expect(exitCode, out).toBe(0);
      expect(pc.addCalls()).toEqual([{ command: "add", rest: [], terminal: true }]);
    });

    it.concurrent("adds nothing without --add", async () => {
      const pc = new Pc();
      const { out, exitCode } = await pc.atTerminal("");
      expect(exitCode, out).toBe(0);
      expect(pc.addCalls()).toEqual([]);
      expect(out).toContain(ADD_LINE);
    });

    it.concurrent("never runs the add step under OVIS_NO_OPEN=1, and says what to run", async () => {
      // the app's own SSH installer sets it: that terminal is not the person's to answer at
      const pc = new Pc();
      const { out, exitCode } = await pc.atTerminal("--add", { OVIS_NO_OPEN: "1" });
      expect(exitCode, out).toBe(0);
      expect(pc.addCalls()).toEqual([]);
      expect(out).toContain(HINT_LINE);
    });

    it.concurrent("runs a release from before add by the name it knows, link", async () => {
      const pc = new Pc();
      pc.plugin("plugin", "link");
      const { exitCode, out } = await pc.atTerminal("--add");
      expect(exitCode, out).toBe(0);
      expect(pc.addCalls()).toEqual([{ command: "link", rest: [], terminal: true }]);
    });

    it.concurrent("says what to run on a release from before both", async () => {
      const pc = new Pc();
      pc.plugin("plugin", "neither");
      const { out, exitCode } = await pc.atTerminal("--add");
      expect(exitCode, out).toBe(0);
      expect(pc.addCalls()).toEqual([]);
      expect(out).toContain(HINT_LINE);
    });

    it.concurrent("an add that fails does not fail the install, and the way to add stays on the screen", async () => {
      const pc = new Pc().flag("add-fails");
      const { out, exitCode } = await pc.atTerminal("--add");
      expect(exitCode, out).toBe(0);
      expect(pc.addCalls()).toHaveLength(1);
      expect(out).toContain(ADD_LINE);
      expect(out.split(TOKEN_LINE)).toHaveLength(2);
    });

    it.concurrent("Ctrl-C ends the add, not the install", async () => {
      const pc = new Pc().flag("add-waits");
      const { out, exitCode } = await pc.atTerminal("--add", {}, { after: "waiting for an approval", text: CTRL_C });
      expect(exitCode, out).toBe(0);
      expect(pc.addCalls()).toHaveLength(1);
      expect(out).toContain(ADD_LINE);
      expect(out).toContain(TOKEN_LINE);
    });
  });
});
