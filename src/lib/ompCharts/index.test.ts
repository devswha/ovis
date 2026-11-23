import { describe, expect, it, spyOn } from "bun:test";
import ts from "typescript-api";

import { files as scan, read } from "../../../scripts/source-scan.ts";
import { SVG_FIGURE_MAX_LENGTH, SVG_FIGURE_ROLES, svgFigureUrl } from "../svgFigure.ts";
import { buildChart, type ChartSpec, guessShading, planChart, targetStanding } from "./chart-plan.ts";
import { renderChartSvg } from "./chart-svg.ts";
import { chartLabel, tableChartSvg } from "./index.ts";
import { analyzeTable, parseCell } from "./table-data.ts";

const BENCHMARK = {
  header: ["Model", "Pass rate", "p50 latency"],
  rows: [["Opus 5.5", "92%", "4.1 s"], ["Sonnet 5.5", "88%", "2.3 s"], ["Haiku 5.5", "71%", "0.9 s"], ["GPT-6", "90%", "3.4 s"], ["Gemini 4", "85%", "2.8 s"]],
};
const LATENCY = {
  header: ["Endpoint", "p50 (ms)"],
  rows: [["/search", "180"], ["/feed", "95"], ["/login", "110"], ["/export", "900"], ["/health", "7"], ["/upload", "240"]],
};
const HISTOGRAM = {
  header: ["Latency", "Service A", "Service B"],
  rows: [["<10 ms", "120", "12"], ["10–50 ms", "300", "40"], ["50–100 ms", "80", "20"], [">100 ms", "20", "8"]],
};
const OUTCOMES = {
  header: ["Suite", "Pass", "Fail"],
  rows: [["unit", "400", "20"], ["api", "30", "10"], ["e2e", "12", "8"], ["load", "900", "100"]],
};
// two groups whose totals differ 45×: the stacked chart gives each its own axis
const BANDS = {
  header: ["Model", "Run", "Cached", "Uncached", "Total", "Result"],
  rows: [["small", "a", "10", "5", "15", "✅ pass"], ["small", "b", "12", "6", "18", "✅ pass"], ["big", "a", "400", "250", "650", "❌ fail"], ["big", "b", "520", "300", "820", "❌ fail"]],
};
const BUDGETS = {
  header: ["Endpoint", "p99", "Budget"],
  rows: [["/search", "100 ms", "<100 ms"], ["/feed", "80 ms", "<100 ms"], ["/login", "100 ms", "≤ 100 ms"], ["/export", "150 ms", "≤ 120 ms"]],
};
const FLOORS = {
  header: ["Suite", "Pass rate", "Target"],
  rows: [["unit", "90%", ">90%"], ["api", "90%", "≥ 90%"], ["e2e", "85%", ">= 80%"], ["load", "70%", ">80%"]],
};
// each scenario as (name, after, before): every one rose
const SCENARIOS = [["parse", "2", "1"], ["compile", "3000", "1000"], ["link", "40", "10"]];

/** What omp's own guess draws for a table, before it is drawn. */
function specOf(header: readonly string[], rows: readonly (readonly string[])[]): ChartSpec {
  const table = analyzeTable(header, rows);
  return buildChart(table, planChart(table)!)!;
}

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

describe("what omp's guess reads of a table", () => {
  it("is a change from the Before column wherever the table writes it, so what rose draws as rising", () => {
    const afterFirst = specOf(["Scenario", "After", "Before"], SCENARIOS);
    const beforeFirst = specOf(["Scenario", "Before", "After"], SCENARIOS.map(([name, after, before]) => [name!, before!, after!]));
    for (const spec of [afterFirst, beforeFirst]) {
      expect(spec.kind).toBe("change");
      expect(spec.baseline).toBe("Before");
      expect(spec.rival).toBeUndefined();
      expect(spec.series.map((entry) => entry.points.map((point) => point!.value))).toEqual([[2, 3, 4]]);
    }
  });

  it("keeps a target's strictness: a value at a `<` or `>` target misses it, at a `≤` or `≥` one it meets it", () => {
    const standings = ({ header, rows }: typeof BUDGETS) => {
      const spec = specOf(header, rows);
      return spec.targets!.map((target, at) => ({ target: target!.text, met: targetStanding(spec.series[0]!.points[at]!, target!)!.met }));
    };
    expect(standings(BUDGETS)).toEqual([
      { target: "< 100 ms", met: false }, { target: "< 100 ms", met: true }, { target: "≤ 100 ms", met: true }, { target: "≤ 120 ms", met: false },
    ]);
    expect(standings(FLOORS)).toEqual([
      { target: "> 90%", met: false }, { target: "≥ 90%", met: true }, { target: "≥ 80%", met: true }, { target: "> 80%", met: false },
    ]);
  });

  it("reads two columns alike in either order, however their rows' middle ratios fall", () => {
    // `a` over `b` runs 1, 0.9, 100, 111: its two middle ratios lie decades apart, so which is the median decides
    const rows = [["w", "100", "100"], ["x", "100", "110"], ["y", "10000", "100"], ["z", "10000", "90"]];
    const table = analyzeTable(["Name", "a", "b"], rows);
    const swapped = analyzeTable(["Name", "b", "a"], rows.map(([name, a, b]) => [name!, b!, a!]));
    expect(guessShading([...table.measures].reverse(), table.rows)).toBe(guessShading(table.measures, table.rows));
    expect(planChart(swapped)!.kind).toBe(planChart(table)!.kind);
  });

  it("scales a spread by its own unit where it measures what the value does, else by the value's", () => {
    const spread = (cell: string): number | undefined => {
      const read = parseCell(cell);
      return read.kind === "number" ? read.error : undefined;
    };
    expect(spread("1 s ± 100 ms")).toBeCloseTo(0.1, 12);
    expect(spread("1.2 GiB ± 512 MiB")).toBe(512 * 1024 ** 2);
    expect(spread("100 ms ± 2 s")).toBe(2);
    // a bare spread takes the value's unit; one in another measurement leaves it there
    expect(spread("250 ms ± 40")).toBeCloseTo(0.04, 12);
    expect(spread("1 s ± 100 MB")).toBe(100);
    expect(spread("5 ± 2 ms")).toBeCloseTo(0.002, 12);
  });

  it("searches a wide table's first columns for a ratio of two others, in time that does not grow with the cube of its width", () => {
    const quotient = [["Go", ["410 ms", "92 ms", "1830 ms", "55 ms"]], ["omp-xfs", ["100 ms", "20 ms", "400 ms", "12 ms"]], ["Speedup", ["4.1×", "4.6×", "4.58×", "4.58×"]]] as const;
    const width = 200;
    // beside them, independent numbers: no pair of them is a quotient, so every pair is tried
    const header = ["Name", ...quotient.map(([name]) => name), ...Array.from({ length: width }, (_, column) => `m${column}`)];
    const rows = Array.from({ length: 4 }, (_, row) => [
      `row ${row}`,
      ...quotient.map(([, cells]) => cells[row]!),
      ...Array.from({ length: width }, (_, column) => String(1 + (((row + 1) * 7919 + column * 104729) % 997))),
    ]);
    const started = performance.now();
    const table = analyzeTable(header, rows);
    expect(performance.now() - started).toBeLessThan(1000);
    const [go, speedup] = ["Go", "Speedup"].map((name) => table.columns.find((column) => column.header === name)!);
    expect(speedup!.restates).toBe(go!.index);
  });
});

describe("the chart's description", () => {
  it("calls a stack of outcomes 100% stacked, but not a histogram of shares, which draws its columns side by side", () => {
    expect(chartLabel(renderChartSvg(specOf(OUTCOMES.header, OUTCOMES.rows)))).toContain("100% stacked chart of Pass + Fail by Suite");
    const histogram = specOf(HISTOGRAM.header, HISTOGRAM.rows);
    expect(histogram.kind).toBe("histogram");
    expect(histogram.normalized).toBe(true);
    const label = chartLabel(renderChartSvg(histogram));
    expect(label).toContain("histogram chart of Service A, Service B by Latency");
    expect(label).not.toContain("100% stacked");
  });
});

describe("a stacked chart split into bands", () => {
  it("badges each band's rows with their own statuses", () => {
    const spec = specOf(BANDS.header, BANDS.rows);
    expect(spec.kind).toBe("stacked");
    expect(spec.status).toEqual(["good", "good", "bad", "bad"]);
    const svg = renderChartSvg(spec);
    expect(svg).toContain("scaled per group");
    // the badges in row order, then the two dots of the key; the series' own colors are none of these
    const dots = [...svg.matchAll(/<circle [^>]*fill="var\(--(success|warning|error)\)"/g)].map((match) => match[1]);
    expect(dots).toEqual(["success", "success", "error", "error", "success", "error"]);
  });
});

describe("a chart whose axis would reach past what a number holds", () => {
  const COULD_NOT_DRAW = "Ovis: a table's chart could not be drawn";
  // the first three once ticked on toward Infinity until the page stopped answering; the last drew bars off the page
  const drawnAs = (header: string[], rows: string[][]) => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      return { svg: tableChartSvg(header, rows), warned: [...warn.mock.calls] };
    } finally {
      warn.mockRestore();
    }
  };
  const none = { svg: null, warned: [[COULD_NOT_DRAW, "RangeError"]] };

  it("is none where rounding its limits up overflows: counts from 0 to 1.75e308", () => {
    expect(drawnAs(["Name", "Count"], [["a", "0"], ["b", `175${"0".repeat(306)}`], ["c", "5"], ["d", "7"]])).toEqual(none);
  });

  it("is none where a spread overflows an axis of binary sizes: 1e299 GiB ± 1e299 GiB", () => {
    expect(drawnAs(["Name", "Memory"], [["a", "1e299 GiB ± 1e299 GiB"], ["b", "2 GiB ± 1 GiB"], ["c", "3 GiB ± 1 GiB"], ["d", "4 GiB ± 1 GiB"]])).toEqual(none);
  });

  it("is none where dots would stand on a logarithmic axis past it", () => {
    const rows = [["a", "1e306 s", "4e306 s", "9e306 s"], ["b", "2e307 s", "5e307 s", "1e308 s"], ["c", "3e306 s", "1e307 s", "3e307 s"], ["d", "1.5e308 s ± 1e308 s", "4e307 s", "8e306 s"]];
    expect(drawnAs(["Case", "Go", "Rust", "Zig"], rows)).toEqual(none);
  });

  it("is none, not a drawing of NaN and Infinity, where a spread's far end overflows an axis of durations", () => {
    expect(drawnAs(["Name", "Latency"], [["a", "1 s"], ["b", "2 s"], ["c", "3 s"], ["d", "1e308 s ± 9e307 s"]])).toEqual(none);
  });
});

describe("the tokens a chart is colored with", () => {
  it("stand in paint attributes alone, which is all a figure resolves of a generated chart", () => {
    const palette = { fg: "#111", accent: "#222", muted: "#333", border: "#444", surface: "#555", success: "#666", warning: "#777", error: "#888", c1: "#999", c2: "#aaa", c3: "#bbb", c4: "#ccc", c5: "#ddd", c6: "#eee" };
    for (const { header, rows } of [BENCHMARK, LATENCY, HISTOGRAM, OUTCOMES, BANDS, BUDGETS, FLOORS]) {
      const svg = renderChartSvg(specOf(header, rows));
      const figure = svgFigureUrl(svg, palette, { paintOnly: true });
      expect(figure).not.toBeNull();
      expect(figure).toBe(svgFigureUrl(svg, palette));
    }
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
