/**
 * `tui`: runs the terminal client (crates/ovis-tui) in this terminal, pointed at this install's server.
 *
 * It neither starts nor asks the server anything: the program says itself whether a server answers, and it
 * is of use without one. It takes no turn in the plugin's lifecycle lock either.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

export const TUI_NAME = "ovis-tui";
/** the setting that names the program, ahead of the install's own */
export const TUI_BIN_VARIABLE = "OVIS_TUI_BIN";

type Env = Readonly<Record<string, string | undefined>>;

export type TuiLookup =
  | { readonly kind: "found"; readonly path: string }
  /** OVIS_TUI_BIN is set and names no file: the install's own program is not tried instead */
  | { readonly kind: "configured-missing"; readonly path: string }
  | { readonly kind: "missing"; readonly looked: readonly string[] };

/** Where an install keeps the program: beside its PTY host (bin/), else a local build of the crate. */
export function tuiPaths(root: string): readonly string[] {
  return [join(root, "bin", TUI_NAME), join(root, "crates", "ovis-tui", "target", "release", TUI_NAME)];
}

export const isFile = (path: string): boolean => existsSync(path) && statSync(path).isFile();

/** The program to run: OVIS_TUI_BIN from the merged settings, else the first of tuiPaths that is a file. */
export function findTui(settings: Env, where: { readonly root: string; readonly home: string }, fileAt: (path: string) => boolean = isFile): TuiLookup {
  const configured = settings[TUI_BIN_VARIABLE] ?? "";
  if (configured !== "") {
    const path = configured.startsWith("~/") ? join(where.home, configured.slice(2)) : configured;
    return fileAt(path) ? { kind: "found", path } : { kind: "configured-missing", path };
  }
  const paths = tuiPaths(where.root);
  const path = paths.find(fileAt);
  return path === undefined ? { kind: "missing", looked: paths } : { kind: "found", path };
}

/**
 * The program's environment: the caller's, with OVIS_URL (unless the caller exported one) and the
 * settings' token. The token goes only here: never into an argument, a file or the output.
 */
export function tuiEnv(caller: Env, settings: Env, origin: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(caller)) if (value !== undefined) env[key] = value;
  if ((env["OVIS_URL"] ?? "") === "") env["OVIS_URL"] = origin;
  const token = settings["OVIS_TOKEN"] ?? "";
  if (token !== "") env["OVIS_TOKEN"] = token;
  return env;
}

export const WINDOWS_MESSAGE = "ovis tui: the terminal client runs on Linux and macOS only.\n";

/** What a lookup that found nothing to run says, for the person who typed `ovis tui`. */
export function lookupMessage(lookup: Exclude<TuiLookup, { kind: "found" }>): string {
  switch (lookup.kind) {
    case "configured-missing":
      return `ovis tui: ${TUI_BIN_VARIABLE} is ${lookup.path}, which is not a file. Point it at the ${TUI_NAME} program, or remove it to use the one this install has.\n`;
    case "missing":
      return [
        `ovis tui: this install has no ${TUI_NAME} program yet. It was looked for at:`,
        ...lookup.looked.map((path) => `  ${path}`),
        "To build it, run these two commands in a checkout of Ovis:",
        "  crates/ovis-tui/prepare.sh",
        "  cargo build --release --manifest-path crates/ovis-tui/Cargo.toml",
        `or set ${TUI_BIN_VARIABLE} to the path of a ${TUI_NAME} you have.`,
        "",
      ].join("\n");
    default: {
      const unreachable: never = lookup;
      return unreachable;
    }
  }
}

export interface TuiOptions {
  readonly platform: NodeJS.Platform;
  /** the install's root (plugin.ts ROOT) and the home a leading `~/` stands for */
  readonly where: { readonly root: string; readonly home: string };
  /** the caller's own environment, which the program inherits */
  readonly caller: Env;
  /** the plugin's merged settings: the process environment and its config files */
  readonly settings: Env;
  /** the server's origin, as `status` prints it */
  readonly origin: string;
  readonly err: (text: string) => void;
  /** where the launcher's signal handlers go: process.on for the command */
  readonly on: (signal: "SIGINT" | "SIGTERM" | "SIGHUP", handler: () => void) => void;
}

/** Runs the program with the terminal handed over; its exit code, or 128 + the signal that ended it. */
export async function runTui(args: readonly string[], options: TuiOptions): Promise<number> {
  if (options.platform === "win32") {
    options.err(WINDOWS_MESSAGE);
    return 1;
  }
  const lookup = findTui(options.settings, options.where);
  if (lookup.kind !== "found") {
    options.err(lookupMessage(lookup));
    return 1;
  }
  let child: Bun.Subprocess<"inherit", "inherit", "inherit">;
  try {
    child = Bun.spawn([lookup.path, ...args], { env: tuiEnv(options.caller, options.settings, options.origin), stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  } catch (error) {
    options.err(`ovis tui: could not run ${lookup.path}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  // the program holds the terminal in raw mode and owns Ctrl+C; a SIGINT sent to the whole group must not end this
  // process under it. A SIGTERM or SIGHUP sent to this process alone is passed on, so both end.
  options.on("SIGINT", () => undefined);
  for (const signal of ["SIGTERM", "SIGHUP"] as const) options.on(signal, () => child.kill(signal));
  // Bun resolves a death by signal as 128 + its number
  return await child.exited;
}
