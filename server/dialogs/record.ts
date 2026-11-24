import { createHash } from "node:crypto";
import { ANSI_RE, CARD_BODY_MAX, cleanLine, type ParsedPrompt } from "./shared.ts";

/**
 * A shell command waiting on the user's approval, as the agent's own record holds it (its session file or
 * database, server/record-cards.ts): the request's id there and the command to the letter. The screen
 * wraps, cuts and redraws a command; the record does not.
 */
export interface RecordRequest {
  readonly id: string;
  readonly command: string;
}

/**
 * How an agent's record names its pending approval: `pending` reads the record (a session file's tail, or its rows);
 * `dialog` is the line the agent's approval dialog starts with on the screen, or absent where the generic card
 * itself is the dialog (gjc's selector, read from its opening border); `wrapMark` is what the agent draws at the
 * end of a row it wrapped a command at.
 */
export interface AgentRecord<Source = string> {
  pending(source: Source): RecordRequest | null;
  readonly dialog?: RegExp;
  readonly wrapMark?: RegExp;
}

/** Box drawing and whitespace: what a screen adds to a command it draws (borders, wraps, indents, tabs as spaces). */
const DRAWN_RE = /[\s\u2500-\u257f]+/gu;

/**
 * The rows of the screen's last approval dialog, from its last `dialog` line to the screen's end, or the card's own
 * words; null when no such line is on the screen.
 */
type DialogShape = Pick<AgentRecord, "dialog" | "wrapMark">;

function dialogRows(card: ParsedPrompt, screen: string, { dialog, wrapMark }: DialogShape): string[] | null {
  const lines = dialog === undefined ? [card.question, ...(card.body ?? "").split("\n")]
    : screen.replace(ANSI_RE, "").split(/\r?\n/).map(cleanLine);
  let start = lines.length - 1;
  while (dialog !== undefined && start >= 0 && !dialog.test(lines[start]!)) start -= 1;
  return start < 0 ? null : lines.slice(dialog === undefined ? 0 : start).map((line) => wrapMark ? line.replace(wrapMark, "") : line);
}

/**
 * Whether a dialog's rows show the whole command: every character of it, in order and together, whatever the
 * screen added (borders, the rows it wrapped onto). A dialog that cut the command, or shows another one, does not.
 */
export function commandShown(command: string, rows: readonly string[]): boolean {
  const wanted = command.replace(DRAWN_RE, "");
  return wanted !== "" && rows.join("").replace(DRAWN_RE, "").includes(wanted);
}

/**
 * The card for a dialog the screen shows with the command its record holds: the command, to the letter, in place
 * of the lines the screen drew it on. The id covers the request too, so an answer goes to that request only.
 * Without a request, or a dialog that does not show its whole command, the card is the screen's own.
 */
export function withRecord(card: ParsedPrompt, request: RecordRequest | null, screen: string, record: DialogShape): ParsedPrompt {
  const rows = request === null ? null : dialogRows(card, screen, record);
  if (request === null || rows === null || !commandShown(request.command, rows)) return card;
  const id = createHash("sha256").update(JSON.stringify({ card: card.id, record: request.id, command: request.command })).digest("hex").slice(0, 12);
  return { ...card, id, body: request.command.slice(0, CARD_BODY_MAX), record: request };
}

export const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** A record's JSON lines that parse to objects: a first line read from its middle, or a last one half written, does not. */
export function jsonLines(text: string): Record<string, unknown>[] {
  return text.split("\n").flatMap((line) => {
    try { return [object(JSON.parse(line))].filter((entry) => entry !== null); } catch { return []; }
  });
}

/**
 * The requests a record holds open, in the order they were made: `open` adds one (or replaces one by its id), `close`
 * ends one, and `clear` all, at a turn the user starts: one the agent left open before it (refused, interrupted)
 * never ran and is not asked any more. A record that holds more than one open at a time names no single pending request, so `only` gives none:
 * the screen's dialog could be any of them, and one command can be a part of another's.
 */
export class OpenRequests {
  readonly #open = new Map<string, RecordRequest | null>();
  open(id: string, command: string | null): void {
    this.#open.delete(id);
    this.#open.set(id, command === null ? null : { id, command });
  }
  close(id: unknown): void {
    if (typeof id === "string") this.#open.delete(id);
  }
  clear(): void {
    this.#open.clear();
  }
  only(): RecordRequest | null {
    return this.#open.size === 1 ? [...this.#open.values()][0]! : null;
  }
}

/**
 * The shell call a session file of pi's shape (`{"type":"message","message":{…}}` lines, as gjc and Letta's local
 * backend write them) holds open: an assistant's `toolCall` to a tool named in `tools` with no `toolResult` for its
 * id after it, and no other call open beside it. Calls are issued before they are approved, so this is a pending
 * approval only while the screen shows the dialog for it (withRecord).
 */
export function pendingToolCall(text: string, tools: ReadonlySet<string>): RecordRequest | null {
  const calls = new OpenRequests();
  for (const entry of jsonLines(text)) {
    const message = object(entry.message);
    if (message?.role === "toolResult") calls.close(message.toolCallId);
    if (message?.role === "user") calls.clear();
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content.map(object)) {
      if (part?.type !== "toolCall" || typeof part.id !== "string") continue;
      const command = object(part.arguments)?.command;
      calls.open(part.id, typeof part.name === "string" && tools.has(part.name) && typeof command === "string" ? command : null);
    }
  }
  return calls.only();
}
