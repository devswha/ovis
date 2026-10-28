/**
 * Claude Code's inline `--settings` JSON on a Windows PC (#2232). herdr starts an agent there
 * through a PowerShell script, and when `claude` is a PowerShell script (the shim an npm global
 * install puts in front of claude.exe) Windows PowerShell 5.1 strips the JSON's double quotes on
 * the way to claude.exe, which then exits with "Invalid JSON provided to --settings". A settings
 * file's path, spaces included, arrives intact through every route herdr takes, and Claude Code
 * reads a `--settings` value that is not `{…}` as one. Linux and macOS quote each word for a POSIX
 * shell and take the JSON as it is.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where the files go: `ovis\claude-settings` in this Windows user's %LOCALAPPDATA%, the profile's
 * own folder for what stays on this PC, which only this user and the administrators can reach.
 * Not %TEMP%: TEMP can name a folder other accounts write to (C:\Temp, or C:\Windows\Temp for a
 * service), where another account could make this folder first and, a file being named by its
 * text's hash, swap hooks into it between the check below and Claude Code's read. Not the server's
 * state dir (defaultStateDir, %USERPROFILE%\.config\ovis): createServer's `stateDir` stops at
 * index.ts, so the create routes would have to pass it down, and the default one goes wherever
 * OVIS_STATE_DIR or XDG_CONFIG_HOME point. A file holds only the JSON a launch already put on
 * Claude Code's command line (the dialog's is {"ultracode":true}). Claude Code keeps what it read
 * from it at start (2.1.311 pins a settings file's content), so one removed later costs nothing and
 * the next launch writes it again.
 */
export function claudeSettingsDir(env: Record<string, string | undefined> = process.env, home: string = homedir()): string {
  return join(env["LOCALAPPDATA"] || join(home, "AppData", "Local"), "ovis", "claude-settings");
}

/** Whether Claude Code reads a `--settings` value as JSON rather than as a file's path: its own test. */
const inlineJson = (value: string): boolean => {
  const trimmed = value.trim();
  return trimmed.startsWith("{") && trimmed.endsWith("}");
};

/**
 * `args` with each inline JSON `--settings` value, `--settings <json>` or `--settings=<json>`,
 * replaced by the path `write` gives a file holding that text. Every other argument is kept, and
 * nothing after a bare `--` is read as a flag.
 */
export function settingsFileArgs(args: readonly string[], write: (json: string) => string): string[] {
  const rewritten: string[] = [];
  for (let at = 0; at < args.length; at++) {
    const arg = args[at]!;
    if (arg === "--") {
      rewritten.push(...args.slice(at));
      break;
    }
    if (arg === "--settings" && at + 1 < args.length) {
      // the flag's value is the flag's own, a "--" there included: it is not read again as an argument
      const value = args[++at]!;
      rewritten.push(arg, inlineJson(value) ? write(value) : value);
    }
    else if (arg.startsWith("--settings=") && inlineJson(arg.slice("--settings=".length))) {
      rewritten.push(`--settings=${write(arg.slice("--settings=".length))}`);
    }
    else rewritten.push(arg);
  }
  return rewritten;
}

/** whether `path` holds exactly `text` */
const holds = (path: string, text: string): boolean => {
  try { return readFileSync(path, "utf8") === text; } catch { return false; }
};

/**
 * The path of a file in `dir` holding `json`, named by its sha256: the same text is one file, written
 * once. The first launch makes it new, with no rename that Defender or the indexer could hold up for
 * a moment on Windows, and a later one finds it there. Only a file under its name that holds other
 * text (cut short, or edited) is replaced, written under a temporary name and renamed into place so
 * nothing reads half of it.
 */
export function settingsFile(json: string, dir: string = claudeSettingsDir()): string {
  const path = join(dir, `${createHash("sha256").update(json).digest("hex")}.json`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(path, json, { mode: 0o600, flag: "wx" });
    return path;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (holds(path, json)) return path;
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, json, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } catch (error) {
    // the scanner that refused the rename can refuse the delete too: its error must not stand in
    // for the rename's, or skip the check below
    try { rmSync(temporary, { force: true }); } catch {}
    // another launch put the same text there first: Windows refuses a rename over a file a
    // starting Claude has open
    if (!holds(path, json)) throw error;
  }
  return path;
}

/**
 * `args` as herdr's agent.start should get them for a `kind` agent on `platform`: on Windows, a
 * Claude Code's inline JSON `--settings` goes as a file's path (see the top of this file). When the
 * file cannot be written the JSON goes as it is: a claude.exe (the native installer's) or a
 * claude.cmd takes it intact, and only an npm install's PowerShell shim would lose it, so a full
 * disk or a folder that cannot be made must not fail every launch.
 */
export function agentStartArgs(kind: string, args: string[], options: { platform?: string; dir?: string } = {}): string[] {
  if ((options.platform ?? process.platform) !== "win32" || kind !== "claude") return args;
  try {
    return settingsFileArgs(args, (json) => settingsFile(json, options.dir));
  } catch (error) {
    console.error(`claude --settings file: ${error instanceof Error ? error.message : String(error)}`);
    return args;
  }
}
