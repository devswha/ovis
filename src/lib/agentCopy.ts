/**
 * Copied text from an agent's pane, as one paragraph per paragraph (#2558). An agent on the
 * alternate screen (Claude Code, Codex) wraps its reply itself: it breaks a paragraph at the pane
 * width and starts each continuation row at its block's hanging indent, so those breaks are real
 * rows on the grid, and both xterm's selection and herdr's `pane.selection.read` return them with
 * the newline and the indent. herdr's own TUI copies the same rows as one line; this does the same.
 *
 * A row joins the one above when it starts exactly at the hanging indent of the row above (that
 * row's indent plus its marker: `⏺ `, `- `, `1. `, `⎿  `) and its first word could not have fit
 * after that row, which is where a word wrap breaks. A short line, a blank line, a list's next
 * item, a code line indented deeper, a table or box row, and a row drawn wider than the pane is
 * now (scrollback from before a resize) keep their line break. A word cut at the edge (a URL or
 * path longer than a whole row, which a wrap has to split) and Chinese or Japanese text cut
 * between two wide characters join with no space.
 */
import { herdrWidthProvider } from "./terminalWidths.ts";

const MARKER = /^(?:[⏺●•◦▪*+-]|[⎿└]|\d{1,3}[.)])\s+/u;
const BOX = /[\u2500-\u257f|]/u;
/** Hangul spaces its words; other wide scripts (Chinese, Japanese) wrap between any two characters */
const HANGUL = /\p{Script=Hangul}/u;

let widths: ReturnType<typeof herdrWidthProvider> | undefined;

/** The cells `text` takes on herdr's grid. */
function cells(text: string): number {
  widths ??= herdrWidthProvider();
  let count = 0;
  for (const char of text) count += widths.wcwidth(char.codePointAt(0)!);
  return count;
}

const leading = (text: string): number => text.length - text.trimStart().length;

/**
 * `text` as selected from rows `cols` cells wide, its first row starting at cell `firstCol`, with
 * the agent's wrapped rows joined back into their lines and the continuation indent dropped.
 */
export function unwrapAgentRows(text: string, cols: number, firstCol = 0): string {
  // xterm joins rows with \r\n on Windows
  const parts = text.split(/(\r?\n)/);
  let joined = parts[0]!;
  let row = joined;
  let rowStart = firstCol;
  // where the row above's continuation rows start: its indent plus its marker
  let hanging = rowStart + leading(row) + (MARKER.exec(row.trimStart())?.[0].length ?? 0);
  for (let i = 1; i < parts.length; i += 2) {
    const separator = parts[i]!;
    const next = parts[i + 1]!;
    const indent = leading(next);
    const rest = next.slice(indent);
    const above = row.trimEnd();
    const end = rowStart + cells(above);
    const word = rest.split(" ", 1)[0]!;
    const wraps = indent > 0 && indent === hanging && rest !== "" && above.trim() !== ""
      && end <= cols && end + 1 + cells(word) > cols
      && !BOX.test(above.at(-1)!) && !BOX.test(rest[0]!);
    if (wraps) {
      const last = [...above].at(-1)!;
      const first = rest.codePointAt(0)!;
      // a word too long for a row of its own was split at the edge, and wide text breaks between any two characters
      const cut = (end >= cols && cells(above.split(" ").at(-1)! + word) > cols - indent)
        || (cells(last) === 2 && cells(String.fromCodePoint(first)) === 2 && !HANGUL.test(last) && !HANGUL.test(String.fromCodePoint(first)));
      joined = joined.trimEnd() + (cut ? "" : " ") + rest;
    } else {
      joined += separator + next;
      hanging = indent + (MARKER.exec(rest)?.[0].length ?? 0);
    }
    row = next;
    rowStart = 0;
  }
  return joined;
}
