import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { version } from "../package.json";
import { DEFAULT_PORT } from "../shared/protocol.ts";
import { ENTRIES } from "../server/entries.ts";
import { LEAVE_ALL } from "../tui/host/guard.ts";
import * as libc from "./libc.ts";
import { importClosure, read } from "./source-scan.ts";
import { callerEnv, isBare, launchTui, opensScreen, screenStart, shellEnv, systemParts, tuiEnv, waiterCommand, WINDOWS_MESSAGE, type LaunchParts, type Probe } from "./plugin-tui.ts";
import { findHc } from "../server/herdr-core/discovery.ts";
import { runOnPty, stopAllPtyRuns } from "../tui/testing/pty.ts";

const ROOT = join(import.meta.dir, "..");
let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "ovis-plugin-tui-"));
});

afterEach(() => {
  // a test that made a folder read-only gives it back first, so it can be removed
  for (const dir of [join(scratch, "config")]) if (existsSync(dir)) chmodSync(dir, 0o755);
  rmSync(scratch, { recursive: true, force: true });
});

const SOCKET = "/scratch/hc.sock";
/** a home with nothing in it: hc's own config.toml is looked for under it, never under the real one */
const HOME = "/nonexistent-home";


interface Fake {
  /** what the launcher did, in order: probe, ask, find, start, wait, run, kill, on and off */
  readonly calls: string[];
  /** each stderr line's stable code */
  readonly codes: () => string[];
  readonly said: string[];
  readonly runs: { command: readonly string[]; env: Record<string, string>; cwd: string | undefined }[];
  readonly parts: LaunchParts;
}

/**
 * The launcher's parts as data: `probes` answer the connects in turn (the last one again after that), `answer` is the
 * line typed at the question, `hc` what the finder finds, `started` the exit of `hc server start`, `end` the screen's.
 */
function fake(options: { flushed?: boolean; probes?: Probe[]; answer?: string | null; hc?: string | null; started?: number; end?: number; over?: Partial<LaunchParts> } = {}): Fake {
  const calls: string[] = [];
  const said: string[] = [];
  const runs: Fake["runs"] = [];
  const probes = [...options.probes ?? [{ kind: "core" } as const]];
  let clock = 0;
  const parts: LaunchParts = {
    platform: "linux",
    isTty: true,
    caller: { HOME, HC_SOCKET: SOCKET, PATH: "/usr/bin" },
    settings: {},
    screen: { command: ["screen"], cwd: "/install", file: null },
    folder: "/home/me/project",
    probe: async (socket) => {
      calls.push(`probe ${socket}`);
      return probes.length > 1 ? probes.shift()! : probes[0]!;
    },
    findHc: async () => {
      calls.push("find");
      return options.hc === undefined ? "/bin/hc" : options.hc;
    },
    startCore: async (hc) => {
      calls.push(`start ${hc}`);
      return { code: options.started ?? 0, err: options.started ? "it broke\n" : "" };
    },
    discard: () => {
      calls.push("discard");
      return options.flushed ?? true;
    },
    ask: async () => {
      calls.push("ask");
      return options.answer === undefined ? "" : options.answer;
    },
    handOver: async (command, run) => {
      calls.push(`run ${command.join(" ")}`);
      runs.push({ command, ...run });
      return options.end ?? 0;
    },
    err: (text) => { said.push(text); },
    now: () => clock,
    wait: async (ms) => {
      calls.push("wait");
      clock += ms;
    },
    ...options.over,
  };
  const codes = () => said.flatMap((text) => [...text.matchAll(/^ovis tui: ([a-z_]+): /gm)].map((match) => match[1]!));
  return { calls, codes, said, runs, parts };
}

/** the launcher's work, without its signal listeners */
const work = (calls: string[]) => calls.filter((call) => !/^(on|off) /.test(call));
const RAN = ["probe /scratch/hc.sock", "run screen"];
const STARTED = ["probe /scratch/hc.sock", "discard", "ask", "find", "start /bin/hc", "probe /scratch/hc.sock", "wait", "probe /scratch/hc.sock", "run screen"];
const none: Probe = { kind: "none" };
const core: Probe = { kind: "core" };

describe("the launch decision table", () => {
  const rows: [name: string, options: Parameters<typeof fake>[0], argv: string[], exit: number, calls: string[], codes: string[]][] = [
    ["win32 runs nothing", { over: { platform: "win32" } }, [], 1, [], []],
    ["a core answers: the screen, nothing asked", {}, [], 0, RAN, []],
    ["on macOS too", { over: { platform: "darwin" } }, [], 0, RAN, []],
    ["the screen's exit code is the launcher's", { end: 3 }, [], 3, RAN, []],
    ["no core, Enter: hc found, a core started, the screen once it answers", { probes: [none, none, core] }, [], 0, STARTED, []],
    ["no core, y", { probes: [none, none, core], answer: "y" }, [], 0, STARTED, []],
    ["no core, Yes with blanks", { probes: [none, none, core], answer: " Yes " }, [], 0, STARTED, []],
    ["a flush that cannot run still asks, and a yes still starts", { probes: [none, none, core], flushed: false }, [], 0, STARTED, []],
    ["no core, n: the start command, nothing started", { probes: [none], answer: "n" }, [], 1, ["probe /scratch/hc.sock", "discard", "ask"], ["no_core"]],
    ["no core, no", { probes: [none], answer: "no" }, [], 1, ["probe /scratch/hc.sock", "discard", "ask"], ["no_core"]],
    ["no core, any other answer", { probes: [none], answer: "maybe" }, [], 1, ["probe /scratch/hc.sock", "discard", "ask"], ["no_core"]],
    ["no core, the input ended", { probes: [none], answer: null }, [], 1, ["probe /scratch/hc.sock", "discard", "ask"], ["no_core"]],
    ["not a terminal, no core: the start command, nothing asked", { probes: [none], over: { isTty: false } }, [], 1, ["probe /scratch/hc.sock"], ["no_core"]],
    ["not a terminal, a core: no screen", { over: { isTty: false } }, [], 1, ["probe /scratch/hc.sock"], ["not_a_terminal"]],
    ["no hc program: one line, nothing started", { probes: [none], hc: null }, [], 1, ["probe /scratch/hc.sock", "discard", "ask", "find"], ["no_hc"]],
    ["hc server start fails: no screen", { probes: [none], started: 3 }, [], 1, ["probe /scratch/hc.sock", "discard", "ask", "find", "start /bin/hc"], ["start_failed"]],
    ["a connect that fails otherwise: nothing asked or started", { probes: [{ kind: "failed", code: "closed", reason: "EACCES" }] }, [], 1, ["probe /scratch/hc.sock"], ["closed"]],
    ["-h goes to the screen's entry as it is, nothing probed, at a terminal or not", { over: { isTty: false } }, ["-h"], 0, ["run screen -h"], []],
    ["-V and a wrong argument too", {}, ["-V", "--bad"], 0, ["run screen -V --bad"], []],
  ];

  it.each(rows)("%s", async (_, options, argv, exit, calls, codes) => {
    const run = fake(options);
    expect(await launchTui(argv, run.parts)).toBe(exit);
    expect(work(run.calls)).toEqual(calls);
    expect(run.codes()).toEqual(codes);
    if (options?.over?.platform === "win32") expect(run.said).toEqual([WINDOWS_MESSAGE]);
  });

  it("waits 30 s for a core it started, trying every 100 ms, then gives up without the screen", async () => {
    const run = fake({ probes: [none] });
    expect(await launchTui([], run.parts)).toBe(1);
    expect(run.calls.filter((call) => call.startsWith("probe")).length).toBe(1 + 300);
    expect(run.calls.filter((call) => call === "wait").length).toBe(300);
    expect(run.runs).toEqual([]);
    expect(run.codes()).toEqual(["no_answer"]);
  });

  it("says once that OVIS_TUI_BIN is no longer used, from the caller or the settings, and runs the screen", async () => {
    for (const over of [{ caller: { HOME, HC_SOCKET: SOCKET, OVIS_TUI_BIN: "/opt/ovis-tui" } }, { settings: { OVIS_TUI_BIN: "~/ovis-tui" } }]) {
      const run = fake({ over });
      expect(await launchTui([], run.parts)).toBe(0);
      expect(run.codes()).toEqual(["tui_bin_unused"]);
      expect(work(run.calls)).toEqual(RAN);
    }
  });
});

describe("core choice", () => {
  const caller = { HC_SOCKET: "/run/me/caller.sock", HC_SESSION: "caller", PATH: "/usr/bin" };
  const settings = { HC_SOCKET: "/run/me/settings.sock", HC_SESSION: "ovis" };
  const picked = (env: Record<string, string | undefined>) => ({ HC_SOCKET: env["HC_SOCKET"], HC_SESSION: env["HC_SESSION"] });

  it.each([
    ["a flag over everything, clearing an inherited HC_SOCKET", "work", caller, settings, { HC_SOCKET: undefined, HC_SESSION: "work" }],
    ["the caller's socket over the settings", null, { HC_SOCKET: "/run/me/caller.sock" }, settings, { HC_SOCKET: "/run/me/caller.sock", HC_SESSION: undefined }],
    ["the caller's session over the settings", null, { HC_SESSION: "caller" }, settings, { HC_SOCKET: undefined, HC_SESSION: "caller" }],
    ["the settings when the caller names no core", null, { PATH: "/usr/bin" }, settings, settings],
    ["a session the settings name alone", null, {}, { HC_SESSION: "ovis" }, { HC_SOCKET: undefined, HC_SESSION: "ovis" }],
    ["hc's default when nobody names one", null, { PATH: "/usr/bin" }, {}, { HC_SOCKET: undefined, HC_SESSION: undefined }],
  ] as const)("%s", async (_, session, from, set, expected) => {
    const run = fake({ over: { caller: { HOME, XDG_RUNTIME_DIR: "/run/test", ...from }, settings: set } });
    expect(await launchTui(session === null ? [] : ["--session", session], run.parts)).toBe(0);
    expect(picked(run.runs[0]!.env)).toEqual(expected);
  });

  it("is what the screen gets in its environment, without the Ovis server's token", async () => {
    const run = fake({ over: { caller: { HOME, HC_SOCKET: SOCKET, XDG_RUNTIME_DIR: "/run/test", OVIS_TOKEN: "secret", PATH: "/usr/bin" } } });
    expect(await launchTui(["--session", "work"], run.parts)).toBe(0);
    expect(work(run.calls)).toEqual(["probe /run/test/herdr-core/work.sock", "run screen"]);
    // the app's address as `ovis status` reaches it (no token: the screen holds none)
    const app = `http://127.0.0.1:${DEFAULT_PORT}`;
    expect(run.runs[0]!.env).toEqual({ HOME, HC_SESSION: "work", XDG_RUNTIME_DIR: "/run/test", PATH: "/usr/bin", OVIS_TUI_CWD: "/home/me/project", OVIS_TUI_SERVER: app });
    const fromSettings = fake({ over: { caller: { HOME, XDG_RUNTIME_DIR: "/run/test" }, settings: { HC_SESSION: "ovis", OVIS_TOKEN: "secret" } } });
    expect(await launchTui([], fromSettings.parts)).toBe(0);
    expect(work(fromSettings.calls)).toEqual(["probe /run/test/herdr-core/ovis.sock", "run screen"]);
    expect(fromSettings.runs[0]!.env).toEqual({ HOME, HC_SESSION: "ovis", XDG_RUNTIME_DIR: "/run/test", OVIS_TUI_CWD: "/home/me/project", OVIS_TUI_SERVER: app });
    // the settings' PORT and HOST name it, a bind to every address reached on loopback
    const moved = fake({ over: { caller: { HOME, XDG_RUNTIME_DIR: "/run/test" }, settings: { PORT: "18555", HOST: "0.0.0.0" } } });
    expect(await launchTui([], moved.parts)).toBe(0);
    expect(moved.runs[0]!.env["OVIS_TUI_SERVER"]).toBe("http://127.0.0.1:18555");
  });

  it.each([
    ["the caller's socket", [], { HC_SOCKET: "/run/me/hc.sock" }, {}, "HC_SOCKET=/run/me/hc.sock hc server start"],
    ["a flag over an inherited socket", ["--session", "work"], { HC_SOCKET: "/run/me/hc.sock" }, {}, "env -u HC_SOCKET HC_SESSION=work hc server start"],
    ["the settings' session", [], {}, { HC_SESSION: "ovis" }, "HC_SESSION=ovis hc server start"],
    ["hc's default", [], {}, {}, "hc server start"],
    ["a path a shell would split", [], { HC_SOCKET: "/run/my core/it's.sock" }, {}, "HC_SOCKET='/run/my core/it'\\''s.sock' hc server start"],
  ])("prints the exact start command for %s", async (_, argv, caller, settings, command) => {
    const run = fake({ probes: [none], answer: "n", over: { caller: { HOME, XDG_RUNTIME_DIR: "/run/test", ...caller }, settings } });
    expect(await launchTui(argv, run.parts)).toBe(1);
    expect(run.said.join("").split("\n")[1]).toBe(`  ${command}`);
  });
});

/** The waiter run as a child (the launcher becomes it with execve): its exit code, what it wrote, and the child itself. */
function waiterChild(script: string | readonly string[], env: Record<string, string> = {}, input = "") {
  const child = Bun.spawn(waiterCommand(typeof script === "string" ? ["/bin/sh", "-c", script] : script, env), { env: { PATH: "/usr/bin:/bin" }, cwd: scratch, stdin: new Blob([input]), stdout: "pipe", stderr: "inherit" });
  return { child, out: new Response(child.stdout).text() };
}

/** `LaunchParts.handOver` for a test: the real waiter, as a child that inherits the test's stdio. */
async function waiterRun(command: readonly string[], options: { env: Record<string, string>; cwd: string }): Promise<number> {
  return Bun.spawn(waiterCommand(command, options.env), { env: { PATH: "/usr/bin:/bin" }, cwd: options.cwd, stdin: "ignore", stdout: "inherit", stderr: "inherit" }).exited;
}

describe("the waiter the screen runs under", () => {
  it("hands the terminal over: the screen runs under the waiter, with exactly its environment and stdin, and its exit code", async () => {
    const run = fake();
    expect(await launchTui([], run.parts)).toBe(0);
    expect(run.calls).toEqual(["probe /scratch/hc.sock", "run screen"]);
    const env = waiterChild(["/usr/bin/env"], { A: "1", B: "x=y z" });
    expect(await env.child.exited).toBe(0);
    expect(await env.out).toBe("A=1\nB=x=y z\n");
    const typed = waiterChild('read line; echo "got:$line"; exit 3', {}, "typed\n");
    expect(await typed.child.exited).toBe(3);
    expect(await typed.out).toBe("got:typed\n");
  });

  it.skipIf(process.platform === "win32")("undoes the screen's modes after a signal the screen cannot catch, and nothing after its own ends", async () => {
    const killed = waiterChild("kill -KILL $$");
    expect(await killed.child.exited).toBe(128 + 9);
    expect(await killed.out).toBe(LEAVE_ALL);
    for (const [script, code] of [["exit 0", 0], ["exit 143", 143], ["kill -TERM $$", 143], ["kill -HUP $$", 129]] as const) {
      const ended = waiterChild(script);
      expect(await ended.child.exited).toBe(code);
      expect(await ended.out).toBe("");
    }
  });

  it.skipIf(process.platform === "win32")("on a real terminal writes the settings it read back after a SIGKILL, and leaves them after the screen's own end", async () => {
    // the settings as stty lists them, without PENDIN: macOS's kernel sets that flag by itself when a terminal leaves raw mode
    const quote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;
    for (const [screen, settings, code] of [["stty raw -echo; kill -KILL $$", "same", 137], ["stty raw -echo; exit 0", "changed", 0]] as const) {
      const waiter = waiterCommand(["/bin/sh", "-c", screen], { PATH: "/usr/bin:/bin" }).map(quote).join(" ");
      const run = runOnPty({ command: ["/bin/sh", "-c", `s() { stty -a | sed "s/-*pendin//g"; }; before=$(s); ${waiter}; code=$?; [ "$before" = "$(s)" ] && w=same || w=changed; echo "END $w $code"`], env: { PATH: "/usr/bin:/bin" }, cols: 80, rows: 24, deadlineMs: 20_000 });
      await run.until(/END \w+ \d+/);
      expect(/END (\w+) (\d+)/.exec(run.output())!.slice(1)).toEqual([settings, String(code)]);
      expect(run.output().includes(LEAVE_ALL)).toBe(code !== 0);
      await run.exited;
    }
  }, 30_000);

  it.skipIf(process.platform === "win32")("passes a SIGTERM or SIGHUP sent to it alone on to the screen at once, also right behind a SIGINT, which ends nothing", async () => {
    // the system's own /bin/sh (dash on Linux, bash 3.2 on macOS), twenty times each with no gap between the two signals
    for (const [signal, code] of [["SIGTERM", 143], ["SIGHUP", 129]] as const) {
      for (let round = 0; round < 20; round++) {
        const child = Bun.spawn(waiterCommand(["/bin/sh", "-c", "echo up; exec sleep 30"], {}), { env: { PATH: "/usr/bin:/bin" }, cwd: scratch, stdin: "ignore", stdout: "pipe", stderr: "inherit" });
        // the screen said it is up: the waiter set its traps before it started the screen
        const first = await child.stdout.getReader().read();
        expect(new TextDecoder().decode(first.value)).toBe("up\n");
        child.kill("SIGINT");
        child.kill(signal);
        expect([round, await child.exited]).toEqual([round, code]);
      }
    }
  }, 30_000);
});

describe("the shell's environment", () => {
  /** the shell every measured case ran under */
  const SHELL = { PATH: "/usr/bin", HOME: "/home/me", SHELLV: "shell" };

  it("drops the cross-file and nested-default repro without losing PATH, HOME or TERM", async () => {
    writeFileSync(join(scratch, ".env"), [
      "DB_HOST=localhost", "DEFAULT_TOKEN=tok_123", "TOKEN=${TOKEN_OVERRIDE:-$DEFAULT_TOKEN}", 'WINDIR="C:\\repos\\app"',
      "TZ=UTC", "HC_API_KEY=canary", "PATH=/wrong", "HOME=/wrong", "TERM=dumb",
    ].join("\n"));
    writeFileSync(join(scratch, ".env.local"), "DATABASE_URL=postgres://app:canary@$DB_HOST/app\n");
    const shell = {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: scratch, TERM: "xterm-256color",
      PORT: "1", HERDR_PLUGIN_CONFIG_DIR: join(scratch, "config"), HC_SOCKET: join(scratch, "hc.sock"),
      HERDR_TEST_SESSION: "row60-repro", XDG_RUNTIME_DIR: join(scratch, "run"),
    };
    const child = Bun.spawn([process.execPath, "-e", `
      import { callerEnv } from ${JSON.stringify(join(ROOT, "scripts", "plugin-tui.ts"))};
      const names = ["DB_HOST", "DEFAULT_TOKEN", "TOKEN", "WINDIR", "TZ", "HC_API_KEY", "DATABASE_URL"];
      console.log(JSON.stringify({
        loaded: names.filter(name => Object.hasOwn(process.env, name)),
        caller: callerEnv({ kernel: () => null, env: process.env, cwd: process.cwd() }),
      }));
    `], { cwd: scratch, env: shell, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [text, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, err).toBe(0);
    const { loaded, caller } = JSON.parse(text);
    expect(loaded).toEqual(["DB_HOST", "DEFAULT_TOKEN", "TOKEN", "WINDIR", "TZ", "HC_API_KEY", "DATABASE_URL"]);
    expect(caller).toMatchObject(shell);
    expect(loaded.filter((name: string) => Object.hasOwn(caller, name))).toEqual([]);
  });

  it.each([
    ["cross-file reference", "K=$LOWER\n"],
    ["nested default", "K=${MISSING:-${OTHER:-$HOME}}\n"],
    ["single quotes", "K='pa$$word'\n"],
    ["carriage returns", 'K="a\\r\\nb"\r\n'],
    ["non-ASCII blanks", "K=\u00a0value\u3000\n"],
    ["Unicode line separator in a value", "K=a\u2028b\n"],
    ["empty braces", "K=${}\n"],
    ["unquoted comment", "K=value#comment\n"],
    ["quoted multiline value", 'K="first\nsecond"\n'],
    ["BOM, export and colon", "\ufeff export K : value\r\n"],
    ["lone CR", "OTHER=value\rK=value\r"],
    ["line break before the delimiter", "export\nK\n = value\n"],
    ["dotted and dashed key", "K=other\nk.dash-key=value\n"],
  ])("fallback drops the name regardless of its value: %s", (_, dotenv) => {
    const env = { ...SHELL, K: "a different shell value", "k.dash-key": "shell" };
    expect(shellEnv({ kernel: null, env, dotenv: [dotenv] })).toEqual(
      dotenv.includes("k.dash-key") ? SHELL : { ...SHELL, "k.dash-key": "shell" },
    );
  });

  it.each(["PATH", "HOME", "TERM", "USER", "LOGNAME", "SHELL"])("fallback keeps %s even when named by a file", (name) => {
    expect(shellEnv({ kernel: null, env: { [name]: "shell" }, dotenv: [`${name}=shell\n`] })).toEqual({ [name]: "shell" });
  });

  it("fallback drops every optional setting named by .env, including routing names", () => {
    const env = { HC_SOCKET: "/scratch/file.sock", HC_SESSION: "file", TZ: "UTC", TMPDIR: "/file", HC_API_KEY: "canary", XDG_CONFIG_HOME: "/file-config", LC_SECRET: "canary" };
    const dotenv = Object.entries(env).map(([name, value]) => `${name}=${value}`).join("\n");
    expect(shellEnv({ kernel: null, env: { ...SHELL, ...env }, dotenv: [dotenv] })).toEqual(SHELL);
  });

  it("is the kernel's copy where it can be read, whatever Bun added from the folder", () => {
    expect(shellEnv({ kernel: "PATH=/usr/bin\0HOME=/home/me\0DOUBLE=shell\0EMPTY=\0WITH_EQ=a=b\0", env: { ...SHELL, FROM_FILE: "x" }, dotenv: ["FROM_FILE=x\n"] }))
      .toEqual({ PATH: "/usr/bin", HOME: "/home/me", DOUBLE: "shell", EMPTY: "", WITH_EQ: "a=b" });
  });

  it.each([".env", ".env.local", ".env.development", ".env.development.local", ".env.production", ".env.production.local", ".env.test", ".env.test.local"])(
    "rebuilt from the working folder, %s is read",
    (file) => {
      const folder = join(scratch, "project");
      mkdirSync(folder);
      writeFileSync(join(folder, file), "FROM_FILE=x\n");
      expect(callerEnv({ kernel: () => null, env: { ...SHELL, FROM_FILE: "x" }, cwd: folder })).toEqual(SHELL);
      expect(callerEnv({ kernel: () => "ONLY=kernel\0", env: { ...SHELL, FROM_FILE: "x" }, cwd: folder })).toEqual({ ONLY: "kernel" });
    },
  );
});

describe("macOS exec-time environment", () => {
  function procArgs(argc: number, bytes: string): Buffer {
    const header = Buffer.alloc(4);
    header.writeInt32LE(argc);
    // Exercise a view into a larger buffer as well as a buffer allocated at offset zero.
    return Buffer.concat([Buffer.from("prefix"), header, Buffer.from(bytes)]).subarray(6);
  }

  it("reads env after the exec path, NUL padding and exactly argc arguments", () => {
    const bytes = procArgs(3, "/bin/bun\0\0\0bun\0\0ARG=not-env\0EMPTY=\0KEPT=a=b\0\0");
    expect(libc.parseProcArgs(bytes)).toBe("EMPTY=\0KEPT=a=b\0");
  });

  it("accepts a complete block containing no environment", () => {
    expect(libc.parseProcArgs(procArgs(1, "/bin/bun\0\0bun\0\0"))).toBe("");
  });

  it("excludes Darwin startup metadata even when there is no padding after env", () => {
    const bytes = procArgs(1, "/bin/bun\0bun\0pfz=0x111\0KEPT=yes\0pfz=0x123\0stack_guard=0x456\0");
    expect(libc.parseProcArgs(bytes)).toBe("pfz=0x111\0KEPT=yes\0");
  });

  it("keeps a shell name resembling Darwin metadata when the kernel zeroes the first apple records", () => {
    expect(libc.parseProcArgs(procArgs(1, "/bin/bun\0bun\0pfz=0x111\0KEPT=yes\0\0\0main_stack=0x456\0"))).toBe("pfz=0x111\0KEPT=yes\0");
  });

  it.each([
    ["short argc", Buffer.from([1, 0, 0])],
    ["negative argc", procArgs(-1, "/bin/bun\0\0bun\0A=x\0")],
    ["missing exec path", procArgs(1, "\0bun\0A=x\0")],
    ["unterminated exec path", procArgs(1, "/bin/bun")],
    ["missing argv", procArgs(1, "/bin/bun\0\0")],
    ["unterminated argv", procArgs(2, "/bin/bun\0\0bun\0truncated")],
    ["unterminated env", procArgs(1, "/bin/bun\0\0bun\0A=x\0B=y")],
  ])("returns null for %s so callerEnv uses its fallback", (_, bytes) => {
    expect(libc.parseProcArgs(bytes)).toBeNull();
    writeFileSync(join(scratch, ".env"), "DROPPED=yes\n");
    expect(callerEnv({ kernel: () => libc.parseProcArgs(bytes), env: { PATH: "/bin", DROPPED: "yes" }, cwd: scratch })).toEqual({ PATH: "/bin" });
  });
});

describe("the screen's start", () => {
  it("is the entry `tui` in the install's own folder: from source by its file and without a .env, compiled by name", () => {
    expect(ENTRIES.tui).toBe("tui/main.ts");
    expect(existsSync(join(ROOT, ENTRIES.tui))).toBe(true);
    expect(screenStart(false, "/src/ovis")).toEqual({ command: [process.execPath, "--no-env-file", "/src/ovis/tui/main.ts"], cwd: "/src/ovis", file: "/src/ovis/tui/main.ts" });
    expect(screenStart(true, "/home/me/.local/share/ovis/bin")).toEqual({ command: [process.execPath, "tui"], cwd: "/home/me/.local/share/ovis/bin", file: null });
  });

  it("says in one line with a code that the screen's file is missing, and starts nothing", async () => {
    const run = fake({ over: { screen: { command: ["screen"], cwd: "/install", file: join(scratch, "gone", "tui", "main.ts") } } });
    expect(await launchTui([], run.parts)).toBe(1);
    expect(run.codes()).toEqual(["screen_missing"]);
    expect(run.said.join("").trimEnd().split("\n").length).toBe(1);
    expect(run.runs).toEqual([]);
  });

  it("keeps the screen's view, emulator and core link out of the launcher, even through type imports", () => {
    const { reached } = importClosure("scripts/plugin.ts", (path) => existsSync(join(ROOT, path)) ? read(path) : undefined);
    expect(reached).toContain("scripts/plugin-tui.ts");
    expect(reached.filter((file) => /^tui\/(view|emulator|core)\//.test(file))).toEqual([]);
  });

  it("gives the screen the caller's environment without the Ovis server's token or address", () => {
    expect(tuiEnv({ TERM: "xterm", OVIS_TOKEN: "exported", OVIS_URL: "http://127.0.0.1:9", HERDR_WEB_TOKEN: "old-name", HC_SESSION: "s" }))
      .toEqual({ TERM: "xterm", HC_SESSION: "s" });
  });
});

describe.skipIf(process.platform === "win32")("a recording stand-in hc", () => {
  /** an hc that answers --version and records the environment `server start` got */
  function standIn(): { bin: string; record: string } {
    const bin = join(scratch, "bin", "hc");
    const record = join(scratch, "hc-env");
    mkdirSync(join(scratch, "bin"), { recursive: true });
    writeFileSync(bin, `#!/bin/sh\ncase "$1" in\n  --version) echo "hc 0.1.18" ;;\n  server) env > '${record}' ;;\n  *) exit 9 ;;\nesac\n`);
    chmodSync(bin, 0o755);
    return { bin, record };
  }
  const recorded = (file: string) => Object.fromEntries(readFileSync(file, "utf8").split("\n").filter((line) => line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));

  const launching = { OVIS_TOKEN: "secret", OVIS_URL: "http://127.0.0.1:7317", PORT: "7317", HERDR_PANE_ID: "w1:p1", BUN_BE_BUN: "1", HC_TERMINAL_ID: "t-1", SSH_TTY: "/dev/pts/3", SSH_CONNECTION: "10.0.0.2 5000 10.0.0.1 22", SSH_CLIENT: "10.0.0.2 5000 22", SSH_AUTH_SOCK: "/tmp/ssh-x/agent.1", TMUX: "/tmp/tmux-1/default,1,0", TMUX_PANE: "%1", STY: "1.pts-1.host", WINDOWID: "42" };

  function parts(answer: string, caller: Record<string, string>) {
    return fake({ probes: [none, core], answer, over: { ...withSystem(caller), caller } });
  }
  /** the system's finder and starter for `caller`, as the launcher runs them */
  function withSystem(caller: Record<string, string>): Partial<LaunchParts> {
    const system = systemParts(caller, scratch);
    return { findHc: system.findHc, startCore: system.startCore, settings: system.settings };
  }

  it("is found where the settings name it, and starts its core without the launch's own names", async () => {
    const { bin, record } = standIn();
    mkdirSync(join(scratch, ".config", "ovis"), { recursive: true });
    writeFileSync(join(scratch, ".config", "ovis", "env"), `OVIS_HC_BIN=${bin}\n`);
    const kept = { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: scratch, HC_SOCKET: join(scratch, "run", "hc.sock"), XDG_RUNTIME_DIR: join(scratch, "run"), XDG_STATE_HOME: join(scratch, "state"), LANG: "C.UTF-8" };
    const run = parts("y", { ...kept, ...launching });
    expect(await launchTui([], run.parts)).toBe(0);
    const env = recorded(record);
    expect(Object.keys(launching).filter((name) => name in env)).toEqual([]);
    expect(env).toMatchObject(kept);
    expect(run.runs.length).toBe(1);
  });

  it("starts nothing on n", async () => {
    const { bin, record } = standIn();
    const run = parts("n", { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: scratch, HC_SOCKET: join(scratch, "hc.sock"), OVIS_HC_BIN: bin });
    expect(await launchTui([], run.parts)).toBe(1);
    expect(existsSync(record)).toBe(false);
    expect(run.runs).toEqual([]);
  });

  it("dotenv canary: a .env in the working folder reaches neither the stand-in hc nor the screen, by either path", async () => {
    // a real Bun started in the folder loads its .env as the launcher's own Bun does; the driver then runs the launcher
    // with the kernel's copy (Linux) and with the rebuild (as on macOS), a stand-in hc and a screen that records its env
    const project = join(scratch, "project");
    const out = join(scratch, "out");
    mkdirSync(project);
    mkdirSync(out);
    mkdirSync(join(scratch, ".config", "ovis"), { recursive: true });
    writeFileSync(join(project, ".env"), "OVIS_TOKEN=canary\nCANARY_GENERIC=canary\nDOTENV_SECRET='pa$$word'\nH1=a#b\nDOUBLE=fromfile\n");
    writeFileSync(join(project, ".env.local"), "LOCAL_ONLY=canary\n");
    const hc = join(scratch, "hc");
    writeFileSync(hc, `#!/bin/sh\ncase "$1" in\n  --version) echo "hc 0.1.18" ;;\n  server) env > "$CANARY_OUT/hc.env" ;;\nesac\n`);
    chmodSync(hc, 0o755);
    writeFileSync(join(scratch, ".config", "ovis", "env"), `OVIS_HC_BIN=${hc}\n`);
    const recorder = join(scratch, "screen.ts");
    writeFileSync(recorder, "await Bun.write(`${process.env.CANARY_OUT}/screen.json`, JSON.stringify(process.env));\n");
    const driver = join(scratch, "driver.ts");
    writeFileSync(driver, `import { renameSync } from "node:fs";
import { callerEnv, kernelEnv, launchTui, systemParts, waiterCommand } from ${JSON.stringify(join(ROOT, "scripts", "plugin-tui.ts"))};
const out = process.env.CANARY_OUT;
for (const path of ["kernel", "fallback"]) {
  const kernel = path === "kernel" ? kernelEnv() : null;
  if (path === "kernel" && kernel === null) throw new Error("could not read the exec-time environment");
  const caller = callerEnv({ kernel: () => kernel, env: process.env, cwd: process.cwd() });
  if (path === "kernel" && caller.DOUBLE !== "fromshell") throw new Error("kernel snapshot lost the shell's DOUBLE");
  let probes = 0;
  const code = await launchTui([], {
    ...systemParts(caller, caller.HOME), isTty: true, probe: async () => ({ kind: probes++ === 0 ? "none" : "core" }), discard: () => true, ask: async () => "y",
    screen: { command: [process.execPath, "--no-env-file", ${JSON.stringify(recorder)}], cwd: out, file: null },
    // the real waiter as a child: the system's handOver would replace this driver
    handOver: (command, options) => Bun.spawn(waiterCommand(command, options.env), { env: { PATH: "/usr/bin:/bin" }, cwd: options.cwd, stdin: "ignore", stdout: "ignore", stderr: "inherit" }).exited,
    wait: async () => {},
  });
  renameSync(out + "/screen.json", out + "/screen-" + path + ".json");
  renameSync(out + "/hc.env", out + "/hc-" + path + ".env");
  console.log(path + " " + code);
}
`);
    const shell = {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: scratch, HC_SOCKET: join(scratch, "hc.sock"),
      HERDR_TEST_SESSION: "row60-canary", XDG_RUNTIME_DIR: join(scratch, "run"), PORT: "1",
      HERDR_PLUGIN_CONFIG_DIR: join(scratch, ".config", "ovis"), DOUBLE: "fromshell", CANARY_OUT: out,
    };
    const child = Bun.spawn([process.execPath, driver], { cwd: project, env: shell, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [said, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, err).toBe(0);
    const paths = ["kernel", "fallback"];
    expect(said.trim().split("\n")).toEqual(paths.map((path) => `${path} 0`));
    for (const path of paths) {
      const screen = JSON.parse(readFileSync(join(out, `screen-${path}.json`), "utf8")) as Record<string, string>;
      const core = recorded(join(out, `hc-${path}.env`));
      for (const env of [screen, core]) {
        expect(["OVIS_TOKEN", "CANARY_GENERIC", "DOTENV_SECRET", "H1", "LOCAL_ONLY"].filter((name) => name in env)).toEqual([]);
        expect([env["DOUBLE"], env["HOME"], env["PATH"]]).toEqual([path === "kernel" ? "fromshell" : undefined, scratch, shell.PATH]);
      }
      expect(screen["OVIS_TUI_CWD"]).toBe(project);
    }
  }, 30_000);

  it("from source, the screen loads no .env of the folder it runs in", async () => {
    const folder = join(scratch, "install");
    mkdirSync(folder);
    writeFileSync(join(folder, ".env"), "OVIS_TOKEN=canary\nCANARY_GENERIC=x\n");
    const screenRecord = join(scratch, "screen-env");
    const recorder = join(scratch, "screen.ts");
    writeFileSync(recorder, `await Bun.write(${JSON.stringify(screenRecord)}, [process.env.OVIS_TOKEN, process.env.CANARY_GENERIC].join(","));\n`);
    const caller = { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: scratch, HC_SOCKET: join(scratch, "hc.sock") };
    const start = screenStart(false, folder);
    const run = fake({ over: { caller, screen: { command: [...start.command.slice(0, -1), recorder], cwd: start.cwd, file: recorder }, handOver: waiterRun } });
    expect(await launchTui([], run.parts)).toBe(0);
    expect(readFileSync(screenRecord, "utf8")).toBe(",");
  }, 30_000);
});

describe.skipIf(process.platform === "win32" || process.getuid?.() === 0)("ovis tui through scripts/plugin.ts", () => {
  /** every path and size under `dir`, so a write anywhere shows, but Bun's own cache of the code it ran (`~/.bun`) */
  function listing(dir: string): string[] {
    return readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((path) => !/^\.bun(\/|$)/.test(path)).sort().map((path) => `${path} ${statSync(join(dir, path)).size}`);
  }

  it("screen path writes no config: with the config folder read-only it works, and the folder's listing is unchanged", async () => {
    // an install from before the rename: plugin.ts's own work at import would copy these settings to the new id's dir
    const config = join(scratch, "config");
    mkdirSync(join(config, "devswha.herdr-web-ui"), { recursive: true });
    writeFileSync(join(config, "devswha.herdr-web-ui", ".env"), "OVIS_TOKEN=legacy\n");
    chmodSync(config, 0o555);
    const before = listing(scratch);
    const socket = join(scratch, "run", "hc.sock");
    const env = {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: scratch, HC_SOCKET: socket,
      HERDR_TEST_SESSION: "row60-config", XDG_RUNTIME_DIR: join(scratch, "run"), PORT: "1",
      HERDR_PLUGIN_CONFIG_DIR: join(config, "devswha.ovis"), BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    };
    const run = async (word: string) => {
      const child = Bun.spawn([process.execPath, "scripts/plugin.ts", word], { cwd: ROOT, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { out, err, code };
    };
    const tui = await run("tui");
    expect(tui.code, tui.err).toBe(1);
    expect(tui.err.split("\n").slice(0, 2)).toEqual([expect.stringMatching(/^ovis tui: no_core: /), `  HC_SOCKET=${socket} hc server start`]);
    for (const word of ["--version", "-V"]) expect(await run(word)).toEqual({ out: `${version}\n`, err: "", code: 0 });
    for (const word of ["help", "-h"]) expect(await run(word)).toMatchObject({ err: "", code: 0 });
    expect(listing(scratch)).toEqual(before);
  }, 30_000);
});

describe("a bare ovis: when it opens the screen", () => {
  const SCREEN = true;
  const STATUS = false;
  const rows: [name: string, argv: string[], over: Partial<LaunchParts>, hc: string | null, opens: boolean, finds: boolean][] = [
    ["no argument at a terminal, hc found: the screen", [], {}, "/bin/hc", SCREEN, true],
    ["on macOS too", [], { platform: "darwin" }, "/bin/hc", SCREEN, true],
    ["--session NAME at a terminal: the screen on that session", ["--session", "work"], {}, "/bin/hc", SCREEN, true],
    ["--session=NAME too", ["--session=work"], {}, "/bin/hc", SCREEN, true],
    ["--session with no value: the screen's entry answers it", ["--session"], {}, "/bin/hc", SCREEN, true],
    ["no hc program on this PC: status", [], {}, null, STATUS, true],
    ["--session NAME and no hc program: as before", ["--session", "work"], {}, null, STATUS, true],
    ["a pipe or a script (stdin or stdout not a terminal): status, hc not even looked for", [], { isTty: false }, "/bin/hc", STATUS, false],
    ["--session NAME on a pipe: as before", ["--session", "work"], { isTty: false }, "/bin/hc", STATUS, false],
    ["win32: status, hc not looked for", [], { platform: "win32" }, "/bin/hc", STATUS, false],
    ["an empty word is a command word", [""], {}, "/bin/hc", STATUS, false],
    ["status stays explicit", ["status"], {}, "/bin/hc", STATUS, false],
    ["tui stays explicit", ["tui"], {}, "/bin/hc", STATUS, false],
    ["a flag that is not --session is no bare call", ["--bogus"], {}, "/bin/hc", STATUS, false],
    ["a word that only starts like --session is no bare call", ["--sessions"], {}, "/bin/hc", STATUS, false],
  ];

  it.each(rows)("%s", async (_, argv, over, hc, opens, finds) => {
    const run = fake({ hc, over: { settings: { OVIS_HC_BIN: "/from/settings" }, ...over } });
    expect(await opensScreen(argv, run.parts)).toBe(opens);
    expect(run.calls).toEqual(finds ? ["find"] : []);
  });

  it("looks for hc in the caller's environment with the settings' on top, as the launcher does", async () => {
    let seen: Record<string, string | undefined> = {};
    const run = fake({ over: { caller: { PATH: "/usr/bin", OVIS_HC_BIN: "/caller", KEEP: "1" }, settings: { OVIS_HC_BIN: "/settings" }, findHc: async (env) => { seen = { ...env }; return "/bin/hc"; } } });
    expect(await opensScreen([], run.parts)).toBe(true);
    expect(seen).toEqual({ PATH: "/usr/bin", OVIS_HC_BIN: "/settings", KEEP: "1" });
  });

  it("isBare: no word, or a first word that is --session or --session=", () => {
    expect([[], ["--session"], ["--session", "a"], ["--session=a"], ["--session="]].map((argv) => isBare(argv))).toEqual([true, true, true, true, true]);
    expect([[""], ["status"], ["-h"], ["--sessionx"], ["a", "--session"]].map((argv) => isBare(argv))).toEqual([false, false, false, false, false]);
  });
});

/**
 * Whether the finder gets an hc from the folders it always looks in (/usr/local/bin, /opt/homebrew/bin) whatever the PATH:
 * on such a PC a case that needs one with no hc cannot be built.
 */
const SYSTEM_HC = (await findHc({ env: { PATH: "/nonexistent" }, home: "/nonexistent-home", loginShellPath: async () => null })) !== null;

describe.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a bare ovis through scripts/plugin.ts", () => {
  const PLUGIN = join(ROOT, "scripts", "plugin.ts");
  afterEach(stopAllPtyRuns);

  /**
   * The shell's environment: everything that could name a core, a config or a program lies in the scratch folder: its
   * home and XDG folders (a `--session` flag discards HC_SOCKET and the core is then looked for under XDG_RUNTIME_DIR),
   * a PATH of one empty folder of its own, a core's socket nobody listens on, and a server port nothing answers on.
   */
  function env(hc: string | null): Record<string, string> {
    mkdirSync(join(scratch, "path"), { recursive: true });
    return {
      PATH: join(scratch, "path"), HOME: scratch, TERM: "xterm-256color", TMPDIR: process.env["TMPDIR"] ?? tmpdir(),
      XDG_RUNTIME_DIR: join(scratch, "run"), XDG_CONFIG_HOME: join(scratch, ".config"), XDG_STATE_HOME: join(scratch, ".local", "state"),
      HC_SOCKET: join(scratch, "run", "hc.sock"), PORT: "1", HERDR_PLUGIN_STATE_DIR: join(scratch, "state"), HERDR_PLUGIN_CONFIG_DIR: join(scratch, "cfg"),
      OVIS_HC_BIN: hc ?? join(scratch, "no-such-hc"),
    };
  }
  /** what `status` prints on this port with no server: the content a silenced program would lack, so no comparison passes on two empty outputs */
  const expectStatus = (text: string) => {
    expect(text).toStartWith("down http://127.0.0.1:1\n");
    expect(text).toContain("config: none (settings go in ");
  };
  /** an hc that answers --version and records any other call */
  function standIn(): { bin: string; record: string } {
    const bin = join(scratch, "bin", "hc");
    const record = join(scratch, "hc-called");
    mkdirSync(join(scratch, "bin"), { recursive: true });
    writeFileSync(bin, `#!/bin/sh\ncase "$1" in\n  --version) echo "hc 0.1.18" ;;\n  *) echo "$@" >> '${record}' ;;\nesac\n`);
    chmodSync(bin, 0o755);
    return { bin, record };
  }
  /** the command on pipes (stdin and stdout are no terminal) */
  async function piped(args: string[], hc: string | null, stdin: "ignore" | "pipe" = "ignore") {
    const child = Bun.spawn([process.execPath, PLUGIN, ...args], { cwd: ROOT, env: env(hc), stdin, stdout: "pipe", stderr: "pipe" });
    if (stdin === "pipe") child.stdin!.end();
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { out, err, code };
  }
  /** the command on a pseudo-terminal, from the root of the checkout; `shell` is what runs there */
  const onPty = (shell: string, hc: string | null) => runOnPty({ command: ["/bin/sh", "-c", `cd '${ROOT}' && ${shell}`], env: env(hc), cols: 100, rows: 30, deadlineMs: 50_000 });

  it("on pipes prints the status text byte for byte and exits as `status` does, hc or not", async () => {
    const { bin, record } = standIn();
    const status = await piped(["status"], bin);
    expectStatus(status.out);
    for (const hc of [bin, null]) for (const stdin of ["ignore", "pipe"] as const) expect(await piped([], hc, stdin)).toEqual(status);
    expect(existsSync(record)).toBe(false);
  }, 60_000);

  it("with stdout a pipe but stdin a terminal, prints the status text, no escape byte, and asks nothing", async () => {
    const { bin, record } = standIn();
    const status = await piped(["status"], bin);
    const run = onPty(`'${process.execPath}' scripts/plugin.ts | /bin/cat`, bin);
    expect(await run.exited).toBe(0);
    expectStatus(run.output().replaceAll("\r\n", "\n"));
    expect(run.output().replaceAll("\r\n", "\n")).toBe(status.out);
    expect(run.output()).not.toContain("\x1b");
    expect(existsSync(record)).toBe(false);
  }, 60_000);

  it.skipIf(SYSTEM_HC)("at a terminal with no hc program prints the status text as before (not run on a PC with hc in a system folder)", async () => {
    const status = await piped(["status"], null);
    const run = onPty(`'${process.execPath}' scripts/plugin.ts`, null);
    expect(await run.exited).toBe(0);
    expectStatus(run.output().replaceAll("\r\n", "\n"));
    expect(run.output().replaceAll("\r\n", "\n")).toBe(status.out);
  }, 60_000);

  it("with stdin not a terminal and stdout a terminal prints the status text, asks nothing and starts nothing", async () => {
    const { bin, record } = standIn();
    const status = await piped(["status"], bin);
    const run = onPty(`'${process.execPath}' scripts/plugin.ts </dev/null`, bin);
    expect(await run.exited).toBe(0);
    expectStatus(run.output().replaceAll("\r\n", "\n"));
    expect(run.output().replaceAll("\r\n", "\n")).toBe(status.out);
    expect(run.output()).not.toContain("[Y/n]");
    expect(existsSync(record)).toBe(false);
  }, 60_000);

  it("at a terminal with hc and no core opens the launcher: the question, and n prints the start command and starts nothing", async () => {
    const { bin, record } = standIn();
    const run = onPty(`'${process.execPath}' scripts/plugin.ts`, bin);
    await run.until("[Y/n]", "the question");
    run.type("n\r");
    await run.until(`HC_SOCKET=${join(scratch, "run", "hc.sock")} hc server start`, "the start command");
    expect(await run.exited).toBe(1);
    expect(existsSync(record)).toBe(false);
  }, 60_000);

  it("--session NAME at a terminal reaches the launcher with that session", async () => {
    const { bin, record } = standIn();
    const run = onPty(`'${process.execPath}' scripts/plugin.ts --session work`, bin);
    await run.until("[Y/n]", "the question");
    run.type("n\r");
    // the flag discards HC_SOCKET: the core is looked for under the scratch XDG_RUNTIME_DIR, never the user's runtime folder
    await run.until(`not running at ${join(scratch, "run", "herdr-core", "work.sock")};`, "the socket of the session, in the scratch folder");
    await run.until("HC_SESSION=work hc server start", "the start command for the session");
    expect(await run.exited).toBe(1);
    expect(existsSync(record)).toBe(false);
  }, 60_000);

  it("--session NAME on pipes is no bare call: the usage, exit 2, as before", async () => {
    const run = await piped(["--session", "work"], null);
    expect(run.code).toBe(2);
    expect(run.err).toStartWith("usage: bun scripts/plugin.ts");
    expect(run.out).toBe("");
  }, 60_000);
});
