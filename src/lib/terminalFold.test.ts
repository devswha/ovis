import { describe, expect, test } from "bun:test";
import type { IBufferCell, IBufferLine } from "@xterm/xterm";
import { paletteColor, readableColor, rowHtml } from "./terminalFold.ts";

interface Cell { chars: string; width?: number; fg?: number; bg?: number; bold?: boolean }

/** A grid row of plain cells: what rowHtml reads of xterm's buffer, palette colours only. */
function line(cells: Cell[], cols: number): IBufferLine {
  const at = (x: number): Cell => cells[x] ?? { chars: "" };
  const cell = (x: number): IBufferCell => {
    const c = at(x);
    return {
      getChars: () => c.chars,
      getWidth: () => c.width ?? 1,
      getCode: () => c.chars.codePointAt(0) ?? 0,
      isBold: () => (c.bold ? 1 : 0),
      isItalic: () => 0, isDim: () => 0, isUnderline: () => 0, isBlink: () => 0, isInverse: () => 0,
      isInvisible: () => 0, isStrikethrough: () => 0, isOverline: () => 0,
      isFgDefault: () => c.fg === undefined, isBgDefault: () => c.bg === undefined,
      isFgRGB: () => false, isBgRGB: () => false,
      isFgPalette: () => c.fg !== undefined, isBgPalette: () => c.bg !== undefined,
      getFgColor: () => c.fg ?? 0, getBgColor: () => c.bg ?? 0,
      getFgColorMode: () => 0, getBgColorMode: () => 0, isAttributeDefault: () => c.fg === undefined && c.bg === undefined && !c.bold,
    } as unknown as IBufferCell;
  };
  return { length: cols, isWrapped: false, getCell: (x: number) => (x < cols ? cell(x) : undefined), translateToString: () => "" } as unknown as IBufferLine;
}
const scratch = {} as IBufferCell;
const plain = (text: string): Cell[] => [...text].map((chars) => ({ chars }));

describe("the folded view of a mirrored grid", () => {
  test("a palette index draws as the theme's colour, xterm's own where the theme names none, then the cube and the grey ramp", () => {
    expect(paletteColor(1, { red: "#ff5555" })).toBe("#ff5555");
    expect(paletteColor(1, {})).toBe("#cc0000");
    expect(paletteColor(16, {})).toBe("#000000");
    expect(paletteColor(196, {})).toBe("#ff0000");
    expect(paletteColor(231, {})).toBe("#ffffff");
    expect(paletteColor(232, {})).toBe("#080808");
    expect(paletteColor(255, {})).toBe("#eeeeee");
  });

  test("a colour too faint on its background is lifted until it reads, as the grid's minimum contrast draws it", () => {
    const lifted = readableColor("#3465a4", "#000000", 4.5);
    expect(lifted).not.toBe("#3465a4");
    expect(readableColor(lifted, "#000000", 4.5)).toBe(lifted);
    const darkened = readableColor("#fce94f", "#ffffff", 4.5);
    expect(darkened).not.toBe("#fce94f");
    expect(readableColor(darkened, "#ffffff", 4.5)).toBe(darkened);
    expect(readableColor("#eeeeec", "#000000", 4.5)).toBe("#eeeeec");
    expect(readableColor("#3465a4", "#000000", 1)).toBe("#3465a4");
    expect(readableColor("rgb(1, 2, 3)", "#000000", 4.5)).toBe("rgb(1, 2, 3)");
  });

  test("a row is its runs of cells drawn alike, without the blank cells herdr pads it with", () => {
    const cells: Cell[] = [{ chars: "a", fg: 1 }, { chars: "b", fg: 1 }, { chars: " " }, { chars: "가", width: 2 }, { chars: "", width: 0 }, ...plain("<&>   ")];
    expect(rowHtml(line(cells, 12), 12, { red: "#ff5555" }, scratch)).toBe('<span style="color:#ff5555;">ab</span> 가&lt;&amp;&gt;');
  });

  test("a row that draws only a background keeps it, and an empty row is empty", () => {
    expect(rowHtml(line([{ chars: " ", bg: 2 }], 4), 4, { green: "#50fa7b" }, scratch)).toBe('<span style="background:#50fa7b;"> </span>');
    expect(rowHtml(line([], 4), 4, {}, scratch)).toBe("");
  });

  test("bold text of the first eight colours draws in their bright forms", () => {
    expect(rowHtml(line([{ chars: "x", fg: 1, bold: true }], 1), 1, {}, scratch)).toBe('<span style="color:#ef2929;font-weight:bold;">x</span>');
  });
});
