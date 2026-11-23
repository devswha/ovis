/**
 * omp's adapter to the approval hub (server/approvals/hub.ts). omp asks its own tool approvals (its approval mode and
 * `tools.approval` rules, the user's) in a dialog of its own, opened through its UI context's `approve`; Ovis makes no
 * policy of its own here. Its extension (server/approvals/extension.ts) wraps that `approve` in omp's terminal UI and,
 * for a shell command, runs omp's own dialog alongside the hub, for Ovis's card. Whichever answers first wins and
 * closes the other; the dialog stays as omp draws it, every option of it, and stays on its own when Ovis can no longer
 * answer (stopped, or restarted with other keys).
 *
 * `approve` is given only the prompt's text (`Allow tool: bash`, an optional `Reason:` line, `Command: <command>`), so
 * the extension ties it to a `bash` call it saw (`tool_call`, the command as omp runs it, after any extension revised
 * it): only a prompt that is exactly that call's goes to the hub. Any other prompt (another tool, a command omp cut in
 * the prompt past its length, one offering grants to remember, a provider safety check) is left to omp's dialog alone.
 *
 * Chosen over omp's Collab (a second client of the session, answering its dialogs the same way): Collab needs a relay
 * the session's host connects to, which Ovis would have to run (omp's own is a hosted service) and speak omp's guest
 * protocol to, for what one extension file does here. Measured on omp 18.14.0.
 */
import { meetsMinVersion } from "../../shared/agent-catalog.ts";
import type { ApprovalDecision } from "./hub.ts";
import { extensionApprovals } from "./extension.ts";

export const OMP_HOOK_MIN_VERSION = "18.14.0";

/** The options of omp's approval dialog that are a decision; any other goes to the dialog as its keys. */
const APPROVE_LABEL = "Approve";
const DENY_LABEL = "Deny";

/** The most `bash` calls the extension remembers between their `tool_call` and their approval. */
const CALLS_MAX = 64;

const GLUE = `
const CALLS_MAX = ${CALLS_MAX};

/** The command of a call seen whose approval prompt this is, exactly, or null. */
function heldCommand(prompt, calls) {
  if (typeof prompt?.full !== "string" || prompt.grants?.length) return null;
  for (const command of calls.values()) {
    const details = "\\nCommand: " + command;
    if (!prompt.full.endsWith(details)) continue;
    const head = prompt.full.slice(0, -details.length);
    if (head === "Allow tool: bash" || /^Allow tool: bash\\nReason: [^\\n]*$/.test(head)) return command;
  }
  return null;
}

export default function ovisApprovals(pi) {
  const calls = new Map();
  const wrapped = new WeakSet();
  pi.on("tool_call", (event) => {
    const command = event?.input?.command;
    if (event?.toolName !== "bash" || typeof command !== "string" || command.trim() === "") return undefined;
    calls.set(event.toolCallId, command);
    if (calls.size > CALLS_MAX) calls.delete(calls.keys().next().value);
    return undefined;
  });
  const done = (event) => { calls.delete(event?.toolCallId); };
  pi.on("tool_approval_resolved", done);
  pi.on("tool_result", done);
  pi.on("session_start", (_event, ctx) => {
    const ui = ctx?.ui;
    // omp's terminal UI only: in its RPC mode the dialogs are the RPC client's
    if (ctx?.mode !== "tui" || !ctx.hasUI || typeof ui?.approve !== "function" || wrapped.has(ui)) return;
    wrapped.add(ui);
    const approve = ui.approve.bind(ui);
    ui.approve = async (prompt, opts) => {
      const command = heldCommand(prompt, calls);
      if (command === null) return approve(prompt, opts);
      const closing = new AbortController();
      const signal = opts?.signal ? AbortSignal.any([closing.signal, opts.signal]) : closing.signal;
      try {
        return await Promise.race([
          approve(prompt, { ...opts, signal }),
          hubDecision({ tool: "bash", command, description: null }, signal).then((decision) => decision === "allow" ? "once" : "deny"),
        ]);
      } finally {
        closing.abort();
      }
    };
  });
}
`;

function decision(label: string): ApprovalDecision | null {
  return label === APPROVE_LABEL ? "allow" : label === DENY_LABEL ? "deny" : null;
}

/** omp 18.x from the one measured on: a later major may change the UI context under the hook. */
export const ompApprovals = {
  ...extensionApprovals("omp", (version) => meetsMinVersion(version, OMP_HOOK_MIN_VERSION) && version.split(".")[0] === "18", GLUE),
  decision,
};
