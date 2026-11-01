/**
 * Copied text from an agent's pane, as one paragraph per paragraph (#2558). An agent on the
 * alternate screen (Claude Code, Codex) wraps its reply itself: it breaks a paragraph at the pane
 * width and starts each continuation row with its block's indent, so those breaks are real rows
 * on the grid, and both xterm's selection and herdr's `pane.selection.read` return them with the
 * newline and the indent. herdr's own TUI copies the same rows as one line; this does the same.
 *
 * A row joins the one above when it is indented and its first word could not have fit after the
 * row above, which is where a word wrap breaks: a short line, a blank line, an unindented row or
 * an indented row that would have fit (a list's next item) keeps its line break. A row that is one
 * word filling the whole width (a long URL or path cut at the edge) joins with no space.
 */

const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]|\p{Extended_Pictographic}/u;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The cells `text` takes on the grid: a wide character (Hangul, CJK, an emoji) takes two. */
function cells(text: string): number {
  let count = 0;
  for (const { segment } of segmenter.segment(text)) count += WIDE.test(segment) ? 2 : 1;
  return count;
}

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
  for (let i = 1; i < parts.length; i += 2) {
    const separator = parts[i]!;
    const next = parts[i + 1]!;
    const indent = next.length - next.trimStart().length;
    const rest = next.slice(indent);
    const end = rowStart + cells(row.trimEnd());
    const word = rest.split(" ", 1)[0]!;
    if (indent > 0 && rest !== "" && row.trim() !== "" && end + 1 + cells(word) > cols) {
      // a lone word reaching the edge was cut there, not wrapped at a space
      const cut = end >= cols && !row.trim().includes(" ");
      joined = joined.trimEnd() + (cut ? "" : " ") + rest;
    } else joined += separator + next;
    row = next;
    rowStart = 0;
  }
  return joined;
}
