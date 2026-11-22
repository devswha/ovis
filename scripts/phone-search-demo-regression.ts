/**
 * The phone header's Search button (demo build, no herdr session): at 390 and 320 wide, and with the
 * workspace's tabs in the header, the button is drawn beside the menu at a finger's size without
 * pushing More off the bar; a tap opens the command palette as a sheet with its search focused, a
 * picked pane is selected as on a desktop, and Back closes the sheet.
 * Captures go to UI_EVIDENCE_DIR as phone-search-<width>[-tabs].png when it is set.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { serveDemo } from "./demo-server.ts";

const EVIDENCE = process.env.UI_EVIDENCE_DIR;
const TARGET = 44;

interface Box { x: number; y: number; width: number; height: number }

const overlaps = (a: Box, b: Box): boolean => a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;

async function headerFits(page: Page, tag: string, width: number): Promise<void> {
  const button = page.locator(".app-header").getByRole("button", { name: "Command palette", exact: true });
  await button.waitFor();
  const box = await button.boundingBox();
  assert.ok(box, `${tag}: the Search button has a box`);
  assert.ok(box.width + 0.5 >= TARGET && box.height + 0.5 >= TARGET, `${tag}: the Search button is a finger's size (${box.width}x${box.height})`);
  const others = await page.locator(".app-header :is(.drawer-toggle, .lens-toggle, .header-more-button, .header-tabs-sheet)").evaluateAll((nodes) => nodes
    .map((node) => { const { x, y, width, height } = node.getBoundingClientRect(); return { name: node.className, x, y, width, height }; })
    .filter((other) => other.width > 0 && other.height > 0));
  assert.ok(others.some((other) => other.name.includes("header-more-button")), `${tag}: More is on the bar (${JSON.stringify(others)})`);
  for (const other of others) {
    assert.ok(!overlaps(box, other), `${tag}: the Search button ${JSON.stringify(box)} stays clear of ${JSON.stringify(other)}`);
    assert.ok(other.x >= -0.5 && other.x + other.width <= width + 0.5, `${tag}: ${other.name} stays on screen ${JSON.stringify(other)}`);
  }
  const drawer = others.find((other) => other.name.includes("drawer-toggle"));
  assert.ok(drawer && box.x >= drawer.x + drawer.width - 0.5 && box.x - (drawer.x + drawer.width) < TARGET, `${tag}: the Search button sits beside the menu (${JSON.stringify({ box, drawer })})`);
}

async function run(browser: Browser, origin: string, width: number, tabs: boolean): Promise<void> {
  const tag = `${width}${tabs ? " with tabs in the header" : ""}`;
  const context = await browser.newContext({ viewport: { width, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: "en-US", colorScheme: "light" });
  try {
    await context.addInitScript((phoneTabs) => {
      localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "light" }));
      if (phoneTabs) localStorage.setItem("ovis:phone-tabs", JSON.stringify("header"));
    }, tabs);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}?pane=${encodeURIComponent(panes.api)}`);
    await page.locator(".conn-live").waitFor();
    if (tabs) await page.locator(".app-header .header-tabs.is-phone").waitFor();
    await headerFits(page, tag, width);
    if (EVIDENCE) await page.screenshot({ path: join(EVIDENCE, `phone-search-${width}${tabs ? "-tabs" : ""}.png`) });
    if (tabs) { assert.deepEqual(errors, []); return; }

    const button = page.locator(".app-header").getByRole("button", { name: "Command palette", exact: true });
    const palette = page.getByRole("dialog", { name: "Command palette", exact: true });
    const search = palette.getByRole("searchbox", { name: "Search panes and actions", exact: true });
    await button.tap();
    await search.waitFor();
    assert.equal(await search.evaluate((node) => node === document.activeElement), true, `${tag}: the search is focused, so the phone's keyboard opens`);
    await search.fill("retry");
    const row = palette.locator(".palette-pane", { hasText: "Ship the retry flag" });
    await row.waitFor();
    const picked = await row.getAttribute("data-pane");
    assert.ok(picked && picked !== panes.api, `${tag}: the result is another pane (${picked})`);
    await row.tap();
    await palette.waitFor({ state: "detached" });
    await page.waitForFunction((pane) => new URLSearchParams(location.search).get("pane") === pane, picked);

    await button.tap();
    await search.waitFor();
    await page.goBack();
    await palette.waitFor({ state: "detached" });
    assert.equal(new URL(page.url()).searchParams.get("pane"), picked, `${tag}: Back closes the palette and stays on the picked pane`);
    assert.deepEqual(errors, []);
    console.log(`PASS phone Search button at ${tag}: beside the menu, opens the palette with its search focused, jumps to the picked pane, Back closes it`);
  } finally { await context.close(); }
}

const app = mkdtempSync(join(tmpdir(), "ovis-phone-search-demo-"));
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    <script type="module"`));
  const server = serveDemo(app, { prefix: "/" });
  try {
    if (EVIDENCE) mkdirSync(EVIDENCE, { recursive: true });
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      const origin = `http://127.0.0.1:${server.port}/`;
      for (const width of [390, 320]) await run(browser, origin, width, false);
      await run(browser, origin, 320, true);
      console.log("PASS phone Search button with the workspace's tabs in the header at 320: More stays on the bar");
    } finally { await browser.close(); }
  } finally { await server.stop(true); }
} finally {
  rmSync(app, { recursive: true, force: true });
}
