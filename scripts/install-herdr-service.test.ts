import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * install.sh on a PC where herdr is not running (installed just now, or installed and stopped): it starts herdr's server
 * headless from a user service, so the app runs now and again after a restart, and says what runs. The functions are cut
 * out of install.sh itself and run under /bin/sh with a HOME of their own and stand-in herdr, systemctl, loginctl,
 * launchctl and id, so nothing on this PC is started or registered. scripts/install-service-docker.ts runs the real
 * thing in a container with systemd.
 */

const ROOT = join(import.meta.dir, "..");
const INSTALLER = readFileSync(join(ROOT, "install.sh"), "utf8");
function fn(name: string): string {
  const match = new RegExp(`^${name}\\(\\) \\{.*\\}$`, "m").exec(INSTALLER) ?? new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}$`, "m").exec(INSTALLER);
  if (!match) throw new Error(`install.sh defines no ${name}()`);
  return match[0];
}
const CONSTANTS = ["OVIS_HOME", "HERDR_SERVICE", "HERDR_AGENT_LABEL"].map((name) => {
  const line = new RegExp(`^${name}=.*$`, "m").exec(INSTALLER)?.[0];
  if (!line) throw new Error(`install.sh sets no ${name}`);
  return line;
}).join("\n");
const FUNCTIONS = ["say", "fail", "link", "quoted", "xml_text", "unit_text", "herdr_running", "keep_lingering", "start_herdr", "herdr_failed", "running_lines", "herdr_command"].map(fn).join("\n");

const dir = mkdtempSync(join(tmpdir(), "ovis-install-herdr-"));
afterAll(() => {
  // a stand-in herdr left running by a test that failed midway
  for (const file of readdirSync(dir).filter((name) => name.startsWith("home-")).map((home) => join(dir, home, "herdr.pid")).filter((file) => existsSync(file))) {
    try { process.kill(Number(readFileSync(file, "utf8")), "SIGKILL"); } catch {}
  }
  rmSync(dir, { recursive: true, force: true });
});

const SYSTEM = join(dir, "system");
mkdirSync(SYSTEM);
const own = new Set(["herdr", "systemctl", "loginctl", "launchctl", "id"]);
for (const from of ["/usr/bin", "/bin"].filter((system) => existsSync(system))) {
  for (const name of readdirSync(from)) {
    if (own.has(name) || !existsSync(join(from, name))) continue;
    own.add(name);
    symlinkSync(join(from, name), join(SYSTEM, name));
  }
}

/**
 * herdr as the installer sees it: `status server --json` answers from $HOME/up, and `server` comes up (or not, with
 * $HOME/broken) and stays, writing its pid where the test ends it, and a line on its output the installer must not carry.
 */
const HERDR = `case "$*" in
  "status server --json") if [ -e "$HOME/up" ]; then echo '{"running":true}'; else echo '{"running":false}'; fi ;;
  server)
    echo "herdr server $$" >> "$HOME/calls"
    [ ! -e "$HOME/broken" ] || { echo "herdr: broken" >&2; exit 1; }
    echo $$ > "$HOME/herdr.pid"
    echo "herdr server running"
    touch "$HOME/up"
    exec sleep 600 ;;
  *) echo "unexpected herdr $*" >&2; exit 1 ;;
esac`;
const recorder = (name: string, body = "") => `echo "${name} $*" >> "$HOME/calls"\n${body}`;
/** systemctl --user as a user manager answers it; its restart starts the unit's herdr as systemd would */
const SYSTEMCTL = recorder("systemctl", `case "$*" in
  "--user restart ovis-herdr.service") [ -e "$HOME/systemd-refuses" ] && exit 1; "$HOME/tools/herdr" server >/dev/null 2>&1 </dev/null & ;;
esac
exit 0`);

function pc(tools: Record<string, string> = {}): { home: string; bin: string; env: Record<string, string>; calls: () => string[]; stop: () => void } {
  const home = mkdtempSync(join(dir, "home-"));
  const bin = join(home, "tools");
  mkdirSync(bin);
  for (const [name, body] of Object.entries({ herdr: HERDR, ...tools })) writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const calls = () => existsSync(join(home, "calls")) ? readFileSync(join(home, "calls"), "utf8").trim().split("\n") : [];
  const stop = () => {
    if (!existsSync(join(home, "herdr.pid"))) return;
    try { process.kill(Number(readFileSync(join(home, "herdr.pid"), "utf8")), "SIGKILL"); } catch {}
  };
  return { home, bin, calls, stop, env: { HOME: home, PATH: `${bin}:${SYSTEM}`, XDG_CONFIG_HOME: "", TERM: "dumb" } };
}

function sh(call: string, env: Record<string, string>): { code: number; out: string; ms: number } {
  const started = performance.now();
  const run = Bun.spawnSync(["/bin/sh", "-c", `set -eu\n${CONSTANTS}\nterminal=0\n${FUNCTIONS}\n${call}`], { env, stdout: "pipe", stderr: "pipe", timeout: 40_000 });
  return { code: run.exitCode ?? -1, out: run.stdout.toString() + run.stderr.toString(), ms: performance.now() - started };
}

const id = `case "$1" in -u) echo 501 ;; -un) echo alice ;; esac`;

describe.skipIf(process.platform === "win32")("start_herdr on Linux, with a user systemd", () => {
  it("registers ovis-herdr.service, which starts herdr and never stops it, enables it and starts it now", () => {
    const linux = pc({ systemctl: SYSTEMCTL, loginctl: recorder("loginctl", `[ "$1" = show-user ] && echo yes`), id });
    try {
      const result = sh(`os=linux; start_herdr; echo "kept=$herdr_kept lingering=$lingering"`, linux.env);
      expect(result.code, result.out).toBe(0);
      expect(result.out).toContain("kept=systemd lingering=on");
      const unit = readFileSync(join(linux.home, ".config", "systemd", "user", "ovis-herdr.service"), "utf8");
      expect(unit).toBe(`[Unit]
Description=herdr for Ovis: herdr's server, headless, which starts Ovis

[Service]
Type=oneshot
RemainAfterExit=yes
KillMode=process
WorkingDirectory=~
Environment="PATH=${linux.env["PATH"]}"
ExecStart=/bin/sh -c '"$$0" server </dev/null &' "${linux.bin}/herdr"

[Install]
WantedBy=default.target
`);
      expect(unit).not.toContain("ExecStop");
      expect(linux.calls().filter((call) => call.startsWith("systemctl"))).toEqual([
        "systemctl --user show-environment", "systemctl --user daemon-reload", "systemctl --user enable ovis-herdr.service", "systemctl --user restart ovis-herdr.service",
      ]);
      // what herdr prints goes to the journal, never to the installer's own output
      expect(result.out).not.toContain("herdr server running");
    } finally { linux.stop(); }
  });

  it("writes the same unit byte for byte on a second run", () => {
    const linux = pc({ systemctl: SYSTEMCTL, loginctl: `[ "$1" = show-user ] && echo yes`, id });
    try {
      expect(sh("os=linux; start_herdr", linux.env).code).toBe(0);
      const unit = join(linux.home, ".config", "systemd", "user", "ovis-herdr.service");
      const first = readFileSync(unit, "utf8");
      linux.stop();
      rmSync(join(linux.home, "up"));
      expect(sh("os=linux; start_herdr", linux.env).code).toBe(0);
      expect(readFileSync(unit, "utf8")).toBe(first);
      expect(readdirSync(join(linux.home, ".config", "systemd", "user"))).toEqual(["ovis-herdr.service"]);
    } finally { linux.stop(); }
  });

  it("turns lingering on where it is off and no password is asked, and notes that it did", () => {
    const linux = pc({ systemctl: SYSTEMCTL, loginctl: recorder("loginctl", `[ "$1" = show-user ] && echo no; exit 0`), id });
    try {
      const result = sh(`os=linux; start_herdr; echo "lingering=$lingering"`, linux.env);
      expect(result.out).toContain("lingering=turned-on");
      expect(linux.calls()).toContain("loginctl --no-ask-password enable-linger alice");
      expect(readFileSync(join(linux.home, ".local", "share", "ovis", "lingering"), "utf8")).toBe("alice\n");
    } finally { linux.stop(); }
  });

  it("leaves lingering as it is where it is on, refused, or cannot be read, and notes nothing", () => {
    for (const [loginctl, state] of [[`[ "$1" = show-user ] && echo yes`, "on"], [`[ "$1" = show-user ] && { echo no; exit 0; }; exit 1`, "off"], ["exit 1", "unknown"]] as const) {
      const linux = pc({ systemctl: SYSTEMCTL, loginctl: recorder("loginctl", loginctl), id });
      try {
        const result = sh(`os=linux; start_herdr; echo "lingering=$lingering"`, linux.env);
        expect(result.out).toContain(`lingering=${state}`);
        expect(existsSync(join(linux.home, ".local", "share", "ovis", "lingering"))).toBe(false);
        if (state !== "off") expect(linux.calls().filter((call) => call.includes("enable-linger"))).toEqual([]);
      } finally { linux.stop(); }
    }
  });

  it("starts herdr once in the background where systemd does not take the unit, and says so", () => {
    const linux = pc({ systemctl: SYSTEMCTL, loginctl: "exit 1", id });
    writeFileSync(join(linux.home, "systemd-refuses"), "");
    try {
      const result = sh(`os=linux; start_herdr; echo "kept=$herdr_kept"`, linux.env);
      expect(result.code, result.out).toBe(0);
      expect(result.out).toContain("systemd did not take");
      expect(result.out).toContain("kept=once");
      expect(linux.calls().filter((call) => call.startsWith("herdr server"))).toHaveLength(1);
    } finally { linux.stop(); }
  });
});

describe.skipIf(process.platform === "win32")("start_herdr without a service manager", () => {
  it("starts herdr in a session of its own, with its output away from the installer's, and ends while herdr runs on", () => {
    const linux = pc();
    try {
      const result = sh(`os=linux; start_herdr; echo "kept=$herdr_kept"`, linux.env);
      expect(result.code, result.out).toBe(0);
      expect(result.out).toContain("kept=once");
      expect(result.out).not.toContain("herdr server running");
      // the run ended while herdr runs on: herdr holds none of its output, which a script reads to its end
      expect(result.ms).toBeLessThan(15_000);
      const pid = Number(readFileSync(join(linux.home, "herdr.pid"), "utf8"));
      expect(() => process.kill(pid, 0)).not.toThrow();
      if (process.platform === "linux") expect(readlinkSync(`/proc/${pid}/cwd`)).toBe(linux.home);
      if (Bun.which("setsid") && process.platform === "linux") {
        const session = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ")[3];
        expect(Number(session)).toBe(pid);
      }
    } finally { linux.stop(); }
  });

  it("says at once, not after its bound, when herdr does not come up, and where to see why", () => {
    const linux = pc();
    writeFileSync(join(linux.home, "broken"), "");
    const result = sh("os=linux; start_herdr || herdr_failed", linux.env);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain(`herdr did not start, so neither did the app; to see why: run ${linux.bin}/herdr server`);
    expect(result.ms).toBeLessThan(10_000);
  });
});

describe.skipIf(process.platform === "win32")("start_herdr on macOS", () => {
  const plistOf = (home: string) => join(home, "Library", "LaunchAgents", "sh.ovis.herdr-server.plist");
  /** launchd that loads the agent (its RunAtLoad starts herdr), or answers that it is loaded already ($HOME/loaded) */
  const LAUNCHCTL = recorder("launchctl", `case "$1" in
  print) [ -e "$HOME/loaded" ] ;;
  bootstrap) [ -e "$HOME/no-gui" ] && exit 5; "$HOME/tools/herdr" server >/dev/null 2>&1 </dev/null & ;;
  kickstart) "$HOME/tools/herdr" server >/dev/null 2>&1 </dev/null & ;;
esac`);

  it("loads the Mac app's LaunchAgent, which runs herdr server at login and leaves the server herdr hands over running", () => {
    const mac = pc({ launchctl: LAUNCHCTL, id });
    try {
      const result = sh(`os=darwin; start_herdr; echo "kept=$herdr_kept"`, mac.env);
      expect(result.code, result.out).toBe(0);
      expect(result.out).toContain("kept=launchd");
      const plist = readFileSync(plistOf(mac.home), "utf8");
      expect(plist).toContain("<key>Label</key><string>sh.ovis.herdr-server</string>");
      expect(plist).toContain(`<key>ProgramArguments</key><array><string>${mac.bin}/herdr</string><string>server</string></array>`);
      expect(plist).toContain("<key>RunAtLoad</key><true/>");
      expect(plist).toContain("<key>AbandonProcessGroup</key><true/>");
      expect(plist).toContain("<key>LC_CTYPE</key><string>UTF-8</string>");
      expect(plist).toContain(`<key>WorkingDirectory</key><string>${mac.home}</string>`);
      expect(plist).toContain(`<key>StandardOutPath</key><string>${mac.home}/Library/Logs/Ovis/herdr-server.log</string>`);
      expect(mac.calls().filter((call) => call.startsWith("launchctl"))).toEqual([
        "launchctl enable gui/501/sh.ovis.herdr-server", "launchctl print gui/501/sh.ovis.herdr-server", `launchctl bootstrap gui/501 ${plistOf(mac.home)}`,
      ]);
      const lint = process.platform === "darwin" ? ["plutil", "-lint", plistOf(mac.home)] : ["python3", "-c", "import plistlib, sys; plistlib.load(open(sys.argv[1], 'rb'))", plistOf(mac.home)];
      if (Bun.which(lint[0]!)) expect(Bun.spawnSync(lint).exitCode).toBe(0);
    } finally { mac.stop(); }
  });

  it("kicks an agent that is loaded already and never boots one out: it may run herdr with the user's agents", () => {
    const mac = pc({ launchctl: LAUNCHCTL, id });
    writeFileSync(join(mac.home, "loaded"), "");
    try {
      expect(sh("os=darwin; start_herdr", mac.env).code).toBe(0);
      const calls = mac.calls().filter((call) => call.startsWith("launchctl"));
      expect(calls).toEqual(["launchctl enable gui/501/sh.ovis.herdr-server", "launchctl print gui/501/sh.ovis.herdr-server", "launchctl kickstart gui/501/sh.ovis.herdr-server"]);
      expect(calls.some((call) => call.includes("bootout"))).toBe(false);
    } finally { mac.stop(); }
  });

  it("starts herdr in the background where there is no login at the screen, and leaves the agent for the next one", () => {
    const mac = pc({ launchctl: LAUNCHCTL, id });
    writeFileSync(join(mac.home, "no-gui"), "");
    try {
      const result = sh(`os=darwin; start_herdr; echo "kept=$herdr_kept"`, mac.env);
      expect(result.code, result.out).toBe(0);
      expect(result.out).toContain("kept=login");
      expect(existsSync(plistOf(mac.home))).toBe(true);
      expect(mac.calls().filter((call) => call.startsWith("herdr server"))).toHaveLength(1);
    } finally { mac.stop(); }
  });
});

describe.skipIf(process.platform === "win32")("running_lines", () => {
  const ovis = (running: boolean) => `ovis_cli() { ${running ? `echo "running http://127.0.0.1:7317 (pid 4242)"` : "echo stopped"}; }; ovis_command() { printf ovis; }; original_path=$PATH; herdr_bin=$(command -v herdr); runtime=herdr`;
  const lines = (state: string, tools: Record<string, string> = {}) => {
    const { env } = pc({ id, ...tools });
    return sh(`${ovis(true)}; ${state}; running_lines`, env).out;
  };

  it("says where Ovis runs, what starts it again, how to see it and how to stop it", () => {
    const systemd = lines("herdr_kept=systemd; lingering=turned-on");
    expect(systemd).toContain("Ovis: Ovis runs now at http://127.0.0.1:7317, in herdr, which the user service ovis-herdr starts again whenever this PC starts, with nobody logged in (systemctl --user status ovis-herdr)\n");
    expect(systemd).toContain("Ovis: see it: ovis status. Stop it: ovis stop (it starts again with herdr). Stop herdr and every terminal in it: herdr server stop\n");
    expect(systemd).toContain("Ovis: lingering is on for alice now, so herdr runs with nobody logged in; the guide's Uninstall turns it off again\n");
    const login = lines("herdr_kept=systemd; lingering=off");
    expect(login).toContain("which the user service ovis-herdr starts again at your next login");
    expect(login).toContain("Ovis: to keep herdr and Ovis running after you log out, and start them when this PC starts, run once: loginctl enable-linger alice\n");
    expect(lines("herdr_kept=once; lingering=")).toContain("which was started in the background: this PC has no user service manager, so after a restart run this installer again");
    expect(lines("herdr_kept=launchd; lingering=")).toContain("which launchd starts again at your login (");
    // herdr ran before the install: nothing of it is the installer's to tell how to stop
    const before = lines("herdr_kept=; lingering=");
    expect(before).toContain("Ovis: Ovis runs now at http://127.0.0.1:7317, and starts whenever herdr does. See it: ovis status. Stop it: ovis stop\n");
    expect(before).not.toContain("server stop");
  });

  it("says nothing of a server that does not run", () => {
    const { env } = pc({ id });
    expect(sh(`${ovis(false)}; herdr_kept=systemd; lingering=on; running_lines`, env).out).toBe("");
  });
});

describe.skipIf(process.platform === "win32")("the guide's Uninstall", () => {
  const guide = readFileSync(join(ROOT, "docs", "guide.md"), "utf8");
  const uninstall = guide.slice(guide.indexOf("### Uninstall"), guide.indexOf("## How Ovis fits with herdr"));
  const line = (word: string) => uninstall.split("\n").find((text) => text.includes(word) && !text.trimStart().startsWith("#")) ?? "";
  const paste = (text: string, env: Record<string, string>) => Bun.spawnSync(["/bin/sh", "-c", text], { env, stdout: "pipe", stderr: "pipe", timeout: 20_000 });

  it("removes the service the installer made without stopping herdr, and turns lingering off only where the installer turned it on", () => {
    const linux = pc({ systemctl: SYSTEMCTL, loginctl: recorder("loginctl", `[ "$1" = show-user ] && echo no; exit 0`), id });
    try {
      expect(sh("os=linux; start_herdr", linux.env).code).toBe(0);
      const before = linux.calls().length;
      for (const word of ["ovis-herdr", "lingering"]) expect(paste(line(word), linux.env).exitCode, line(word)).toBe(0);
      const calls = linux.calls().slice(before);
      expect(calls).toContain("systemctl --user disable ovis-herdr");
      expect(calls.some((call) => / (stop|kill)\b/.test(call))).toBe(false);
      expect(calls).toContain("loginctl disable-linger");
      expect(existsSync(join(linux.home, ".config", "systemd", "user", "ovis-herdr.service"))).toBe(false);
      expect(existsSync(join(linux.home, ".local", "share", "ovis", "lingering"))).toBe(false);
      // herdr and its terminals run on
      expect(() => process.kill(Number(readFileSync(join(linux.home, "herdr.pid"), "utf8")), 0)).not.toThrow();
    } finally { linux.stop(); }
    const lingered = pc({ systemctl: SYSTEMCTL, loginctl: recorder("loginctl", `[ "$1" = show-user ] && echo yes`), id });
    try {
      expect(sh("os=linux; start_herdr", lingered.env).code).toBe(0);
      paste(line("lingering"), lingered.env);
      expect(lingered.calls().filter((call) => call.includes("disable-linger"))).toEqual([]);
    } finally { lingered.stop(); }
  });

  it("disables and removes the LaunchAgent on macOS without booting it out", () => {
    const mac = pc({ launchctl: recorder("launchctl"), id });
    mkdirSync(join(mac.home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(join(mac.home, "Library", "LaunchAgents", "sh.ovis.herdr-server.plist"), "<plist/>");
    expect(paste(line("sh.ovis.herdr-server"), mac.env).exitCode).toBe(0);
    expect(mac.calls()).toEqual(["launchctl disable gui/501/sh.ovis.herdr-server"]);
    expect(existsSync(join(mac.home, "Library", "LaunchAgents", "sh.ovis.herdr-server.plist"))).toBe(false);
  });
});
