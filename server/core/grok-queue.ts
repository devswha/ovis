/**
 * Send now to a working Grok. Grok queues an Enter on typed text while a turn runs; one more Enter on its empty
 * prompt sends the top queued row now, cancelling the turn at work. What Grok's live screen shows of that queue is read
 * here from the screens recorded in src/lib/fixtures-input-rows/grok-1.0.77 (README there).
 */
import { stripVTControlCharacters } from "node:util";
import { inputRowState, screenFromAnsi } from "../../shared/input-row.ts";
import { GROK_QUEUED_MESSAGE, GROK_SEND_NOW_UNCONFIRMED_MESSAGE, GROK_SEND_UNCONFIRMED_MESSAGE, grokQueuedBehindMessage } from "../../shared/submit-outcome.ts";
import { HerdrError } from "../herdr/client.ts";

/** What Grok's live screen shows of its prompt queue. */
export type GrokQueue =
  /**
   * Fullscreen: each queued row's text as Grok draws it (its first line, cut with `…`, ` (+N lines)` for the rest),
   * and whether its shortcuts row offers `Enter:send now`, which it does only with the prompt empty and focused.
   */
  | { readonly mode: "fullscreen"; readonly rows: readonly string[]; readonly enterSendsNow: boolean }
  /** Minimal mode: no input box, only a count on the info row (`1 queued · /queue`), 0 when none is drawn. */
  | { readonly mode: "minimal"; readonly count: number };

/** a queued row, drawn above the turn's status row: `    #1 first follow-up please` */
const QUEUE_ROW = /^ {4}#(\d+) (.*)$/;
/** a row of the agent's output, which Grok indents by five */
const OUTPUT_ROW = /^ {5}\S/;

/** null: neither layout is on the screen, or the queue pane holds the focus and frames its rows. */
export function grokQueue(screen: string): GrokQueue | null {
  const rows = stripVTControlCharacters(screen).split("\n").map((row) => row.trimEnd());
  const last = rows.filter((row) => row.trim() !== "").at(-1) ?? "";
  const input = rows.map((row) => /^\s*│ ❯/.test(row)).lastIndexOf(true);
  if (input < 0) {
    const minimal = /(?:^|· )(\d+) queued · \/queue(?: ·|$)/.exec(last);
    if (minimal) return { mode: "minimal", count: Number(minimal[1]) };
    return last.endsWith("ctrl+o transcript") && rows.some((row) => /^❯(?: |$)/.test(row)) ? { mode: "minimal", count: 0 } : null;
  }
  if (rows.some((row) => /^\s*│\s+#\d+ /.test(row))) return null;
  const top = rows.slice(0, input).map((row) => /^\s*╭/.test(row)).lastIndexOf(true);
  const above = rows.slice(0, top < 0 ? input : top);
  const end = above.map((row) => QUEUE_ROW.test(row)).lastIndexOf(true);
  const queued: string[] = [];
  for (let index = end; index >= 0; index--) {
    const row = QUEUE_ROW.exec(above[index]!);
    if (!row) break;
    queued.unshift(row[2]!);
  }
  // numbered from #1 down to the box, with no output under them: anything else is not Grok's queue
  const numbered = queued.every((_, index) => QUEUE_ROW.exec(above[end - queued.length + 1 + index]!)![1] === String(index + 1));
  const rowsOfQueue = numbered && !above.slice(end + 1).some((row) => OUTPUT_ROW.test(row)) ? queued : [];
  return { mode: "fullscreen", rows: rowsOfQueue, enterSendsNow: last.split("│").some((part) => part.trim() === "Enter:send now") };
}

const squash = (text: string): string => text.replace(/\s+/g, " ").trim();

/** Whether a queued row as Grok draws it is `message`. A row drawn otherwise than recorded is not. */
export function showsMessage(row: string, message: string): boolean {
  const lines = message.replace(/\n+$/, "").split("\n");
  let shown = squash(row);
  const more = / \(\+(\d+) lines?\)$/.exec(shown);
  if (more) shown = shown.slice(0, more.index);
  if (Number(more?.[1] ?? 0) !== lines.length - 1) return false;
  const first = squash(lines[0]!);
  return shown.endsWith("…") ? first.startsWith(shown.slice(0, -1).trimEnd()) : shown === first;
}

/** Grok's empty prompt with nothing over it (shared/input-row.ts grokInputRow): no draft on any of its lines, no card. */
const grokPromptEmpty = (screen: string): boolean => inputRowState("grok", screenFromAnsi(screen)) === "ready";

const changed = (message: string): HerdrError => new HerdrError("submit_changed", message);

/**
 * After the Enter that typed `message` into a working Grok (`delayMs` later, on a fresh read `look` that throws once
 * the pane holds another Grok session), one more Enter goes only when the screen shows the message as the top queued
 * row, herdr reports the pane working, and the shortcuts row offers `Enter:send now` over Grok's empty prompt. The
 * screen decides every other outcome, and nothing more is pressed:
 * - the message queued behind other rows, or on top with the prompt not empty: it is in Grok's queue, said so;
 * - minimal mode, where herdr does not tell a running turn: its count says it is queued (`before`, the screen read
 *   before the send, gives how many were there first), or Grok took it;
 * - no queued row while herdr reports Grok working, a row that is not the message, a screen neither layout reads, or a
 *   failed read: unconfirmed;
 * - no queued row with the turn over: the send as herdr's Enter made it.
 */
export async function sendGrokQueuedNow(opts: {
  message: string;
  before: GrokQueue | null;
  delayMs: number;
  look: () => Promise<{ status: string; screen: string }>;
  sendEnter: () => Promise<void>;
}): Promise<void> {
  // fixed wait: Grok draws the queued row after the Enter that queued it (SUBMIT_DELAY_MS; drawn by 150 ms when recorded)
  await Bun.sleep(opts.delayMs);
  const seen = await opts.look().catch(() => { throw changed(GROK_SEND_UNCONFIRMED_MESSAGE); });
  const queue = grokQueue(seen.screen);
  if (queue === null) throw changed(GROK_SEND_UNCONFIRMED_MESSAGE);
  switch (queue.mode) {
    case "minimal": {
      if (queue.count === 0) return;
      const earlier = opts.before?.mode === "minimal" ? opts.before.count : null;
      if (earlier === null || queue.count !== earlier + 1) throw changed(GROK_SEND_UNCONFIRMED_MESSAGE);
      throw changed(earlier > 0 ? grokQueuedBehindMessage(earlier) : GROK_QUEUED_MESSAGE);
    }
    case "fullscreen": {
      if (queue.rows.length === 0) {
        if (seen.status === "working") throw changed(GROK_SEND_UNCONFIRMED_MESSAGE);
        return;
      }
      const at = queue.rows.map((row) => showsMessage(row, opts.message)).lastIndexOf(true);
      if (at < 0) throw changed(GROK_SEND_UNCONFIRMED_MESSAGE);
      if (at > 0) throw changed(grokQueuedBehindMessage(at));
      if (seen.status !== "working" || !queue.enterSendsNow || !grokPromptEmpty(seen.screen)) throw changed(GROK_QUEUED_MESSAGE);
      await opts.sendEnter().catch(() => { throw changed(GROK_SEND_NOW_UNCONFIRMED_MESSAGE); });
      return;
    }
    default: {
      const unreachable: never = queue;
      throw new Error(`unknown Grok queue ${JSON.stringify(unreachable)}`);
    }
  }
}
