import { askedQuestions } from "../shared/askQuestions.ts";
import type { InteractivePrompt } from "../shared/protocol.ts";
import { paneTranscript } from "./conversation.ts";
import { ConversationUnavailable } from "./conversation-shared.ts";
import { gjcMenuShown } from "./dialogs/fallback.ts";
import { parsedByPublicPrompt, publicPrompt } from "./dialogs/shared.ts";
import { OmoAskReader, ompAsksAfter, type OmoAsks } from "./omo-ask.ts";
import { alike, cardDrawn, drawn, shows } from "./omp-ask.ts";

/** the row gjc's ask (0.22) adds under a question's options (tools/ask.ts `OTHER_OPTION`); it numbers it, and adds a
 * clarification row, only for a deep-interview question, which this does not read */
const OTHER = "Other (type your own)";
/** gjc adds this to the recommended option's label before it draws it (tools/ask.ts `RECOMMENDED_SUFFIX`) */
const RECOMMENDED = " (Recommended)";
/** the rows gjc's selector draws over and under a title taller than its rows (hook-selector.ts `ScrollableTitle`) */
const MORE_ABOVE = "▲ more";
const MORE_BELOW = "▼ more";

const flat = (text: string): string => text.replace(/\s+/gu, " ").trim();

/**
 * Whether the selector's title rows draw `markdown`: all of it, or its start when the title is taller than its rows and
 * scrolled to the top (`▼ more` under it). A title scrolled past its start shows no start to check.
 */
function titleShown(rows: readonly string[], markdown: string): boolean {
  if (rows[0] === MORE_ABOVE) return false;
  const expected = drawn(markdown, true);
  if (rows.at(-1) !== MORE_BELOW) return shows(rows.join("\n"), expected);
  const start = flat(rows.slice(0, -1).join("\n"));
  return expected !== null && start !== "" && flat(expected).length > start.length && flat(expected).startsWith(start);
}

/** Whether the selector's rows (Esc left out) are the call's labels as drawn, then gjc's Other row. */
function optionsShown(rows: readonly string[], labels: readonly string[]): boolean {
  return rows.length === labels.length + 1 && rows.at(-1) === OTHER
    && labels.every((label, index) => shows(rows[index]!, drawn(label, false)));
}

/**
 * gjc's ask in the agent's own Markdown. gjc asks through its selector (`ctx.ui.select`), which the generic card reads off
 * the screen (dialogs/fallback.ts): it takes the title's last row for the question and the rows above it for a body,
 * and the Markdown gjc drew is lost. The session's one open `ask` call gives the question back whole when the selector
 * on screen provably draws one of its single-choice questions: its title rows are that question as gjc draws it (with
 * its `(n/m)` when the call asks more than one), and its rows are that question's labels, the recommended one with gjc's
 * ` (Recommended)`, in order, then Other. Anything else leaves the card as read. The card keeps its id and the keys read
 * for it: the selector on screen stays the authority over what an answer sends.
 */
export function gjcAskPrompt(prompt: InteractivePrompt, open: OmoAsks): InteractivePrompt {
  const parsed = parsedByPublicPrompt.get(prompt);
  const title = parsed?.gjcTitleRows;
  if (parsed?.responder !== "fallback-gjc-menu" || title === undefined || open.length !== 1) return prompt;
  const rows = parsed.menuLabels.slice(0, -1);
  const questions = askedQuestions("ask", open[0]!.args) ?? [];
  const matches = questions.flatMap((asked, index) => {
    if (asked.multi || asked.options.length === 0) return [];
    const markdown = questions.length > 1 ? `${asked.question} (${index + 1}/${questions.length})` : asked.question;
    // gjc takes no recommendation on a question of one option (tools/ask.ts `validRecommendedIndex`)
    const recommended = asked.options.length > 1 ? asked.recommended : null;
    const labels = asked.options.map((option, at) => at === recommended && !option.label.endsWith(RECOMMENDED) ? `${option.label}${RECOMMENDED}` : option.label);
    return titleShown(title, markdown) && optionsShown(rows, labels) ? [{ markdown, labels }] : [];
  });
  if (matches.length !== 1) return prompt;
  const { markdown, labels } = matches[0]!;
  // labels the card would show alike are told apart on the terminal by place alone: the card stays as drawn (#2233)
  const shown = labels.map((label) => alike(cardDrawn(label, false) ?? label));
  if (new Set(shown).size !== shown.length) return prompt;
  return publicPrompt(gjcMenuShown(parsed, {
    question: markdown, body: null, text_format: "markdown",
    options: [...labels.map((label) => ({ label, description: null })), ...parsed.options.slice(labels.length)],
  }));
}

const reader = new OmoAskReader(ompAsksAfter);
const unreadable = new Set<string>();

/** A gjc selector's card with its open ask call's Markdown (gjcAskPrompt), or as read when the pane's session cannot be found. */
export async function withGjcAsk(paneId: string, card: InteractivePrompt): Promise<InteractivePrompt> {
  if (parsedByPublicPrompt.get(card)?.responder !== "fallback-gjc-menu") return card;
  try {
    const found = await paneTranscript(paneId);
    return found.source === "gjc-transcript" ? gjcAskPrompt(card, reader.read(found.path)) : card;
  } catch (error) {
    if (error instanceof ConversationUnavailable || (error as NodeJS.ErrnoException).code === "ENOENT") return card;
    const kind = error instanceof Error ? error.name : typeof error;
    if (!unreadable.has(kind)) {
      unreadable.add(kind);
      console.warn(`prompt: gjc's session could not be read for pane ${paneId}; its ask card stays the screen's (${error instanceof Error ? error.message : String(error)})`);
    }
    return card;
  }
}
