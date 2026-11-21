/**
 * The built-in browser as an agent's browser tool (Settings, Agents, Claude Code): offered only in the desktop app
 * while its Built-in browser setting is on and the app can let agents in (not on Windows yet), with its own description. The desktop bridge is stood in by the page.
 * UI_EVIDENCE_DIR keeps captures.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { serveDemo } from "./demo-server.ts";

const EVIDENCE = process.env.UI_EVIDENCE_DIR;

async function row(browser: Browser, origin: string, settings: Record<string, unknown>, bridge: boolean, shot: string | null, agentTools = true): Promise<string[]> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, locale: "ko-KR", colorScheme: "light" });
  await context.addInitScript((stored) => localStorage.setItem("ovis:settings", stored), JSON.stringify({ language: "ko", theme: "light", ...settings }));
  if (bridge) await context.addInitScript((tools) => {
    (window as unknown as { ovisBrowser: unknown }).ovisBrowser = { agentTools: tools, current: async () => ({ tabs: [], results: [] }), onChange: () => () => {}, close: () => {} };
  }, agentTools);
  const page = await context.newPage();
  await page.goto(origin);
  await page.locator(".conn-live").waitFor();
  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  await page.getByRole("dialog").first().getByText("에이전트", { exact: true }).first().click();
  await page.getByText("Claude Code", { exact: true }).first().click();
  const select = page.getByLabel("브라우저 도구", { exact: true });
  await select.scrollIntoViewIfNeeded();
  const options = await select.locator("option").evaluateAll((all) => all.map((option) => option.textContent + ((option as HTMLOptionElement).disabled ? " (disabled)" : "")));
  if (shot !== null) {
    await select.selectOption("ovis");
    await page.getByText("에이전트가 이 앱의 내장 브라우저에서 자기 탭을 씁니다.", { exact: false }).waitFor();
    if (EVIDENCE) await page.screenshot({ path: join(EVIDENCE, shot) });
  }
  await context.close();
  return options;
}

async function main(): Promise<void> {
  const app = mkdtempSync(join(tmpdir(), "ovis-agent-browser-tool-demo-"));
  try {
    await buildDemoApp(app);
    const index = join(app, "index.html");
    writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    <script type="module"`));
    const server = serveDemo(app, { prefix: "/" });
    try {
      if (EVIDENCE) mkdirSync(EVIDENCE, { recursive: true });
      const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
      try {
        const origin = `http://127.0.0.1:${server.port}/`;
        assert.ok(!(await row(browser, origin, {}, false, null)).includes("Ovis 내장 브라우저"), "a browser outside the desktop app is not offered the built-in browser");
        assert.ok((await row(browser, origin, { agentBrowserTools: { claude: "ovis" } }, false, null)).includes("Ovis 내장 브라우저 (disabled)"), "a choice saved in the desktop app shows on another device, not to be picked");
        assert.ok(!(await row(browser, origin, { builtInBrowser: false }, true, null)).includes("Ovis 내장 브라우저"), "the desktop app with the setting off does not offer it");
        assert.ok(!(await row(browser, origin, { builtInBrowser: true }, true, null, false)).includes("Ovis 내장 브라우저"), "a desktop app that cannot let agents in (Windows) does not offer it");
        assert.ok(!(await row(browser, origin, { builtInBrowser: true, agentBrowserTools: { claude: "ovis" } }, true, null, false)).includes("Ovis 내장 브라우저"), "a choice saved before is not offered where agents cannot be let in");
        assert.ok(!(await row(browser, origin, { builtInBrowser: false, agentBrowserTools: { claude: "ovis" } }, true, null)).includes("Ovis 내장 브라우저"), "nor with the setting off");
        assert.ok((await row(browser, origin, { builtInBrowser: true }, true, "agent-built-in-browser-tool-1280-light.png")).includes("Ovis 내장 브라우저"), "the desktop app with the setting on offers it");
      } finally { await browser.close(); }
    } finally {
      await server.stop(true);
    }
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
}

await main();
console.log("agent built-in browser tool demo regression passed");
