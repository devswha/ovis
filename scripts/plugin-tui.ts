/**
 * `ovis tui`: Ovis's own screen of herdr-core's terminals (tui/main.ts, the entry `tui`) in this terminal.
 * scripts/plugin.ts hands the command here before its own work at import, so it reads and writes nothing of Ovis's
 * state or config dirs. Its `--help` is the command line's own (scripts/plugin-cli.ts), like every command's.
 *
 * The launcher finds the core the screen joins, starts the screen as a child and stays until it ends: it gives the
 * terminal back when the screen died by a signal. When no core answers, it asks before it starts one; no other path
 * starts a core. It asks the Ovis server nothing and takes no turn in the plugin's lifecycle lock.
 */
import { existsSync, readFileSync, readSync, writeSync } from "node:fs";
import { constants, homedir } from "node:os";
import { join } from "node:path";
import { isatty } from "node:tty";
import { FFIType } from "bun:ffi";
import { COMPILED, entryCommand, ROOT } from "../server/entries.ts";
import { mergeEnvLayers } from "../server/legacy-env.ts";
import { coreLaunchEnv } from "../server/herdr-core/core-env.ts";
import { coreSocket } from "../server/herdr-core/core-socket.ts";
import { LEAVE_ALL } from "../tui/host/guard.ts";
import { EXIT_FAILED, parseArgs, SCREEN_FOLDER, targetEnv } from "../tui/start.ts";
import { openLibc } from "../tui/host/libc.ts";
import { discardTyped, macExecEnv } from "./libc.ts";
import { ENV_FILES, ownDir, readEnvFile } from "./plugin-settings.ts";

type Env = Readonly<Record<string, string | undefined>>;

/** The setting that named the old hc-tui program: the screen is part of Ovis now. */
const TUI_BIN_VARIABLE = "OVIS_TUI_BIN";

/** What the screen never gets: it talks to herdr-core alone. */
const WITHHELD = ["OVIS_TOKEN", "OVIS_URL", "HERDR_WEB_TOKEN", "HC_SCOPE"] as const;

/** The screen's environment: the caller's (with the chosen core), without the Ovis server's token or address. */
export function tuiEnv(caller: Env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(caller)) if (value !== undefined && !(WITHHELD as readonly string[]).includes(key)) env[key] = value;
  return env;
}

/**
 * The `.env` files Bun loads from the working folder when it starts, for every mode (NODE_ENV) at once: `.env`,
 * `.env.local`, `.env.<mode>` and `.env.<mode>.local`. More files than one mode loads only drops more names below.
 */
const DOTENV_FILES = [".env", ".env.local", ...["development", "production", "test"].flatMap((mode) => [`.env.${mode}`, `.env.${mode}.local`])];

const BASIC_SHELL_NAMES = new Set(["PATH", "HOME", "TERM", "USER", "LOGNAME", "SHELL"]);

/**
 * The environment the user's shell gave this process, without what Bun took from the working folder at its start (the
 * `.env` files; a `bunfig.toml` preload runs before any of this). Prefer the NUL-separated copy from the kernel.
 * Without it, drop every name the files assign regardless of the value, except the six basic shell names.
 */
export function shellEnv(from: { kernel: string | null; env: Env; dotenv: readonly string[] }): Record<string, string> {
  if (from.kernel !== null) {
    return Object.fromEntries(from.kernel.split("\0").filter((entry) => entry.indexOf("=") > 0).map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]));
  }
  const given = new Set<string>();
  // Scan names only: an assignment-looking line inside a quoted value can only make this more conservative.
  for (const text of from.dotenv) for (const [, name] of text.matchAll(/^\s*(?:export\s+)?([A-Za-z0-9_.-]+)\s*[=:]/gm)) {
    if (name !== undefined) given.add(name);
  }
  return Object.fromEntries(Object.entries(from.env).filter((entry): entry is [string, string] => entry[1] !== undefined && (BASIC_SHELL_NAMES.has(entry[0]) || !given.has(entry[0]))));
}

/** The Linux or macOS copy of the environment this process was started with, untouched by Bun's `.env` loading. */
export function kernelEnv(): string | null {
  if (process.platform === "darwin") return macExecEnv();
  if (process.platform !== "linux") return null;
  try { return readFileSync("/proc/self/environ", "utf8"); } catch { return null; }
}

/** Prefer the kernel's copy; only read the folder's `.env` files on the fallback path. */
export function callerEnv(from: { kernel: () => string | null; env: Env; cwd: string }): Record<string, string> {
  const kernel = from.kernel();
  const read = (file: string) => {
    try { return readFileSync(file, "utf8"); } catch { return null; }
  };
  const dotenv = kernel !== null ? [] : DOTENV_FILES.map((name) => read(join(from.cwd, name))).filter((text): text is string => text !== null);
  return shellEnv({ kernel, env: from.env, dotenv });
}

export const WINDOWS_MESSAGE = "ovis tui: the terminal client runs on Linux and macOS only.\n";

const QUESTION = "herdr-core is not running. Start it? [Y/n] ";

/** How long a core `hc server start` started has to answer a connect, and how often one is tried meanwhile. */
const CORE_WAIT_MS = 30_000;
const CORE_RETRY_MS = 100;

/**
 * The core the screen joins, as the environment the screen and a core it starts get: a `--session` flag (it clears an
 * inherited HC_SOCKET), else HC_SOCKET or HC_SESSION of the caller, else the ones Ovis's settings files name (the
 * installer writes them there), else hc's own `default`.
 */
function coreChoice(session: string | null, caller: Env, settings: Env): Record<string, string | undefined> {
  if (session !== null) return targetEnv(caller, session);
  const named = (env: Env) => Boolean(env["HC_SOCKET"]) || Boolean(env["HC_SESSION"]);
  if (named(caller) || !named(settings)) return { ...caller };
  return { ...caller, HC_SOCKET: settings["HC_SOCKET"] || undefined, HC_SESSION: settings["HC_SESSION"] || undefined };
}

const shellWord = (value: string) => (/^[A-Za-z0-9_./:=@%+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`);

/** The command that starts the chosen core from the caller's shell, the core's names written out. */
function startCommand(chosen: Env, caller: Env): string {
  const words = caller["HC_SOCKET"] && !chosen["HC_SOCKET"] ? ["env", "-u", "HC_SOCKET"] : [];
  for (const name of ["HC_SOCKET", "HC_SESSION"]) if (chosen[name]) words.push(`${name}=${shellWord(chosen[name]!)}`);
  return [...words, "hc", "server", "start"].join(" ");
}

/** Enter (an empty line), `y` or `yes` starts a core; `n`, the end of the input and anything else do not. */
const saidYes = (line: string | null) => line !== null && ["", "y", "yes"].includes(line.trim().toLowerCase());

/** One connect to a core's socket: something accepts it, nothing listens there, or the connect failed otherwise. */
export type Probe = { kind: "core" } | { kind: "none" } | { kind: "failed"; code: string; reason: string };

/** The screen as a child process. */
export interface Screen {
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  kill(signal: NodeJS.Signals): void;
}

/** How the screen is started: the entry `tui`, the folder it runs in, and its file from source (null: compiled in). */
export interface ScreenStart {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly file: string | null;
}

/**
 * The screen runs in the install's own folder, never the caller's: Bun loads the `.env` files and runs the
 * `bunfig.toml` preload of its working folder, and a compiled Bun program does so whatever it is told. From source
 * Bun is also told to load no `.env`, as a checkout may hold one for a dev server. (Exported for its table test: which
 * binary runs is fixed at build time, and the seam is smaller than building one per case.)
 */
export function screenStart(compiled: boolean = COMPILED, root: string = ROOT): ScreenStart {
  const [bin, entry] = entryCommand("tui", root, compiled);
  return compiled ? { command: [bin, entry], cwd: root, file: null } : { command: [bin, "--no-env-file", entry], cwd: root, file: entry };
}

/** The terminal's settings, read before the screen starts and written back when it died by a signal. */
export interface TerminalSettings {
  save(): Uint8Array | null;
  restore(saved: Uint8Array): void;
  write(bytes: string): void;
}

/** Everything the launcher touches outside itself, so each case can be run without a terminal, a core or hc. */
export interface LaunchParts {
  readonly platform: NodeJS.Platform;
  /** stdin and stdout are both terminals */
  readonly isTty: boolean;
  /** the caller's environment */
  readonly caller: Env;
  /** Ovis's settings files (`env`, `.env`) */
  readonly settings: Env;
  readonly screen: ScreenStart;
  /** the folder `ovis tui` was typed in: a new workspace starts there, the first one too */
  readonly folder: string;
  probe(socket: string): Promise<Probe>;
  /** hc with its trust checks, without the login shell's PATH; null when there is none */
  findHc(env: Env): Promise<string | null>;
  /** `hc server start` in `env`: its exit code, and what it said on stderr */
  startCore(hc: string, env: Record<string, string>): Promise<{ code: number; err: string }>;
  /** throws away what was typed and not read yet; false where it cannot (the question is asked all the same) */
  discard(): boolean;
  /** the question at the terminal, in cooked mode: the line typed, or null at the end of the input */
  ask(question: string): Promise<string | null>;
  run(command: readonly string[], options: { env: Record<string, string>; cwd: string }): Screen;
  readonly terminal: TerminalSettings;
  /** listens for a signal; what it returns stops listening */
  on(signal: "SIGINT" | "SIGTERM" | "SIGHUP", handler: () => void): () => void;
  err(text: string): void;
  now(): number;
  wait(ms: number): Promise<void>;
}

/**
 * `ovis tui [--session NAME]`: the screen on the chosen core, with a yes asked before a core is started; `-h`, `-V` and
 * a wrong argument go to the screen's entry as they are, which answers them. The exit code is the screen's, 128 + the
 * signal that ended it, or 1 when it did not start.
 */
export async function launchTui(argv: readonly string[], parts: LaunchParts): Promise<number> {
  const say = (code: string, text: string) => parts.err(`ovis tui: ${code}: ${text}\n`);
  if (parts.platform === "win32") {
    parts.err(WINDOWS_MESSAGE);
    return EXIT_FAILED;
  }
  const args = parseArgs(argv);
  if (args.kind !== "run") return runScreen([...argv], tuiEnv(parts.caller), parts);
  if (parts.caller[TUI_BIN_VARIABLE] || parts.settings[TUI_BIN_VARIABLE]) say("tui_bin_unused", `${TUI_BIN_VARIABLE} is no longer used: the screen is part of Ovis now`);
  const chosen = coreChoice(args.session, parts.caller, parts.settings);
  const target = coreSocket({ env: chosen });
  const found = await parts.probe(target.path);
  if (found.kind === "failed") {
    say(found.code, found.reason);
    return EXIT_FAILED;
  }
  if (found.kind === "none") {
    const refused = () => {
      say("no_core", `herdr-core session ${target.session} is not running at ${target.path}; start it with:\n  ${startCommand(chosen, parts.caller)}`);
      return EXIT_FAILED;
    };
    if (!parts.isTty) return refused();
    // what was typed before the question is no answer to it: an Enter typed ahead would start a core unread
    parts.discard();
    if (!saidYes(await parts.ask(QUESTION))) return refused();
    const hc = await parts.findHc({ ...parts.caller, ...parts.settings });
    if (hc === null) {
      say("no_hc", "no herdr-core (hc) program was found on this PC; install it, or name it with OVIS_HC_BIN");
      return EXIT_FAILED;
    }
    const started = await parts.startCore(hc, coreLaunchEnv(chosen));
    if (started.code !== 0) {
      say("start_failed", `${hc} server start exited ${started.code}${started.err.trim() === "" ? "" : `: ${started.err.trim()}`}`);
      return EXIT_FAILED;
    }
    let answered = false;
    for (const deadline = parts.now() + CORE_WAIT_MS; !answered && parts.now() < deadline; ) {
      answered = (await parts.probe(target.path)).kind === "core";
      if (!answered) await parts.wait(CORE_RETRY_MS);
    }
    if (!answered) {
      say("no_answer", `herdr-core was started but did not answer at ${target.path} within ${CORE_WAIT_MS / 1000} s`);
      return EXIT_FAILED;
    }
  }
  if (!parts.isTty) {
    say("not_a_terminal", "stdin and stdout must both be a terminal");
    return EXIT_FAILED;
  }
  return runScreen([], { ...tuiEnv(chosen), [SCREEN_FOLDER]: parts.folder }, parts);
}

/**
 * Runs the screen with the terminal handed over and stays until it ends. The screen holds the terminal in raw mode and
 * owns Ctrl+C, so a SIGINT sent to the whole group is ignored from before it starts; a SIGTERM or SIGHUP sent to this
 * process alone is passed on. A screen that died by a signal could not give the terminal back: this process writes back
 * the settings it read before the start and undoes every mode the screen's host can turn on. After any other end it writes
 * nothing: the screen gave the terminal back itself, and popping the keyboard protocol twice would take the shell's own.
 */
async function runScreen(argv: string[], env: Record<string, string>, parts: LaunchParts): Promise<number> {
  const offs = [parts.on("SIGINT", () => undefined)];
  let child: Screen | undefined;
  for (const signal of ["SIGTERM", "SIGHUP"] as const) offs.push(parts.on(signal, () => child?.kill(signal)));
  try {
    // Bun's own "Module not found" would be all a user saw of an install that lost the screen's file
    if (parts.screen.file !== null && !existsSync(parts.screen.file)) {
      parts.err(`ovis tui: screen_missing: the screen's file ${parts.screen.file} is missing; reinstall Ovis\n`);
      return EXIT_FAILED;
    }
    const saved = parts.terminal.save();
    try {
      child = parts.run([...parts.screen.command, ...argv], { env, cwd: parts.screen.cwd });
    } catch (error) {
      parts.err(`ovis tui: start_failed: the screen could not be started: ${error instanceof Error ? error.message : String(error)}\n`);
      return EXIT_FAILED;
    }
    const end = await child.exited;
    if (end.signal === null) return end.code ?? EXIT_FAILED;
    if (saved !== null) parts.terminal.restore(saved);
    parts.terminal.write(LEAVE_ALL);
    return 128 + (constants.signals[end.signal] ?? 0);
  } finally {
    for (const off of offs) off();
  }
}

/** Bytes enough for any system's `struct termios` (60 on Linux, 72 on macOS). */
const TERMIOS_BYTES = 256;
const TCSANOW = 0;

/** The terminal on stdin and stdout, its settings through the C library; nothing where that cannot be opened. */
function systemTerminal(): TerminalSettings {
  const libc = openLibc({
    tcgetattr: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
    tcsetattr: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  });
  return {
    save: () => {
      const saved = new Uint8Array(TERMIOS_BYTES);
      return libc !== null && libc.symbols.tcgetattr(0, saved) === 0 ? saved : null;
    },
    restore: (saved) => { libc?.symbols.tcsetattr(0, TCSANOW, saved); },
    write: (bytes) => {
      try { writeSync(1, bytes); } catch { /* the terminal is gone: nothing to give back */ }
    },
  };
}

/** A line typed at the terminal in cooked mode, read straight from fd 0 so no reader stays to take the screen's keys. */
function readLine(): string | null {
  const bytes: number[] = [];
  const one = Buffer.alloc(1);
  for (;;) {
    let read = 0;
    try { read = readSync(0, one, 0, 1, null); } catch { return null; }
    if (read === 0) return bytes.length === 0 ? null : Buffer.from(bytes).toString("utf8");
    if (one[0] === 0x0a) return Buffer.from(bytes).toString("utf8");
    bytes.push(one[0]!);
  }
}

/** Ovis's settings files, read where plugin.ts reads them, without asking herdr for its config dir. */
function readSettings(env: Env, home: string): Env {
  const dir = env["HERDR_PLUGIN_CONFIG_DIR"] ?? ownDir(join(home, ".config"));
  return mergeEnvLayers(ENV_FILES.map((name) => join(dir, name)).filter((file) => existsSync(file)).map(readEnvFile));
}

/** The launcher's parts on this system for a caller's environment and home: the process's terminal and signals, Bun.spawn, hc. */
export function systemParts(caller: Env, home: string): LaunchParts {
  return {
    platform: process.platform,
    isTty: isatty(0) && isatty(1),
    caller,
    settings: readSettings(caller, home),
    screen: screenStart(),
    folder: process.cwd(),
    probe: async (socket) => {
      const { connectCoreSocket } = await import("../server/herdr-core/socket-transport.ts");
      try {
        (await connectCoreSocket(socket)).kill();
        return { kind: "core" };
      } catch (error) {
        const kind = (error as { kind?: unknown }).kind;
        if (kind === "no_core") return { kind: "none" };
        return { kind: "failed", code: typeof kind === "string" ? kind : "connect_failed", reason: error instanceof Error ? error.message : String(error) };
      }
    },
    findHc: async (env) => {
      const { findHc } = await import("../server/herdr-core/discovery.ts");
      return (await findHc({ env, loginShellPath: async () => null }))?.bin ?? null;
    },
    startCore: async (hc, env) => {
      const child = Bun.spawn([hc, "server", "start"], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { code, err };
    },
    discard: discardTyped,
    ask: async (question) => {
      try { writeSync(1, question); } catch { return null; }
      return readLine();
    },
    run: (command, options) => {
      const child = Bun.spawn([...command], { env: options.env, cwd: options.cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      return { exited: child.exited.then((code) => ({ code: child.signalCode === null ? code : null, signal: child.signalCode as NodeJS.Signals | null })), kill: (signal) => child.kill(signal) };
    },
    terminal: systemTerminal(),
    on: (signal, handler) => {
      process.on(signal, handler);
      return () => process.off(signal, handler);
    },
    err: (text) => process.stderr.write(text),
    now: () => performance.now(),
    // fixed wait: the pause between two connects of launchTui's loop, which CORE_WAIT_MS bounds
    wait: (ms) => Bun.sleep(ms),
  };
}

/** `ovis tui <args>`, for scripts/plugin.ts before its own work: the exit code. */
export async function runTui(args: readonly string[], kernel: () => string | null = kernelEnv): Promise<number> {
  // the screen and a core it starts get what the shell gave, never what Bun took from the working folder
  const caller = callerEnv({ kernel, env: process.env, cwd: process.cwd() });
  return launchTui(args, systemParts(caller, caller["HOME"] || homedir()));
}
