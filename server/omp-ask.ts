import { askedQuestions } from "../shared/askQuestions.ts";
import type { InteractivePrompt } from "../shared/protocol.ts";
import { parsedByPublicPrompt, publicPrompt } from "./dialogs/shared.ts";
import type { OmoAsks } from "./omo-ask.ts";

/**
 * omp's Ask card in the agent's own Markdown (#1644). The terminal draws the call's text through
 * its Markdown renderer (pi-tui `ask-dialog.ts`, omp 18.12.6 to 18.13.2), and the card read off the
 * screen gets only that drawn text: emphasis, code and links are lost, and a question past four
 * rows is cut with `…`.
 *
 * The session's one open `ask` call (ompAsksAfter) gives its text back only when that call
 * is provably the menu on screen: one of its questions, drawn as omp draws it, is the question
 * shown, with the same options in the same order, labels and descriptions included. Anything else
 * leaves the card as drawn: no open call or more than one, no question or more than one that
 * matches, Markdown omp draws in a way not followed here (a table, a quote, a task list), an option
 * with a preview (omp draws it into the option's rows), a description omp cut at its two rows. The
 * terminal's menu stays the authority: the card keeps its id and the keys read for it, so an
 * answer goes where it did.
 */
export function ompMarkdownPrompt(prompt: InteractivePrompt, open: OmoAsks): InteractivePrompt {
  const parsed = parsedByPublicPrompt.get(prompt);
  if (parsed?.responder !== "omp-question" || open.length !== 1) return prompt;
  const matches = (askedQuestions("ask", open[0]!.args) ?? []).filter((asked) => asked.multi === prompt.multi_select
    && asked.options.length === prompt.options.length
    && asked.options.every((option, index) => {
      const shown = prompt.options[index]!;
      const description = option.description?.trim() ? option.description : null;
      return option.preview === null && shows(shown.label, drawn(label(option.label), false))
        && (description === null ? shown.description === null : shown.description !== null && shows(shown.description, drawn(description, false)));
    })
    && shows(prompt.question, drawn(asked.question, true), parsed.ompQuestionCut === true));
  if (matches.length !== 1) return prompt;
  const asked = matches[0]!;
  return publicPrompt({
    ...parsed,
    question: asked.question,
    options: asked.options.map((option) => ({ label: label(option.label), description: option.description?.trim() ? option.description : null })),
    text_format: "markdown",
  });
}

/** omp adds ` (Recommended)` to the recommended option's label; the card read off the screen drops it (dialogs/omp.ts), and so does this one */
const label = (text: string): string => text.replace(/ \(Recommended\)$/i, "");

/**
 * Whether the screen's text is `drawn`, character for character but for spacing, which omp wraps at
 * the pane's width. Case, digits and every mark count, so a call that differs from the menu by one
 * `/`, `*`, `_` or letter is another call. Only a question omp says it cut (`cut`, dialogs/omp.ts)
 * may show just the start of the call's question, followed by omp's `…`.
 */
function shows(screen: string, drawn: string | null, cut = false): boolean {
  if (drawn === null) return false;
  const shown = screen.replace(/\s+/gu, "");
  const asked = drawn.replace(/\s+/gu, "");
  if (shown === asked) return true;
  const start = shown.replace(/…$/u, "");
  return cut && start !== shown && asked.length > start.length && asked.startsWith(start);
}

class Undrawn extends Error {}
const undrawn = (): never => { throw new Undrawn(); };

/**
 * `markdown` as omp draws it, read by a CommonMark parser (Bun's), as omp's own is: emphasis,
 * strikethrough and code show their text, a picture its alt text, a link its words; an escaped or
 * unpaired mark (`\*`, `*.log`, `_cache/`) stays. A question (`question`) is a Markdown block: its
 * links show their address after their words unless the words are the address, a heading of
 * level 3 or more keeps its `#`s, list items take omp's `- ` or `N. `, code blocks their code. A label
 * or description is one line of inline Markdown. Null for what omp draws otherwise (a table, a
 * quote, a rule, HTML, a task list, a block inside a label): the card then stays as drawn.
 */
function drawn(markdown: string, question: boolean): string | null {
  const block = <T>(draw: (children: string, meta: T) => string) => question ? draw : undrawn;
  try {
    return Bun.markdown.render(markdown, {
      text: (children) => children,
      strong: (children) => children,
      emphasis: (children) => children,
      strikethrough: (children) => children,
      codespan: (children) => children,
      image: (children) => children,
      link: (children, { href }) => question && href && children !== href && children !== href.replace(/^mailto:/, "") ? `${children} (${href})` : children,
      paragraph: (children) => `${children}\n`,
      heading: block<{ level: number }>((children, { level }) => `${level > 2 ? `${"#".repeat(level)} ` : ""}${children}\n`),
      code: block((children) => children),
      list: block((children) => children),
      listItem: block<{ index: number; ordered: boolean; start?: number; checked?: boolean }>((children, { index, ordered, start, checked }) =>
        checked === undefined ? `${ordered ? `${(start ?? 1) + index}. ` : "- "}${children}\n` : undrawn()),
      blockquote: undrawn, hr: undrawn, table: undrawn, html: undrawn,
    });
  } catch (error) {
    if (error instanceof Undrawn) return null;
    throw error;
  }
}
