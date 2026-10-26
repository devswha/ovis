/**
 * A mirrored pane wider than a phone (a Windows PC: herdr has no terminal attach there, so the bridge
 * repaints the pane at its size on that PC) is drawn folded to the screen's width, with nothing cut off
 * on the right; the pane menu's "Original width" draws the grid as it is again, remembered for this
 * device. On the unmodified app over the demo's fixture transport: no herdr, no user state.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { appFaces } from "./app-faces.ts";

const COLS = 120;
const ROWS = 40;

interface FoldFixture { sockets: Array<WebSocket & { push(frame: Record<string, unknown>): void }> }
declare global { interface Window { foldFixture: FoldFixture } }

/** The demo owns metadata and auth; this makes its PC a mirror, as a Windows PC is, with a grid of its own. */
function installFoldFixture(screen: string, cols: number, rows: number): void {
  const state: FoldFixture = { sockets: [] };
  window.foldFixture = state;
  const fetchDemo = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await fetchDemo(input, init);
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (url.pathname !== "/api/health" || url.search !== "") return response;
    const body = await response.json() as { herdr: Record<string, unknown> };
    body.herdr = { ...body.herdr, terminal_attach: false, terminal_mirror: true };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  }) as typeof window.fetch;
  const Demo = window.WebSocket;
  const Recorded = function (url: string | URL, protocols?: string | string[]) {
    const socket = new Demo(url, protocols) as FoldFixture["sockets"][number];
    state.sockets.push(socket);
    const push = socket.push.bind(socket);
    socket.push = (frame) => {
      if (frame.type === "pane-geometry") push({ ...frame, cols, rows, fixed: true });
      // the demo's own recording would draw over the fixture's screen
      else if (frame.type === "pty-data" && frame.fixture !== "fold") return;
      else if (frame.type === "pty-data") {
        const { fixture: _, ...output } = frame;
        push(output);
      }
      else push(frame);
    };
    const send = socket.send.bind(socket);
    socket.send = (raw) => {
      send(raw);
      const frame = JSON.parse(String(raw)) as { type: string; pane_id?: string };
      if (frame.type !== "attach") return;
      socket.push({ type: "pane-geometry", pane_id: frame.pane_id, cols, rows, fixed: true });
      socket.push({ type: "pty-data", fixture: "fold", pane_id: frame.pane_id, data: screen });
    };
    return socket;
  };
  for (const name of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"] as const) Object.defineProperty(Recorded, name, { value: Demo[name] });
  window.WebSocket = Recorded as unknown as typeof WebSocket;
}

const cellWidth = (text: string): number => [...text].reduce((sum, char) => sum + (/[\u1100-\u115f\uac00-\ud7a3\u3000-\u303f\uff00-\uff60]/u.test(char) ? 2 : 1), 0);
/** `head`, filled with `fill` to the grid's width less the row's END marker, then the marker */
const row = (index: number, head: string, fill = "."): string => {
  const marker = `END${index}`;
  let text = head;
  while (cellWidth(text) + cellWidth(fill) <= COLS - marker.length) text += fill;
  return text + " ".repeat(COLS - marker.length - cellWidth(text)) + marker;
};
const plain = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");
const screenRows: string[] = [];
for (let index = 1; index <= ROWS; index++) {
  if (index === 3) screenRows.push(`\x1b[31mRED-SEGMENT\x1b[0m${row(index, " ").slice("RED-SEGMENT".length)}`);
  else if (index === 5) screenRows.push(row(index, "한글 줄바꿈: 오른쪽 끝까지 보여야 합니다 ", "가"));
  else if (index === ROWS) screenRows.push(row(index, "FOLD-LAST "));
  else screenRows.push(row(index, `R${String(index).padStart(2, "0")} the quick brown fox `));
}
for (const text of screenRows) assert.equal(cellWidth(plain(text)), COLS, `a fixture row is the grid's width: ${plain(text)}`);
// what server/mirror.ts sends for a whole screen: line wrap off while the rows are drawn
const SCREEN = `\x1b[?25l\x1b[0m\x1b[H\x1b[2J\x1b[?7l${screenRows.join("\r\n")}\x1b[0m\x1b[?7h`;

interface Visible { folded: boolean; cut: string[]; hostScrollWidth: number; hostClientWidth: number }
/** Whether every row's END marker is inside the pane's visible width, in whichever view draws it. */
const visibleMarkers = (page: Page): Promise<Visible> => page.evaluate((rows) => {
  const host = document.querySelector<HTMLElement>(".pane-frame.is-current .pane-terminal")!;
  const folded = host.hasAttribute("data-folded");
  const drawn = host.querySelector<HTMLElement>(folded ? ".terminal-fold" : ".xterm-rows")!;
  const box = host.getBoundingClientRect();
  const left = box.left + host.clientLeft;
  const right = left + host.clientWidth;
  const cut: string[] = [];
  // one child per grid row in either view; a marker may span text nodes (xterm draws the cell under
  // its hidden cursor, the last row's end, in a span of its own)
  const rowNodes = [...drawn.children];
  for (let index = 1; index <= rows; index++) {
    const marker = `END${index}`;
    const nodes: Text[] = [];
    const row = rowNodes[index - 1];
    if (row) for (let walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT), node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
    const text = nodes.map((node) => node.data).join("");
    const at = text.lastIndexOf(marker);
    let found: DOMRect | null = null;
    if (at >= 0) {
      const place = (offset: number): [Text, number] => {
        let left = offset;
        for (const node of nodes) {
          if (left <= node.data.length) return [node, left];
          left -= node.data.length;
        }
        return [nodes.at(-1)!, nodes.at(-1)!.data.length];
      };
      const range = document.createRange();
      range.setStart(...place(at));
      range.setEnd(...place(at + marker.length));
      found = range.getBoundingClientRect();
    }
    if (!found || found.left < left - 1 || found.right > right + 1) cut.push(found ? `${marker} at ${Math.round(found.left)}-${Math.round(found.right)} of ${Math.round(left)}-${Math.round(right)}` : `${marker} not drawn`);
  }
  return { folded, cut, hostScrollWidth: host.scrollWidth, hostClientWidth: host.clientWidth };
}, ROWS);

const settled = (page: Page): Promise<void> => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
const foldState = (page: Page, folded: boolean): Promise<unknown> => page.waitForFunction((want) => {
  const host = document.querySelector(".pane-frame.is-current .pane-terminal");
  return host !== null && host.hasAttribute("data-folded") === want && (!want || host.querySelector(".terminal-fold-row") !== null);
}, folded);
const savedWrap = (page: Page): Promise<unknown> => page.evaluate(() => JSON.parse(localStorage.getItem("ovis:settings") ?? "{}").terminalMirrorWrap);
/** Every row's END marker inside the pane's visible width, waited for: the view settles a frame or a resize after it is drawn. */
const rowsWhole = async (page: Page, label: string): Promise<Visible> => {
  let seen = await visibleMarkers(page);
  for (const deadline = Date.now() + 10_000; seen.cut.length > 0 && Date.now() < deadline;) {
    await settled(page);
    seen = await visibleMarkers(page);
  }
  assert.deepEqual(seen.cut, [], `${label}: rows cut off on the right ${JSON.stringify(seen)}`);
  return seen;
};
const choose = async (page: Page, label: string): Promise<void> => {
  await page.locator(".tab-strip-menu").first().click();
  // at phone width the tab's menu is a bottom sheet of buttons (RowMenu)
  const item = page.locator(".row-sheet").getByRole("button", { name: label, exact: true });
  try { await item.waitFor({ timeout: 5_000 }); }
  catch (cause) {
    const menu = await page.evaluate(() => ({
      items: [...document.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"], .row-sheet-item')].map((node) => node.textContent?.trim()),
      buttons: [...document.querySelectorAll<HTMLElement>(".tab-strip-menu")].map((node) => ({ label: node.getAttribute("aria-label"), expanded: node.getAttribute("aria-expanded"), shown: node.offsetParent !== null })),
      open: document.querySelector('[role="menu"], .row-sheet, .menu')?.outerHTML.slice(0, 1200) ?? null,
    }));
    throw new Error(`the pane menu offers no "${label}": ${JSON.stringify(menu)}`, { cause });
  }
  await item.click();
};

const app = mkdtempSync(join(tmpdir(), "herdr-mirror-fold-demo-"));
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () =>
    `<script src="./demo-transport.js"></script>\n<script>(${installFoldFixture.toString()})(${JSON.stringify(SCREEN)}, ${COLS}, ${ROWS})</script>\n<script type="module"`));
  const prefix = "/herdr-web-ui/demo/app/";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith(prefix)) return new Response("not found", { status: 404 });
    let file: string;
    try { file = decodeURIComponent(path.slice(prefix.length)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return await body.exists() ? new Response(body) : new Response("not found", { status: 404 });
  } });
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" });
      try {
        // fixed metrics: the 120-column grid fits a 1440px desktop and no phone
        await context.addInitScript(() => {
          if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "terminal", terminalInputMode: "direct", terminalFontFamily: "JetBrains Mono Web", alertsOn: false }));
        });
        const page = await context.newPage();
        page.setDefaultTimeout(10_000);
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.port}${prefix}?pane=${encodeURIComponent(panes.shell)}&view=terminal`);
        await page.locator(".conn-live").waitFor();
        await appFaces(page);
        await page.waitForFunction(() => document.querySelector(".pane-frame.is-current .xterm-rows")?.textContent?.includes("FOLD-LAST"));

        // a phone: every row whole, folded to the screen's width, and nothing to pan sideways
        let seen = await rowsWhole(page, "390px phone");
        assert.ok(seen.folded, "390px phone: the mirror is drawn folded");
        assert.ok(seen.hostScrollWidth <= seen.hostClientWidth, `390px phone: the folded pane has nothing to pan sideways ${JSON.stringify(seen)}`);
        const fold = await page.evaluate(() => {
          const view = document.querySelector<HTMLElement>(".pane-frame.is-current .terminal-fold")!;
          const host = view.parentElement!;
          const rows = [...view.querySelectorAll<HTMLElement>(".terminal-fold-row")].map((node) => node.textContent ?? "");
          const red = [...view.querySelectorAll<HTMLElement>("span")].find((span) => span.textContent?.includes("RED-SEGMENT"));
          const last = [...view.querySelectorAll<HTMLElement>(".terminal-fold-row")].at(-1)!.getBoundingClientRect();
          const box = host.getBoundingClientRect();
          return { rows, red: red ? getComputedStyle(red).color : null, plain: getComputedStyle(view).color, lastBottom: last.bottom, hostBottom: box.top + host.clientTop + host.clientHeight };
        });
        assert.deepEqual(fold.rows, screenRows.map((text) => plain(text).trimEnd()), "the folded rows hold the grid's rows, each whole and in order");
        assert.ok(fold.red !== null && fold.red !== fold.plain, `a coloured run keeps its colour when folded (${fold.red} against ${fold.plain})`);
        assert.ok(Math.abs(fold.lastBottom - fold.hostBottom) <= 1, `the last row, where a prompt sits, is in view (${fold.lastBottom} against ${fold.hostBottom})`);

        // a smaller Android phone, then the phone on its side: still folded, still whole
        for (const [width, height] of [[360, 800], [844, 390]] as const) {
          const before = await page.evaluate(() => document.querySelector<HTMLElement>(".pane-frame.is-current .pane-terminal")!.clientWidth);
          await page.setViewportSize({ width, height });
          // 844px is past the phone layout: the pane is narrower than the window, and still narrower than the grid
          await page.waitForFunction((was) => {
            const host = document.querySelector<HTMLElement>(".pane-frame.is-current .pane-terminal");
            return host !== null && host.clientWidth !== was && host.hasAttribute("data-folded");
          }, before);
          await rowsWhole(page, `${width}x${height}`);
        }

        // the pane menu's way back, for a full-screen program: the grid at its width, panned sideways
        await page.setViewportSize({ width: 390, height: 844 });
        await foldState(page, true);
        await choose(page, "Original width");
        await foldState(page, false);
        seen = await visibleMarkers(page);
        assert.ok(seen.hostScrollWidth > seen.hostClientWidth, "Original width: the grid is as wide as on the PC, and pans");
        assert.equal(await savedWrap(page), false, "the choice is kept in this device's settings");
        await page.reload();
        await page.locator(".conn-live").waitFor();
        await page.waitForFunction(() => document.querySelector(".pane-frame.is-current .xterm-rows")?.textContent?.includes("FOLD-LAST"));
        await settled(page);
        assert.equal(await page.locator(".pane-frame.is-current .pane-terminal[data-folded]").count(), 0, "a reload keeps the original width");
        await choose(page, "Wrap to screen");
        await foldState(page, true);
        assert.equal(await savedWrap(page), true, "Wrap to screen is kept too");

        // an observer's grid is the pty's own: never folded
        await page.evaluate(() => window.foldFixture.sockets.at(-1)!.send(JSON.stringify({ type: "role", mode: "observe" })));
        await foldState(page, false);
        await page.evaluate(() => window.foldFixture.sockets.at(-1)!.send(JSON.stringify({ type: "role", mode: "interact" })));
        await foldState(page, true);

        // a desktop the grid fits: drawn as it is, as before
        await page.setViewportSize({ width: 1440, height: 900 });
        await foldState(page, false);
        await rowsWhole(page, "1440px desktop, the grid fits");

        assert.deepEqual(errors, []);
        console.log(`PASS mirror fold: ${COLS}x${ROWS} mirror folded whole at 390, 360 and 844 (landscape), Original width pans and survives a reload, observers and a desktop unfolded`);
      } finally { await context.close(); }
    } finally { await browser.close(); }
  } finally { server.stop(); }
} finally { rmSync(app, { recursive: true, force: true }); }
