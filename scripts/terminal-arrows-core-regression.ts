/**
 * Arrows on herdr-core: browser → WS → hc's attach → a raw-mode PTY that logs its stdin. hc's attach
 * carries the program's modes to xterm (`terminal-modes`), so a plain arrow is typed as xterm encodes
 * it, beside the letters around it, instead of going through hc's terminal.keys, which waits until
 * nobody has typed for ~3 s. Runs where OVIS_TEST_HC_BIN names an hc.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { createServer } from "../server/index.ts";
import { paneRead, paneSendKeys, paneSendText, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { setRuntime, startRuntime } from "../server/herdr-core/runtime.ts";
import { chromePath } from "./chrome-path.ts";
import { isolatedHcEnv, stopIsolatedCore } from "./test-hc.ts";

const bin = process.env["OVIS_TEST_HC_BIN"];
if (!bin || process.platform === "win32") {
  console.log("terminal arrows on herdr-core: skipped (set OVIS_TEST_HC_BIN to an hc; not on Windows)");
  process.exit(0);
}

/** hc's quiet rule holds terminal.keys until nobody typed for ~3 s: an arrow typed as text never waits on it */
const NO_QUIET_WAIT_MS = 1_500;
const probe = resolve("scripts/fixtures/modifier-probe.py");
// short: hc's socket path under the root must stay within the OS's limit
const root = realpathSync(mkdtempSync(join("/tmp", "hca-")));
for (const sub of ["state", "config", "run", "home", "ovis-state"]) mkdirSync(join(root, sub), { mode: 0o700 });
const env = isolatedHcEnv(root, { SHELL: "/bin/sh" });
const owned: string[] = [];
const errors: string[] = [];
let browser: Browser | undefined;
let adapter: Awaited<ReturnType<typeof startRuntime>> = null;
let server: ReturnType<typeof createServer> | undefined;

async function until(check: () => boolean | Promise<boolean>, label: string | (() => string)): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    assert(Date.now() < deadline, `timed out: ${typeof label === "string" ? label : label()}`);
    await Bun.sleep(5);
  }
}

interface Session {
  page: Page;
  pane: string;
  frames: Array<{ type: string; text?: string; keys?: string[] }>;
  /** what the program in the pane has read since the last call */
  received: () => string;
}

/** A pane of its own that runs `before` and then the stdin logger, shown in a desktop browser. */
async function open(name: string, before: string): Promise<Session> {
  const cwd = join(root, name);
  mkdirSync(cwd);
  const made = await workspaceCreate({ cwd, label: `ovis-test-core-arrows-${name}` });
  owned.push(made.workspace.workspace_id);
  const pane = made.root_pane.pane_id;
  const log = join(root, `${name}.hex`);
  await paneSendText(pane, `clear; ${before} python3 -u '${probe}' '${log}' plain`);
  await paneSendKeys(pane, ["Enter"]);
  const context = await browser!.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(({ pane }) => {
    localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
    localStorage.setItem(`ovis:view:${pane}`, "terminal");
  }, { pane });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(`${name}: ${error.message}`));
  const frames: Session["frames"] = [];
  let ready = false;
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      const { id: _receipt, ...message } = JSON.parse(String(payload));
      if (message.pane_id === pane && (message.type === "input" || message.type === "keys")) frames.push(message);
    });
    socket.on("framereceived", ({ payload }) => {
      const message = JSON.parse(String(payload));
      if (message.type === "error") console.log(`${name}: terminal error`, message);
      if (message.type === "input-ready" && message.pane_id === pane) ready = message.ready !== false;
    });
  });
  await page.goto(`http://127.0.0.1:${server!.port}/?pane=${encodeURIComponent(pane)}`);
  await until(() => ready, `${name}: terminal accepts input`);
  await page.locator(".xterm-screen").waitFor();
  let read = 0;
  return {
    page, pane, frames,
    received: () => {
      const all = existsSync(log) ? readFileSync(log, "utf8") : "";
      const fresh = all.slice(read);
      read = all.length;
      return Buffer.from(fresh, "hex").toString("latin1");
    },
  };
}

const probeReady = (pane: string) => until(async () => (await paneRead({ paneId: pane, source: "visible" })).text.includes("PROBE READY plain"), `${pane}: raw probe ready`);

/** The arrows' frames are typed text, never named keys, and the program reads each in `final`'s form. */
async function arrowsAs(s: Session, label: string, form: (final: string) => string): Promise<void> {
  const before = s.frames.length;
  for (const [key, final] of [["ArrowUp", "A"], ["ArrowDown", "B"], ["ArrowRight", "C"], ["ArrowLeft", "D"]] as const) {
    let got = "";
    await s.page.keyboard.press(key);
    await until(() => (got += s.received()).length >= 3, `${label}: ${key} received`);
    assert.equal(got, form(final), `${label}: ${key}`);
  }
  assert.deepEqual(s.frames.slice(before).map((frame) => frame.type), ["input", "input", "input", "input"], `${label}: each arrow is typed, not a named key`);
}

try {
  const started = Bun.spawn([bin, "run", "--bg", "--json"], { env, stdout: "ignore", stderr: "pipe" });
  assert.equal(await started.exited, 0, `hc run: ${await new Response(started.stderr).text()}`);
  process.env["OVIS_HC_ENV"] = JSON.stringify(env);
  process.env["OVIS_HC_BIN"] = bin;
  process.env["OVIS_RUNTIME"] = "herdr-core";
  setRuntime("herdr-core");
  adapter = await startRuntime(join(root, "ovis-state"), async () => ({ bin, version: "test" }));
  assert(adapter, "herdr-core runtime started");
  server = createServer({ port: 0, hostname: "127.0.0.1", stateDir: join(root, "ovis-state"), token: "" });
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox", "--accept-lang=en-US"] });

  // 1. Application cursor keys set before the browser attached: hc's first paint tells xterm, and
  // less, git log and vim read SS3 (ESC O A)
  {
    const s = await open("decckm", "printf '\\033[?1049h\\033[?1h';");
    await probeReady(s.pane);
    await s.page.locator(".xterm-helper-textarea").focus();
    await arrowsAs(s, "application cursor keys", (final) => `\x1bO${final}`);
  }

  // 2. Set while the browser watches: hc's live stream tells xterm
  {
    const s = await open("live", "printf '\\033[?1049h'; read go; printf '\\033[?1h';");
    await s.page.locator(".xterm-helper-textarea").focus();
    await s.page.keyboard.press("Enter");
    await probeReady(s.pane);
    await arrowsAs(s, "application cursor keys set while attached", (final) => `\x1bO${final}`);
  }

  // 3. Normal cursor mode (a shell's line editor): CSI, in order with the letters typed around it,
  // and an arrow right after a letter is not held for hc's quiet rule
  {
    const s = await open("normal", "printf '\\033[?1049h';");
    await probeReady(s.pane);
    await s.page.locator(".xterm-helper-textarea").focus();
    await arrowsAs(s, "normal cursor keys", (final) => `\x1b[${final}`);
    let together = "";
    for (let round = 0; round < 5; round += 1) {
      const pressed = performance.now();
      await s.page.keyboard.press("a");
      await s.page.keyboard.press("ArrowLeft");
      await s.page.keyboard.press("b");
      await until(() => (together += s.received()).length >= (round + 1) * 5, () => `a, ArrowLeft and b received (read ${JSON.stringify(together)})`);
      const took = performance.now() - pressed;
      assert(took < NO_QUIET_WAIT_MS, `a, ArrowLeft and b took ${took.toFixed(0)} ms: the arrow waited for hc's quiet rule`);
    }
    assert.equal(together, "a\x1b[Db".repeat(5), "an arrow pressed between two letters arrives between them");
    let got = "";
    await s.page.keyboard.press("Escape");
    await s.page.keyboard.press("ArrowUp");
    await until(() => (got += s.received()).length >= 4, "Escape and ArrowUp received");
    assert.equal(got, "\x1b\x1b[A", "an arrow right after an Escape arrives after it");
  }

  assert.deepEqual(errors, [], "no page errors");
  console.log("terminal arrows on herdr-core: PASS");
} finally {
  await browser?.close().catch((error) => console.log("browser close failed", error));
  await Promise.resolve().then(() => server?.stop()).catch((error) => console.log("server stop failed", error));
  for (const id of owned) await workspaceClose(id).catch((error) => console.log("workspace close failed", id, error));
  adapter?.stop();
  await stopIsolatedCore(bin, env);
  rmSync(root, { recursive: true, force: true });
}
