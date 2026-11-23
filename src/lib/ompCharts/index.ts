/**
 * The chart omp draws under a table, from omp's own engine: table-data.ts, chart-plan.ts and chart-svg.ts here are
 * vendored from can1357/oh-my-pi (THIRD_PARTY_NOTICES.md; each file's header lists what Ovis changed), so a table
 * charts in the chat as it does in the terminal.
 *
 * `tableChartSvg` is the path of omp's `tui.autoGraph: always` (packages/tui/src/chat/table-chart.ts, chartEntry and
 * drawChart): read the cells, guess a plan, build the chart, and draw it only when `worthCharting` says the table
 * deserves one. Smart mode, where a model refines the guess, is not here: it needs omp's judge model.
 *
 * Only a dynamic import reaches this folder (components/Markdown.tsx): the engine is a chunk of its own, fetched for
 * the first table that may chart, and the app's first script does not carry it.
 */
import { SVG_FIGURE_MAX_LENGTH } from "../svgFigure.ts";
import { buildChart, planChart, worthCharting } from "./chart-plan.ts";
import { renderChartSvg } from "./chart-svg.ts";
import { analyzeTable } from "./table-data.ts";

/** Tables remembered by their cells: as many as omp keeps, so a long chat holds its recent charts without growing. */
const CACHE_LIMIT = 256;
const charts = new Map<string, string | null>();

function draw(header: readonly string[], rows: readonly (readonly string[])[]): string | null {
  const table = analyzeTable(header, rows);
  const plan = planChart(table);
  if (plan === undefined) return null;
  const spec = buildChart(table, plan);
  if (spec === undefined || !worthCharting(spec)) return null;
  const svg = renderChartSvg(spec);
  // a figure past this size is not drawn (lib/svgFigure.ts), and a table of hundreds of rows makes megabytes of one
  return svg.length > SVG_FIGURE_MAX_LENGTH ? null : svg;
}

/**
 * The SVG omp's own guess draws under the table whose cells are `header` and `rows` (each cell as the Markdown it
 * was written in: the engine strips the decoration itself), colored with figure tokens (`var(--accent)`, …) for
 * lib/svgFigure.ts to resolve; null where omp draws no chart. A table the engine cannot read is a table without
 * a chart, never an error: the table stays what it is.
 */
export function tableChartSvg(header: readonly string[], rows: readonly (readonly string[])[]): string | null {
  const key = JSON.stringify([header, rows]);
  const known = charts.get(key);
  if (known !== undefined) {
    // read again, so the table to go is the one read the longest ago
    charts.delete(key);
    charts.set(key, known);
    return known;
  }
  let svg: string | null = null;
  try {
    svg = draw(header, rows);
  } catch (error) {
    console.warn("Ovis: a table's chart could not be drawn", error instanceof Error ? error.name : error);
  }
  if (charts.size >= CACHE_LIMIT) charts.delete(charts.keys().next().value!);
  charts.set(key, svg);
  return svg;
}

const ROOT_LABEL = /^<svg\b[^>]*?\saria-label="([^"]*)"/;
const ESCAPED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"" };

/**
 * The chart's own description, its root's `aria-label` as plain text ("" where it has none): the words a screen
 * reader says for the figure, which an image document does not pass on, so the page names the image with them.
 */
export function chartLabel(svg: string): string {
  const label = ROOT_LABEL.exec(svg)?.[1];
  return label === undefined ? "" : label.replace(/&(amp|lt|gt|quot);/g, (_entity, name: string) => ESCAPED[name]!);
}
