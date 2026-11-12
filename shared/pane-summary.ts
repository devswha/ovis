/**
 * A pane's last words for a list row (GET /api/pane/summary): the newest turn that said something,
 * cut short, with when it was said and when the user last asked. Read from the conversation the chat
 * lens shows, so the row and the thread never disagree.
 */
import type { ConversationPart, ConversationTurn } from "./protocol.ts";

/** Panes one summary request may name. */
export const PANE_SUMMARY_MAX_IDS = 24;
/** UTF-16 units of a summary's text. */
export const PANE_SUMMARY_TEXT_MAX = 280;
/** How long one summary request reads conversations; panes not read by then are left out of its answer. */
export const PANE_SUMMARY_DEADLINE_MS = 1500;

export interface PaneSummary {
  role: "assistant" | "user";
  /** whitespace collapsed, at most PANE_SUMMARY_TEXT_MAX units, never half a character, never empty */
  text: string;
  /** the turn's `end_ts ?? ts` */
  at: string | null;
  /** the newest user turn's `ts`; null when the user never wrote */
  asked_at: string | null;
  /** the words are a request the agent recorded as failed */
  failed?: true;
}

export interface PaneSummaries {
  /** the server's clock when it answered, so a client can tell its own offset */
  server_time: string;
  /** by pane id; null for a pane with nothing said or no readable conversation; a pane left out was not read this time */
  summaries: Record<string, PaneSummary | null>;
}

type TextPart = Extract<ConversationPart, { kind: "text" }>;

interface Words { part: TextPart; text: string }

const FENCE = /^\s*```[\w+-]*\s*$/u;
/** a heading, list item or quote mark at a line's start; inline marks stay for the client */
const BLOCK_MARK = /^\s*(?:#{1,6} |[-*+] |\d+[.)] |> )/u;

/** A text as one line: fence lines and block marks dropped, whitespace runs collapsed, trimmed. */
function plain(text: string): string {
  return text.split("\n").filter((line) => !FENCE.test(line)).map((line) => line.replace(BLOCK_MARK, "")).join(" ")
    .replace(/\s+/gu, " ").trim();
}

/** At most PANE_SUMMARY_TEXT_MAX units, without a lone high surrogate at the end. */
function cut(text: string): string {
  const head = text.slice(0, PANE_SUMMARY_TEXT_MAX);
  const last = head.charCodeAt(head.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head;
}

/** The words a turn ends on: an answer's last final answer, else its last text; a user's first text. A text with nothing left once cleaned counts as blank. */
function wordsOf(turn: ConversationTurn): Words | undefined {
  const texts = turn.parts.flatMap((part): Words[] => {
    if (part.kind !== "text") return [];
    const text = plain(part.text);
    return text === "" ? [] : [{ part, text }];
  });
  if (turn.role === "user") return texts[0];
  for (let index = texts.length - 1; index >= 0; index--) if (texts[index]!.part.phase === "final_answer") return texts[index];
  return texts[texts.length - 1];
}

/** The newest turn's words that has any, or null when no turn has text. */
export function summaryOf(turns: readonly ConversationTurn[]): PaneSummary | null {
  let newestUser = turns.length - 1;
  while (newestUser >= 0 && turns[newestUser]!.role !== "user") newestUser--;
  const asked = newestUser >= 0 ? turns[newestUser]!.ts : null;
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index]!;
    const words = wordsOf(turn);
    if (words === undefined) continue;
    return {
      role: turn.role, text: cut(words.text), at: turn.end_ts ?? turn.ts, asked_at: asked,
      ...(words.part.failed ? { failed: true as const } : {}),
    };
  }
  return null;
}
