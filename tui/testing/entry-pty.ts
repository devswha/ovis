import { join } from "node:path";
import { answerQueries, gridText, runSupervised, screenOutput, type PtyRun, type SupervisedRun } from "./pty.ts";

export const SOURCE_OVIS = [process.execPath, join(import.meta.dir, "../../scripts/plugin.ts")] as const;
export const DETACH = "\x02q";
export const RESTORE = "\x1b[<u\x1b[?1006l\x1b[?1002l\x1b[?2004l\x1b[?1004l\x1b[?25h\x1b[?1049l";
export const HOST_ANSWERS = [
  ["\x1b[?2026$p", "\x1b[?2026;2$y"],
  ["\x1b[c", "\x1b[?62;22c"],
] as const;

export function entryEnv(folder: { readonly root: string; readonly env: Record<string, string> }, bin?: string): Record<string, string> {
  return {
    ...folder.env,
    ...(bin ? { OVIS_HC_BIN: bin } : {}),
    TERM: "xterm-256color", COLORTERM: "truecolor", PORT: "1", TMPDIR: folder.root,
    HERDR_TEST_SESSION: `entry-${process.pid}`,
    HERDR_PLUGIN_CONFIG_DIR: join(folder.root, "plugin-config"),
    HERDR_PLUGIN_STATE_DIR: join(folder.root, "plugin-state"),
    OVIS_TUI_STATE_DIR: join(folder.root, "tui-state"),
  };
}

export function entryPty(
  entry: readonly string[],
  env: Record<string, string>,
  cols: number,
  rows: number,
  options: { readonly deadlineMs?: number; readonly answers?: ReadonlyArray<readonly [string, string]>; readonly onData?: (text: string) => void } = {},
): SupervisedRun {
  const answer = answerQueries((bytes) => run.type(bytes), options.answers ?? HOST_ANSWERS);
  const run: SupervisedRun = runSupervised({
    entry: ["sh", "-c", 'cd "$HOME" && exec "$@"', "entry", ...entry],
    env, cols, rows, deadlineMs: options.deadlineMs ?? 15_000,
    onData: (text) => { answer(text); options.onData?.(text); },
  });
  return run;
}

/** Wait for new terminal output, excluding every byte already captured at `from`. */
export function fresh(run: PtyRun, from: number, text: string): Promise<void> {
  const quoted = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return run.until(new RegExp(`^[\\s\\S]{${from}}[\\s\\S]*${quoted}`), text);
}

export const visibleGrid = (run: PtyRun, cols: number, rows: number): Promise<string> =>
  gridText(screenOutput(run.output()), cols, rows);
