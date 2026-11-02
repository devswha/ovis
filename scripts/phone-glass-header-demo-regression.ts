import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { pickLens } from "./view-toggle.ts";

// #1457: a short phone (landscape) drops a lone tab's row, and the chat then puts the glass header
// over the pane. The pane's own menu button must start below that header, never under its More
// button (six dots, not three), and a banner (View only) must not cover it. The keyboard alone
// makes no phone short: typing upright keeps the row (lib/useCramped.ts).
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
const app = mkdtempSync(join(tmpdir(), "ovis-glass-header-demo-"));
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
    // installed app has, so the header's height under glass is the one a phone draws.
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
        // A short phone draws no tab row for a workspace's only tab: close the pane's sibling tabs.
        const closed = await page.evaluate(async (id) => {
          const { snapshot } = await (await fetch("/api/session")).json() as { snapshot: { panes: { pane_id: string; tab_id: string; workspace_id: string }[]; tabs: { tab_id: string; workspace_id: string }[] } };
          const own = snapshot.panes.find((pane) => pane.pane_id === id)!;
          const others = snapshot.tabs.filter((tab) => tab.workspace_id === own.workspace_id && tab.tab_id !== own.tab_id);
          for (const tab of others) {
            const response = await fetch("/api/tab/close", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tab_id: tab.tab_id }) });
            if (!response.ok) throw new Error(`tab close ${response.status}`);
          }
          return others.length;
        }, panes.api);
        assert.ok(closed > 0, "the demo pane's workspace had another tab to close");
        await page.waitForFunction(() => document.querySelectorAll(".tab-strip-item").length === 1);

        await pickLens(page, "chat");
        const message = page.getByRole("textbox", { name: "Message", exact: true });
        await message.waitFor();
        assert.equal(await page.locator(".pane-frame.is-single .pane-frame-menu").isVisible(), false,
          "upright, the lone tab keeps its row, whose menu carries the pane's actions");

        // the message box focused and the keyboard up: Android shrinks the layout viewport with it,
        // under the 600px of a short phone, and the lone tab's row still stays
        await message.click();
        await page.setViewportSize({ width: 390, height: 470 });
        await page.evaluate(() => (window as Window & { glassViewport?: (value: number) => void }).glassViewport?.(470));
        await page.waitForFunction(() => document.documentElement.hasAttribute("data-keyboard"));
        await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
        assert.equal(await page.locator(".app-header .tab-strip").isVisible(), true, "typing upright keeps the lone tab's row");

        // turned on its side the phone is short: the lone tab's row goes
        await message.evaluate((node) => (node as HTMLElement).blur());
        await page.setViewportSize({ width: 740, height: 390 });
        await page.evaluate(() => (window as Window & { glassViewport?: (value: number) => void }).glassViewport?.(390));
        await page.locator(".tab-strip").waitFor({ state: "detached" });
        assert.notEqual(await page.locator(".app-header").evaluate((node) => getComputedStyle(node).backdropFilter), "none",
          "the chat of a lone tab with no row puts the glass header over the pane");
        await checkMenus(page, "chat-landscape");

        // a view-only connection draws its "View only" banner at the pane's top right too
        await page.evaluate(() => (window as SocketsWindow).glassSockets.at(-1)!.send(JSON.stringify({ type: "role", mode: "observe" })));
        await page.locator(".terminal-banner-observe").waitFor();
        await page.locator(".tab-strip").waitFor({ state: "detached" });
        await checkMenus(page, "chat-landscape-view-only");
        const banners = await page.locator(".terminal-banners > :not(.visually-hidden)").evaluateAll((nodes) => nodes.map((node) => {
          const box = node.getBoundingClientRect();
          return { x: box.x, y: box.y, width: box.width, height: box.height, text: node.textContent?.trim() ?? "" };
        }).filter((box) => box.width > 0 && box.height > 0));
        assert.ok(banners.some((banner) => banner.text === "View only"), `the View only banner is drawn (${JSON.stringify(banners)})`);
        const menu = await page.locator(".pane-frame.is-single .pane-frame-menu").boundingBox();
        if (!menu) throw new Error("the lone pane's menu has a box");
        for (const banner of banners) {
          const overlaps = menu.x < banner.x + banner.width && banner.x < menu.x + menu.width && menu.y < banner.y + banner.height && banner.y < menu.y + menu.height;
          assert.equal(overlaps, false, `the banner "${banner.text}" ${JSON.stringify(banner)} covers the lone pane's menu ${JSON.stringify(menu)}`);
        }
        assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest(".pane-frame-menu") instanceof HTMLElement, { x: menu.x + menu.width / 2, y: menu.y + menu.height / 2 }), true,
          "a press on the lone pane's menu reaches it, not a banner over it");
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    } finally { await browser.close(); }
  } finally { await server.stop(true); }
  console.log("PASS phone glass header: a lone pane's menu starts below the header, never under its More button or a banner");
} finally {
  rmSync(app, { recursive: true, force: true });
}

async function checkMenus(page: Page, label: string): Promise<void> {
  const header = await page.locator(".app-header").boundingBox();
  const more = await page.locator(".header-more-button").boundingBox();
  const paneMenu = page.locator(".pane-frame.is-single .pane-frame-menu");
  if (!header || !more) throw new Error(`${label}: the header and its More button are drawn`);
  assert.equal(await paneMenu.isVisible(), true, `${label}: a finger keeps the lone pane's own menu`);
  const pane = await paneMenu.boundingBox();
  if (!pane) throw new Error(`${label}: the lone pane's menu has a box`);
  if (evidence) {
    mkdirSync(evidence, { recursive: true });
    await page.screenshot({ path: join(evidence, `phone-glass-header-${label}.png`), clip: { x: 0, y: 0, width: page.viewportSize()!.width, height: 160 } });
  }
  const overlaps = pane.x < more.x + more.width && more.x < pane.x + pane.width && pane.y < more.y + more.height && more.y < pane.y + pane.height;
  assert.equal(overlaps, false, `${label}: the pane's menu ${JSON.stringify(pane)} is drawn under the header's More button ${JSON.stringify(more)}`);
  assert.ok(pane.y >= header.y + header.height - 0.5, `${label}: the pane's menu starts below the glass header (menu top ${pane.y}, header bottom ${header.y + header.height})`);
}
