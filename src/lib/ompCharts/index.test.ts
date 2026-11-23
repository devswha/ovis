import { describe, expect, it, spyOn } from "bun:test";
import ts from "typescript-api";

import { files as scan, read } from "../../../scripts/source-scan.ts";
import { SVG_FIGURE_MAX_LENGTH, SVG_FIGURE_ROLES } from "../svgFigure.ts";
import { buildChart, planChart } from "./chart-plan.ts";
import { renderChartSvg } from "./chart-svg.ts";
import { chartLabel, tableChartSvg } from "./index.ts";
import { analyzeTable } from "./table-data.ts";

const BENCHMARK = {
  header: ["Model", "Pass rate", "p50 latency"],
  rows: [["Opus 5.5", "92%", "4.1 s"], ["Sonnet 5.5", "88%", "2.3 s"], ["Haiku 5.5", "71%", "0.9 s"], ["GPT-6", "90%", "3.4 s"], ["Gemini 4", "85%", "2.8 s"]],
};
const LATENCY = {
  header: ["Endpoint", "p50 (ms)"],
  rows: [["/search", "180"], ["/feed", "95"], ["/login", "110"], ["/export", "900"], ["/health", "7"], ["/upload", "240"]],
};

describe("the table chart", () => {
  it("is what omp's own guess draws for a table of models by pass rate and latency", () => {
    const svg = tableChartSvg(BENCHMARK.header, BENCHMARK.rows);
    expect(svg).not.toBeNull();
    expect(svg!.startsWith("<svg ")).toBe(true);
    expect(svg!.endsWith("</svg>")).toBe(true);
    expect(chartLabel(svg!)).toBe("small multiples chart of Pass rate, p50 latency by Model");
  });

  it("is a bar chart for one column of numbers under names", () => {
    const svg = tableChartSvg(LATENCY.header, LATENCY.rows);
    expect(svg).not.toBeNull();
    expect(chartLabel(svg!)).toBe("bar chart of p50 (ms) by Endpoint");
  });

  it("reads each cell as the Markdown it was written in, so a bolded row is the one the chart stresses", () => {
    const plain = tableChartSvg(BENCHMARK.header, BENCHMARK.rows);
    const bolded = tableChartSvg(BENCHMARK.header, [["**Opus 5.5**", "**92%**", "4.1 s"], ...BENCHMARK.rows.slice(1)]);
    expect(bolded).not.toBeNull();
    expect(bolded).not.toBe(plain);
    expect(chartLabel(bolded!)).toBe(chartLabel(plain!));
  });

  it("is none for a table of words", () => {
    expect(tableChartSvg(["Tool", "Notes"], [["Vite", "a fast dev server"], ["Bun", "all in one runtime"], ["Deno", "secure by default"], ["Node", "the incumbent"]])).toBeNull();
  });

  it("is none for three cities and their populations, as omp's guess draws none: it asks for four categories", () => {
    expect(tableChartSvg(["City", "Population (millions)"], [["Tokyo", "37"], ["Delhi", "33"], ["Shanghai", "29"]])).toBeNull();
  });

  it("is colored with the figure tokens lib/svgFigure.ts knows, and no other", () => {
    for (const { header, rows } of [BENCHMARK, LATENCY]) {
      const tokens = new Set([...tableChartSvg(header, rows)!.matchAll(/var\(--([\w-]+)/g)].map((match) => match[1]!));
      expect(tokens.size).toBeGreaterThan(1);
      expect([...tokens].filter((token) => !(token in SVG_FIGURE_ROLES))).toEqual([]);
    }
  });

  it("is none where a figure could not show it: past the size an ```svg fence may have", () => {
    const header = ["Name", "a", "b", "c", "d", "e", "f"];
    const rows = Array.from({ length: 150 }, (_, row) => [`row ${row}`, ...Array.from({ length: 6 }, (_, column) => String((row * 7 + column * 13) % 1000))]);
    const table = analyzeTable(header, rows);
    const spec = buildChart(table, planChart(table)!);
    expect(renderChartSvg(spec!).length).toBeGreaterThan(SVG_FIGURE_MAX_LENGTH);
    expect(tableChartSvg(header, rows)).toBeNull();
  });
});

describe("what the engine cannot read", () => {
  // a header that is not a list makes the engine throw, as a table it cannot read would
  const unreadable = (rows: string[][]): string | null => tableChartSvg(null as unknown as string[], rows);

  it("is a table without a chart, told of once however often it is asked for", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(unreadable([["unreadable once"]])).toBeNull();
      expect(unreadable([["unreadable once"]])).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toBe("Ovis: a table's chart could not be drawn");
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps the 256 tables read last, and a table read again is the newest", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ask = (name: string): void => { unreadable([[name]]); };
      for (let table = 0; table < 256; table++) ask(`lru ${table}`);
      expect(warn).toHaveBeenCalledTimes(256);
      ask("lru 0");
      expect(warn).toHaveBeenCalledTimes(256);
      ask("lru 256");
      expect(warn).toHaveBeenCalledTimes(257);
      // 0 was read again just now, so 1 is the one that went; 0 is still known
      ask("lru 0");
      expect(warn).toHaveBeenCalledTimes(257);
      ask("lru 1");
      expect(warn).toHaveBeenCalledTimes(258);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("chartLabel", () => {
  it("is the root's aria-label as plain text", () => {
    expect(chartLabel("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"720\" role=\"img\" aria-label=\"R&amp;D &lt;5 ms&gt;. &quot;bar&quot; chart of Cost\" font-size=\"13\"><title>x</title></svg>"))
      .toBe("R&D <5 ms>. \"bar\" chart of Cost");
  });

  it("is empty where the figure has none, or only an element inside it has", () => {
    expect(chartLabel("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>")).toBe("");
    expect(chartLabel("<svg><g aria-label=\"inner\"></g></svg>")).toBe("");
  });

  it("is the label of a chart the engine drew", () => {
    expect(chartLabel(tableChartSvg(LATENCY.header, LATENCY.rows)!)).toBe("bar chart of p50 (ms) by Endpoint");
  });
});

const OMP_CHARTS = /(?:^|\/)ompCharts(?:\/|$)/;

/** The folder's modules a file imports or re-exports as a value: not as a type, and not through `import()`. */
function valueImportsOf(file: string, code: string): string[] {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, false, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  return source.statements.flatMap((statement) => {
    if (ts.isImportDeclaration(statement) && statement.importClause?.phaseModifier !== ts.SyntaxKind.TypeKeyword && ts.isStringLiteral(statement.moduleSpecifier)) return [statement.moduleSpecifier.text];
    if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier)) return [statement.moduleSpecifier.text];
    return [];
  }).filter((specifier) => specifier.startsWith(".") && OMP_CHARTS.test(specifier));
}

describe("the chunk of its own", () => {
  // the engine is most of a megabyte of source: a static import from the app's first script would carry it there
  it("is reached from outside this folder by a dynamic import only", () => {
    const offenders = scan("src/**/*.{ts,tsx}")
      .filter((file) => !file.startsWith("src/lib/ompCharts/") && !/\.test\./.test(file))
      .flatMap((file) => valueImportsOf(file, read(file)).map((specifier) => `${file}: ${specifier}`));
    expect(offenders).toEqual([]);
    expect(read("src/components/Markdown.tsx")).toMatch(/import\(\s*"\.\.\/lib\/ompCharts\/index\.ts"\s*\)/);
  });

  it("tells a static import of the folder from a type import and a dynamic one", () => {
    const found = (code: string): string[] => valueImportsOf("src/components/x.tsx", code);
    expect(found("import { tableChartSvg } from \"../lib/ompCharts/index.ts\";")).toEqual(["../lib/ompCharts/index.ts"]);
    expect(found("import \"../lib/ompCharts/chart-svg.ts\";")).toEqual(["../lib/ompCharts/chart-svg.ts"]);
    expect(found("export { chartLabel } from \"../lib/ompCharts/index.ts\";")).toEqual(["../lib/ompCharts/index.ts"]);
    expect(found("import type { chartLabel } from \"../lib/ompCharts/index.ts\";")).toEqual([]);
    expect(found("export type { chartLabel } from \"../lib/ompCharts/index.ts\";")).toEqual([]);
    expect(found("const engine = import(\"../lib/ompCharts/index.ts\").then((module) => module.tableChartSvg);")).toEqual([]);
    expect(found("import { other } from \"../lib/ompChartsLike.ts\";")).toEqual([]);
  });
});
