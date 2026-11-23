import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { parseMarkdown } from "../../shared/markdown.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { PREVIEW_CHUNK_ELEMENTS } from "../lib/textPreview.ts";
import { Markdown, ProgressiveMarkdown } from "./Markdown.tsx";

const globals = ["IS_REACT_ACT_ENVIRONMENT", "window", "document", "getComputedStyle", "navigator", "MutationObserver"];
const saved = new Map(globals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  const listen = { addEventListener() {}, removeEventListener() {} };
  const style = { setProperty() {}, removeProperty() {}, getPropertyValue: () => "", backgroundColor: "" };
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    window: { ...listen, localStorage: { getItem: () => null, setItem() {} } },
    document: { documentElement: { lang: "", dataset: {}, style }, querySelector: () => null },
    getComputedStyle: () => style,
    navigator: { languages: ["en"] },
    MutationObserver: class { observe() {} disconnect() {} },
  });
  jest.useFakeTimers();
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  jest.useRealTimers();
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test("a long Markdown preview is partial until its last chunk commits with all headings", async () => {
  const headingCount = PREVIEW_CHUNK_ELEMENTS + 1;
  const blocks = parseMarkdown(Array.from({ length: headingCount }, (_, index) => `# Section ${index + 1}`).join("\n\n"));
  await act(async () => {
    renderer = create(createElement(SettingsProvider, { children: createElement(ProgressiveMarkdown, { blocks }) }));
  });
  const preview = renderer?.root.findByType("div");
  expect(preview?.props["data-drawn"]).toBe("partial");

  for (let step = 0; step < 10 && preview?.props["data-drawn"] === "partial"; step++) {
    await act(async () => { jest.runOnlyPendingTimers(); });
  }
  expect(preview?.props["data-drawn"]).toBe("complete");
  expect(preview?.findAllByProps({ className: "markdown-h1" })).toHaveLength(headingCount);
});

const BENCHMARK = [
  "| Model | Pass rate | p50 latency |",
  "|---|---|---|",
  "| Opus 5.5 | 92% | 4.1 s |",
  "| Sonnet 5.5 | 88% | 2.3 s |",
  "| Haiku 5.5 | 71% | 0.9 s |",
  "| GPT-6 | 90% | 3.4 s |",
  "| Gemini 4 | 85% | 2.8 s |",
].join("\n");
const BENCHMARK_CHART = "small multiples chart of Pass rate, p50 latency by Model";

type ChartProps = { tableCharts?: boolean; streaming?: boolean };
const element = (text: string, props: ChartProps = {}) => createElement(SettingsProvider, { children: createElement(Markdown, { ...props, children: text }) });

/** `text` drawn, then the ticks that fetching omp's chart engine (its own chunk) and handing it over take. */
async function draw(text: string, props: ChartProps = {}): Promise<void> {
  await act(async () => { renderer = create(element(text, props)); });
  // a dynamic import, as the component's own: this test is of that load, which no static import would exercise
  await act(async () => { await import("../lib/ompCharts/index.ts"); });
  for (let tick = 0; tick < 10; tick++) await act(async () => { await Promise.resolve(); });
}

/** What the Markdown drew at its top, block by block: a block's class, else its tag. */
function drawn(): string[] {
  const root = renderer?.toJSON();
  if (root === null || root === undefined || Array.isArray(root)) return [];
  return (root.children ?? []).map((child) => typeof child === "string" ? child : String(child.props["className"] ?? child.type));
}

const images = (): string[] => renderer?.root.findAllByType("img").map((image) => String(image.props["alt"])) ?? [];

test("a table that omp would chart has the chart directly under it, named by the chart's own words", async () => {
  await draw(`before\n\n${BENCHMARK}\n\nafter`, { tableCharts: true });
  expect(drawn()).toEqual(["p", "markdown-table-wrap", "markdown-mermaid-frame", "p"]);
  expect(images()).toEqual([BENCHMARK_CHART]);
  expect(String(renderer?.root.findByType("img").props["src"]).startsWith("data:image/svg+xml")).toBe(true);
});

test("a row the table names like a theme token keeps its name in the chart, whose colors are the theme's", async () => {
  await draw(BENCHMARK.replace("Opus 5.5", "var(--accent)"), { tableCharts: true });
  const url = String(renderer?.root.findByType("img").props["src"]);
  const svg = decodeURIComponent(url.slice(url.indexOf(",") + 1));
  expect(svg).toContain(">var(--accent)</text>");
  expect(svg).not.toMatch(/(?:fill|stroke|stop-color)="var\(/);
});

test("without charts asked for, the table has none", async () => {
  await draw(`before\n\n${BENCHMARK}\n\nafter`);
  expect(drawn()).toEqual(["p", "markdown-table-wrap", "p"]);
  expect(images()).toEqual([]);
  await act(async () => renderer?.unmount());
  await draw(`before\n\n${BENCHMARK}\n\nafter`, { tableCharts: false, streaming: true });
  expect(drawn()).toEqual(["p", "markdown-table-wrap", "p"]);
  expect(images()).toEqual([]);
});

test("the table at the end of text still arriving waits for a block after it, as in omp", async () => {
  await draw(BENCHMARK, { tableCharts: true, streaming: true });
  expect(drawn()).toEqual(["markdown-table-wrap"]);
  expect(images()).toEqual([]);
  await act(async () => renderer?.unmount());

  await draw(`${BENCHMARK}\n\nThe fastest is Haiku 5.5.`, { tableCharts: true, streaming: true });
  expect(drawn()).toEqual(["markdown-table-wrap", "markdown-mermaid-frame", "p"]);
  expect(images()).toEqual([BENCHMARK_CHART]);
  await act(async () => renderer?.unmount());

  await draw(BENCHMARK, { tableCharts: true });
  expect(drawn()).toEqual(["markdown-table-wrap", "markdown-mermaid-frame"]);
});

test("a table keeps its place as the text it ends arrives, and the chart comes under it", async () => {
  await draw(BENCHMARK, { tableCharts: true, streaming: true });
  const table = renderer?.root.findByProps({ className: "markdown-table-wrap" });
  await act(async () => {
    renderer?.update(element(`${BENCHMARK}\n\nDone.`, { tableCharts: true, streaming: true }));
  });
  for (let tick = 0; tick < 5; tick++) await act(async () => { await Promise.resolve(); });
  expect(drawn()).toEqual(["markdown-table-wrap", "markdown-mermaid-frame", "p"]);
  expect(renderer?.root.findByProps({ className: "markdown-table-wrap" })).toBe(table);
});

test("only the tables at the top of the text are charted, as in omp", async () => {
  await draw(BENCHMARK.split("\n").map((line) => `> ${line}`).join("\n"), { tableCharts: true });
  expect(drawn()).toEqual(["blockquote"]);
  expect(images()).toEqual([]);
});

test("a table the engine declines, or has no number in it, has no chart", async () => {
  await draw("| City | Population (millions) |\n|---|---|\n| Tokyo | 37 |\n| Delhi | 33 |\n| Shanghai | 29 |\n\n| Tool | Notes |\n|---|---|\n| Vite | fast |\n| Bun | all in one |", { tableCharts: true });
  expect(drawn()).toEqual(["markdown-table-wrap", "markdown-table-wrap"]);
});

test("a chart the browser cannot draw leaves the table alone, not its source", async () => {
  await draw(BENCHMARK, { tableCharts: true });
  expect(drawn()).toEqual(["markdown-table-wrap", "markdown-mermaid-frame"]);
  await act(async () => { renderer?.root.findByType("img").props["onError"](); });
  expect(drawn()).toEqual(["markdown-table-wrap"]);
  expect(renderer?.root.findAllByProps({ className: "markdown-code" })).toEqual([]);
});

// last: a server render leaves the test renderer's later renders warning of two renderers sharing a provider
test("a table's markup is the same whatever the chart props, off or asked for before the engine is there", () => {
  const table = "<div class=\"markdown\"><div class=\"markdown-table-wrap\"><table><thead><tr><th><span>A</span></th><th><span>B</span></th></tr></thead><tbody><tr><td><span>1</span></td><td><span>2</span></td></tr></tbody></table></div></div>";
  for (const props of [{}, { tableCharts: false }, { tableCharts: false, streaming: true }, { tableCharts: true }]) {
    expect(renderToStaticMarkup(element("| A | B |\n|---|---|\n| 1 | 2 |", props))).toBe(table);
  }
});
