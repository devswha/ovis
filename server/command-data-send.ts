/**
 * Commands sent through an agent's own API instead of typed into its terminal, where the agent has a route for that
 * command and the pane's own session can be reached (docs/agent-commands.md, "The three contracts"). Everything else
 * is typed as before. Once a request may have reached the agent, the command is never typed as well.
 */
import type { HerdrPane, SlashCommand } from "../shared/protocol.ts";
import { servedPlan, servedStatus, servesCommands } from "./approvals/codex.ts";
import { HerdrError, paneGet } from "./herdr/client.ts";
import { opencodeSessionId } from "./opencode.ts";
import { openCodePaneService } from "./opencode-native.ts";
import { compactOpenCodeSession, openCodePermissionsRead, runOpenCodeCommand } from "./opencode-service.ts";
import type { CommandSend } from "./outcome.ts";
import { openCodeTuiCommand } from "./skills/opencode.ts";

/**
 * A command a data route can carry: OpenCode 2's `/compact` or one of its server commands by name, or the bare `/plan`
 * of a Codex on the server Ovis started for it.
 */
export type CommandDataRoute = { agent: "opencode"; kind: "compact" } | { agent: "opencode"; kind: "command"; name: string; text: string }
  | { agent: "codex"; kind: "plan" };

/** The data route for a chat send that is exactly one command, or null to type it. */
export function commandDataRoute(command: CommandSend, text: string): CommandDataRoute | null {
  if ((command.agent !== "codex" && command.agent !== "opencode") || command.invocations.length !== 1) return null;
  if (command.agent === "codex") {
    // the slash first, as Codex's composer reads a command
    // Codex's /compact stays typed: compacting through its server aborts a turn Ovis may not have heard of yet
    return /^\/plan\s*$/u.test(text) && command.invocations[0]!.name === "plan" ? { agent: "codex", kind: "plan" } : null;
  }
  if (command.agent !== "opencode") return null;
  // an @skill rides with the typed text, where the TUI attaches it (opencode-skill-attach.ts)
  if (/(?:^|\s)@\S/u.test(text)) return null;
  // as OpenCode's TUI reads it (parseSlashHead): the slash first, the name up to the first white space, the rest as is
  const head = /^\/(\S+)(?:\s([\s\S]*))?$/u.exec(text);
  if (!head || head[1] !== command.invocations[0]!.name) return null;
  const [, name, argument = ""] = head as unknown as [string, string, string | undefined];
  if (name === "compact") return argument.trim() === "" ? { agent: "opencode", kind: "compact" } : null;
  return openCodeTuiCommand(name) ? null : { agent: "opencode", kind: "command", name, text: argument };
}

/**
 * A pane's catalog with the rows Chat leaves out of its palette for want of a result (`chatPaletteHidden`) offered again
 * where their command goes as data and its answer is the result: `/plan` of a Codex on Ovis's own server.
 */
export function withDataRoutes(agent: string | null, paneId: string, commands: SlashCommand[]): SlashCommand[] {
  if (agent !== "codex" || !servesCommands(paneId)) return commands;
  return commands.map((command) => {
    if (!command.chatPaletteHidden || command.source !== "builtin" || command.name !== "plan") return command;
    const { chatPaletteHidden: _, ...offered } = command;
    return offered;
  });
}

/** A command sent by data: when it went, and whether the answer itself shows it ran (an OpenCode command's callback, Codex's settings). */
export interface DataSent { at: number; ran: boolean }

/**
 * Sends a routed command through the pane's own agent session. Null when nothing reached the agent (no verified
 * session, the connection never opened, or a refusal before anything ran): the caller types it. Throws when the
 * request may have run without an answer, or ran and failed, so the command is not typed again.
 * `mayWrite` asks the sender once more right before the request's bytes leave; false sends nothing (null).
 */
export async function sendCommandAsData(pane: HerdrPane, route: CommandDataRoute, mayWrite: () => boolean, openCodeStateDir?: string): Promise<DataSent | null> {
  if (route.agent === "codex") {
    const threadId = servedStatus(pane.pane_id)?.threadId;
    // never a thread herdr says the pane does not show, read again right before the request (herdr-core reports none)
    if (threadId === undefined || codexDisagrees(pane, threadId) || codexDisagrees(await paneGet(pane.pane_id), threadId)) return null;
    const at = Date.now();
    const answer = await servedPlan(pane.pane_id, threadId, mayWrite);
    if (answer === "unsent") return null;
    if (answer === "unknown") throw new HerdrError("timeout", "Codex did not answer the command sent to its server; check the terminal before sending it again");
    return { at, ran: true };
  }
  if (process.platform === "win32") return null;
  const bound = await openCodePaneService(pane, undefined, openCodeStateDir);
  // only the 2.x API measured; and only the session the pane shows now, not one an older check bound
  if (!bound || !openCodePermissionsRead(bound.service.version) || bound.sessionID !== opencodeSessionId(pane)) return null;
  if (opencodeSessionId(await paneGet(pane.pane_id)) !== bound.sessionID) return null;
  const at = Date.now();
  const answer = route.kind === "compact"
    ? await compactOpenCodeSession(bound.service.config, bound.sessionID, mayWrite)
    : await runOpenCodeCommand(bound.service.config, bound.sessionID, route.name, route.text, mayWrite);
  if (answer === "unsent") return null;
  if (answer === "unknown") throw new HerdrError("timeout", "OpenCode did not answer the command sent to its session; check the terminal before sending it again");
  // 4xx: refused before anything ran (an unknown command is CommandNotFoundError, 404)
  if (answer.status >= 400 && answer.status < 500) return null;
  if (answer.status < 200 || answer.status >= 300) {
    throw new HerdrError("command_failed", `OpenCode could not run ${route.kind === "compact" ? "/compact" : `/${route.name}`} (HTTP ${answer.status})`);
  }
  return { at, ran: route.kind === "command" };
}

/** Whether herdr reports a Codex session in `pane` other than `threadId` (by its id, or by its rollout file's name). */
function codexDisagrees(pane: Pick<HerdrPane, "agent_session">, threadId: string): boolean {
  const session = pane.agent_session;
  if (session?.agent !== "codex" || !session.value) return false;
  return session.kind === "id" ? session.value !== threadId : !(session.kind === "path" && session.value.endsWith(`-${threadId}.jsonl`));
}
