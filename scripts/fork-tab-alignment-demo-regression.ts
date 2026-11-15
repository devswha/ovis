import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { appFaces } from "./app-faces.ts";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

// With Square corners on, the fork's header tabs stand on the strip's bottom edge. The + (and More)
// kept upstream's centring, so the + floated a few pixels above the tab it belongs to. On the demo
// app at a desktop's width, the active tab and the + share one vertical middle with the setting off
// and on. All files and HTTP traffic stay in this disposable, loopback-only app.
const app = mkdtempSync(join(tmpdir(), "herdr-fork-tab-alignment-demo-"));
const PANE = panes.api;

async function prepareDemo(): Promise<void> {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  writeFileSync(index, html.replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    <script type="module"`));
}

async function check(browser: Browser, origin: string, squareCorners: boolean): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
  try {
    await context.addInitScript((square) => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", alertsOn: false, squareCorners: square })), squareCorners);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(PANE)}`);
    await page.locator(".conn-live").waitFor({ state: "attached" });
    await page.locator(".header-tabs .tab-strip-item").first().waitFor();
    await appFaces(page);
    assert.equal(await page.evaluate(() => document.documentElement.dataset["forkSquareCorners"]), String(squareCorners));
    const middle = (selector: string) => page.locator(selector).first().evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return rect.top + rect.height / 2;
    });
    const tab = await middle(".header-tabs .tab-strip-item.is-active");
    const add = await middle(".header-tabs .tab-strip-add");
    assert.ok(Math.abs(tab - add) < 1, `squareCorners ${squareCorners}: the active tab's middle (${tab}px) and the + (${add}px) are within 1px`);
    assert.deepEqual(errors, []);
    console.log(`PASS squareCorners ${squareCorners}: tab middle ${tab}px, + middle ${add}px`);
  } finally { await context.close(); }
}

try {
  await prepareDemo();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/herdr-web-ui/demo/app/")) return new Response("not found", { status: 404 });
    let file: string;
    try { file = decodeURIComponent(path.slice("/herdr-web-ui/demo/app/".length)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return (await body.exists()) ? new Response(body) : new Response("not found", { status: 404 });
  } });
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      for (const squareCorners of [false, true]) await check(browser, `http://127.0.0.1:${server.port}`, squareCorners);
    } finally { await browser.close(); }
  } finally { await server.stop(true); }
} finally {
  rmSync(app, { recursive: true, force: true });
}
