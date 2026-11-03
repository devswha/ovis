/**
 * A selection in progress never moves what is under it, even when the agent's turn ends under it
 * (#1922, #2650): on the unmodified app over the demo's fixture transport, the demo's opening Claude
 * turn is held until a selection has started in a later reply, then ended (its last words drawn, the
 * Working line gone). With a mouse at 1280 the drag is pressed before the turn ends and finished after
 * it, once from a bare press and once from a drag already partway; at 390 on a touch screen a selection stands (as a long press leaves it) while the turn ends. In
 * every frame between, the reply stays where it was, the drag takes exactly its words, and once the
 * selection is gone a reader who was following is at the end again. All files and HTTP traffic stay in
 * this disposable, loopback-only app; no herdr session is opened.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

const playwrightCore = "playwright-core";
const { chromium } = (await import(playwrightCore)) as typeof import("playwright-core");

const app = mkdtempSync(join(tmpdir(), "herdr-chat-selection-turn-end-"));
const PANE = panes.api;
const WAIT = { timeout: 10_000 } as const;
const ASK = "Plan the offline sync rework first, no code yet.";
const PLAN = "Here is the plan for the sync rework:\n\n1. Add a `revision` column to `notes` and backfill it from `updated_at`.\n2. On reconnect, fetch the server copy and replay the local edit on top of it.\n3. Show a conflict banner when both sides changed the same note.\n\nThe migration touches the `notes` table only. I will start with step 1 once you confirm.";
const WORDS = "backfill it from updated_at";
/** the demo transport ends its opening turn on a timer of this length (site/demo/transport.ts) */
const TURN_END_MS = 4500;

const frames = (page: Page): Promise<void> => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

/** Where `WORDS` lie in the last reply holding them, and a range over them. */
const wordsBox = (page: Page) => page.evaluate((words) => {
  const turn = [...document.querySelectorAll(".chat-turn-agent")].filter((row) => (row.textContent ?? "").includes(words)).at(-1);
  if (!turn) throw new Error(`not in a reply: ${words}`);
  const walker = document.createTreeWalker(turn, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
  const at = nodes.map((node) => node.data).join("").indexOf(words);
  const point = (offset: number): [Text, number] => { let left = offset; for (const node of nodes) { if (left <= node.data.length) return [node, left]; left -= node.data.length; } throw new Error("offset"); };
  const range = document.createRange();
  range.setStart(...point(at));
  range.setEnd(...point(at + words.length));
  (window as unknown as { wordsRange: Range }).wordsRange = range;
  const rects = [...range.getClientRects()].filter((rect) => rect.width > 0);
  return { x0: rects[0]!.left + 1, y0: rects[0]!.top + rects[0]!.height / 2, x1: rects.at(-1)!.right - 1, y1: rects.at(-1)!.top + rects.at(-1)!.height / 2 };
}, WORDS);

/** Records the reply's top in every frame from now until `stopWatch`. */
const watch = (page: Page) => page.evaluate((words) => {
  const lab = window as unknown as { watched: number[]; watching: boolean };
  lab.watched = []; lab.watching = true;
  const step = () => {
    if (!lab.watching) return;
    const turn = [...document.querySelectorAll(".chat-turn-agent")].filter((row) => (row.textContent ?? "").includes(words)).at(-1);
    if (turn) lab.watched.push(Math.round(turn.getBoundingClientRect().top * 10) / 10);
    requestAnimationFrame(step);
  };
  step();
}, WORDS);
const stopWatch = (page: Page) => page.evaluate(() => { const lab = window as unknown as { watched: number[]; watching: boolean }; lab.watching = false; return lab.watched; });

/** The held turn ends now, and resolves once its last words are drawn and the Working line is gone. */
async function endTurn(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { endTurn: () => void }).endTurn());
  await page.locator(".chat-turn-agent", { hasText: "6 tests pass." }).waitFor({ state: "attached", ...WAIT });
  await page.locator(".chat-virtual-footer", { hasText: "Working" }).waitFor({ state: "detached", ...WAIT });
  await frames(page);
}

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  // Before the demo's transport runs: its turn-end timer is held until the test calls endTurn(), and
  // the pane's transcript ends in a plan, a reply below the turn that ends, to select in.
  const gates = `<script>(() => {
    const wait = window.setTimeout;
    let held = null;
    window.setTimeout = (fn, ms, ...rest) => {
      if (ms === ${TURN_END_MS} && held === null) { held = () => fn(...rest); return 0; }
      return wait(fn, ms, ...rest);
    };
    window.endTurn = () => { const end = held; held = () => {}; if (end) end(); };
  })();</script>`;
  const plan = `<script>(() => {
    const demo = window.fetch;
    window.fetch = (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
      if (url.pathname !== "/api/pane/conversation" || url.searchParams.get("pane_id") !== ${JSON.stringify(PANE)}) return demo(input, init);
      return Promise.resolve(demo(input, init)).then(async (response) => {
        if (!response.ok) return response;
        const body = await response.json();
        if (Array.isArray(body.turns)) body.turns = [...body.turns,
          { role: "user", ts: "2026-10-29T00:00:00.000Z", parts: [{ kind: "text", text: ${JSON.stringify(ASK)} }] },
          { role: "assistant", ts: "2026-10-29T00:00:01.000Z", end_ts: "2026-10-29T00:00:20.000Z", parts: [{ kind: "text", phase: "final_answer", text: ${JSON.stringify(PLAN)} }] }];
        return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
      });
    };
  })();</script>`;
  writeFileSync(index, html.replace(/<script type="module"/, () => `${gates}\n    <script src="./demo-transport.js"></script>\n    ${plan}\n    <script type="module"`));

  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/herdr-web-ui/demo/app/")) return new Response("not found", { status: 404 });
    let file: string;
    try { file = decodeURIComponent(path.slice("/herdr-web-ui/demo/app/".length)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return (await body.exists()) ? new Response(body) : new Response("not found", { status: 404 });
  } });
  const url = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(PANE)}`;
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      const shapes = [
        // pressed, nothing selected yet, while the turn ends: the press alone holds the chat
        { name: "desktop-1280-press", width: 1280, height: 800, mobile: false, partway: false },
        { name: "desktop-1280-drag", width: 1280, height: 800, mobile: false, partway: true },
        { name: "phone-390", width: 390, height: 844, mobile: true, partway: false },
      ] as const;
      for (const shape of shapes) {
        const label = shape.name;
        const context = await browser.newContext({ viewport: { width: shape.width, height: shape.height }, locale: "en-US", hasTouch: shape.mobile, isMobile: shape.mobile });
        try {
          await context.addInitScript((id) => {
            localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "dark", palette: "codex" }));
            localStorage.setItem(`ovis:view:${id}`, "chat");
          }, PANE);
          const page = await context.newPage();
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          page.setDefaultTimeout(WAIT.timeout);
          await page.goto(url);
          await page.getByText("Show a conflict banner", { exact: false }).waitFor(WAIT);
          await page.locator(".chat-virtual-footer", { hasText: "Working" }).waitFor(WAIT);
          await frames(page);
          const box = await wordsBox(page);
          const room = await page.evaluate(() => document.querySelector<HTMLElement>(".chat-transcript-virtual")!.style.minHeight);

          await watch(page);
          if (!shape.mobile) {
            // pressed (and, for a drag, moved partway) before the turn ends, finished after it
            await page.mouse.move(box.x0, box.y0);
            await page.mouse.down();
            if (shape.partway) await page.mouse.move((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2, { steps: 8 });
            await endTurn(page);
            await page.mouse.move(box.x1, box.y1, { steps: 8 });
            await page.mouse.up();
          } else {
            // the range a long press and its handles leave, standing while the turn ends
            await page.evaluate(() => { const selection = getSelection()!; selection.removeAllRanges(); selection.addRange((window as unknown as { wordsRange: Range }).wordsRange); });
            await frames(page);
            await endTurn(page);
          }
          await frames(page);
          const tops = await stopWatch(page);
          assert.ok(tops.length > 2, `${label}: the reply was watched across the selection`);
          assert.deepEqual([Math.min(...tops), Math.max(...tops)], [tops[0], tops[0]], `${label}: the reply stays put while it is selected, every frame (tops ${tops.join(", ")})`);
          assert.equal(await page.evaluate(() => getSelection()?.toString() ?? ""), WORDS, `${label}: the selection holds exactly the words selected`);

          // once the selection is gone, the reader still following is at the end, with no room kept past it
          await page.evaluate(() => getSelection()?.removeAllRanges());
          await frames(page);
          const end = await page.evaluate(() => {
            const node = document.querySelector<HTMLElement>(".chat-view-virtual")!;
            return { gap: Math.round(node.scrollHeight - node.clientHeight - node.scrollTop), room: document.querySelector<HTMLElement>(".chat-transcript-virtual")!.style.minHeight };
          });
          assert.deepEqual(end, { gap: 0, room }, `${label}: back at the end once the selection is gone, with the list's own min-height`);
          assert.deepEqual(errors, [], `${label}: no page errors`);
          console.log(`PASS ${label}`);
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }
  } finally {
    server.stop(true);
  }
} finally {
  rmSync(app, { recursive: true, force: true });
}
