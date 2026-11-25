import { expect, test } from "bun:test";
import { Terminal } from "@xterm/xterm";
import { matchHerdrWidths } from "../terminalWidths.ts";
import { holdScreenRows, viewRows, type ScreenRows } from "../terminalScreen.ts";
import { ghosttyRows } from "./screenRows.ts";
import { selectionText, wordAt, wrappedRange } from "./selection.ts";
import { GhosttyVt } from "./vt.ts";

const SEPARATORS = " ()[]{}',\"`";
const parse = (term: Terminal, data: string): Promise<void> => new Promise((resolve) => term.write(data, resolve));

async function both(cols: number, rows: number, stream: string, read: (rows: ScreenRows) => unknown): Promise<{ xterm: unknown; ghostty: unknown }> {
  const term = new Terminal({ cols, rows, scrollback: 50, allowProposedApi: true });
  matchHerdrWidths(term);
  const vt = await GhosttyVt.create(cols, rows);
  try {
    vt.setScrollback(50);
    vt.write(stream);
    await parse(term, stream);
    return { xterm: read(term.buffer.active), ghostty: read(ghosttyRows(vt)) };
  } finally {
    vt.dispose();
    term.dispose();
  }
}

const SCREEN = "$ ls (src/lib) 한글단어 x\r\n👨‍👩‍👧 emoji-word, \"quoted\"\r\n" + "averyveryverylongwordthatwraps".repeat(2) + " tail\r\n  \tindented   line   \r\n";

test("a double click takes the same word off either engine's rows, wide cells, graphemes and wraps included", async () => {
  const points: [number, number][] = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 20; x++) points.push([x, y]);
  const read = (rows: ScreenRows) => points.map((point) => [wordAt(rows, 20, SEPARATORS, point, true), wordAt(rows, 20, SEPARATORS, point, false)]);
  const { xterm, ghostty } = await both(20, 8, SCREEN, read);
  expect(ghostty).toEqual(xterm);
});

test("a word is cut at xterm's separators and follows a wrap onto the next row", async () => {
  const { ghostty } = await both(20, 4, `ab (word) cd\r\n${"x".repeat(30)}\r\n`, (rows) => ({
    inParens: wordAt(rows, 20, SEPARATORS, [5, 0], false),
    wrapped: wordAt(rows, 20, SEPARATORS, [3, 1], false),
    blank: wordAt(rows, 20, SEPARATORS, [15, 0], false),
    lines: wrappedRange(rows, 2),
  }));
  // "word" is columns 4-7 of row 0; the 30 x's fill row 1 and wrap 10 columns onto row 2
  expect(ghostty).toEqual({ inParens: { start: 4, length: 4 }, wrapped: { start: 0, length: 30 }, blank: undefined, lines: { first: 1, last: 2 } });
});

test("a triple click and a copy take the same lines and text off either engine's rows", async () => {
  const read = (rows: ScreenRows) => ({
    ranges: [0, 1, 2, 3, 4, 5, 6].map((y) => wrappedRange(rows, y)),
    text: selectionText(rows, [3, 0], [5, 6], false, "\n"),
    oneRow: selectionText(rows, [2, 1], [12, 1], false, "\n"),
    column: selectionText(rows, [2, 0], [9, 6], true, "\n"),
    empty: selectionText(rows, [4, 0], [4, 3], true, "\n"),
  });
  const { xterm, ghostty } = await both(20, 8, SCREEN, read);
  expect(ghostty).toEqual(xterm);
});

test("a wide glyph's second column is taken as xterm takes it: in a double click, a copy that starts there and a column copy", async () => {
  const { ghostty, xterm } = await both(4, 4, "界 cat\r\na界BC\r\n0123\r\na界B\r\n0123", (rows) => ({
    rightHalf: wordAt(rows, 4, SEPARATORS, [1, 0], false),
    wrapped: wordAt(rows, 4, SEPARATORS, [2, 2], false),
    fromSecondHalf: selectionText(rows, [1, 0], [5, 0], false, "\n"),
    column: selectionText(rows, [2, 4], [4, 6], true, "\n"),
  }));
  expect(ghostty).toEqual(xterm);
  // xterm.js 6: the word is the glyph; the word runs on over the wrap; a copy from the second column starts with a space
  expect(ghostty).toEqual({ rightHalf: { start: 0, length: 2 }, wrapped: { start: 0, length: 5 }, fromSecondHalf: "  c", column: "23\n B\n23" });
});

test("a row xterm keeps in its history is read as the row as far above the screen in libghostty, wherever the view is", async () => {
  const term = new Terminal({ cols: 80, rows: 3, scrollback: 50, allowProposedApi: true });
  const vt = await GhosttyVt.create(80, 3);
  try {
    vt.setScrollback(50);
    const stream = [1, 2, 3, 4, 5, 6].map((n) => String(n).repeat(100)).join("\r\n");
    vt.write(stream);
    await parse(term, stream);
    term.resize(120, 3);
    vt.resize(120, 3, 8, 16);
    holdScreenRows(term, () => ghosttyRows(vt));
    // the two engines lay out a widened screen differently: what the row reads is the row drawn there (libghostty's)
    const read = (): string => viewRows(term).getLine(term.buffer.active.baseY)?.translateToString(true) ?? "";
    const drawn = ghosttyRows(vt).getLine(ghosttyRows(vt).viewportY)?.translateToString(true);
    const atBottom = read();
    term.scrollToTop();
    vt.scrollFromBottom(vt.history().scrollback);
    expect(atBottom).toBe(drawn!);
    expect(read()).toBe(atBottom);
  } finally {
    holdScreenRows(term, null);
    vt.dispose();
    term.dispose();
  }
});
