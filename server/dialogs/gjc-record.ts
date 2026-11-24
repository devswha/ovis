import { type AgentRecord, pendingToolCall } from "./record.ts";

const SHELL_TOOLS: ReadonlySet<string> = new Set(["bash"]);

/**
 * gjc (0.18) asks nothing itself: an approval is a hook or extension of the user's that opens gjc's selector
 * (`ctx.ui.select`) before the `bash` call runs. Its session file (pi's shape) holds the call already, and the selector,
 * read from its opening border as the generic card reads it (dialogs/fallback.ts), is the dialog:
 *
 *   Approve the shell command
 *   touch am-short.flag
 *   Allow this command?
 *
 *   ❯ Allow once
 *     Deny
 */
export const gjcRecord: AgentRecord = {
  pending: (text) => pendingToolCall(text, SHELL_TOOLS),
};
