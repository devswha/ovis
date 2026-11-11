import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

// A phone keeps the workspace's tab row at every size, a short screen included: the row is the one
// way to the tabs, and the workspace's name and the + are useful with a single tab too. A short
// screen (a foldable's outer display, landscape, or the keyboard up) draws it compact, 36px instead
// of 44px. The header over the pane is the plain bar, never the glass one: the row sits between the
// two, so the transcript never reaches the header. A banner (View only) starts below the header.
type SocketsWindow = Window & { glassSockets: WebSocket[] };

/** Keeps the demo's sockets, so the check can turn this connection into a view-only one. */
function recordSockets(): void {
  const sockets: WebSocket[] = [];
  (window as SocketsWindow).glassSockets = sockets;
  const Demo = window.WebSocket;
  const Recorded = function (url: string | URL, protocols?: string | string[]) {
    const socket = new Demo(url, protocols);
    sockets.push(socket);
    return socket;
  };
  for (const name of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"] as const) Object.defineProperty(Recorded, name, { value: Demo[name] });
  window.WebSocket = Recorded as unknown as typeof WebSocket;
}

const evidence = process.env.UI_EVIDENCE_DIR;
const app = mkdtempSync(join(tmpdir(), "ovis-phone-row-demo-"));
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  writeFileSync(index, html.replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n<script>(${recordSockets.toString()})()</script>\n<script type="module"`));

  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/herdr-web-ui/demo/app/")) return new Response("not found", { status: 404 });
    let file: string;
    try { file = decodeURIComponent(path.slice("/herdr-web-ui/demo/app/".length)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    if (!(await body.exists())) return new Response("not found", { status: 404 });
    // Chromium on Linux has no phone status bar: give the header a phone's top inset, as the
    // installed app has, so the header's height is the one a phone draws.
    if (file.endsWith(".css")) return new Response((await body.text()).replace(/env\(safe-area-inset-top(?:,\s*0px)?\)/g, "32px"), { headers: { "content-type": "text/css" } });
    return new Response(body);
  } });
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" });
      try {
        await context.addInitScript(() => {
          localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
          const viewport = window.visualViewport!;
          let height = 795;
          Object.defineProperty(viewport, "height", { get: () => height });
          (window as Window & { glassViewport?: (value: number) => void }).glassViewport = (value) => {
            height = value;
            viewport.dispatchEvent(new Event("resize"));
          };
        });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(panes.api)}`);
        await page.locator(".conn-live").waitFor();
        await page.locator(".tab-strip").waitFor();
        await page.locator(".view-switch .is-chat").click();
        const message = page.getByRole("textbox", { name: "Message", exact: true });
        await message.waitFor();

        const box = (selector: string) => page.evaluate((selector) => {
          const node = document.querySelector(selector);
          if (!node) return null;
          const { left, top, right, bottom, width, height } = node.getBoundingClientRect();
          return { left, top, right, bottom, width, height };
        }, selector);

        /** The row is drawn, its workspace's name and + are there, and the open tab is wholly in view. */
        const checkRow = async (label: string, height: number): Promise<void> => {
          const strip = await box(".tab-strip");
          assert.ok(strip, `${label}: the row is drawn`);
          assert.equal(Math.round(strip.height), height, `${label}: the row is ${height}px tall`);
          const chip = await box(".tab-strip-workspace");
          assert.ok(chip && chip.width >= 44 && chip.height >= 36, `${label}: the workspace's name is a target (${JSON.stringify(chip)})`);
          assert.ok((await page.locator(".tab-strip-workspace-name").textContent())?.trim(), `${label}: it names the workspace`);
          const add = await box(".tab-strip-add");
          assert.ok(add && add.width >= 36 && add.height >= 36, `${label}: the + is a target`);
          const row = await box(".tab-strip-row");
          assert.ok(row && add.right <= row.right + 1, `${label}: the + stays inside the row`);
          const active = await box(".tab-strip-item.is-active");
          assert.ok(active && active.left >= strip.left - 1 && active.right <= add.left + 1, `${label}: the open tab is wholly in view`);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${label}: nothing overflows sideways`);
          assert.equal(await page.locator(".app-header .context-tabs").count(), 0, `${label}: the title opens no list of tabs`);
          assert.equal(await page.locator(".app-header").evaluate((node) => getComputedStyle(node).backdropFilter), "none",
            `${label}: the header over the pane is the plain bar, the row between them`);
          if (evidence) {
            mkdirSync(evidence, { recursive: true });
            await page.screenshot({ path: join(evidence, `phone-row-${label}.png`) });
          }
        };

        await checkRow("390x844", 44);

        // A short phone keeps the row, compact: the same cells, 36px tall
        for (const [width, height, label] of [[320, 640, "320x640"], [360, 640, "360x640"], [390, 667, "390x667"]] as const) {
          await page.setViewportSize({ width, height });
          await page.waitForFunction(() => window.matchMedia("(max-width: 768px) and (max-height: 700px)").matches);
          await page.locator(".tab-strip").waitFor();
          await checkRow(label, 36);
        }

        // A landscape phone (wider than the sheets' breakpoint) keeps it too
        await page.setViewportSize({ width: 667, height: 375 });
        await page.locator(".tab-strip").waitFor();
        await checkRow("667x375", 36);

        // A tablet upright draws the full row
        await page.setViewportSize({ width: 700, height: 900 });
        await page.locator(".tab-strip").waitFor();
        await checkRow("700x900", 44);

        // The keyboard up: the row stays, and the composer stays above the keyboard
        await message.tap();
        await page.setViewportSize({ width: 390, height: 470 });
        await page.evaluate(() => (window as Window & { glassViewport?: (value: number) => void }).glassViewport?.(470));
        await page.waitForFunction(() => document.documentElement.hasAttribute("data-keyboard"));
        await checkRow("390x470-keyboard", 36);
        const composer = await box(".composer");
        assert.ok(composer && composer.bottom <= 471, `the composer stays above the keyboard (${JSON.stringify(composer)})`);

        // A view-only connection draws its "View only" banner below the header, never under it
        await page.evaluate(() => (window as SocketsWindow).glassSockets.at(-1)!.send(JSON.stringify({ type: "role", mode: "observe" })));
        await page.locator(".terminal-banner-observe").waitFor();
        const header = await box(".app-header");
        assert.ok(header, "the header has a box");
        const banners = await page.locator(".terminal-banners > :not(.visually-hidden)").evaluateAll((nodes) => nodes.map((node) => {
          const box = node.getBoundingClientRect();
          return { x: box.x, y: box.y, width: box.width, height: box.height, text: node.textContent?.trim() ?? "" };
        }).filter((box) => box.width > 0 && box.height > 0));
        assert.ok(banners.some((banner) => banner.text === "View only"), `the View only banner is drawn (${JSON.stringify(banners)})`);
        for (const banner of banners) {
          assert.ok(banner.y >= header.bottom - 0.5, `the banner "${banner.text}" starts below the header (bottom ${header.bottom})`);
        }
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    } finally { await browser.close(); }
  } finally { await server.stop(true); }
  console.log("PASS phone tab row: drawn at 390x844, 320x640, 360x640, 390x667, 667x375, 700x900 and with the keyboard up, compact on a short screen, the workspace's name and the + always there, the open tab in view, the header plain and a banner below it");
} finally {
  rmSync(app, { recursive: true, force: true });
}
