import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { InteractivePrompt } from "../shared/protocol.ts";
import { paneTranscript, type NativeTranscript } from "./conversation.ts";
import { ConversationUnavailable } from "./conversation-shared.ts";
import { lettaMessagesPath } from "./letta-store.ts";
import { grokHeldTranscript } from "./grok-store.ts";
import { sessionSnapshot } from "./herdr/client.ts";
import { type AgentRecord, type RecordRequest, withRecord } from "./dialogs/record.ts";
import { parsedByPublicPrompt, publicPrompt } from "./dialogs/shared.ts";
import { gjcRecord } from "./dialogs/gjc-record.ts";
import { lettaRecord } from "./dialogs/letta-record.ts";
import { grokRecord } from "./dialogs/grok-record.ts";
import { copilotRecord } from "./dialogs/copilot-record.ts";
import { museRecord } from "./dialogs/muse-record.ts";

/**
 * Where an agent's record of a pane's session says which command waits (`read`), and the dialog that shows it.
 */
interface RecordSource {
  readonly record: Pick<AgentRecord, "dialog" | "wrapMark">;
  read(paneId: string): Promise<RecordRequest | null>;
}

/** A record kept in a session file the agent appends to, found as the pane's conversation is: its last lines are read. */
function sessionFile(record: AgentRecord, file: (transcript: NativeTranscript) => string | null): RecordSource {
  return { record, read: async (paneId) => { const path = file(await paneTranscript(paneId)); return path === null ? null : record.pending(tail(path)); } };
}

/** Grok's session as herdr names it, or else the one its process holds (grok-store.ts `grokHeldTranscript`). */
async function grokSessionFile(paneId: string): Promise<string | null> {
  try {
    const found = await paneTranscript(paneId);
    if (found.source === "grok-transcript") return found.path;
  } catch (error) {
    if (!(error instanceof ConversationUnavailable)) throw error;
  }
  const pane = (await sessionSnapshot()).panes.find((candidate) => candidate.pane_id === paneId);
  return pane === undefined ? null : await grokHeldTranscript(pane);
}

/** The agents that answer their approvals in their own dialog only (no hook Ovis can hold them with). */
const RECORDS: Readonly<Record<string, RecordSource>> = {
  gjc: sessionFile(gjcRecord, (found) => found.source === "gjc-transcript" ? found.path : null),
  muse: sessionFile(museRecord, (found) => found.source === "muse-transcript" ? found.path : null),
  copilot: sessionFile(copilotRecord, (found) => found.source === "copilot-transcript" ? found.path : null),
  // the local backend's messages, which Letta appends to as the turn goes; its transcript waits for the turn's end
  letta: sessionFile(lettaRecord, (found) => found.source === "letta-transcript" && found.letta ? lettaMessagesPath(found.letta.store, found.letta.agent, found.letta.conversation) : null),
  grok: { record: grokRecord, read: async (paneId) => { const path = await grokSessionFile(paneId); return path === null ? null : grokRecord.pending(tail(path)); } },
};

export function recordFor(agent: string): Pick<AgentRecord, "dialog" | "wrapMark"> | undefined {
  return RECORDS[agent]?.record;
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
  const source = RECORDS[agent];
  if (source === undefined) return null;
  try {
    return await source.read(paneId);
  } catch (error) {
    if (error instanceof ConversationUnavailable || (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** A generic card for the pane, with the command its agent's record holds when the dialog on the screen shows it whole. */
export async function withAgentRecord(paneId: string, agent: string, card: InteractivePrompt, screen: string): Promise<InteractivePrompt> {
  const source = RECORDS[agent];
  const parsed = parsedByPublicPrompt.get(card);
  if (source === undefined || parsed === undefined || !parsed.responder.startsWith("fallback")) return card;
  const shown = withRecord(parsed, await recordRequest(paneId, agent), screen, source.record);
  return shown === parsed ? card : publicPrompt(shown);
}
