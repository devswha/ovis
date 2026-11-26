import { homedir } from "node:os";
import { join } from "node:path";

import { captureStatusline, payload } from "../statusline-capture.ts";
import { configuredStatusLine } from "../statusline-install.ts";

/**
 * `approval-hook ... --statusline`: the status line of a Claude Ovis started (server/approvals/claude.ts). It draws the
 * line the user set, run as Claude runs it (`sh -c`, the payload on its stdin, its output Claude's line): the command
 * given with `--statusline-command` (base64, from a `--settings` the launch already had), else the one Claude's settings
 * files set now, read again at each render so an edit to them shows as it would. Then it keeps what the payload says of
 * the context window and the limits, as the installed capture does (server/statusline-capture.ts), where Ovis reads them.
 * It talks to no hub.
 */
export async function runStatusline(argv: readonly string[], env: Record<string, string | undefined> = process.env): Promise<void> {
  const text = await payload();
  if (text === null) return;
  const at = argv.indexOf("--statusline-command");
  let command = at >= 0 && argv[at + 1] ? Buffer.from(argv[at + 1]!, "base64").toString("utf8") : null;
  if (command === null) {
    let projectDir: string | null = null;
    try {
      const workspace = (JSON.parse(text) as { workspace?: { project_dir?: unknown } } | null)?.workspace;
      if (typeof workspace?.project_dir === "string" && workspace.project_dir !== "") projectDir = workspace.project_dir;
    } catch { /* a payload that is not JSON names no project: the user's settings still do */ }
    const line = configuredStatusLine(env["CLAUDE_CONFIG_DIR"]?.trim() || join(homedir(), ".claude"), projectDir);
    command = line === null ? null : line["command"] as string;
  }
  const drawn = command === null ? null : Bun.spawn(["sh", "-c", command], { stdin: Buffer.from(text), stdout: "inherit", stderr: "inherit", env });
  captureStatusline(text, () => true);
  if (drawn !== null) process.exitCode = await drawn.exited;
}
