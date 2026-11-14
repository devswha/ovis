import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ovis-drawer-modal-"));
const app = join(root, "app");
await buildDemoApp(app);
const index = (await Bun.file(join(app, "index.html")).text()).replace(
  '<script type="module"',
  '<script src="/demo-transport.js"></script><script type="module"',
);
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/") return new Response(index, { headers: { "content-type": "text/html" } });
  const file = Bun.file(join(app, path));
  return await file.exists() ? new Response(file) : new Response("not found", { status: 404 });
} });
// a launch that fails still stops the server and removes the demo build
const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] }).catch((error: unknown) => {
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
  throw error;
});
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.port}/?pane=w1C%3Ap1&view=chat`);
  await page.locator(".conn-live").first().waitFor();
  await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
  const drawer = page.locator("#workspace-drawer");
  await drawer.waitFor({ state: "visible" });
  assert.equal(await drawer.getAttribute("role"), "dialog", "the phone drawer exposes dialog semantics");
  assert.equal(await drawer.getAttribute("aria-modal"), "true", "the trapped phone drawer is modal");
  // the header's toggle drawn as its top row belongs to the modal for a screen reader too; New workspace is the
  // drawer's own (each PC's +, the lone Host's row), so the header draws no + over it
  const owned = (await drawer.getAttribute("aria-owns"))?.split(" ") ?? [];
  assert.deepEqual(owned, ["drawer-toggle"], "the open drawer owns the header's toggle");
  for (const id of owned) assert.equal(await page.locator(`.app-header #${id}`).count(), 1, `the owned ${id} is the header's own control`);
  assert.equal(await page.locator(".app-header .new-workspace-button").count(), 0, "the header draws no + over the open drawer");
  // a tap that opened it shows no focus ring: the drawer holds the focus itself, no control in it
  const ringless = () => page.evaluate(() => document.activeElement?.id === "workspace-drawer" && document.querySelector(":focus-visible:not(#workspace-drawer)") === null);
  assert.equal(await ringless(), true, "the opened drawer holds the focus itself, with no control's ring");
  assert.equal(await page.locator(".pane-column").getAttribute("inert"), "", "the pane behind the drawer is inert");
  const drawerButtons = drawer.locator("button:visible");
  assert.ok(await drawerButtons.count() > 0, "the drawer has focusable controls");
  await drawerButtons.last().focus();
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => {
    const active = document.activeElement;
    return active !== null && (active.matches(".drawer-toggle") || active.closest("#workspace-drawer") !== null);
  }), true, "Tab stays within the drawer and the header's toggle");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Open workspace list", exact: true }).waitFor();
  assert.equal(await drawer.getAttribute("aria-modal"), null, "a closed drawer is not modal");
  // modal or not, the drawer follows the finger: a swipe in from the left edge opens it, a swipe back closes it
  const cdp = await context.newCDPSession(page);
  const swipe = async (from: number, to: number, fromY = 420, toY = fromY, durationMs = 0): Promise<void> => {
    const at = Date.now() / 1000;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from, y: fromY }], ...(durationMs ? { timestamp: at } : {}) });
    for (let step = 1; step <= 12; step++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from + ((to - from) * step) / 12, y: fromY + ((toY - fromY) * step) / 12 }], ...(durationMs ? { timestamp: at + durationMs * step / 12000 } : {}) });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [], ...(durationMs ? { timestamp: at + (durationMs + 150) / 1000 } : {}) });
  };
  await swipe(6, 300);
  await page.locator("#workspace-drawer.is-open[aria-modal='true']").waitFor();
  assert.equal(await ringless(), true, "a drawer swiped open shows no control's focus ring");
  await swipe(300, 10);
  await page.locator("#workspace-drawer:not(.is-open)").waitFor();
  assert.equal(await drawer.getAttribute("aria-modal"), null, "a drawer swiped closed is not modal");
  assert.equal(await drawer.getAttribute("aria-owns"), null, "a closed drawer owns nothing of the header");
  // Observe the browser's real events after the drawer's capture listener: a claimed move is
  // cancelled before it reaches the pane. A diagonal stroke must remain the browser's to scroll.
  await page.evaluate(() => {
    const moves: { trusted: boolean; cancelled: boolean; drawerMoved: boolean; x: number }[] = [];
    Object.assign(window, { drawerTouchMoves: moves });
    document.addEventListener("touchmove", (event) => {
      moves.push({ trusted: event.isTrusted, cancelled: event.defaultPrevented, x: event.touches[0]?.clientX ?? 0,
        drawerMoved: (document.getElementById("workspace-drawer")?.style.transform ?? "") !== "" });
    }, { capture: true, passive: true });
  });
  const moves = () => page.evaluate(() => (window as unknown as { drawerTouchMoves: { trusted: boolean; cancelled: boolean; drawerMoved: boolean; x: number }[] }).drawerTouchMoves.splice(0));
  await swipe(170, 370);
  await page.locator("#workspace-drawer.is-open[aria-modal='true']").waitFor();
  assert.equal(await ringless(), true, "a drawer opened from mid-screen keeps its modal focus");
  const openingMoves = await moves();
  assert.ok(openingMoves.some((move) => move.trusted && move.drawerMoved), "a decided native interior swipe takes hold of the drawer");
  const undecidedMoves = openingMoves.filter((move) => move.x - 170 < 56);
  assert.ok(undecidedMoves.length > 0, "the browser delivered an interior move before the opening threshold");
  assert.ok(undecidedMoves.every((move) => !move.cancelled && !move.drawerMoved), "the undecided interior moves remain uncancelled");
  await swipe(300, 10);
  await page.locator("#workspace-drawer:not(.is-open)").waitFor();
  await moves();
  await page.waitForFunction(() => (document.querySelector(".chat-view")?.scrollTop ?? 0) > 0);
  const scrollBefore = await page.locator(".chat-view").evaluate((node) => node.scrollTop);
  assert.ok(scrollBefore > 0, "the demo transcript has earlier content to scroll to");
  // A flat first move must not steal a later vertical scroll (maintainer review point 1).
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 170, y: 240 }] });
  for (const [x, y] of [[190, 242], [192, 300], [195, 360], [200, 430]]) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  const turningMoves = await moves();
  assert.ok(turningMoves.some((move) => move.trusted), "the turning stroke produces native moves");
  assert.ok(turningMoves.every((move) => !move.cancelled && !move.drawerMoved), "a flat-to-vertical stroke never belongs to the drawer");
  await page.waitForFunction((before) => (document.querySelector(".chat-view")?.scrollTop ?? before) < before, scrollBefore);
  assert.equal(await drawer.getAttribute("aria-modal"), null, "the turning stroke leaves the drawer closed");
  await page.locator(".chat-view").evaluate((node) => { node.scrollTop = node.scrollHeight; });
  const diagonalBefore = await page.locator(".chat-view").evaluate((node) => node.scrollTop);
  await swipe(170, 240, 240, 420);
  assert.equal(await drawer.getAttribute("aria-modal"), null, "a diagonal mid-screen stroke leaves the drawer closed");
  const diagonalMoves = await moves();
  assert.ok(diagonalMoves.some((move) => move.trusted), "the diagonal test dispatched native touch moves");
  assert.ok(diagonalMoves.every((move) => !move.cancelled), "a diagonal stroke is not cancelled by the drawer");
  await page.waitForFunction((before) => (document.querySelector(".chat-view")?.scrollTop ?? before) < before, diagonalBefore);
  await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
  await page.waitForFunction(() => (document.querySelector("#workspace-drawer")?.getBoundingClientRect().left ?? -1) >= -0.5);
  const divider = page.getByRole("separator", { name: "Resize PCs and Agents", exact: true });
  const box = await divider.boundingBox();
  assert.ok(box, "the real sidebar split divider is visible");
  await moves();
  await swipe(box.x + box.width - 20, box.x + 20, box.y + box.height / 2);
  await page.locator("#workspace-drawer:not(.is-open)").waitFor();
  assert.equal(await drawer.getAttribute("aria-modal"), null, "a leftward swipe from the divider closes an open drawer");
  const dividerMoves = await moves();
  assert.ok(dividerMoves.some((move) => move.trusted && move.drawerMoved), "the open drawer still follows a divider-started closing swipe");
  await page.waitForFunction(() => (document.querySelector("#workspace-drawer")?.getBoundingClientRect().right ?? 1) <= 0.5);
  await swipe(300, 380, 420, 420, 600);
  await page.locator("#workspace-drawer.is-open[aria-modal='true']").waitFor();
  await page.waitForFunction(() => (document.querySelector("#workspace-drawer")?.getBoundingClientRect().left ?? -1) >= -0.5);
  assert.equal(await drawer.getAttribute("aria-modal"), "true", "a slow short swipe from the right half stays open after release");
  await page.keyboard.press("Escape");
  await page.locator("#workspace-drawer:not(.is-open)").waitFor();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator("#workspace-drawer:not([role])").waitFor();
  assert.equal(await drawer.getAttribute("aria-modal"), null, "the desktop sidebar is not modal");
  await context.close();
  console.log("PASS phone drawer is a modal focus-trapped surface; interior swipes wait for direction, flat-to-vertical strokes scroll, divider-started closing and slow right-half opening work");
} finally {
  await browser.close();
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
}
