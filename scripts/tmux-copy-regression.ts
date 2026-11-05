/**
 * A copy made in tmux reaches the browser's clipboard (#1517): herdr's attach stream drops the OSC 52
 * tmux sends, so with the shared "Copies in tmux" setting on, the server sets a hook on the tmux a shown
 * pane runs (server/tmux-clipboard.ts), reads tmux's buffer when it fires and tells the browser showing
 * the pane. A herdr pane on the isolated test herdr runs a tmux client on its own socket and config
 * (a fixture, with set-clipboard on so an app's OSC 52 is taken); with the setting off no hook is set,
 * and once on, an app's OSC 52 inside tmux and a copy-mode copy each land on the clipboard.
 * Run by ui-contexts-checks.ts; skipped where tmux is not installed.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { paneSendText, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { createServer } from "../server/index.ts";
import { UsageService } from "../server/usage.ts";

export async function checkTmuxCopy(browser: Browser): Promise<void> {
  const tmux = Bun.which("tmux");
  if (tmux === null || process.platform === "win32") {
    console.log("SKIP tmux copy: no tmux on this PC");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "ovis-tmux-copy-"));
  const state = join(root, "state");
  mkdirSync(state);
  const socket = join(root, "sock");
  const run = async (...args: string[]): Promise<string> => {
    const child = Bun.spawn([tmux, "-S", socket, ...args], { env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (code !== 0) throw new Error(`tmux ${args.join(" ")} failed: ${await new Response(child.stderr).text()}`);
    return out.trim();
  };
  let server: ReturnType<typeof createServer> | undefined;
  let workspace: string | undefined;
  try {
    server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: state, usage: new UsageService(undefined, []) });
    const origin = `http://127.0.0.1:${server.port}`;
    const conf = join(root, "tmux.conf");
    writeFileSync(conf, "set -g set-clipboard on\n");
    const ourHook = async (): Promise<boolean> => (await run("show-hooks", "-g", "pane-set-clipboard").catch(() => "")).includes(`[${server!.port}]`);
    const hookIs = async (want: boolean): Promise<void> => {
      const deadline = Date.now() + 10_000;
      while (await ourHook() !== want) {
        if (Date.now() > deadline) throw new Error(`the tmux hook was never ${want ? "set" : "removed"}`);
        await Bun.sleep(50);
      }
    };
    const share = (tmuxCopy: boolean) => page.evaluate((on) => fetch("/api/preferences", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ settings: { tmuxCopy: on } }) }).then((answer) => answer.ok), tmuxCopy);
    let page!: import("playwright-core").Page;
    const created = await workspaceCreate({ cwd: root, label: "ovis-test-tmux-copy" });
    workspace = created.workspace.workspace_id;
    const pane = created.root_pane.pane_id;
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    try {
      await context.addInitScript((id) => {
        localStorage.setItem(`ovis:view:${id}`, "terminal");
        // what the page wrote to the clipboard, in order, once each write is done
        const written: string[] = [];
        (window as any).clipboardWritten = written;
        const writeText = navigator.clipboard.writeText.bind(navigator.clipboard);
        navigator.clipboard.writeText = (text: string) => writeText(text).then(() => { written.push(text); });
      }, pane);
      await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
      page = await context.newPage();
      page.setDefaultTimeout(10_000);
      await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
      await page.locator(".pane-terminal .xterm-rows").waitFor();
      await paneSendText(pane, `clear; exec ${tmux} -S ${socket} -f ${conf} new-session -s copy\r`);
      await page.locator(".pane-terminal .xterm-rows > div", { hasText: "[copy]" }).first().waitFor();
      const clipboard = (): Promise<string> => page.evaluate(() => navigator.clipboard.readText());
      const copied = (text: string) => page.waitForFunction((want) => ((window as any).clipboardWritten as string[]).includes(want), text);
      await page.evaluate(() => navigator.clipboard.writeText("UNCHANGED"));

      // off by default: the server sets nothing on the user's tmux; a sweep that saw the pane has run by
      // the time the setting turns on, which sweeps again at once
      assert.equal(await ourHook(), false, "with the setting off no hook is set");
      assert.ok(await share(true), "the setting is shared");
      await hookIs(true);
      console.log("PASS the setting, off by default, sets the hook on the tmux the shown pane runs");

      // an app's copy inside tmux (vim's "+y, Claude Code's copy): OSC 52 to tmux, which herdr does not pass on
      await run("send-keys", "-t", "copy", "printf '\\033]52;c;%s\\a' \"$(printf TMUXCOPY-from-an-app | base64)\"; echo TMUXCOPY-sent", "Enter");
      await page.locator(".pane-terminal .xterm-rows > div", { hasText: /^TMUXCOPY-sent/ }).first().waitFor();
      await copied("TMUXCOPY-from-an-app");
      await page.locator(".terminal-banner", { hasText: "copied to clipboard" }).waitFor();
      console.log("PASS an app's OSC 52 inside tmux reaches the browser's clipboard");

      // tmux's own copy mode: a line selected and copied
      await run("send-keys", "-t", "copy", "clear; echo TMUXCOPY-the-line", "Enter");
      await page.locator(".pane-terminal .xterm-rows > div", { hasText: /^TMUXCOPY-the-line/ }).first().waitFor();
      await run("copy-mode", "-t", "copy");
      await run("send-keys", "-t", "copy", "-X", "search-backward", "TMUXCOPY-the-line");
      await run("send-keys", "-t", "copy", "-X", "select-line");
      await run("send-keys", "-t", "copy", "-X", "copy-selection-and-cancel");
      await copied("TMUXCOPY-the-line");
      assert.equal(await clipboard(), "TMUXCOPY-the-line", "a copy-mode copy is the clipboard");
      console.log("PASS a tmux copy-mode copy reaches the browser's clipboard");

      assert.ok(await share(false), "the setting is shared");
      await hookIs(false);
      console.log("PASS turning the setting off removes the hook");
    } finally {
      await context.close();
    }
  } finally {
    await run("kill-server").catch(() => {});
    if (workspace) await workspaceClose(workspace).catch(() => {});
    server?.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await import("./test-herdr.ts");
  const { chromium } = await import("playwright-core");
  const { chromePath } = await import("./chrome-path.ts");
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    await checkTmuxCopy(browser);
  } finally {
    await browser?.close();
  }
}
