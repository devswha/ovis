/**
 * The phone header's lens toggle (Chat or Terminal, a tap flips them) is a compact control: it sits inside
 * the header bar with clear space above and below (never edge to edge), below a safe-area top inset
 * and in the compact density's shorter bar too, and still offers a touch target at least 44px tall
 * and wide through its invisible expander, which stays inside the bar. A tap on it shows the
 * pane's terminal. Folded (412) and
 * unfolded (720) foldable widths, a short landscape phone, a notched screen and the compact density.
 * On the isolated test herdr; UI_EVIDENCE_DIR=<dir> keeps the screenshots.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { chromePath } from "./chrome-path.ts";
import { pickLens, shownLens, VIEW_BUTTON } from "./view-toggle.ts";

const TOUCH_TARGET = 44;
const CLEARANCE = 6;

export async function checkHeaderLensSwitch(browser: Browser, origin: string, evidence?: string): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-lens-switch-")));
  let workspaceId: string | null = null;
  try {
    const created = await workspaceCreate({ cwd: root, label: "ovis-test-lens-switch" });
    workspaceId = created.workspace.workspace_id;
    for (const size of [
      { label: "folded 412x915", width: 412, height: 915, inset: 0 },
      { label: "notched 412x915", width: 412, height: 915, inset: 28 },
      { label: "unfolded 720x870", width: 720, height: 870, inset: 0 },
      { label: "landscape 740x360", width: 740, height: 360, inset: 0 },
      { label: "compact density 412x915", width: 412, height: 915, inset: 0, density: "compact" },
    ] as Array<{ label: string; width: number; height: number; inset: number; density?: string }>) {
      const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: "en-US" });
      try {
        await context.addInitScript((density) => {
          if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", ...(density ? { density } : {}) }));
        }, size.density ?? null);
        const page = await context.newPage();
        if (size.inset > 0) {
          const cdp = await context.newCDPSession(page);
          await cdp.send("Emulation.setSafeAreaInsetsOverride" as never, { insets: { top: size.inset, topMax: size.inset, left: 0, leftMax: 0, bottom: 0, bottomMax: 0, right: 0, rightMax: 0 } } as never);
        }
        await page.goto(`${origin}/?pane=${encodeURIComponent(created.root_pane.pane_id)}`);
        await page.locator(VIEW_BUTTON).waitFor();
        const geometry = await page.evaluate((selector) => {
          const box = (node: Element) => node.getBoundingClientRect();
          const header = document.querySelector(".app-header")!;
          const button = document.querySelector(selector)!;
          const own = box(button);
          const expander = getComputedStyle(button, "::before");
          const grow = expander.content === "none" ? 0 : -parseFloat(expander.top);
          return { header: box(header), button: own, target: { top: own.top - grow, bottom: own.bottom + grow }, insetTop: parseFloat(getComputedStyle(header).paddingTop),
            density: document.documentElement.dataset["density"] ?? null, controlH: parseFloat(getComputedStyle(button).getPropertyValue("--control-h")) };
        }, VIEW_BUTTON);
        assert.ok(Math.abs(geometry.insetTop - size.inset) <= 0.5, `${size.label}: the header's top padding is the emulated safe-area inset, ${size.inset}px (${geometry.insetTop}px)`);
        assert.equal(geometry.density, size.density ?? "comfortable", `${size.label}: the page runs in the ${size.density ?? "comfortable"} density`);
        const bar = { top: geometry.header.top + geometry.insetTop, bottom: geometry.header.bottom };
        assert.ok(geometry.button.top - bar.top >= CLEARANCE && bar.bottom - geometry.button.bottom >= CLEARANCE,
          `${size.label}: the button leaves room above and below in the bar (${JSON.stringify({ bar, button: geometry.button })})`);
        // drawn at the density's --control-h, as every header control is
        assert.ok(Math.abs(geometry.button.height - geometry.controlH) <= 0.5, `${size.label}: the button is the density's --control-h, ${geometry.controlH}px (${geometry.button.height}px)`);
        assert.ok(geometry.target.bottom - geometry.target.top >= TOUCH_TARGET - 0.5, `${size.label}: the touch target is ${TOUCH_TARGET}px tall (${geometry.target.bottom - geometry.target.top})`);
        assert.ok(geometry.button.width >= TOUCH_TARGET - 0.5, `${size.label}: the button is a finger wide (${geometry.button.width})`);
        assert.ok(geometry.target.top >= bar.top - 0.5 && geometry.target.bottom <= bar.bottom + 0.5, `${size.label}: the touch target stays inside the bar`);
        await pickLens(page, "terminal", { tap: true });
        assert.equal(await shownLens(page), "terminal", `${size.label}: a tap on the toggle shows the terminal`);
        if (evidence) await page.screenshot({ path: join(evidence, `lens-switch-${size.label.replace(/\s+/g, "-")}.png`), clip: { x: 0, y: 0, width: size.width, height: 140 } });
      } finally { await context.close(); }
    }
    console.log("PASS the phone header's lens button sits with room above and below, a 44px touch target inside the bar, and a tap on it switches the lens, folded, unfolded, landscape, under a notch and in the compact density");
  } finally {
    if (workspaceId) await workspaceClose(workspaceId).catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await import("./test-herdr.ts");
  const { chromium } = await import("playwright-core");
  const { createServer } = await import("../server/index.ts");
  const { UsageService } = await import("../server/usage.ts");
  const state = mkdtempSync(join(tmpdir(), "ovis-lens-switch-state-"));
  const evidence = process.env["UI_EVIDENCE_DIR"];
  if (evidence) mkdirSync(evidence, { recursive: true });
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: state, usage: new UsageService(undefined, []) });
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  try {
    await checkHeaderLensSwitch(browser, `http://127.0.0.1:${server.port}`, evidence);
  } finally {
    await browser.close();
    server.stop();
    rmSync(state, { recursive: true, force: true });
  }
}
