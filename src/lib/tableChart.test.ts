import { describe, expect, it } from "bun:test";

import { parseInline, parseMarkdown, type MarkdownBlock } from "../../shared/markdown.ts";
import { cellSource, tableChartCells, type TableChartCells } from "./tableChart.ts";

function cellsOf(markdown: string): (TableChartCells | null)[] {
  return parseMarkdown(markdown).flatMap((block: MarkdownBlock) => block.type === "table" ? [tableChartCells(block.header, block.rows)] : []);
}

describe("cellSource", () => {
  it("writes a cell back as the Markdown it was written in, which is what the chart engine reads", () => {
    for (const written of [
      "92%",
      "**Opus 5.5**",
      "**92%** ✅",
      "`sessions/<cwd>/*.jsonl`",
      "~~old~~ 4.1 s",
      "*slow*, 5 ms",
      "[312530](https://x.test/312530)",
      "![chart](https://x.test/c.png)",
      "\\$12.50",
      "3 <br> 4",
      "$x^2$ and \\(y\\)",
    ]) expect(cellSource(parseInline(written))).toBe(written);
  });

  it("keeps the words of a mark written the other way, the marks of its kind: _a_ for *a*, a bare address for a link", () => {
    expect(cellSource(parseInline("__strong__ and _soft_"))).toBe("**strong** and *soft*");
    expect(cellSource(parseInline("see https://x.test/a"))).toBe("see [https://x.test/a](https://x.test/a)");
  });
});

describe("tableChartCells", () => {
  it("is a table's cells as strings, the header's and each row's", () => {
    expect(cellsOf([
      "| Model | Pass rate |",
      "|:--|--:|",
      "| **Opus 5.5** | **92%** |",
      "| [Sonnet 5.5](https://x.test/s) | `88`% |",
    ].join("\n"))).toEqual([{ header: ["Model", "Pass rate"], rows: [["**Opus 5.5**", "**92%**"], ["[Sonnet 5.5](https://x.test/s)", "`88`%"]] }]);
  });

  it("cuts a row to the header's width and pads a short one, as omp's Markdown reader does", () => {
    expect(cellsOf([
      "| A | B | C |",
      "|---|---|---|",
      "| 1 | 2 |",
      "| 3 | 4 | 5 | 6 |",
    ].join("\n"))).toEqual([{ header: ["A", "B", "C"], rows: [["1", "2", ""], ["3", "4", "5"]] }]);
  });

  it("is none for a table with no digit in its body, so the engine is not fetched for it", () => {
    expect(cellsOf("| Tool | Notes |\n|---|---|\n| Vite | fast |\n| Bun | all in one |")).toEqual([null]);
    // a number in the header names a column; it is no measure
    expect(cellsOf("| Tool | 2026 |\n|---|---|\n| Vite | fast |\n| Bun | all in one |")).toEqual([null]);
    expect(cellsOf("| Tool | Notes |\n|---|---|\n| Vite | v8 |")).toEqual([{ header: ["Tool", "Notes"], rows: [["Vite", "v8"]] }]);
  });
});
