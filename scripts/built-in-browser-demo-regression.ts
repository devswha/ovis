/**
 * The desktop app's built-in browser in the demo, with the desktop bridge (app/electron/src/preload.ts
 * ovisBrowser) stood in by the page: the sidebar's Browser group, a tab beside the pane where the app
 * would draw it, taking control of an agent's tab, a new tab of one's own, the tab stepping aside for
 * a dialog, and the settings rows that only the desktop app offers. UI_EVIDENCE_DIR keeps captures.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { serveDemo } from "./demo-server.ts";

const EVIDENCE = process.env.UI_EVIDENCE_DIR;

type Call = [string, ...unknown[]];

/** the bridge the desktop app's preload gives its own page, kept in the page; `show` paints where the app would draw the tab */
function standInBridge(): void {
  const tab = (id: number, profile: "mine" | "agent", address: string, title: string) => ({ id, profile, address, title, loading: false, canGoBack: false, canGoForward: false, held: false });
  const state = {
    calls: [] as Call[],
    tabs: [tab(1, "agent", "https://mobbin.com/screens/notion", "Notion 로그인"), tab(2, "mine", "http://localhost:5173/", "localhost:5173")],
    listeners: [] as ((browser: unknown) => void)[],
    next: 3,
  };
  const emit = () => { for (const listener of state.listeners) listener({ tabs: state.tabs.map((entry) => ({ ...entry })) }); };
  const drawn = () => {
    let view = document.getElementById("stand-in-view");
    if (view === null) {
      view = document.createElement("div");
      view.id = "stand-in-view";
      view.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;background:#fff;border-top:1px solid #e5e5e5;font:14px system-ui;color:#555;padding:24px;box-sizing:border-box";
      document.body.append(view);
    }
    return view;
  };
  (window as unknown as { __browser: typeof state }).__browser = state;
  (window as unknown as { ovisBrowser: unknown }).ovisBrowser = {
    current: async () => ({ tabs: state.tabs.map((entry) => ({ ...entry })) }),
    onChange: (listener: (browser: unknown) => void) => { state.listeners.push(listener); return () => { state.listeners = state.listeners.filter((other) => other !== listener); }; },
    open: async (url: string) => {
      state.calls.push(["open", url]);
      const id = state.next++;
      state.tabs.push(tab(id, "mine", url, new URL(url).host));
      emit();
      return id;
    },
    show: (id: number, bounds: { x: number; y: number; width: number; height: number }) => {
      state.calls.push(["show", id, bounds]);
      const view = drawn();
      Object.assign(view.style, { display: "block", left: `${bounds.x}px`, top: `${bounds.y}px`, width: `${bounds.width}px`, height: `${bounds.height}px` });
      view.textContent = state.tabs.find((entry) => entry.id === id)?.title ?? "";
    },
    hide: () => {
      state.calls.push(["hide"]);
      const view = document.getElementById("stand-in-view");
      if (view) view.style.display = "none";
    },
    close: (id: number) => { state.calls.push(["close", id]); state.tabs = state.tabs.filter((entry) => entry.id !== id); emit(); },
    navigate: async (id: number, url: string) => { state.calls.push(["navigate", id, url]); return true; },
    go: (id: number, step: string) => state.calls.push(["go", id, step]),
    hold: (id: number, held: boolean) => {
      state.calls.push(["hold", id, held]);
      const found = state.tabs.find((entry) => entry.id === id);
      if (found) found.held = held;
      emit();
    },
  };
}

const calls = (page: Page) => page.evaluate(() => (window as unknown as { __browser: { calls: Call[] } }).__browser.calls.splice(0));

async function open(browser: Browser, origin: string, width: number, theme: "light" | "dark", on: boolean, bridge = true): Promise<Page> {
  const phone = width === 390;
  const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 820 }, ...(phone ? { deviceScaleFactor: 3, isMobile: true, hasTouch: true } : {}), locale: "ko-KR", colorScheme: theme });
  await context.addInitScript((settings) => localStorage.setItem("ovis:settings", settings), JSON.stringify({ language: "ko", theme, builtInBrowser: on }));
  if (bridge) await context.addInitScript(standInBridge);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}?pane=${encodeURIComponent(panes.api)}`);
  await page.locator(".conn-live").waitFor();
  assert.deepEqual(errors, [], `${width} ${theme}: no page errors`);
  return page;
}

async function wide(browser: Browser, origin: string, theme: "light" | "dark"): Promise<void> {
  const tag = `1280 ${theme}`;
  const shot = async (page: Page, name: string) => { if (EVIDENCE && theme === "light") await page.screenshot({ path: join(EVIDENCE, `built-in-browser-${name}-1280-${theme}.png`) }); };

  const before = await open(browser, origin, 1280, theme, false, false);
  assert.equal(await before.getByRole("region", { name: "브라우저", exact: true }).count(), 0, `${tag}: a browser without the desktop app shows no Browser group`);
  await shot(before, "before");
  await before.context().close();

  const page = await open(browser, origin, 1280, theme, true);
  const group = page.getByRole("region", { name: "브라우저", exact: true });
  await group.waitFor();
  assert.deepEqual(await group.getByRole("button").allInnerTexts(), ["", "Notion 로그인", "localhost:5173"], `${tag}: the group lists the tabs after its New tab button`);

  await group.getByRole("button", { name: /Notion 로그인/ }).click();
  const holder = page.locator(".browser-panel-holder");
  await holder.getByText("에이전트가 쓰는 중", { exact: true }).waitFor();
  const address = page.getByRole("textbox", { name: "주소", exact: true });
  assert.equal(await address.inputValue(), "https://mobbin.com/screens/notion", `${tag}: the panel shows the tab's address`);
  assert.equal(await address.getAttribute("readonly"), "", `${tag}: an agent's tab is only watched until taken`);
  const body = await page.locator(".browser-panel-body").boundingBox();
  const shown = (await calls(page)).filter(([name]) => name === "show").at(-1);
  assert.ok(body && shown, `${tag}: the panel asks the app to draw the tab`);
  const bounds = shown[2] as { x: number; y: number; width: number; height: number };
  assert.equal(shown[1], 1);
  for (const key of ["x", "y", "width", "height"] as const) assert.ok(Math.abs(bounds[key] - body[key]) < 1, `${tag}: the tab is drawn over the panel's body (${key})`);
  await shot(page, "agent-tab");

  await holder.getByRole("button", { name: "제어 가져오기", exact: true }).click();
  await holder.getByText("내가 제어 중 · 에이전트는 멈춤", { exact: true }).waitFor();
  assert.deepEqual((await calls(page)).filter(([name]) => name === "hold"), [["hold", 1, true]], `${tag}: taking control asks the app once`);
  assert.equal(await address.getAttribute("readonly"), null, `${tag}: a held tab takes an address`);
  await shot(page, "held");
  await holder.getByRole("button", { name: "중지", exact: true }).click();
  await holder.getByText("에이전트가 쓰는 중", { exact: true }).waitFor();

  await group.getByRole("button", { name: "새 탭", exact: true }).click();
  const typed = page.getByRole("textbox", { name: "주소", exact: true });
  await page.getByText("주소를 입력하면 내 탭으로 열립니다.", { exact: false }).waitFor();
  await typed.fill("localhost:3000/docs");
  await typed.press("Enter");
  await group.getByRole("button", { name: /localhost:3000/ }).waitFor();
  assert.deepEqual((await calls(page)).filter(([name]) => name === "open"), [["open", "http://localhost:3000/docs"]], `${tag}: a typed address opens a tab of one's own`);
  assert.equal(await group.getByRole("button", { name: /localhost:3000/ }).getAttribute("aria-current"), "true", `${tag}: the new tab is the one shown`);

  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  const settings = page.getByRole("dialog").first();
  await settings.waitFor();
  await page.waitForFunction(() => (window as unknown as { __browser: { calls: Call[] } }).__browser.calls.some(([name]) => name === "hide"));
  await settings.getByText("채팅", { exact: true }).first().click();
  await page.getByRole("switch", { name: "내장 브라우저", exact: true }).scrollIntoViewIfNeeded();
  assert.equal(await page.getByRole("switch", { name: "내장 브라우저", exact: true }).isChecked(), true, `${tag}: the setting row is offered in the desktop app`);
  await page.getByRole("textbox", { name: "차단한 사이트", exact: true }).waitFor();
  await shot(page, "settings");
  await page.context().close();
}

async function phone(browser: Browser, origin: string): Promise<void> {
  const page = await open(browser, origin, 390, "light", true);
  assert.equal(await page.getByRole("region", { name: "브라우저", exact: true }).count(), 0, "390: a narrow window has no place beside the pane, so no Browser group");
  await page.context().close();
}

async function main(): Promise<void> {
  const app = mkdtempSync(join(tmpdir(), "ovis-built-in-browser-demo-"));
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
        for (const theme of ["light", "dark"] as const) await wide(browser, origin, theme);
        await phone(browser, origin);
      } finally { await browser.close(); }
    } finally {
      await server.stop(true);
    }
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
}

await main();
console.log("built-in browser demo regression passed");
