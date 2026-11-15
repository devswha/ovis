/**
 * How much of a streamed reply is drawn (heldBackTurns in liveTurn.ts): whole words, short of
 * markdown it has opened but not closed yet, so a half-written `**bold` or link never shows its marks.
 */

/** The end of the last whole word at or before `at`; past the text's end only once it is done. */
export function wordCut(text: string, at: number, done: boolean): number {
  if (at >= text.length && done) return text.length;
  for (let index = Math.min(Math.floor(at), text.length); index > 0; index--) {
    if (/\s/.test(text[index] ?? "")) return index;
  }
  return 0;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** a line that is only a list, heading or quote marker so far */
const BARE_MARKER = /^\s*(?:[-*+]|\d{1,9}[.)]|#{1,6}|>)\s*$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}/;
const PUNCTUATION = /[\s\p{P}\p{S}]/u;

/** Where the unclosed inline markdown in a paragraph starts, or null when all of it is closed. */
function openInline(paragraph: string): number | null {
  const open = new Map<string, number>();
  const brackets: number[] = [];
  let index = 0;
  while (index < paragraph.length) {
    const char = paragraph[index]!;
    if (char === "\\") { index += 2; continue; }
    if (char === "`") {
      let run = 1;
      while (paragraph[index + run] === "`") run++;
      const marks = "`".repeat(run);
      let close = paragraph.indexOf(marks, index + run);
      while (close !== -1 && paragraph[close + run] === "`") close = paragraph.indexOf(marks, close + run + 1);
      if (close === -1) return Math.min(index, ...open.values(), ...brackets);
      index = close + run;
      continue;
    }
    if (char === "[") { brackets.push(index); index++; continue; }
    if (char === "]" && brackets.length > 0) {
      if (index + 1 === paragraph.length) break;
      const start = brackets.pop()!;
      if (paragraph[index + 1] === "(") {
        const close = paragraph.indexOf(")", index + 2);
        if (close === -1) return Math.min(start, ...open.values(), ...brackets);
        index = close + 1;
        continue;
      }
      index++;
      continue;
    }
    if (char === "*" || char === "_" || char === "~") {
      let run = 1;
      while (paragraph[index + run] === char) run++;
      if (char === "~" && run < 2) { index++; continue; }
      const mark = char.repeat(char === "~" ? 2 : Math.min(run, 3));
      const before = paragraph[index - 1];
      const after = paragraph[index + run];
      if (open.has(mark) && before !== undefined && !/\s/.test(before)) open.delete(mark);
      // marks the text ends on may yet open something: wait for the next word
      else if (after === undefined) return Math.min(index, ...open.values(), ...brackets);
      else if (!/\s/.test(after) && (char !== "_" || before === undefined || PUNCTUATION.test(before))) open.set(mark, index);
      index += run;
      continue;
    }
    index++;
  }
  const starts = [...open.values(), ...brackets];
  return starts.length === 0 ? null : Math.min(...starts);
}

/**
 * How much of `text` up to `cut` can be drawn without a mark that is not closed yet: the last
 * paragraph stops before an unclosed emphasis, code span or link, a bare list or heading marker,
 * or a table with no separator row yet. An open code fence is drawn as it comes (it reads as code
 * already), and a done text is drawn whole.
 */
export function stablePrefix(text: string, cut: number, done: boolean): number {
  if (done) return cut;
  const lines = text.slice(0, cut).split("\n");
  let fence: string | null = null;
  let start = 0;
  let offset = 0;
  for (const line of lines) {
    const marks = FENCE.exec(line)?.[1];
    if (fence !== null) {
      if (marks !== undefined && marks[0] === fence[0] && marks.length >= fence.length && line.trim() === marks) fence = null;
      if (fence === null) start = offset + line.length + 1;
    } else if (marks !== undefined) fence = marks;
    else if (line.trim() === "") start = offset + line.length + 1;
    offset += line.length + 1;
  }
  if (fence !== null || start >= cut) return cut;
  const paragraph = text.slice(start, cut);
  const lastLine = paragraph.lastIndexOf("\n") + 1;
  if (BARE_MARKER.test(paragraph.slice(lastLine))) return start + lastLine;
  if (paragraph.trimStart().startsWith("|") && !paragraph.split("\n").some((line) => TABLE_SEPARATOR.test(line))) return start;
  const unclosed = openInline(paragraph);
  return unclosed === null ? cut : start + unclosed;
}
