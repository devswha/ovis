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
declare global { interface Window { dragFixture: { inputs: Frame[]; glideFinished?: boolean } } }

function installDragFixture(): void {
  const params = new URL(location.href).searchParams;
  const core = params.get("server") === "core";
  const touch = params.get("touch") === "1";
  const local = params.get("buffer") === "main";
  // Fullscreen apps use an alternate screen with SGR mouse reporting, unlike local history.
  const stream = local
    ? Array.from({ length: 120 }, (_, i) => `LOCAL-ROW-${i + 1}\r\n`).join("")
    : `\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[H\x1b[2J${Array.from({ length: 20 }, (_, index) => `CODEX-ROW-${index + 1}`).join("\r\n")}`;
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
  for (const { pane, name, kind, local = false, oneRow = false } of [
    { pane: panes.web, name: "Codex fullscreen", oneRow: true, kind: "herdr" },
    { pane: panes.web, name: "Codex fullscreen", oneRow: true, kind: "core" },
    { pane: panes.api, name: "Claude fullscreen", oneRow: true, kind: "herdr" },
    { pane: panes.api, name: "Claude fullscreen", oneRow: true, kind: "core" },
    { pane: panes.api, name: "Claude main screen", local: true, kind: "core" },
    { pane: panes.shell, name: "Shell local history", local: true, kind: "core" },
    { pane: panes.shell, name: "Generic mouse app", kind: "herdr" },
  ]) {
    const context = await newContext({ viewport: { width: 412, height: 860 }, isMobile: true, hasTouch: true });
    try {
      await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({
        language: "en", defaultView: "terminal", terminalInputMode: "direct", alertsOn: false,
      })));
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      await page.goto(`${baseUrl}?pane=${encodeURIComponent(pane)}&view=terminal&server=${kind}&touch=1&buffer=${local ? "main" : "alternate"}`);
      const rows = page.locator(".pane-frame.is-current .ghostty-row");
      if (!local) await page.locator(".pane-frame.is-current .xterm.enable-mouse-events").waitFor();
      await rows.filter({ hasText: local ? "LOCAL-ROW-120" : "CODEX-ROW-1" }).first().waitFor();
      const rowNumber = async () => Number((await rows.first().textContent())?.match(/LOCAL-ROW-(\d+)/)?.[1]);
      const before = local ? await rowNumber() : 0;
      if (local) assert.ok(before > 2);
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
      assert.equal(await reports(), oneRow ? 1 : 0, `${kind}: wheel reports after a slow drag of 1.25 rows (${name})`);
      if (local) {
        assert.equal(await rowNumber(), before - 1, `${name}: local scrolling advances one row`);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
        assert.equal(await sent(page), "", `${name}: no remote input`);
        console.log(`PASS ${kind}: ${name} advances locally without wheel reports`);
        continue;
      }
      if (!oneRow) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + Math.ceil(row.height * 3.25) }] });
      }
      await page.locator(".pane-frame.is-current .ghostty-row", { hasText: "TRANSCRIPT-OFFSET-1" }).first().waitFor();
      assert.equal(await reports(), 1);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
      if (oneRow) {
        await page.evaluate(({ x, y, rowHeight }) => {
          const target = document.elementFromPoint(x, y)!;
          const now = performance.now();
          // Observe completion rather than timing a Playwright polling round trip. The unit
          // test with a controlled frame clock checks the actual spacing and cutoff.
          window.dragFixture.glideFinished = false;
          const watch = new MutationObserver((changes) => {
            if (changes.some((change) => change.oldValue !== null &&
                !(change.target as Element).hasAttribute("data-touch-fling"))) {
              watch.disconnect();
              window.dragFixture.glideFinished = true;
            }
          });
          watch.observe(document.body, { subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ["data-touch-fling"] });
          const send = (type: string, y: number, at: number) => {
            const points = type === "touchend" ? [] : [new Touch({ identifier: 1, target, clientX: x, clientY: y })];
            const event = new TouchEvent(type, { bubbles: true, cancelable: true, touches: points });
            Object.defineProperty(event, "timeStamp", { value: at });
            target.dispatchEvent(event);
          };
          send("touchstart", y, now - 80);
          send("touchmove", y + rowHeight * 4, now);
          send("touchend", y + rowHeight * 4, now);
        }, { x, y, rowHeight: row.height });
        await page.waitForFunction(() => window.dragFixture.glideFinished === true, undefined, { timeout: 5000 });
        assert.ok(await reports() > 5, `${kind}: a flick still coasts after the finger lifts`);
      }
      console.log(`PASS ${kind}: ${name} uses the ${oneRow ? "one" : "three"}-row wheel report step`);
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
