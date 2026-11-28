/**
 * A plain drag in a Codex pane (#2384): Codex selects on its alternate screen and scrolls its own
 * history past an edge, then copies with OSC 52, which herdr's attach drops. So the drag stays Ovis's
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import type { Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { withDemoBrowser } from "./demo-browser.ts";
import { appFaces } from "./app-faces.ts";

interface Frame { type: string; pane_id?: string; text?: string }
declare global { interface Window { dragFixture: { inputs: Frame[] } } }

function installDragFixture(): void {
  const params = new URL(location.href).searchParams;
  const core = params.get("server") === "core";
  const touch = params.get("touch") === "1";
  // Codex's main screen as it starts: the alternate screen with drag reporting in SGR
  const stream = `\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[H\x1b[2J${Array.from({ length: 20 }, (_, index) => `CODEX-ROW-${index + 1}`).join("\r\n")}`;
  const state = { inputs: [] as Frame[] };
  window.dragFixture = state;
  const Demo = window.WebSocket;
  const Recorded = function (url: string | URL, protocols?: string | string[]) {
    const socket = new Demo(url, protocols) as WebSocket & { push(frame: Record<string, unknown>): void };
    const push = socket.push.bind(socket);
    let featured = false;
    let offset = 0;
    let waiting: (() => void) | null = null;
    socket.push = (frame) => {
      if ((frame.type === "snapshot" || frame.type === "features") && Array.isArray(frame.features) && core) {
        push({ ...frame, features: [...(frame.features as string[]), "terminal-history"] });
      } else if (frame.type === "pty-data") {
        // the demo's own recording would draw over the fixture's screen
        if (frame.fixture !== "drag") return;
        const { fixture: _, ...output } = frame;
        push(output);
      } else push(frame);
      if (frame.type === "snapshot" || frame.type === "features") {
        featured = true;
        waiting?.();
        waiting = null;
      }
    };
    const send = socket.send.bind(socket);
    socket.send = (raw) => {
      const frame = JSON.parse(String(raw)) as Frame;
      if (frame.type === "input" || frame.type === "keys") state.inputs.push(frame);
      send(raw);
      // A fixture for the TUI side of the same SGR path: each wheel-up report moves its transcript
      // one row, rather than scrolling the browser's own history.
      if (touch && frame.type === "input" && frame.pane_id) {
        const steps = (frame.text?.match(/\x1b\[<64;\d+;\d+M/g) ?? []).length;
        if (steps > 0) {
          offset += steps;
          socket.push({ type: "pty-data", fixture: "drag", pane_id: frame.pane_id, data: `\x1b[1;1H\x1b[2KTRANSCRIPT-OFFSET-${offset}` });
        }
      }
      if (frame.type === "attach" && frame.pane_id) {
        const paint = () => socket.push({ type: "pty-data", fixture: "drag", pane_id: frame.pane_id, data: stream });
        if (featured) paint();
        else waiting = paint;
      }
    };
    return socket;
  };
  for (const name of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"] as const) Object.defineProperty(Recorded, name, { value: Demo[name] });
  window.WebSocket = Recorded as unknown as typeof WebSocket;
}

const evidence = process.env.UI_EVIDENCE_DIR;
const sent = (page: Page) => page.evaluate(() => window.dragFixture.inputs.map((frame) => frame.text ?? "").join(""));

await withDemoBrowser({ tempPrefix: "codex-drag-demo-", afterTransport: `\n<script>(${installDragFixture.toString()})()</script>` }, async ({ newContext, baseUrl }) => {
  for (const { pane, codex, kind } of [
    { pane: panes.web, codex: true, kind: "herdr" },
    { pane: panes.web, codex: true, kind: "core" },
    { pane: panes.shell, codex: false, kind: "herdr" },
  ]) {
    const context = await newContext({ viewport: { width: 412, height: 860 }, isMobile: true, hasTouch: true });
    try {
      await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({
        language: "en", defaultView: "terminal", terminalInputMode: "direct", alertsOn: false,
      })));
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      await page.goto(`${baseUrl}?pane=${encodeURIComponent(pane)}&view=terminal&server=${kind}&touch=1`);
      await page.locator(".pane-frame.is-current .xterm.enable-mouse-events").waitFor();
      await page.locator(".pane-frame.is-current .ghostty-row", { hasText: "CODEX-ROW-1" }).first().waitFor();
      const box = await page.locator(".pane-frame.is-current .xterm-screen").boundingBox();
      const row = await page.locator(".pane-frame.is-current .ghostty-row").first().boundingBox();
      assert.ok(box && row);
      const x = Math.round(box.x + box.width / 2);
      const y = Math.round(box.y + box.height / 3);
      const cdp = await context.newCDPSession(page);
      const reports = async () => ((await sent(page)).match(/\x1b\[<64;\d+;\d+M/g) ?? []).length;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + Math.ceil(row.height * 1.25) }] });
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      assert.equal(await reports(), codex ? 1 : 0, `${kind}: wheel reports after a slow drag of 1.25 rows (${codex ? "Codex" : "ordinary pane"})`);
      if (!codex) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + Math.ceil(row.height * 3.25) }] });
      }
      await page.locator(".pane-frame.is-current .ghostty-row", { hasText: "TRANSCRIPT-OFFSET-1" }).first().waitFor();
      assert.equal(await reports(), 1);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
      if (codex) {
        const started = await page.evaluate(({ x, y, rowHeight }) => {
          const target = document.elementFromPoint(x, y)!;
          const now = performance.now();
          const send = (type: string, y: number, at: number) => {
            const points = type === "touchend" ? [] : [new Touch({ identifier: 1, target, clientX: x, clientY: y })];
            const event = new TouchEvent(type, { bubbles: true, cancelable: true, touches: points });
            Object.defineProperty(event, "timeStamp", { value: at });
            target.dispatchEvent(event);
          };
          send("touchstart", y, now - 80);
          send("touchmove", y + rowHeight * 4, now);
          send("touchend", y + rowHeight * 4, now);
          return now;
        }, { x, y, rowHeight: row.height });
        await page.locator(".pane-frame.is-current [data-touch-fling]").waitFor({ state: "attached" });
        await page.locator(".pane-frame.is-current [data-touch-fling]").waitFor({ state: "detached" });
        const elapsed = await page.evaluate((started) => performance.now() - started, started);
        assert.ok(elapsed < 1250, `${kind}: a Codex flick stops before a sparse tail (${elapsed.toFixed()} ms)`);
        assert.ok(await reports() > 5, `${kind}: a flick still coasts after the finger lifts`);
      }
      console.log(`PASS ${kind}: ${codex ? "Codex advances after one row of finger travel" : "ordinary panes retain the three-row report step"}`);
    } finally {
      await context.close();
    }
  }
  const cases = [{ kind: "herdr", codexDrag: false }, { kind: "core", codexDrag: false }, { kind: "herdr", codexDrag: true }, { kind: "core", codexDrag: true }] as const;
  for (const { kind, codexDrag } of cases) {
    const name = `${kind}, Codex panes ${codexDrag ? "on" : "off"}`;
    const context = await newContext({ viewport: { width: 1280, height: 900 } });
    try {
      await context.addInitScript((codexDrag) => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "terminal", terminalInputMode: "direct", alertsOn: false, codexDrag })), codexDrag);
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${baseUrl}?pane=${encodeURIComponent(panes.web)}&view=terminal&server=${kind}`);
      await page.locator(".conn-live").waitFor();
      await appFaces(page);
      await page.locator(".pane-frame.is-current .xterm.enable-mouse-events").waitFor();
      const screen = page.locator(".pane-frame.is-current .xterm-screen");
      const box = await screen.boundingBox();
      assert.ok(box);
      await page.mouse.move(box.x + 40, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + 200, box.y + box.height / 3, { steps: 4 });
      await page.mouse.move(box.x + 200, box.y - 10, { steps: 4 });
      await page.mouse.up();
      const press = /\x1b\[<0;\d+;\d+M/, release = /\x1b\[<0;\d+;\d+m/;
      const note = page.locator(".pane-frame.is-current .terminal-banner", { hasText: "Codex selected this" });
      if (codexDrag) {
        await page.waitForFunction(() => /\x1b\[<0;\d+;\d+M(?:[\s\S]*?\x1b\[<32;\d+;\d+M)+[\s\S]*?\x1b\[<0;\d+;\d+m/.test(window.dragFixture.inputs.map((frame) => frame.text ?? "").join("")))
          .catch(async (cause: unknown) => { throw new Error(`${name}: the drag never reached Codex (sent ${JSON.stringify(await sent(page))})`, { cause }); });
        assert.equal(await page.locator(".pane-frame.is-current .xterm-selection div").count(), 0, `${name}: Ovis selects nothing over Codex's own selection`);
        // herdr drops Codex's copy: the way to copy and quote here is said; herdr-core passes the copy on
        if (kind === "herdr") await note.waitFor();
        else assert.equal(await note.count(), 0, `${name}: no note where Codex's copy arrives`);
        const selecting = await page.evaluate(() => /Mac/.test(navigator.platform)) ? "Alt" : "Shift";
        const presses = async () => ((await sent(page)).match(/\x1b\[<0;\d+;\d+M/g) ?? []).length;
        const pressed = await presses();
        await page.mouse.move(box.x + 40, box.y + box.height / 2);
        await page.keyboard.down(selecting);
        await page.mouse.down();
        await page.mouse.move(box.x + 200, box.y + box.height / 3, { steps: 4 });
        await page.mouse.up();
        await page.keyboard.up(selecting);
        await page.locator(".pane-frame.is-current .xterm-selection div").first().waitFor();
        assert.equal(await presses(), pressed, `${name}: ${selecting}+drag sends Codex no press`);
        await page.mouse.down();
        await page.mouse.move(box.x + 40, box.y + box.height / 2, { steps: 4 });
        await page.mouse.up();
        await page.waitForFunction((count) => (window.dragFixture.inputs.map((frame) => frame.text ?? "").join("").match(/\x1b\[<0;\d+;\d+M/g) ?? []).length > count, pressed);
        await page.locator(".pane-frame.is-current .xterm-selection div").first().waitFor({ state: "detached" });
      } else {
        await page.locator(".pane-frame.is-current .xterm-selection div").first().waitFor();
        const typed = await sent(page);
        assert.ok(!press.test(typed) && !release.test(typed), `${name}: Codex reads no press or release (sent ${JSON.stringify(typed)})`);
        assert.equal(await note.count(), 0, `${name}: no note`);
      }
      assert.deepEqual(errors, [], `${name}: no page errors`);
      if (evidence) await page.screenshot({ path: join(evidence, `codex-drag-${kind}-${codexDrag ? "on" : "off"}.png`) });
      console.log(`PASS ${name}: a plain drag in a Codex pane is ${codexDrag ? "Codex's" : "Ovis's selection"}`);
    } finally {
      await context.close();
    }
  }
});
