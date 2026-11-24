import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { InteractivePrompt } from "../shared/protocol.ts";
import { paneTranscript, type NativeTranscript } from "./conversation.ts";
import { ConversationUnavailable } from "./conversation-shared.ts";
import { lettaMessagesPath } from "./letta-store.ts";
import { type AgentRecord, type RecordRequest, withRecord } from "./dialogs/record.ts";
import { parsedByPublicPrompt, publicPrompt } from "./dialogs/shared.ts";
import { gjcRecord } from "./dialogs/gjc-record.ts";
import { lettaRecord } from "./dialogs/letta-record.ts";
import { grokRecord } from "./dialogs/grok-record.ts";
import { copilotRecord } from "./dialogs/copilot-record.ts";
import { museRecord } from "./dialogs/muse-record.ts";

/**
 * The agents that answer their approvals in their own dialog only (no hook Ovis can hold them with), whose record
 * says which command waits, and the file of the pane's session that holds it.
 */
const RECORDS: Readonly<Record<string, AgentRecord & { file(transcript: NativeTranscript): string | null }>> = {
  gjc: { ...gjcRecord, file: (found) => found.source === "gjc-transcript" ? found.path : null },
  grok: { ...grokRecord, file: (found) => found.source === "grok-transcript" ? found.path : null },
  muse: { ...museRecord, file: (found) => found.source === "muse-transcript" ? found.path : null },
  copilot: { ...copilotRecord, file: (found) => found.source === "copilot-transcript" ? found.path : null },
  // the local backend's messages, which Letta appends to as the turn goes; its transcript waits for the turn's end
  letta: { ...lettaRecord, file: (found) => found.source === "letta-transcript" && found.letta ? lettaMessagesPath(found.letta.store, found.letta.agent, found.letta.conversation) : null },
};

export function recordFor(agent: string): AgentRecord | undefined {
  return RECORDS[agent];
}

/** How much of a session file's end is read: a pending call is among its last lines. */
const RECORD_TAIL_BYTES = 1024 * 1024;

function tail(path: string): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, RECORD_TAIL_BYTES);
    const bytes = Buffer.alloc(length);
    readSync(fd, bytes, 0, length, size - length);
    const text = bytes.toString("utf8");
    return length < size ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    closeSync(fd);
  }
}

/**
 * The request the pane's agent's record holds open, or null when nothing proves one: no record for this agent, no
 * session found for the pane, or a file that is gone. The card then stays the screen's own.
 */
export async function recordRequest(paneId: string, agent: string): Promise<RecordRequest | null> {
  const record = RECORDS[agent];
  if (record === undefined) return null;
  try {
    const file = record.file(await paneTranscript(paneId));
    return file === null ? null : record.pending(tail(file));
  } catch (error) {
    if (error instanceof ConversationUnavailable || (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** A generic card for the pane, with the command its agent's record holds when the dialog on the screen shows it whole. */
export async function withAgentRecord(paneId: string, agent: string, card: InteractivePrompt, screen: string): Promise<InteractivePrompt> {
  const record = RECORDS[agent];
  const parsed = parsedByPublicPrompt.get(card);
  if (record === undefined || parsed === undefined || !parsed.responder.startsWith("fallback")) return card;
  const shown = withRecord(parsed, await recordRequest(paneId, agent), screen, record);
  return shown === parsed ? card : publicPrompt(shown);
}
