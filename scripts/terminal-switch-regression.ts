/** Recent terminal switches against owned panes, with click-to-painted-content measurements. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type WebSocket } from "playwright-core";
import { createServer } from "../server/index.ts";
import { paneSendText, tabCreate, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { UsageService } from "../server/usage.ts";
import { chromePath } from "./chrome-path.ts";

declare global {
  interface Window {
    switchResult: Promise<{ contentMs: number; readyMs: number }>;
  }
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-terminal-switch-")));
const evidence = process.env["UI_EVIDENCE_DIR"];
if (evidence) mkdirSync(evidence, { recursive: true });
const baseline = process.env["SWITCH_BASELINE"] === "1";
const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), usage: new UsageService(undefined, []) });
const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
let workspace: string | null = null;
try {
  const made = await workspaceCreate({ cwd: root, label: "terminal-switch-fixture" });
  workspace = made.workspace.workspace_id;
  const panes = [made.root_pane.pane_id];
  const tabs = new Map([[made.root_pane.pane_id, made.root_pane.tab_id]]);
  for (let i = 1; i < 5; i++) {
    const tab = await tabCreate({ workspaceId: workspace, label: `switch-${i}` });
    panes.push(tab.root_pane.pane_id);
    tabs.set(tab.root_pane.pane_id, tab.tab.tab_id);
  }
  for (let i = 0; i < panes.length; i++) {
    await paneSendText(panes[i]!, `printf '\\033[2J\\033[HOVIS-SWITCH-${i}\\n'\\n`.replace(/\\n$/, "\n"));
  }
  for (const width of [1440, 390]) for (const theme of ["dark", "light"] as const) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width === 390, hasTouch: width === 390, colorScheme: theme });
    try {
      await context.addInitScript(({ panes, theme }) => {
        localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme, releasePaneAway: false }));
        for (const id of panes) localStorage.setItem(`ovis:view:${id}`, "terminal");
      }, { panes, theme });
      const page = await context.newPage();
      const frames: { type: string; pane_id?: string; keep_size?: boolean }[] = [];
      const sockets: WebSocket[] = [];
      page.on("websocket", (ws) => {
        sockets.push(ws);
        ws.on("framesent", ({ payload }) => { frames.push(JSON.parse(String(payload))); });
      });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(panes[0]!)}`);
      const frame = (id: string) => page.locator(`[data-layout-pane="${id}"]`);
      const ready = (id: string) => frame(id).locator("[data-pane-content]").waitFor();
      const select = async (id: string) => {
        await page.locator(`.tab-strip [role="tab"][data-tab-id="${tabs.get(id)}"]`).click();
        await ready(id);
      };
      await ready(panes[0]!);
      await select(panes[1]!);
      await select(panes[0]!);
      const start = frames.length;
      const samples: { contentMs: number; readyMs: number }[] = [];
      for (let i = 0; i < 10; i++) {
        const index = i % 2 === 0 ? 1 : 0;
        const id = panes[index]!;
        await page.evaluate(({ id, marker }) => {
          window.switchResult = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("switch did not paint")), 10_000);
            document.addEventListener("pointerdown", () => {
              const start = performance.now();
              let contentMs: number | null = null;
              const check = () => {
                const frame = document.querySelector(`[data-layout-pane="${id}"]`);
                const rows = frame?.querySelector(".xterm-rows");
                const visible = frame && getComputedStyle(frame).visibility === "visible";
                if (visible && rows?.textContent?.includes(marker)) contentMs ??= performance.now() - start;
                if (contentMs !== null && frame?.querySelector("[data-pane-content]")) {
                  clearTimeout(timeout);
                  resolve({ contentMs, readyMs: performance.now() - start });
                } else requestAnimationFrame(check);
              };
              requestAnimationFrame(check);
            }, { once: true, capture: true });
          });
        }, { id, marker: `OVIS-SWITCH-${index}` });
        await select(id);
        samples.push(await page.evaluate(() => window.switchResult));
      }
      const warm = frames.slice(start);
      console.log(JSON.stringify({ width, theme, baseline, samples, attaches: warm.filter((frame) => frame.type === "attach").length, detaches: warm.filter((frame) => frame.type === "detach").length }));
      if (!baseline) {
        assert.equal(warm.filter((frame) => frame.type === "attach" || frame.type === "detach").length, 0, "warm switching keeps the existing attachment");
      }
      if (evidence) await page.screenshot({ path: join(evidence, `terminal-switch-${width}-${theme}.png`) });
      if (!baseline) {
        // Output received while hidden must already be painted when this tab returns.
        await paneSendText(panes[1]!, "printf 'OVIS-HIDDEN-UPDATE\\n'\n");
        await frame(panes[1]!).locator(".xterm-rows", { hasText: "OVIS-HIDDEN-UPDATE" }).waitFor({ state: "attached" });
        for (const id of panes.slice(2)) await select(id);
        await frame(panes[1]!).waitFor({ state: "detached" });
        assert.ok(frames.some((frame) => frame.type === "detach" && frame.pane_id === panes[1]), "eviction releases the pane");
        assert.equal(await page.locator("[data-layout-pane]").count(), 4, "the existing four-tab bound holds");
        // Leaving the window releases cached attachments even with releasePaneAway off.
        const away = new Set(panes.slice(2, 4));
        const released = Promise.withResolvers<void>();
        const timeout = setTimeout(() => released.reject(new Error("cached attachments were not released")), 5000);
        const observe = ({ payload }: { payload: string | Buffer }) => {
          const message = JSON.parse(String(payload));
          if (message.type === "detach") away.delete(message.pane_id);
          if (away.size === 0) released.resolve();
        };
        // Subscribe before blur, including already-open sockets.
        for (const socket of sockets) socket.on("framesent", observe);
        try {
          await page.evaluate(() => {
            Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false });
            window.dispatchEvent(new Event("blur"));
          });
          await released.promise;
        } finally {
          clearTimeout(timeout);
          for (const socket of sockets) socket.off("framesent", observe);
        }
      }
      assert.deepEqual(errors, [], "no browser errors");
    } finally { await context.close(); }
  }
} finally {
  await browser.close();
  server.stop();
  if (workspace !== null) await workspaceClose(workspace);
  rmSync(root, { recursive: true, force: true });
}
