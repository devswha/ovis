/**
 * PageUp in a long chat (#3662): on a busy device the chat's list (@legendapp/list) draws the rows a
 * scroll uncovered at their estimated heights and measures them a frame or more later. The row the
 * reader was already reading must stay where it is when they are measured.
 *
 * The order is forced, not left to the machine's speed: this build holds every measurement the list
 * takes (all of them go through updateItemSizesBatch) from the PageUp until the reader's row has been
 * read, then hands them to the list at once.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { appContext } from "./app-context.ts";
import { chromePath } from "./chrome-path.ts";
import type {} from "./chat-hold-visible-row-fixture.tsx";

const SEAM = "function updateItemSizesBatch(ctx, measurements) {";
const root = mkdtempSync(join(tmpdir(), "herdr-chat-hold-"));
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
try {
  const build = await Bun.build({
    entrypoints: ["scripts/chat-hold-visible-row-fixture.tsx"], outdir: root, target: "browser",
    define: { "process.env.NODE_ENV": '"development"' },
    plugins: [{
      name: "hold-measurements",
      setup(builder) {
        builder.onLoad({ filter: /@legendapp[\\/]list[^\\/]*[\\/]react\.mjs$/ }, async ({ path }) => {
          const source = await Bun.file(path).text();
          assert.ok(source.includes(SEAM), `${path} has no ${SEAM}`);
          return {
            loader: "js",
            contents: source.replace(SEAM, `${SEAM}\n  if (globalThis.heldMeasurements) { globalThis.heldMeasurements.push(() => updateItemSizesBatch(ctx, measurements)); return; }`),
          };
        });
      },
    }],
  });
  assert.ok(build.success, String(build.logs));
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/") return new Response('<!doctype html><html lang="en"><body style="margin:0"><div id="root"></div><script type="module" src="/chat-hold-visible-row-fixture.js"></script></body></html>', { headers: { "content-type": "text/html" } });
    const file = Bun.file(join(root, path.slice(1)));
    return await file.exists() ? new Response(file) : new Response(null, { status: 404 });
  } });
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  const page = await (await appContext(browser, { viewport: { width: 800, height: 1000 } })).newPage();
  page.setDefaultTimeout(15_000);
  await page.goto(`http://127.0.0.1:${server.port}/`);
  await page.waitForSelector('[data-row="row-199"]');
  await page.waitForFunction(() => {
    const node = document.querySelector<HTMLElement>(".hold-qa-scroller")!;
    return node.scrollTop > 0 && node.scrollHeight - node.clientHeight - node.scrollTop <= 1;
  });
  const frames = (count: number) => page.evaluate((count) => new Promise<void>((resolve) => {
    const next = (left: number) => left === 0 ? resolve() : requestAnimationFrame(() => next(left - 1));
    next(count);
  }), count);
  await frames(10);

  const result = await page.evaluate(async () => {
    const node = document.querySelector<HTMLElement>(".hold-qa-scroller")!;
    const view = node.getBoundingClientRect();
    const drawn = () => [...node.querySelectorAll<HTMLElement>("[data-row]")]
      .map((row) => ({ key: row.dataset.row!, box: row.getBoundingClientRect() }))
      .filter(({ box }) => box.bottom > view.top && box.top < view.bottom)
      .sort((a, b) => a.box.top - b.box.top);
    const topOf = (key: string) => node.querySelector(`[data-row="${key}"]`)!.getBoundingClientRect().top;
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    // the reader's row: the first one wholly in view before the PageUp
    const reading = drawn().find(({ box }) => box.top >= view.top)!.key;
    const beforeScroll = topOf(reading);
    const held: (() => void)[] = [];
    (globalThis as { heldMeasurements?: (() => void)[] }).heldMeasurements = held;
    // a browser's page step, past the rows the list draws ahead of the view (drawDistance)
    const by = Math.round(node.clientHeight * 0.875);
    node.scrollTop -= by;
    for (let wait = 0; wait < 60; wait++) {
      await frame();
      const first = drawn()[0];
      if (first !== undefined && first.box.top <= view.top + 1) break;
    }
    const uncovered = drawn().filter(({ key }) => !window.holdQa.measured(key)).map(({ key }) => key);
    const beforeMeasure = topOf(reading);
    delete (globalThis as { heldMeasurements?: unknown }).heldMeasurements;
    for (const measure of held) measure();
    for (let wait = 0; wait < 10; wait++) await frame();
    return { reading, by, beforeScroll, beforeMeasure, afterMeasure: topOf(reading), uncovered, held: held.length, rows: drawn().map(({ key }) => key) };
  });
  console.log(JSON.stringify(result));
  // the forced order happened: rows the PageUp uncovered were drawn, unmeasured, above the reader's row
  assert.ok(result.held > 0 && result.uncovered.length > 0, `no row was drawn unmeasured: ${JSON.stringify(result)}`);
  assert.ok(Math.abs(result.beforeMeasure - (result.beforeScroll + result.by)) <= 1, `the PageUp did not move the reader's row by its distance: ${JSON.stringify(result)}`);
  assert.ok(Math.abs(result.afterMeasure - result.beforeMeasure) <= 1, `the reader's row ${result.reading} moved ${(result.afterMeasure - result.beforeMeasure).toFixed(1)} px when the rows above it were measured: ${JSON.stringify(result)}`);
  console.log(`ok: ${result.reading} stayed at ${result.afterMeasure.toFixed(1)} px while ${result.uncovered.length} uncovered rows were measured late`);
} finally {
  await browser?.close();
  server?.stop(true);
  rmSync(root, { recursive: true, force: true });
}
