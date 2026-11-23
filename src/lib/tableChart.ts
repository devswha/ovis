import type { InlineNode } from "../../shared/markdown.ts";

/**
 * A cell as the Markdown it was written in, which is what omp's table-chart engine reads (it strips the decoration
 * itself, and reads `**` as a bolded cell, a link around a bare number as an id, a backslash as an escape).
 * shared/markdown.ts keeps only the parsed nodes, whose text is the source between the marks, so writing the
 * marks back gives the engine what omp's own Markdown reader hands it as `cell.text`. Where the writer used
 * `_a_` for `*a*` or left a URL bare, the plain words are the same.
 */
export function cellSource(nodes: readonly InlineNode[]): string {
  let source = "";
  for (const node of nodes) {
    switch (node.type) {
      case "text": source += node.value; break;
      case "code": source += `\`${node.value}\``; break;
      case "math": source += node.dollar === true ? `$${node.value}$` : `\\(${node.value}\\)`; break;
      case "strong": source += `**${cellSource(node.children)}**`; break;
      case "em": source += `*${cellSource(node.children)}*`; break;
      case "del": source += `~~${cellSource(node.children)}~~`; break;
      case "link": source += `[${cellSource(node.children)}](${node.href})`; break;
      case "image": source += `![${node.alt}](${node.src})`; break;
      case "file": source += `[${cellSource(node.children)}](${node.written ?? node.path})`; break;
    }
  }
  return source;
}

export interface TableChartCells {
  header: string[];
  rows: string[][];
}

/**
 * The cells of a table block as the chart engine reads them, or null for a table no chart could come of, so the
 * engine's chunk is not fetched for it: a measure is a column of numbers, and a number has a digit in it.
 * Rows are cut or padded to the header's width, as omp's Markdown reader does.
 */
export function tableChartCells(header: readonly (readonly InlineNode[])[], rows: readonly (readonly (readonly InlineNode[])[])[]): TableChartCells | null {
  const head = header.map(cellSource);
  const body = rows.map((row) => head.map((_cell, column) => cellSource(row[column] ?? [])));
  return body.some((row) => row.some((cell) => /\d/.test(cell))) ? { header: head, rows: body } : null;
}
