/**
 * A state group's fold and each row's time in its state (#3505), on the unmodified app over the
 * demo's fixture transport, at 390 and 1280, light and dark. No live session is read.
 *
 * Settings → Group agents by state and the sidebar's filter are on. Two stamps are stored as this
 * device would have kept them, so their ages are known: the waiting agent's 12 minutes and a
 * resting agent's 3 days. A row says its time only where a stamp tells of it; the agent that
 * finishes as the demo opens is stamped in sight and keeps its time when its finish is read. Idle
 * starts folded and the other groups open; a heading folds and opens its group by click, Enter and
 * Space and says the same count either way; a folded group keeps the selected agent in sight; what
 * the reader chose is kept across a reload; the filter opens every group for its time; a watching
 * device folds its own groups too; and a row with the keyboard's focus that moves under a folded
 * group hands the focus to that group's heading.
 *
 * UI_EVIDENCE_DIR: agent-state-groups-<390|1280>-<light|dark>.png (the list as it starts, Idle
 * folded) and agent-state-groups-open-<...>.png (every group open).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

const EVIDENCE = process.env.UI_EVIDENCE_DIR;
const MINUTE = 60_000;
const DAY = 86_400_000;

async function run(browser: Browser, origin: string, width: number, theme: "light" | "dark"): Promise<void> {
  const phone = width === 390;
  const tag = `${width} ${theme}`;
  const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, ...(phone ? { deviceScaleFactor: 3, isMobile: true, hasTouch: true } : {}), locale: "en-US", colorScheme: theme });
  await context.addInitScript(({ settings, waiting, resting, waited, rested }) => {
    // seeded once, so a reload keeps what the page itself stored
    if (localStorage.getItem("ovis:settings") !== null) return;
    localStorage.setItem("ovis:settings", settings);
    localStorage.setItem("ovis:agent-groups", "true");
    localStorage.setItem("ovis:agents-collapsed", "0");
    localStorage.setItem("ovis:sidebar-filter-shown", "true");
    // the demo's one PC and its herdr (site/demo/transport.ts), as the app stores its stamps (lib/agentStateSince.ts)
    const now = Date.now();
    localStorage.setItem("ovis:agent-state-since", JSON.stringify({ version: 1, pcs: { local: { lifetime: "demo-local", rows: {
      [waiting]: { state: "blocked", at: now - waited },
      [resting]: { state: "idle", at: now - rested },
    } } } }));
  }, { settings: JSON.stringify({ language: "en", theme }), waiting: panes.web, resting: panes.omp, waited: 12 * MINUTE, rested: 3 * DAY });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  const row = (pane: string) => page.locator(`.agents-sidebar .agent-item[data-pane="${pane}"]`);
  const state = (pane: string, status: string) => row(pane).locator(`.sidebar-status[data-status="${status}"]`);
  const since = (pane: string): Promise<string[]> => row(pane).locator(".agent-since").allTextContents();
  const heading = (group: string) => page.locator(`.agents-sidebar .agent-group-label[data-group="${group}"] button`);
  const expanded = (group: string): Promise<string | null> => heading(group).getAttribute("aria-expanded");
  /** the list in sight: a phone's drawer is opened for it */
  const list = async (shown: string = panes.web): Promise<void> => {
    const toggle = page.locator("#drawer-toggle");
    if (phone && await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
    await row(shown).waitFor();
  };
  const open = async (query = ""): Promise<void> => {
    await page.goto(`${origin}?pane=${encodeURIComponent(panes.web)}${query}`);
    await page.locator(".conn-live").waitFor({ state: "attached" });
    await list();
  };

  await open();
  // a device that kept no fold: Idle starts folded, the other groups open, and a time shows where a stamp tells of it
  assert.equal(await expanded("idle"), "false", `${tag}: Idle starts folded`);
  assert.equal(await expanded("blocked"), "true", `${tag}: Needs you starts open`);
  await row(panes.omp).waitFor({ state: "hidden" });
  assert.deepEqual(await since(panes.web), ["12m"], `${tag}: a waiting agent says how long it has waited`);
  const count = await heading("idle").locator(".agent-group-count").textContent();
  const target = await heading("idle").boundingBox();
  assert.ok(target !== null && target.height >= (phone ? 44 : 24), `${tag}: the heading is a ${phone ? "finger's" : "pointer's"} target, ${target?.height}px`);
  if (EVIDENCE) await page.screenshot({ path: join(EVIDENCE, `agent-state-groups-${width}-${theme}.png`) });

  await heading("idle").click();
  assert.equal(await expanded("idle"), "true", `${tag}: its heading opens it`);
  await row(panes.omp).waitFor({ state: "visible" });
  assert.equal(await heading("idle").locator(".agent-group-count").textContent(), count, `${tag}: the heading says the same count open and folded`);
  assert.deepEqual(await since(panes.omp), ["3d"], `${tag}: a resting agent says how long it has rested`);
  assert.deepEqual(await since(panes.cli), [], `${tag}: a state this device did not see begin says no time`);

  // the demo's own agent is mid-turn as it opens and finishes a few seconds in: a change in sight
  await state(panes.api, "done").waitFor({ state: "attached" });
  assert.deepEqual(await since(panes.api), ["<1m"], `${tag}: a state that begins in sight is stamped`);
  await row(panes.api).locator(".agent-select").click();
  await list();
  await state(panes.api, "idle").waitFor({ state: "attached" });
  assert.deepEqual(await since(panes.api), ["<1m"], `${tag}: reading a finished agent keeps its time`);
  if (EVIDENCE) await page.screenshot({ path: join(EVIDENCE, `agent-state-groups-open-${width}-${theme}.png`) });

  // folded again, the group keeps the selected agent in sight and hides the rest; no other group folds with it
  await heading("idle").click();
  assert.equal(await expanded("idle"), "false", `${tag}: its heading folds it`);
  await row(panes.omp).waitFor({ state: "hidden" });
  assert.equal(await row(panes.api).isVisible(), true, `${tag}: the selected agent stays in sight under its folded group`);
  assert.equal(await row(panes.web).isVisible(), true, `${tag}: no other group folds with it`);

  await heading("idle").focus();
  await page.keyboard.press("Enter");
  assert.equal(await expanded("idle"), "true", `${tag}: Enter opens it`);
  await page.keyboard.press("Space");
  assert.equal(await expanded("idle"), "false", `${tag}: Space folds it`);
  assert.equal(await heading("idle").evaluate((node) => node === document.activeElement), true, `${tag}: the focus stays on the heading`);

  // what the reader chose is kept across a reload, where it differs from how the list starts: Idle open, Needs you folded
  await page.keyboard.press("Enter");
  await heading("blocked").click();
  await row(panes.web).waitFor({ state: "hidden" });
  await page.reload();
  await page.locator(".conn-live").waitFor({ state: "attached" });
  await list(panes.api);
  assert.equal(await expanded("idle"), "true", `${tag}: an opened group is kept across a reload`);
  assert.equal(await expanded("blocked"), "false", `${tag}: a fold is kept across a reload`);
  await heading("blocked").click();
  await row(panes.web).waitFor({ state: "visible" });
  assert.deepEqual(await since(panes.web), ["12m"], `${tag}: a stamp is kept across a reload`);

  // the filter shows what it kept: a match under a folded heading is in sight, and the heading does not fold
  await heading("idle").click();
  await row(panes.omp).waitFor({ state: "hidden" });
  await page.locator(".sidebar-filter-input").fill("config");
  await row(panes.omp).waitFor({ state: "visible" });
  assert.equal(await expanded("idle"), "true", `${tag}: the filter opens a folded group`);
  assert.equal(await heading("idle").isDisabled(), true, `${tag}: a heading does not fold under the filter`);
  await page.locator(".sidebar-filter-input").fill("");
  await row(panes.omp).waitFor({ state: "hidden" });
  assert.equal(await expanded("idle"), "false", `${tag}: the fold is back once the filter is cleared`);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${tag}: no sideways scroll`);

  // a device that only watches (`?demo_devices=watch`) sends nothing, and a fold is its own
  await open("&demo_devices=watch");
  await heading("idle").click();
  assert.equal(await expanded("idle"), "true", `${tag}: a watching device opens a group`);
  await row(panes.omp).waitFor({ state: "visible" });
  await heading("idle").click();
  await row(panes.omp).waitFor({ state: "hidden" });

  // a row with the keyboard's focus whose new state files it under a folded group hands the focus to that group's
  // heading. This page's clock is held from its first moment, so the demo agent's turn ends when the check runs it
  await page.evaluate(() => localStorage.setItem("ovis:agent-state-folds", JSON.stringify(["done", "idle"])));
  const held = await context.newPage();
  held.on("pageerror", (error) => errors.push(error.message));
  await held.clock.install({ time: new Date() });
  await held.clock.pauseAt(new Date(Date.now() + 1000));
  await held.goto(`${origin}?pane=${encodeURIComponent(panes.web)}`);
  await held.clock.runFor(1500);
  await held.locator(".conn-live").waitFor({ state: "attached" });
  if (phone) {
    await held.locator("#drawer-toggle").click();
    await held.clock.runFor(500);
  }
  const working = held.locator(`.agents-sidebar .agent-item[data-pane="${panes.api}"]`);
  await working.waitFor();
  await working.locator(".agent-select").focus();
  await held.clock.runFor(4000);
  await working.waitFor({ state: "hidden" });
  assert.equal(await held.evaluate(() => document.activeElement?.closest("li")?.getAttribute("data-group") ?? null), "done", `${tag}: a focused row that moves under a folded group hands its focus to the heading`);
  await held.close();

  assert.deepEqual(errors, [], `${tag}: no page errors`);
  await context.close();
  console.log(`PASS agent state groups ${tag}`);
}

async function main(): Promise<void> {
  const app = mkdtempSync(join(tmpdir(), "ovis-agent-state-groups-demo-"));
  try {
    await buildDemoApp(app);
    const index = join(app, "index.html");
    writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    <script type="module"`));
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      let file: string;
      try { file = decodeURIComponent(new URL(request.url).pathname.slice(1)); } catch { return new Response("bad path", { status: 400 }); }
      if (!file || file.endsWith("/")) file += "index.html";
      if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
      const body = Bun.file(join(app, file));
      return await body.exists() ? new Response(body) : new Response("not found", { status: 404 });
    } });
    try {
      if (EVIDENCE) mkdirSync(EVIDENCE, { recursive: true });
      const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
      try {
        for (const [width, theme] of [[390, "light"], [390, "dark"], [1280, "light"], [1280, "dark"]] as const) await run(browser, `http://127.0.0.1:${server.port}/`, width, theme);
      } finally { await browser.close(); }
    } finally { await server.stop(true); }
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
}

await main();
