import { type AgentRecord, OpenRequests, jsonLines, object } from "./record.ts";
import { copilotRootRecord } from "../copilot.ts";

/**
 * GitHub Copilot CLI's session record (`session-state/<id>/events.jsonl`, 1.0.109) writes the approval it asks for
 * while it asks: `permission.requested` with its `requestId` and, for a shell command, `fullCommandText`; and
 * `permission.completed` with the same `requestId` once answered. Its dialog boxes the command in a box of its own,
 * the last box opened on the screen:
 *
 *   ╭─────────────────────────────────────────────╮
 *   │ Run cmds/fixture.txt contents               │
 *   │ ─────────────────────────────────────────── │
 *   │ ╭─────────────────────────────────────────╮ │
 *   │ │ touch am-short.flag                     │ │
 *   │ ╰─────────────────────────────────────────╯ │
 *   │ Do you want to run this command?            │
 *   │ ❯ 1. Yes                                    │
 */
export const copilotRecord: AgentRecord = {
  dialog: /^╭─+╮$/u,
  pending(text) {
    const requests = new OpenRequests();
    for (const entry of jsonLines(text)) {
      const data = object(entry.data);
      if (entry.type === "permission.requested" && typeof data?.requestId === "string") {
        const command = object(data.permissionRequest)?.fullCommandText;
        requests.open(data.requestId, typeof command === "string" ? command : null);
      } else if (entry.type === "permission.completed") requests.close(data?.requestId);
      else if (entry.type === "user.message") requests.clear();
    }
    return requests.only();
  },
};

export const copilotAskRecord: AgentRecord = {
  pending(text) {
    const calls = new OpenRequests();
    for (const entry of jsonLines(text)) {
      if (!copilotRootRecord(entry) || entry.ephemeral === true) continue;
      const data = object(entry.data);
      if (entry.type === "tool.execution_start" && data?.toolName === "ask_user" && typeof data.toolCallId === "string" && !data.parentToolCallId) {
        const args = object(data.arguments);
        const fields = Object.values(object(object(args?.requestedSchema)?.properties) ?? {});
        const field = fields.length === 1 ? object(fields[0]) : null;
        const choices = field?.type === "string" ? field.enumNames ?? field.enum
          ?? (Array.isArray(field.oneOf) ? field.oneOf.map(item => object(item)?.title ?? object(item)?.const) : null)
          : args?.requestedSchema === undefined ? args?.choices : null;
        const question = args?.message ?? args?.question;
        calls.open(data.toolCallId, typeof question === "string" && Array.isArray(choices) && choices.length && choices.every(choice => typeof choice === "string")
          ? JSON.stringify([question.trim(), choices]) : null);
      } else if (entry.type === "tool.execution_complete" || entry.type === "human_response.recorded") calls.close(data?.toolCallId);
      else if (entry.type === "user.message" || entry.type === "session.abort" || entry.type === "session.resume") calls.clear();
    }
    return calls.only();
  },
};
