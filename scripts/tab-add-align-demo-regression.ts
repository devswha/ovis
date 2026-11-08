/**
 * The header's tab row (#3156) stands its tabs on the row's bottom edge; its + and More buttons sit on
 * the tabs' middle line, not centred in the taller row above it. At 1280 (mouse, 36px tabs, 28px buttons)
 * and 800 (a touch tablet, 44px tabs, a 44px +), each drawn button's middle is within 0.5px of the
 * middle of the tabs. The real client over owned demo fixtures; no live herdr session.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { appFaces } from "./app-faces.ts";
import panes from "../site/demo/fixtures/panes.json";

const app = mkdtempSync(join(tmpdir(), "ovis-tab-add-align-demo-"));
const evidence = process.env.UI_EVIDENCE_DIR;

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => '<script src="./demo-transport.js"></script><script type="module"'));
  const prefix = "/herdr-web-ui/demo/app/";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith(prefix)) return new Response("not found", { status: 404 });
    let file: string;
    try { file = decodeURIComponent(path.slice(prefix.length)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return await body.exists() ? new Response(body) : new Response("not found", { status: 404 });
  } });
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
    try {
      for (const width of [1280, 800]) {
        const touch = width === 800;
        const context = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: touch, colorScheme: "light", locale: "en-US" });
        try {
          await context.addInitScript(() => {
            localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "light", defaultView: "chat", alertsOn: false }));
          });
          const page = await context.newPage();
          page.setDefaultTimeout(15000);
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.goto(`http://127.0.0.1:${server.port}${prefix}?pane=${encodeURIComponent(panes.hermes)}&view=chat`);
          await page.locator(".app-header.has-tab-row .header-tabs .tab-strip-item").first().waitFor();
          await appFaces(page);
          const facts = await page.evaluate(() => {
            const middle = (node: Element) => { const box = node.getBoundingClientRect(); return box.top + box.height / 2; };
            const tabs = [...document.querySelectorAll(".header-tabs .tab-strip-item")].map(middle);
            const buttons = [".header-tabs .tab-strip-add", ".header-tabs .tab-strip-more"]
              .map((selector) => [selector, document.querySelector(selector)] as const)
              .filter(([, node]) => node !== null && (node as HTMLElement).offsetParent !== null)
              .map(([selector, node]) => ({ selector, middle: middle(node!) }));
            return { tabs, buttons };
          });
          assert.ok(facts.tabs.length > 0, `${width}: the header draws its tab row`);
          assert.ok(facts.buttons.some((button) => button.selector.endsWith("-add")), `${width}: the + is drawn`);
          const line = facts.tabs[0]!;
          for (const tab of facts.tabs) assert.ok(Math.abs(tab - line) <= 0.5, `${width}: the tabs share one middle line (${JSON.stringify(facts.tabs)})`);
          for (const button of facts.buttons) {
            assert.ok(Math.abs(button.middle - line) <= 0.5, `${width}: ${button.selector} sits on the tabs' middle line: ${button.middle}px against ${line}px`);
          }
          if (evidence) { mkdirSync(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, `tab-add-align-${width}.png`) }); }
          assert.deepEqual(errors, []);
          console.log(`PASS ${width}${touch ? " (touch)" : ""}: ${facts.buttons.map((button) => button.selector.replace(".header-tabs .tab-strip-", "")).join(" and ")} on the tabs' middle line (${line}px)`);
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }
  } finally {
    server.stop(true);
  }
} finally {
  rmSync(app, { recursive: true, force: true });
}
