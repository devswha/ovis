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
 * is provably the menu on screen: one of its questions, reduced to what omp draws, is the question
 * shown, with the same options in the same order, labels and descriptions included. Anything else
 * leaves the card as drawn: no open call or more than one, no question or more than one that
 * matches, an option with a preview (omp draws it into the option's rows), a description omp cut at
 * its two rows without a mark. The terminal's menu stays the authority: the card keeps its id and
 * the keys read for it, so an answer goes where it did.
 */
export function ompMarkdownPrompt(prompt: InteractivePrompt, open: OmoAsks): InteractivePrompt {
  const parsed = parsedByPublicPrompt.get(prompt);
  if (parsed?.responder !== "omp-question" || open.length !== 1) return prompt;
  const matches = (askedQuestions("ask", open[0]!.args) ?? []).filter((asked) => asked.multi === prompt.multi_select
    && asked.options.length === prompt.options.length
    && asked.options.every((option, index) => {
      const shown = prompt.options[index]!;
      const description = option.description?.trim() ? option.description : null;
      return option.preview === null && shows(shown.label, inline(label(option.label), false))
        && (description === null ? shown.description === null : shown.description !== null && shows(shown.description, inline(description, false)));
    })
    && shows(prompt.question, block(asked.question), parsed.ompQuestionRows === OMP_QUESTION_ROWS));
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

/** omp shows a question in at most this many rows, the last one cut with `…` (pi-tui ask-dialog.ts `MAX_HEADER_ROWS`, 18.12.6 to 18.13.2) */
const OMP_QUESTION_ROWS = 4;

/**
 * Whether the screen's text is `drawn`, character for character but for spacing, which omp wraps at
 * the pane's width. Case, digits and every mark count, so a call that differs from the menu by one
 * `/`, `_` or letter is another call. Only a question omp cut (`cut`: it fills the panel's four rows)
 * may show just the start of the call's question, followed by omp's `…`.
 */
function shows(screen: string, drawn: string, cut = false): boolean {
  const shown = screen.replace(/\s+/gu, "");
  const asked = drawn.replace(/\s+/gu, "");
  if (shown === asked) return true;
  const start = shown.replace(/…$/u, "");
  return cut && start !== shown && asked.length > start.length && asked.startsWith(start);
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const CODE_SPAN_RE = /(`+)([\s\S]*?[^`])\1(?!`)/g;
const LINK_RE = /(!?)\[([^\]\n]*)\]\(\s*<?([^\s)>]*)>?(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g;
const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };

/**
 * A question as omp draws it, a Markdown block: a fence's own lines go and the code between them stays
 * as written; a heading of level 1 or 2 loses its `#` (a deeper one keeps them); every other line is
 * inline Markdown, whose links show their address after their words.
 */
function block(markdown: string): string {
  let fence: string | null = null;
  return markdown.split(/\r?\n/).map((line) => {
    const marker = FENCE_RE.exec(line)?.[1];
    if (fence !== null) {
      if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null;
      return fence === null ? "" : line;
    }
    if (marker !== undefined) { fence = marker; return ""; }
    return inline(line.replace(/^#{1,2}\s+/, ""), true);
  }).join("\n");
}

/**
 * Inline Markdown as omp draws it: a code span's text as written; outside code, no emphasis or
 * strikethrough marks (`*`, `~~`, a `_` at a word's edge), a link as its words (in a question,
 * `addresses`, with its address after them unless they are the address), a picture as its alt text,
 * an HTML entity as its character. A mark omp draws after all only makes the call differ from the
 * screen, which leaves the card as drawn.
 */
function inline(markdown: string, addresses: boolean): string {
  let out = "";
  let at = 0;
  for (const code of markdown.matchAll(CODE_SPAN_RE)) {
    out += prose(markdown.slice(at, code.index), addresses) + code[2]!;
    at = code.index + code[0].length;
  }
  return out + prose(markdown.slice(at), addresses);
}

function prose(text: string, addresses: boolean): string {
  let out = "";
  let at = 0;
  for (const link of text.matchAll(LINK_RE)) {
    const [whole, image, words, href] = [link[0], link[1]!, link[2]!, link[3]!];
    const address = image || !addresses || !href || words === href || words === href.replace(/^mailto:/, "") ? "" : ` (${href})`;
    out += unmarked(text.slice(at, link.index)) + unmarked(words) + address;
    at = link.index + whole.length;
  }
  return out + unmarked(text.slice(at));
}

const unmarked = (text: string): string => text.replace(/\*+|~~|(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, "")
  .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name: string) => ENTITIES[name]!);
