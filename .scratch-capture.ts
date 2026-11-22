// scratch: before/after captures for the phone search button (not committed)
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import panes from "./site/demo/fixtures/panes.json";
import { buildDemoApp } from "./scripts/demo-build.ts";
import { chromePath } from "./scripts/chrome-path.ts";
import { serveDemo } from "./scripts/demo-server.ts";

const stage = process.argv[2] ?? "before";
const out = "/home/devswha/.cache/dori-scratch/parity-0510/captures/phone-search";
mkdirSync(out, { recursive: true });
const app = mkdtempSync(join(tmpdir(), "ovis-phone-search-capture-"));
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    <script type="module"`));
  const server = serveDemo(app, { prefix: "/" });
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  try {
    for (const width of [390, 320, 1280]) {
      const phone = width !== 1280;
      const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, ...(phone ? { deviceScaleFactor: 3, isMobile: true, hasTouch: true } : {}), locale: "en-US", colorScheme: "light" });
      await context.addInitScript(() => { localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "light" })); Reflect.set(window, "__ovisDemoHoldTurn", true); });
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(panes.api)}`);
      await page.locator(".conn-live").waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: join(out, `${stage}-${width}.png`) });
      const button = page.locator(".app-header .palette-button");
      const visible = await button.isVisible();
      console.log(width, "palette button visible:", visible, await button.boundingBox());
      if (visible) await (phone ? button.tap() : button.click());
      else await page.keyboard.press("ControlOrMeta+Shift+K");
      const search = page.getByRole("searchbox", { name: "Search panes and actions", exact: true });
      await search.waitFor();
      await search.fill("retry");
      await page.locator(".palette-pane").first().waitFor({ timeout: 5000 }).catch(async () => console.log("options:", await page.locator("[role=option]").allTextContents()));
      await page.screenshot({ path: join(out, `${stage}-${width}-palette.png`) });
      await context.close();
    }
  } finally { await browser.close(); await server.stop(true); }
} finally { rmSync(app, { recursive: true, force: true }); }
