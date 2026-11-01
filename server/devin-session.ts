import type { HerdrPane } from "../shared/protocol.ts";
import { ConversationUnavailable } from "./conversation-shared.ts";

let warnedUnverifiedSession = false;

/** A live Devin executable, not a command line which happens to mention one. */
export function isDevinProcess(argv: readonly string[]): boolean {
  const executable = argv[0] ?? "";
  const exact = /(?:^|[\\/])devin(?:\.exe)?$/;
  return process.platform === "win32" ? exact.test(executable.toLowerCase()) : exact.test(executable);
}

/** Resolves only a session explicitly named by this live Devin pane, never by directory contents. */
export function devinSessionForPane(pane: HerdrPane, panes: HerdrPane[], argv: string[]): string {
  if (pane.agent !== "devin") throw new ConversationUnavailable("no_session_id");
  const reported = pane.agent_session?.agent === "devin" && pane.agent_session.kind === "id"
    && typeof pane.agent_session.value === "string" && pane.agent_session.value.length > 0
    ? pane.agent_session.value : null;
  const resumed: string[] = [];
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--") break;
    if (arg.startsWith("--resume=")) {
      const id = arg.slice("--resume=".length);
      if (!id || id.startsWith("-")) throw new ConversationUnavailable("no_session_id");
      resumed.push(id);
    } else if (arg === "--resume" || arg === "-r") {
      const id = argv[index + 1];
      if (!id || id.startsWith("-")) throw new ConversationUnavailable("no_session_id");
      resumed.push(id);
      index++;
    }
  }
  const named = resumed[0] ?? null;
  if (resumed.some((id) => id !== named) || (reported !== null && named !== null && reported !== named)) {
    throw new ConversationUnavailable("no_session_id");
  }
  const explicit = reported ?? named;
  // A held ACP session lock alone does not prove which session the terminal displays after a switch.
  if (explicit === null) {
    if (!warnedUnverifiedSession) {
      warnedUnverifiedSession = true;
      console.warn("Devin conversation unavailable: the current session cannot be verified for this process.");
    }
    throw new ConversationUnavailable("devin_current_session_unverified");
  }
  if (panes.some((other) => other.pane_id !== pane.pane_id && other.agent === "devin"
    && other.agent_session?.agent === "devin" && other.agent_session.kind === "id" && other.agent_session.value === explicit)) {
    throw new ConversationUnavailable("no_session_id");
  }
  return explicit;
}
