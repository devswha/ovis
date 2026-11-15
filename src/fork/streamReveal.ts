/**
 * How a streamed reply is revealed (useRevealedTurns in liveTurn.ts): at an even pace across the
 * time until its next update is expected, a whole word at a time, and short of markdown it has
 * opened but not closed yet, so a half-written `**bold` or link never shows its marks.
 */

/** the reveal moves on this often: about 15 frames a second */
export const REVEAL_TICK_MS = 66;
/** the fastest a reveal reads while it is behind: about 500 characters a second */
const FAST_CHARS_PER_MS = 0.5;
/** a backlog is revealed within at most this long, however large */
const MAX_HORIZON_MS = 1500;
/** further behind than this (a phone back from a dead spot) and the reveal jumps */
const MAX_BACKLOG = 1500;
/** the expected time between updates, learned from the last ones within these bounds */
const GAP_MIN_MS = REVEAL_TICK_MS;
const GAP_MAX_MS = 500;
const FIRST_GAP_MS = 200;

export interface Pace {
  /** how far the reveal has got, in characters of the source text (a fraction between words) */
  readonly shown: number;
  /** how long the source text is */
  readonly length: number;
  /** when the source text last grew */
  readonly arrived: number;
  /** how long its updates are apart, smoothed */
  readonly gap: number;
}

export function startPace(length: number, shown: number, now: number): Pace {
  return { shown, length, arrived: now, gap: FIRST_GAP_MS };
}

/** The pace once the source text grew to `length`. */
export function paceGrew(pace: Pace, length: number, now: number): Pace {
  if (length <= pace.length) return pace;
  const gap = Math.min(GAP_MAX_MS, Math.max(GAP_MIN_MS, 0.7 * pace.gap + 0.3 * (now - pace.arrived)));
  return { shown: Math.max(pace.shown, length - MAX_BACKLOG), length, arrived: now, gap };
}

/**
 * Where the reveal is one tick on: what is left is spread over the time until the next update is
 * expected, so it ends as that one lands, and never faster than FAST_CHARS_PER_MS unless the
 * backlog would take longer than MAX_HORIZON_MS at that pace.
 */
export function paceStep(pace: Pace, now: number): Pace {
  const backlog = pace.length - pace.shown;
  if (backlog <= 0) return pace;
  const horizon = Math.max(pace.arrived + pace.gap - now, Math.min(backlog / FAST_CHARS_PER_MS, MAX_HORIZON_MS), REVEAL_TICK_MS);
  return { ...pace, shown: Math.min(pace.length, pace.shown + backlog * REVEAL_TICK_MS / horizon) };
}

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
