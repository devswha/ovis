import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import type { SessionSnapshot } from "../shared/protocol.ts";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

/** All metadata is synthetic and confined to this disposable demo, never a live session. */
function fixture(snapshot: SessionSnapshot | null, ids: string[]): void {
  const parent = snapshot?.panes.find((pane) => pane.pane_id === ids[0]);
  if (!snapshot || !parent) return;
  for (const [index, id] of ids.slice(0, Number(localStorage.getItem("qa:children") ?? 2) + 1).entries()) {
    const pane = snapshot.panes.find((candidate) => candidate.pane_id === id)!;
    const name = ["QA parent", "QA implementer", "QA reviewer"][index] ?? `QA helper ${index}`;
    Object.assign(pane, { workspace_id: parent.workspace_id, label: name, ...(index ? { parent_pane_id: parent.pane_id, agent_role: index === 1 ? "implement" : index === 2 ? "review" : "explore" } : {}) });
    Object.assign(snapshot.tabs.find((tab) => tab.tab_id === pane.tab_id)!, { workspace_id: parent.workspace_id, label: name });
    const layout = snapshot.layouts?.find((candidate) => candidate.tab_id === pane.tab_id);
    if (layout) layout.workspace_id = parent.workspace_id;
  }
  if (localStorage.getItem("qa:overflow") === "true" && !snapshot.tabs.some((tab) => tab.tab_id === "qa:other:0")) {
    const tab = snapshot.tabs.find((entry) => entry.tab_id === parent.tab_id)!;
    for (let index = 0; index < 12; index++) {
      const id = `qa:other:${index}`;
      const name = `QA unrelated ${index}`;
      snapshot.tabs.push({ ...tab, tab_id: id, number: index + 10, label: name });
      snapshot.panes.push({ ...parent, pane_id: id, tab_id: id, label: name });
    }
    snapshot.tabs.splice(snapshot.tabs.indexOf(tab), 1);
    snapshot.tabs.push(tab);
  }
}

const app = mkdtempSync(join(tmpdir(), "ovis-grouped-tabs-demo-"));
try {
  await buildDemoApp(app);
  const transportPath = join(app, "demo-transport.js");
  const transport = readFileSync(transportPath, "utf8");
  assert.ok(transport.includes("function readSnapshot(machine) {"), "the demo's snapshot hook is available");
  writeFileSync(transportPath, transport.replace("function readSnapshot(machine) {", `function readSnapshot(machine) { (${fixture.toString()})(machine.snapshot, ${JSON.stringify([panes.api, panes.web, panes.flaky, panes.omp, panes.cli, panes.hermes, panes.shell])});`));
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, '<script src="./demo-transport.js"></script>\n<script type="module"'));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = decodeURIComponent(new URL(request.url).pathname).replace(/^\/herdr-web-ui\/demo\/app\//, "");
    if (path.split("/").includes("..") || path.includes("\\")) return new Response(null, { status: 400 });
    const file = Bun.file(join(app, path || "index.html"));
    return await file.exists() ? new Response(file) : new Response(null, { status: 404 });
  } });
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      for (const width of [1280, 390]) for (const { enabled, children, overflow = false } of [{ enabled: false, children: 2 }, { enabled: true, children: 2 }, { enabled: true, children: 6 }, { enabled: true, children: 2, overflow: true }]) {
        if (overflow && width < 768) continue;
        const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: width < 768, hasTouch: width < 768, locale: "en-US" });
        try {
          await context.addInitScript(({ enabled: agentFriends, children: count, overflow: more }) => {
            localStorage.setItem("qa:children", String(count));
            localStorage.setItem("qa:overflow", String(more));
            localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", agentFriends, alertsOn: false }));
            localStorage.setItem("ovis:phone-tabs", JSON.stringify("header"));
            Reflect.set(window, "__ovisDemoHoldTurn", true);
          }, { enabled, children, overflow });
          const page = await context.newPage();
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.goto(`http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(panes.api)}`);
          await page.locator(".conn-live").waitFor();
          const row = page.locator(".header-tabs .tab-strip");
          await row.getByRole("tab", { name: /^QA parent/ }).waitFor();
          if (overflow) {
            await row.getByRole("tab", { name: "QA unrelated 0", exact: true }).click();
            await page.locator(".header-tabs .tab-strip-more").click();
            const more = page.getByRole("menu", { name: "More tabs", exact: true });
            await more.getByRole("menuitemcheckbox", { name: "QA implementer", exact: true }).click({ button: "right" });
            const childMenu = page.getByRole("menu", { name: "QA implementer", exact: true });
            await childMenu.waitFor();
            await more.waitFor({ state: "detached" });
            await childMenu.getByRole("menuitem", { name: "Rename tab", exact: true }).click();
            await row.getByRole("textbox").waitFor();
          } else if (!enabled) {
            assert.equal(await row.locator(".fork-tab-chip").count(), 0);
            assert.equal(await row.getByRole("tab", { name: /^QA implementer/ }).count(), 1);
          } else {
            const chip = row.getByRole("tab", { name: "QA implementer", exact: true });
            assert.equal(await row.locator(".fork-tab-chip").count(), children);
            assert.equal(await chip.locator(".lucide-code-xml").count(), 1);
            assert.equal(await chip.locator(".fork-tab-friend").count(), 0);
            await chip.click();
            await page.locator(`[data-layout-pane=${JSON.stringify(panes.web)}]`).waitFor({ state: "visible" });
            assert.equal(await chip.getAttribute("aria-selected"), "true");
            await page.waitForFunction(() => {
              const selected = document.querySelector('.header-tabs .fork-tab-chip[aria-selected="true"]')?.getBoundingClientRect();
              const strip = document.querySelector(".header-tabs .tab-strip")?.getBoundingClientRect();
              return selected && strip && selected.left >= strip.left - 1 && selected.right <= strip.right + 1;
            }, null, { timeout: 5_000 });
            assert.ok((await page.title()).includes("QA implementer"), "the window title names the selected child");
            assert.equal(await row.locator(".tab-strip-item.is-active .tab-strip-label").textContent(), "QA parent");
            if (width < 768) {
              const box = (await chip.boundingBox())!;
              assert.ok(box.width >= 44 && box.height >= 44, "phone chips are touch targets");
              const inactive = row.getByRole("tab", { name: "QA reviewer", exact: true });
              const before = await inactive.evaluate((node) => node.previousElementSibling?.getAttribute("aria-label"));
              assert.ok(before);
              await inactive.dispatchEvent("pointerdown", { pointerType: "touch", pointerId: 1, clientX: 0, clientY: 0 });
              const childMenu = page.getByRole("dialog", { name: "QA reviewer", exact: true });
              await childMenu.waitFor();
              await inactive.dispatchEvent("pointerup", { pointerType: "touch", pointerId: 1 });
              assert.equal(await chip.getAttribute("aria-selected"), "true", "a long press does not select the child");
              await childMenu.getByRole("button", { name: "Move tab left", exact: true }).click();
              await childMenu.waitFor({ state: "detached" });
              await page.waitForFunction((previous) => {
                const names = [...document.querySelectorAll(".header-tabs .fork-tab-chip")].map((node) => node.getAttribute("aria-label"));
                return names.includes(previous) && names.indexOf("QA reviewer") < names.indexOf(previous);
              }, before);
              await page.locator(".header-tabs-sheet").click();
              const sheet = page.locator(".row-sheet");
              const review = sheet.getByRole("button", { name: "QA reviewer", exact: true });
              await review.waitFor();
              assert.equal(await review.locator(".lucide-check").count(), 1);
              await review.click();
              await sheet.waitFor({ state: "detached" });
              await page.locator(`[data-layout-pane=${JSON.stringify(panes.flaky)}]`).waitFor({ state: "visible" });
            } else {
              await chip.press("F2");
              const rename = row.getByRole("textbox");
              await rename.waitFor();
              await rename.press("Escape");
              await chip.waitFor();
              const next = await chip.evaluate((node) => node.nextElementSibling?.getAttribute("aria-label"));
              assert.ok(next);
              await chip.press("Alt+Shift+ArrowRight");
              await page.waitForFunction((neighbour) => {
                const names = [...document.querySelectorAll(".header-tabs .fork-tab-chip")].map((node) => node.getAttribute("aria-label"));
                return names.includes(neighbour) && names.indexOf(neighbour) < names.indexOf("QA implementer");
              }, next);
              await page.locator('.header-tabs .tab-strip[aria-busy="false"]').waitFor();
              const sibling = row.getByRole("tab", { name: next, exact: true });
              const target = (await chip.boundingBox())!;
              await sibling.dragTo(chip, { targetPosition: { x: target.width - 2, y: target.height / 2 } });
              await page.waitForFunction((neighbour) => {
                const names = [...document.querySelectorAll(".header-tabs .fork-tab-chip")].map((node) => node.getAttribute("aria-label"));
                return names.includes(neighbour) && names.indexOf("QA implementer") < names.indexOf(neighbour);
              }, next);
              assert.equal(await chip.getAttribute("aria-selected"), "true", "dragging does not select another child");
              if (children === 2) {
                await row.getByRole("tab", { name: "QA parent", exact: true }).click();
                const area = (await page.locator(".pane-split").boundingBox())!;
                const source = (await chip.boundingBox())!;
                const start = { x: source.x + source.width / 2, y: source.y + source.height / 2 };
                const end = { x: area.x + area.width * 0.8, y: area.y + area.height / 2 };
                const guide = page.locator(".split-drop.is-visible");
                await page.mouse.move(start.x, start.y);
                await page.mouse.down();
                await page.mouse.move(end.x, end.y, { steps: 6 });
                await page.waitForFunction(() => document.querySelector(".split-drop.is-visible")?.getAttribute("data-edge") === "right", null, { timeout: 5_000 });
                await page.mouse.move(start.x, start.y, { steps: 6 });
                // Upstream keeps the outline while dragging, but offers no split over the strip.
                await page.waitForFunction(() => document.querySelector(".split-drop.is-visible")?.getAttribute("data-edge") === null);
                await page.mouse.move(end.x, end.y, { steps: 6 });
                await page.waitForFunction(() => document.querySelector(".split-drop.is-visible")?.getAttribute("data-edge") === "right");
                await page.keyboard.press("Escape");
                await page.mouse.up();
                await guide.waitFor({ state: "hidden" });
                assert.equal(await page.locator(".pane-split.is-split").count(), 0, "Escape cancels the split drag");
                await page.mouse.move(start.x, start.y);
                await page.mouse.down();
                await page.mouse.move(end.x, end.y, { steps: 6 });
                await page.waitForFunction(() => document.querySelector(".split-drop.is-visible")?.getAttribute("data-edge") === "right");
                await page.mouse.up();
                await page.locator(".pane-split.is-split").waitFor();
                await page.locator(`.pane-split.is-split [data-layout-pane=${JSON.stringify(panes.api)}]:visible`).waitFor();
                await page.locator(`.pane-split.is-split [data-layout-pane=${JSON.stringify(panes.web)}]:visible`).waitFor();
                await guide.waitFor({ state: "hidden" });
              }
            }
            if (process.env.UI_EVIDENCE_DIR && children === 2) {
              mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
              await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `grouped-tabs-${width}.png`) });
            }
          }
          assert.deepEqual(errors, []);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          console.log(`PASS grouped tabs: width=${width}, agentFriends=${enabled}, children=${children}, overflow=${overflow}`);
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  } finally { await server.stop(true); }
} finally { rmSync(app, { recursive: true, force: true }); }
