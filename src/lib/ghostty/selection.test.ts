import { expect, test } from "bun:test";
import { Terminal } from "@xterm/xterm";
import { matchHerdrWidths } from "../terminalWidths.ts";
import type { ScreenRows } from "../terminalScreen.ts";
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
