// Experiment check (not for merge): what still works on a phone + herdr-core pane when libghostty alone parses.
// bun scripts/phone-ghostty-functions.ts <current|only> <out.json>
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { createServer } from "../server/index.ts";
import { paneSendKeys, paneSendText, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { setRuntime, startRuntime } from "../server/herdr-core/runtime.ts";
import { chromePath } from "./chrome-path.ts";
import { isolatedHcEnv, stopTestCores } from "./test-hc.ts";

const [arm, outFile] = process.argv.slice(2);
if ((arm !== "current" && arm !== "only") || !outFile) throw new Error("usage: <current|only> <out.json>");
const bin = `${process.env["HOME"]}/.local/bin/herdr-core-real`;
const probe = resolve("scripts/fixtures/modifier-probe.py");
const scratchRoot = resolve("/home/devswha/.cache/ovis-tmp/phone-engine-migrate/fn-r");
mkdirSync(scratchRoot, { recursive: true });
const root = realpathSync(mkdtempSync(join(scratchRoot, "f")));
for (const sub of ["state", "config", "run", "home", "ovis-state", "pane"]) mkdirSync(join(root, sub), { mode: 0o700 });
const env = isolatedHcEnv(root, { SHELL: "/bin/sh" });
const owned: string[] = [];
let browser: Browser | undefined;
let adapter: Awaited<ReturnType<typeof startRuntime>> = null;
let server: ReturnType<typeof createServer> | undefined;
const log = join(root, "probe.hex");
const received = (): string => Buffer.from(existsSync(log) ? readFileSync(log, "utf8") : "", "hex").toString("latin1");
async function until(check: () => boolean | Promise<boolean>, ms = 15_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) return false;
    await Bun.sleep(50);
  }
  return true;
}
const out: Record<string, unknown> = { arm };
try {
  process.env["OVIS_HC_ENV"] = JSON.stringify(env);
  process.env["OVIS_HC_BIN"] = bin;
  process.env["OVIS_RUNTIME"] = "herdr-core";
  setRuntime("herdr-core");
  adapter = await startRuntime(join(root, "ovis-state"), async () => ({ bin, version: "test" }));
  server = createServer({ port: 0, hostname: "127.0.0.1", stateDir: join(root, "ovis-state"), token: "" });
  const made = await workspaceCreate({ cwd: join(root, "pane"), label: "ovis-test-phone-ghostty-functions" });
  owned.push(made.workspace.workspace_id);
  const pane = made.root_pane.pane_id;
  await paneSendText(pane, `clear; for i in $(seq 1 300); do printf 'HIST-%03d https://example.com/h%03d\\n' $i $i; done; printf '\\033[?2004h'; python3 -u '${probe}' '${log}' plain`);
  await paneSendKeys(pane, ["Enter"]);
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox", "--accept-lang=en-US"] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: `http://127.0.0.1:${server.port}` });
  await context.addInitScript(({ pane, arm }) => {
    localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "terminal", alertsOn: false }));
    localStorage.setItem(`ovis:view:${pane}`, "terminal");
    localStorage.setItem("ovis:ghostty-only", arm === "only" ? "on" : "off");
  }, { pane, arm });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(pane)}`);
  const host = ".pane-terminal[data-renderer='ghostty']";
  await page.locator(host).first().waitFor({ timeout: 30_000 });
  const shown = (): Promise<string> => page.locator(`${host} .ghostty-text`).first().innerText();
  const xtermRows = (): Promise<string> => page.locator(`${host} .xterm-rows`).first().evaluate((el) => (el as HTMLElement).textContent ?? "");
  out["ready"] = await until(async () => (await shown()).includes("PROBE READY plain"));
  await Bun.sleep(500);
  received();

  // typing through xterm's textarea
  await page.locator(`${host} .xterm-helper-textarea`).first().focus();
  await page.keyboard.type("abc");
  out["typing"] = { ok: await until(() => received().includes("abc")), bytes: JSON.stringify(received()) };

  // a paste into a program that turned bracketed paste on
  const before = received().length;
  await page.locator(`${host} .xterm-helper-textarea`).first().evaluate((el) => {
    const data = new DataTransfer();
    data.setData("text/plain", "P1\nP2");
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await until(() => received().length > before + 4, 5_000);
  const pasted = received().slice(before);
  out["bracketedPaste"] = { ok: pasted.includes("\x1b[200~") && pasted.includes("\x1b[201~"), bytes: JSON.stringify(pasted) };

  // a swipe down (finger moving down) scrolls back through the history this terminal keeps
  const bottom = await shown();
  const box = (await page.locator(host).first().boundingBox())!;
  const cdp = await context.newCDPSession(page);
  const x = box.x + box.width / 2;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: box.y + 100 }] });
  for (let y = 100; y <= 600; y += 25) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: box.y + y }] });
    await Bun.sleep(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await Bun.sleep(1500);
  const scrolled = await shown();
  const firstHist = (text: string): string | null => /HIST-\d{3}/.exec(text)?.[0] ?? null;
  out["touchScroll"] = { moved: scrolled !== bottom, firstAtBottom: firstHist(bottom), firstAfterSwipe: firstHist(scrolled), typedDuringSwipe: JSON.stringify(received().slice(before + pasted.length)) };

  // what xterm holds for selection, links, Find highlights, the input row and the masked prompt
  out["xtermBufferText"] = (await xtermRows()).slice(0, 200);
  // a word selection: xterm's double click (selection and copy read xterm's buffer)
  const cellRow = await page.locator(`${host} .ghostty-row`).nth(2).boundingBox();
  if (cellRow) await page.mouse.dblclick(cellRow.x + 20, cellRow.y + cellRow.height / 2);
  await Bun.sleep(300);
  await page.keyboard.press("Control+c");
  await Bun.sleep(500);
  out["selection"] = { copied: await page.evaluate(() => navigator.clipboard.readText().catch((e) => "ERR " + e)), rowText: (await page.locator(`${host} .ghostty-row`).nth(2).innerText()).slice(0, 40) };
  // links: xterm's link providers read its buffer; hovering a URL cell makes xterm underline it
  const linkRow = await page.locator(`${host} .ghostty-row`, { hasText: "https://example.com" }).first().boundingBox();
  if (linkRow) {
    await page.mouse.move(linkRow.x + linkRow.width * 0.6, linkRow.y + linkRow.height / 2);
    await Bun.sleep(300);
  }
  out["linkHover"] = await page.evaluate(() => {
    const screen = document.querySelector(".pane-terminal[data-renderer='ghostty'] .xterm-screen") as HTMLElement;
    return { pointer: screen ? getComputedStyle(screen).cursor : null, underlined: document.querySelectorAll(".xterm-underline-5, .xterm-cursor-pointer").length };
  });
  // IME position: xterm's helper textarea sits at the cursor xterm has
  out["cursor"] = await page.evaluate(() => {
    const host = document.querySelector(".pane-terminal[data-renderer='ghostty']") as HTMLElement;
    const ta = host.querySelector(".xterm-helper-textarea") as HTMLElement;
    const cur = host.querySelector(".ghostty-cursor") as HTMLElement;
    const a = ta.getBoundingClientRect(), b = cur.getBoundingClientRect();
    return { textarea: [Math.round(a.left), Math.round(a.top)], ghosttyCursor: [Math.round(b.left), Math.round(b.top)] };
  });
  out["errors"] = errors;
} finally {
  writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out));
  await browser?.close().catch(() => {});
  await Promise.resolve().then(() => server?.stop()).catch(() => {});
  for (const id of owned) await workspaceClose(id).catch(() => {});
  adapter?.stop();
  console.log(`PG_CORE_STOP ${JSON.stringify(await stopTestCores(bin, [{ env, pids: [] }]))}`);
  rmSync(root, { recursive: true, force: true });
}
process.exit(0);
