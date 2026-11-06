/**
 * Keys typed right after a New tab choice (the +, the phone title's sheet, the New tab dialog's Start) reach the
 * new tab, every one and in order, and none the old tab; a Space or Enter typed then opens no second tab.
 */
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { paneRead, sessionSnapshot, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { chromePath } from "./chrome-path.ts";

type Way = "plus" | "sheet" | "dialog";
type Sent = { type: string; pane_id: string; text?: string; keys?: string[] };

async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, `timed out: ${label}`);
    await Bun.sleep(25);
  }
}

function watch(page: Page): { sent: Sent[]; ready: Set<string> } {
  const sent: Sent[] = [];
  const ready = new Set<string>();
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      const message = JSON.parse(String(payload));
      if (message.type === "input" || message.type === "keys") sent.push(message);
    });
    socket.on("framereceived", ({ payload }) => {
      const message = JSON.parse(String(payload));
      if (message.type === "input-ready" && message.ready !== false) ready.add(message.pane_id);
    });
  });
  return { sent, ready };
}

const textOf = (sent: Sent[], paneId: string): string => sent.filter((message) => message.pane_id === paneId)
  .map((message) => message.text ?? (message.keys ?? []).join("")).join("");

async function choose(page: Page, first: string, way: Way, sent: Sent[]): Promise<void> {
  if (way === "sheet") {
    // the title's list stands in for the row on a narrow window
    await page.locator(".app-header .context-tabs").click();
    sent.length = 0;
    await page.locator(".row-sheet-item", { hasText: "New terminal" }).click();
    return;
  }
  await page.locator(`[data-layout-pane=${JSON.stringify(first)}] .xterm-screen`).click();
  if (way === "plus") {
    sent.length = 0;
    await page.locator(".tab-strip-add").click();
    return;
  }
  await page.locator('.tab-strip-item.is-active [role="tab"]').click({ button: "right" });
  await page.getByRole("menuitem", { name: "New tab with agent…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: /^New tab/ });
  await dialog.waitFor();
  sent.length = 0;
  await dialog.getByRole("button", { name: "Start", exact: true }).click();
}

async function typeAhead(browser: Browser, origin: string, way: Way, viewport: { width: number; height: number }, delay: number): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-newtab-typeahead-")));
  const created = await workspaceCreate({ cwd: root, label: `ovis-test-newtab-${way}` });
  const workspaceId = created.workspace.workspace_id;
  const first = created.root_pane.pane_id;
  const context = await browser.newContext({ viewport, locale: "en-US" });
  await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "terminal", alertsOn: false })));
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const { sent, ready } = watch(page);
    await page.goto(`${origin}/?pane=${encodeURIComponent(first)}`);
    await page.locator(".conn-live").waitFor();
    await until(() => ready.has(first), "the first terminal accepts input");
    const word = `ahead-${way}`;
    await choose(page, first, way, sent);
    // typed at once, while herdr is still making the tab
    await page.keyboard.type(`echo ${word}`, { delay });
    await page.keyboard.press("Enter");
    let second: string | undefined;
    await until(async () => (second = (await sessionSnapshot()).panes.find((pane) => pane.workspace_id === workspaceId && pane.pane_id !== first)?.pane_id) !== undefined, "herdr has the new tab");
    await until(() => ready.has(second!), "the new terminal accepts input");
    const ran = async () => (await paneRead({ paneId: second!, source: "recent", lines: 30, stripAnsi: true })).text.split("\n").some((line) => line.trim() === word);
    await until(ran, `${way}: the new tab ran the command typed ahead`);
    assert.equal(textOf(sent, first), "", `${way}: no key goes to the old tab`);
    assert.equal(textOf(sent, second!), `echo ${word}\r`, `${way}: every key reaches the new tab, in order`);
    const tabs = (await sessionSnapshot()).panes.filter((pane) => pane.workspace_id === workspaceId).length;
    assert.equal(tabs, 2, `${way}: a Space or Enter typed ahead opens no other tab`);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
    await workspaceClose(workspaceId).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

export async function checkNewTabTypeAhead(browser: Browser, origin: string): Promise<void> {
  await typeAhead(browser, origin, "plus", { width: 1280, height: 800 }, 0);
  await typeAhead(browser, origin, "sheet", { width: 390, height: 844 }, 0);
  // slower, so the keys go on while the dialog closes over the old tab
  await typeAhead(browser, origin, "dialog", { width: 1280, height: 800 }, 15);
  console.log("PASS keys typed right after New terminal, the tab list's New terminal and the New tab dialog's Start reach the new tab in order, none the old, and open no other tab");
}

if (import.meta.main) {
  await import("./test-herdr.ts");
  const { chromium } = await import("playwright-core");
  const { createServer } = await import("../server/index.ts");
  const { UsageService } = await import("../server/usage.ts");
  const state = mkdtempSync(join(tmpdir(), "ovis-newtab-typeahead-state-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: state, usage: new UsageService(undefined, []) });
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  try { await checkNewTabTypeAhead(browser, `http://127.0.0.1:${server.port}`); }
  finally { await browser.close(); server.stop(); rmSync(state, { recursive: true, force: true }); }
}
