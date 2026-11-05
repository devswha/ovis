import { describe, expect, it } from "bun:test";
import { Terminal } from "@xterm/xterm";

import { matchHerdrWidths } from "../terminalWidths.ts";
import { GhosttyVt } from "./vt.ts";

interface Layout { cells: [number, string][]; cursor: number }

/** Each drawn cell's column and grapheme on the first row, and the cursor's column, as libghostty lays out `text`. */
async function ghosttyLayout(text: string): Promise<Layout> {
  const vt = await GhosttyVt.create(40, 2);
  try {
    vt.write(text);
    const cells: [number, string][] = [];
    vt.frame((y, runs) => {
      if (y !== 0) return;
      for (const run of runs) {
        let x = run.x;
        for (const cell of run.cells) {
          if (cell.text !== " ") cells.push([x, cell.text]);
          x += cell.wide ? 2 : 1;
        }
      }
    });
    return { cells, cursor: vt.cursor().x };
  } finally {
    vt.dispose();
  }
}

/** The same, as xterm counts them with herdr's widths: the grid the cursor, selection and links use. */
async function xtermLayout(text: string): Promise<Layout> {
  const term = new Terminal({ allowProposedApi: true, cols: 40, rows: 2 });
  matchHerdrWidths(term);
  await new Promise<void>((resolve) => term.write(text, resolve));
  const line = term.buffer.active.getLine(0)!;
  const cells: [number, string][] = [];
  for (let x = 0; x < 40; x++) {
    const chars = line.getCell(x)?.getChars() ?? "";
    if (chars && chars !== " ") cells.push([x, chars]);
  }
  const cursor = term.buffer.active.cursorX;
  term.dispose();
  return { cells, cursor };
}

const ascii = ({ cells, cursor }: Layout): Layout => ({
  cells: cells.map(([x, text]): [number, string] => [x, text.replace(/\p{Default_Ignorable_Code_Point}/gu, "")])
    .filter(([, text]) => /^[\x21-\x7e]$/.test(text)),
  cursor,
});

describe("GhosttyVt widths", () => {
  for (const [name, text] of [
    ["ZWJ family", "ABC👨‍👩‍👧XYZ"],
    ["emoji presentation selector", "a⚠️b"],
    ["skin tone", "a👍🏽b"],
    ["flag", "a🇰🇷b"],
    ["keycap", "a1️⃣b"],
    ["Unicode 15 emoji", "a🫨b"],
    ["Hangul and Han", "a한漢b"],
  ] as const) {
    it(`draws each grapheme in xterm's cell: ${name}`, async () => {
      expect(await ghosttyLayout(text)).toEqual(await xtermLayout(text));
    });
  }

  // libghostty draws a cluster with a spacing mark as one two-column cell where xterm has two cells over the
  // same columns, and drops a zero-width space xterm keeps in the cell before it: nothing after them moves
  for (const [name, text] of [
    ["Thai SARA AM", "aน้ำb c"],
    ["Devanagari vowel sign", "aकाb c"],
    ["zero-width space", "a\u200bb c"],
  ] as const) {
    it(`puts the text after it in xterm's columns: ${name}`, async () => {
      expect(ascii(await ghosttyLayout(text))).toEqual(ascii(await xtermLayout(text)));
    });
  }

  for (const [name, prefix] of [
    ["the program turns mode 2027 off", "\x1b[?2027l"],
    ["it turns 2027 off among other modes", "\x1b[?1;2027l"],
    ["the terminal is reset", "\x1bc"],
  ] as const) {
    it(`keeps grapheme clusters after ${name}`, async () => {
      expect(await ghosttyLayout(`${prefix}ABC👨‍👩‍👧XYZ`)).toEqual(await xtermLayout(`${prefix}ABC👨‍👩‍👧XYZ`));
    });
  }
});
