/**
 * A phone's open surfaces keep clear of the screen's safe-area insets: the notch or Dynamic Island,
 * the rounded corners and the home indicator, on every side a phone puts them, landscape's left and
 * right included. Upright (390x844 under a 59px Dynamic Island and a 34px home indicator): the
 * search sheet, the header's More and tab sheets, Settings and a confirmation. A short screen (the
 * keyboard up): a sheet's top stays below the island. Landscape (844x390, 59px on either side and a
 * 21px indicator): Settings, a tab's menu and a confirmation. Every visible control of the open
 * surface lies inside the safe area. Chromium has no phone insets of its own: CDP emulates them.
 * On demo fixtures; UI_EVIDENCE_DIR=<dir> keeps the screenshots.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

type Insets = { top: number; right: number; bottom: number; left: number };
type Screen = { label: string; width: number; height: number; insets: Insets };

const UPRIGHT: Screen = { label: "upright", width: 390, height: 844, insets: { top: 59, right: 0, bottom: 34, left: 0 } };
const SHORT: Screen = { label: "short", width: 390, height: 500, insets: { top: 59, right: 0, bottom: 0, left: 0 } };
const LANDSCAPE: Screen = { label: "landscape", width: 844, height: 390, insets: { top: 0, right: 59, bottom: 21, left: 59 } };

const evidence = process.env["UI_EVIDENCE_DIR"];
if (evidence) mkdirSync(evidence, { recursive: true });

async function open(browser: Browser, origin: string, screen: Screen, run: (page: Page) => Promise<void>): Promise<void> {
  const context = await browser.newContext({ viewport: { width: screen.width, height: screen.height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: "en-US" });
  try {
    await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" })));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const { top, right, bottom, left } = screen.insets;
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setSafeAreaInsetsOverride" as never, { insets: { top, topMax: top, right, rightMax: right, bottom, bottomMax: bottom, left, leftMax: left } } as never);
    await page.goto(`${origin}/?pane=${encodeURIComponent(panes.api)}`);
    await page.locator(".conn-live").waitFor();
    await run(page);
    assert.deepEqual(errors, [], `${screen.label}: no page errors`);
  } finally { await context.close(); }
}

/** The visible controls and text of `surface` that reach into an inset, clipped to their scroll boxes. */
async function outside(page: Page, surface: string, insets: Insets): Promise<string[]> {
  await page.locator(surface).last().waitFor();
  // a sheet rises for --dur-sheet: measure where it rests
  await page.waitForFunction((selector) => [...document.querySelectorAll(selector)].every((node) => node.getAnimations({ subtree: true }).every((animation) => animation.playState !== "running")), surface);
  return page.evaluate(({ surface, insets }) => {
    const safe = { left: insets.left, top: insets.top, right: innerWidth - insets.right, bottom: innerHeight - insets.bottom };
    const found: string[] = [];
    for (const root of document.querySelectorAll(surface)) {
      for (const node of root.querySelectorAll("button, a[href], input, textarea, select, [role=button], [role=menuitem], [role=option], h1, h2, h3, label, p")) {
        const style = getComputedStyle(node);
        if (style.visibility === "hidden" || style.display === "none" || node.closest(".visually-hidden, [aria-hidden=true]")) continue;
        if (node.matches("h1, h2, h3, label, p") && !node.textContent?.trim()) continue;
        const box = node.getBoundingClientRect();
        let shown = { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
        for (let up = node.parentElement; up; up = up.parentElement) {
          const clip = getComputedStyle(up);
          if (clip.overflowX === "visible" && clip.overflowY === "visible") continue;
          const edge = up.getBoundingClientRect();
          shown = { left: Math.max(shown.left, edge.left), top: Math.max(shown.top, edge.top), right: Math.min(shown.right, edge.right), bottom: Math.min(shown.bottom, edge.bottom) };
        }
        if (shown.right - shown.left < 1 || shown.bottom - shown.top < 1) continue;
        const sides = (["left", "top"] as const).filter((side) => shown[side] < safe[side] - 0.5)
          .concat((["right", "bottom"] as const).filter((side) => shown[side] > safe[side] + 0.5));
        if (sides.length === 0) continue;
        const name = (node.getAttribute("aria-label") ?? node.textContent ?? "").trim().slice(0, 40);
        found.push(`${node.tagName.toLowerCase()} "${name}" past the ${sides.join(" and ")} inset (${JSON.stringify(shown)})`);
      }
    }
    return found;
  }, { surface, insets });
}

/** Every surface is checked before the run fails, so one run names each one that reaches into an inset. */
const failures: string[] = [];
function clear(found: string[], what: string): void {
  for (const line of found) failures.push(`${what}: ${line}`);
}

async function keep(page: Page, name: string): Promise<void> {
  if (evidence) await page.screenshot({ path: join(evidence, `phone-safe-area-${name}.png`) });
}

async function headerMore(page: Page, item?: string): Promise<void> {
  await page.locator(".header-more-button").click();
  if (item) await page.locator(".row-sheet, .row-menu").getByText(item, { exact: true }).click();
}

async function close(page: Page, surface: string): Promise<void> {
  await page.keyboard.press("Escape");
  await page.locator(surface).waitFor({ state: "detached" });
}

const app = mkdtempSync(join(tmpdir(), "ovis-safe-area-demo-"));
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  writeFileSync(index, html.replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n<script type="module"`));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    let file: string;
    try { file = decodeURIComponent(new URL(request.url).pathname.slice(1)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return (await body.exists()) ? new Response(body) : new Response("not found", { status: 404 });
  } });
  const origin = `http://127.0.0.1:${server.port}`;
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  try {
    await open(browser, origin, UPRIGHT, async (page) => {
      const label = UPRIGHT.label;
      await headerMore(page, "Search panes and actions");
      clear(await outside(page, ".palette-scrim", UPRIGHT.insets), `${label}: the search sheet clears the Dynamic Island`);
      await keep(page, "upright-search");
      await close(page, ".palette-scrim");

      await headerMore(page);
      clear(await outside(page, ".row-sheet", UPRIGHT.insets), `${label}: the header's More sheet clears the insets`);
      await close(page, ".row-sheet");

      await page.locator(".app-header .context-tabs").click();
      clear(await outside(page, ".row-sheet", UPRIGHT.insets), `${label}: the title's tab sheet clears the insets`);
      await close(page, ".row-sheet");

      await headerMore(page, "Close tab");
      clear(await outside(page, "[role=alertdialog]", UPRIGHT.insets), `${label}: a confirmation clears the insets`);
      await close(page, "[role=alertdialog]");

      await page.locator(".drawer-toggle").click();
      await page.locator(".sidebar").getByRole("button", { name: /^Settings/ }).first().click();
      clear(await outside(page, ".settings-dialog", UPRIGHT.insets), `${label}: Settings clears the insets`);
      await keep(page, "upright-settings");
    });

    await open(browser, origin, SHORT, async (page) => {
      for (const [name, surface, show] of [
        ["search", ".command-palette", () => headerMore(page, "Search panes and actions")],
        ["More", ".row-sheet", () => headerMore(page)],
        ["Settings", ".settings-dialog", async () => {
          await page.locator(".drawer-toggle").click();
          await page.locator(".sidebar").getByRole("button", { name: /^Settings/ }).first().click();
        }],
      ] as const) {
        await show();
        clear(await outside(page, surface, SHORT.insets), `${SHORT.label}: the ${name} sheet clears the island`);
        const top = await page.locator(surface).evaluate((node) => node.getBoundingClientRect().top);
        if (top < SHORT.insets.top) failures.push(`${SHORT.label}: the ${name} sheet starts under the island (${top} < ${SHORT.insets.top})`);
        if (name === "search") await keep(page, "short-search");
        await close(page, surface);
      }
    });

    await open(browser, origin, LANDSCAPE, async (page) => {
      const label = LANDSCAPE.label;
      await page.locator(".sidebar").getByRole("button", { name: /^Settings/ }).first().click();
      clear(await outside(page, ".settings-dialog", LANDSCAPE.insets), `${label}: Settings clears the notch on either side and the home indicator`);
      await keep(page, "landscape-settings");
      await close(page, ".settings-dialog");

      await page.locator(".tab-strip-menu").first().click();
      clear(await outside(page, ".row-menu", LANDSCAPE.insets), `${label}: a tab's menu ends above the home indicator`);
      await keep(page, "landscape-tab-menu");
      await page.locator(".row-menu").getByText("Close tab", { exact: true }).click();
      clear(await outside(page, "[role=alertdialog]", LANDSCAPE.insets), `${label}: a confirmation clears the insets`);
      await close(page, "[role=alertdialog]");
    });
  } finally {
    await browser.close();
    await server.stop(true);
  }
  assert.deepEqual(failures, [], "every open surface keeps clear of the safe-area insets");
  console.log("PASS a phone's sheets, dialogs and menus keep clear of the safe-area insets, upright, short and landscape");
} finally {
  rmSync(app, { recursive: true, force: true });
}
