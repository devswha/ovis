/** Fresh installs keep upstream controls; a saved fork device retains its choices. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

const openDrawer = async (page: Page) => {
  await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
  await page.locator("#workspace-drawer.is-open").waitFor();
};

const app = mkdtempSync(join(tmpdir(), "ovis-fork-preferences-"));
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, '<script src="./demo-transport.js"></script><script type="module"'));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname.replace(/^\/herdr-web-ui\/demo\/app\//, "");
    if (path.split("/").includes("..") || path.includes("\\")) return new Response(null, { status: 400 });
    const file = Bun.file(join(app, !path || path.endsWith("/") ? `${path}index.html` : path));
    return await file.exists() ? new Response(file) : new Response(null, { status: 404 });
  } });
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      for (const legacy of [false, true]) {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" });
        try {
          await context.addInitScript((legacy) => {
            if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", alertsOn: false, ...(legacy ? { contextCircle: true, phoneTabs: "header" } : {}) }));
          }, legacy);
          const page = await context.newPage();
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.goto(`http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(panes.omp)}&view=chat`);
          await page.locator(".conn-live").waitFor({ state: "attached" });
          await page.locator(".chat-turn-agent").first().waitFor();
          assert.equal(await page.locator(".chat-speak").count() > 0, legacy, "read aloud is opt-in");
          await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
          await page.locator("#workspace-drawer.is-open").waitFor();
          assert.equal(await page.locator(".machine-screen").count() > 0, legacy, "Computer view is opt-in");
          await page.keyboard.press("Escape");
          const toggle = page.locator(".app-header .lens-toggle");
          if (legacy) await toggle.waitFor({ state: "detached" });
          else await toggle.waitFor();
          assert.equal(await page.locator(".header-tabs-sheet").count() > 0, legacy, "only the saved fork device has phone tabs in the header");
          const preferences = await page.evaluate(() => ({ compact: document.documentElement.dataset["forkCompactTabMenus"], steady: document.documentElement.dataset["forkSteadyKeyboardTabs"] }));
          assert.deepEqual(preferences, { compact: String(legacy), steady: String(legacy) }, "menu and keyboard behavior preserve migrated device choices");
          const radius = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--radius-lg").trim());
          assert.equal(radius, legacy ? "0" : "12px", "corners follow the migrated preference");
          await page.keyboard.press("ControlOrMeta+Shift+Comma");
          await page.locator(".settings-dialog").waitFor();
          const search = page.locator(".settings-search-input");
          await search.fill("Square corners");
          const corners = page.getByRole("switch", { name: "Square corners", exact: true });
          await corners.waitFor();
          assert.equal(await corners.getAttribute("aria-checked"), String(legacy));
          await corners.click();
          await page.reload();
          await page.locator(".conn-live").waitFor({ state: "attached" });
          assert.equal(await page.evaluate(() => document.documentElement.dataset["forkSquareCorners"]), String(!legacy), "the explicit choice survives reload without being migrated again");
          // Agent friends: the saved fork device shows each running agent as its friend alone, no harness logo; upstream defaults keep the marks
          const faces = (selector: string) => page.locator(selector).evaluateAll((nodes) => nodes.map((node) => ({ friend: node.querySelector(".agent-friend img") !== null, mark: node.querySelector(".agent-mark") !== null })));
          const checkFaces = async (what: string, selector: string) => {
            if (legacy) await page.waitForFunction((css) => [...document.querySelectorAll(css)].some((node) => node.querySelector(".agent-friend")), selector);
            const seen = (await faces(selector)).filter((face) => face.friend || face.mark);
            assert.ok(seen.length > 0, `${what}: has agent rows`);
            assert.ok(seen.every((face) => (face.friend && !face.mark) === legacy && (face.mark && !face.friend) === !legacy), `${what}: ${legacy ? "the friend alone, no .agent-mark" : "the harness mark, no friend"}`);
          };
          await page.evaluate(() => localStorage.setItem("ovis:phone-inbox", "true"));
          await page.goto(`http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?app=inbox`);
          await page.locator(".mode-inbox .inbox-item").first().waitFor();
          await checkFaces("inbox rows", ".mode-inbox .inbox-avatar");
          await page.evaluate(() => { localStorage.removeItem("ovis:phone-inbox"); localStorage.setItem("ovis:sidebar-agent-tree", "true"); });
          await page.goto(`http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(panes.omp)}&view=chat`);
          await page.locator(".conn-live").waitFor({ state: "attached" });
          await openDrawer(page);
          await page.locator(".workspace-agent .sidebar-mark").first().waitFor();
          await checkFaces("the sidebar's workspace agent rows", ".workspace-agent .sidebar-mark");
          await page.evaluate(() => localStorage.removeItem("ovis:sidebar-agent-tree"));
          await page.goto(`http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(panes.omp)}&view=chat`);
          await page.locator(".conn-live").waitFor({ state: "attached" });
          await page.evaluate(() => localStorage.setItem("ovis:phone-tabs", JSON.stringify("row")));
          await page.setViewportSize({ width: 700, height: 900 });
          await page.reload();
          await page.locator(".conn-live").waitFor({ state: "attached" });
          // A lone tab makes the cramped-height rule observable. This is a demo session, never a real pane.
          await page.evaluate(async (paneId) => {
            const { snapshot } = await (await fetch("/api/session")).json() as { snapshot: { panes: { pane_id: string; workspace_id: string; tab_id: string }[]; tabs: { workspace_id: string; tab_id: string }[] } };
            const own = snapshot.panes.find((pane) => pane.pane_id === paneId)!;
            for (const tab of snapshot.tabs.filter((tab) => tab.workspace_id === own.workspace_id && tab.tab_id !== own.tab_id)) {
              const response = await fetch("/api/tab/close", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tab_id: tab.tab_id }) });
              if (!response.ok) throw new Error(`tab close ${response.status}`);
            }
          }, panes.omp);
          const tabRow = page.locator(".pane-slot .tab-strip");
          await tabRow.waitFor();
          await page.waitForFunction(() => document.querySelectorAll(".pane-slot .tab-strip-item").length === 1);
          await page.getByRole("textbox", { name: "Message", exact: true }).click();
          await page.setViewportSize({ width: 700, height: 650 });
          await page.waitForFunction(() => window.matchMedia("(max-width: 768px) and (max-height: 700px)").matches);
          await tabRow.waitFor({ state: legacy ? "visible" : "detached" });
          assert.deepEqual(errors, []);
          console.log(`PASS ${legacy ? "legacy fork" : "upstream defaults"}: tabs, lens, corners, Settings, reload and keyboard sizing`);
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  } finally { await server.stop(true); }
} finally { rmSync(app, { recursive: true, force: true }); }
