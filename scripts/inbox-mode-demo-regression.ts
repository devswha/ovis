import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { appFaces } from "./app-faces.ts";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import type { Machine } from "../shared/machines.ts";
import type { AgentStatus } from "../shared/protocol.ts";
import { SHEET_HISTORY_KEY } from "../src/lib/historyKeys.ts";

declare global {
  interface Window {
    inboxFixture: {
      /** rosters the app has been handed since the page loaded */
      rosters: number;
      /** hands the app the roster again, as the server's next push would */
      publish(): Promise<void>;
      /** sets a pane's state as herdr would: its pane-status event, then the roster */
      set(paneId: string, status: AgentStatus, finish?: number): Promise<void>;
      /** every size the app has asked of a pane's pty since the page loaded, in order */
      resizes: { pane: string; cols: number; rows: number }[];
    };
  }
}

// Holds the demo's agents still, whatever its own timers do: Codex waits for an answer, Claude works
// (the demo would finish it 4.5s in), the flaky-test agent is done and not looked at, the rest are idle.
// Loaded after demo-transport.js and before the app; what it forces survives a reload.
function installInboxFixture(): void {
  const key = "inbox-mode-regression:forced";
  const stored = sessionStorage.getItem(key);
  const state: { epoch: string; forced: Record<string, { status: AgentStatus; finish: number }> } = stored ? JSON.parse(stored) : {
    epoch: `inbox-fixture-${Date.now()}`,
    forced: {
      "w1D:p1": { status: "blocked", finish: 0 },
      "w1C:p1": { status: "working", finish: 0 },
      "w1H:p1": { status: "done", finish: 1 },
      "w1J:p1": { status: "idle", finish: 0 },
      "w1K:p1": { status: "idle", finish: 0 },
      "w1L:p1": { status: "idle", finish: 0 },
    },
  };
  const save = (): void => sessionStorage.setItem(key, JSON.stringify(state));
  save();
  const patch = (machines: Machine[]): Machine[] => {
    for (const machine of machines) {
      const snapshot = machine.snapshot;
      if (!snapshot) continue;
      snapshot.finish_epoch = `${state.epoch}:${machine.id}`;
      for (const pane of snapshot.panes) {
        const forced = state.forced[pane.pane_id];
        if (forced) { pane.agent_status = forced.status; pane.finish_id = forced.finish; }
      }
      for (const agent of snapshot.agents) {
        const forced = state.forced[agent.pane_id];
        if (forced) agent.agent_status = forced.status;
      }
    }
    return machines;
  };
  const sources = new Set<EventSource>();
  const fetchDemo = window.fetch;
  window.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    const response = await fetchDemo(input, init);
    if (url.pathname !== "/api/machines" || !response.ok) return response;
    const body = await response.json();
    return Response.json({ ...body, machines: patch(body.machines) });
  }, fetchDemo);
  const DemoSource = window.EventSource;
  window.EventSource = class extends DemoSource {
    constructor(url: string | URL, init?: EventSourceInit) {
      super(url, init);
      sources.add(this);
      let receive: EventSource["onmessage"] = null;
      Object.defineProperty(this, "onmessage", {
        get: () => (event: MessageEvent<string>) => {
          const body = JSON.parse(event.data);
          if (body.type === "machines") { body.machines = patch(body.machines); window.inboxFixture.rosters++; }
          if (body.type === "machine-message" && body.message.type === "pane-status") {
            body.message.finish_epoch = `${state.epoch}:${body.machine_id}`;
            const forced = state.forced[body.message.pane_id];
            if (forced) { body.message.agent_status = forced.status; body.message.finish_id = forced.finish; }
          }
          receive?.call(this, new MessageEvent("message", { data: JSON.stringify(body) }));
        },
        set: (handler: EventSource["onmessage"]) => { receive = handler; },
      });
    }
    close(): void { sources.delete(this); super.close(); }
  };
  const send = (body: unknown): void => {
    for (const source of sources) source.onmessage?.(new MessageEvent("message", { data: JSON.stringify(body) }));
  };
  // the demo's socket is a class of its own that no browser event reports: each size the app asks of a pty is noted
  const DemoSocket = window.WebSocket;
  const Recorded = function (url: string | URL, protocols?: string | string[]) {
    const socket = new DemoSocket(url, protocols);
    const sendFrame = socket.send.bind(socket);
    socket.send = (data: Parameters<WebSocket["send"]>[0]): void => {
      if (typeof data === "string") {
        const frame = JSON.parse(data);
        if (frame.type === "resize") window.inboxFixture.resizes.push({ pane: frame.pane_id, cols: frame.cols, rows: frame.rows });
      }
      sendFrame(data);
    };
    return socket;
  } as unknown as typeof WebSocket;
  for (const name of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"] as const) Object.defineProperty(Recorded, name, { value: DemoSocket[name] });
  window.WebSocket = Recorded;
  window.inboxFixture = {
    rosters: 0,
    resizes: [],
    async publish() {
      const { machines } = await (await fetch("/api/machines")).json();
      send({ type: "machines", machines });
    },
    async set(paneId, status, finish = 0) {
      state.forced[paneId] = { status, finish };
      save();
      send({ type: "machine-message", machine_id: "local", message: { type: "pane-status", pane_id: paneId, agent_status: status, finish_id: finish, finish_epoch: `${state.epoch}:local` } });
      await this.publish();
    },
  };
}

// The agent inbox as a mode of the app, on the unmodified app over the demo's fixture transport: the two entries and
// the exit, the list as a phone's screen (its rows, state marks, filter and search), a thread with the terminal behind
// its monitor button, the history (Back, Forward, reloads, a cold address), New workspace, a watching device, the
// device setting that starts a phone in the mode, the two panes of a wide window with the boxes classic has, and a
// pane that shows its terminal while the mode is entered and left: its pty is sent no size and its box stays. All
// files and HTTP traffic stay in this disposable, loopback-only app; no herdr session is opened.
const BLOCKED = "w1D:p1";      // Codex, waiting: "Allow command?"
const WORKING = "w1C:p1";      // Claude
const DONE = "w1H:p1";         // the flaky-test agent, finished and not looked at
const IDLE = ["w1J:p1", "w1K:p1", "w1L:p1"];
const BLOCKED_TITLE = "Guard the export button";
const WORKING_TITLE = "Idempotent payments";
/** what the mode's shell never draws */
const ABSENT = [".inbox-filters", ".inbox-chip", ".inbox-place", ".inbox-title", ".inbox-dot", ".tab-strip", ".context-tabs", ".view-switch", ".status-bar", "#drawer-toggle", "#workspace-drawer", ".sidebar-toggle", ".pane-split.is-split"];
const PHONE = { width: 390, height: 844 };
/** how long nothing may be sent to a pty: past the terminal's own wait for its box to settle before it fits */
const NO_RESIZE_WAIT_MS = 1_000;

const app = mkdtempSync(join(tmpdir(), "ovis-inbox-mode-"));
const evidence = process.env["UI_EVIDENCE_DIR"];
const errors: string[] = [];
/** the blocks that failed: each is reported where it fails, and the blocks after it still run */
const failures: string[] = [];

type Settings = Record<string, unknown>;
interface Box { x: number; y: number; w: number; h: number; right: number; bottom: number }
interface Row { pane: string | null; machine: string | null; state: string | null; name: string; words: string | null; mark: string | null; markLabel: string | null; asking: boolean; time: string | null; datetime: string | null; buttons: number; current: string | null }
/** what the address says of the mode: null for a parameter it does not hold */
interface Address { app: string | null; pane: string | null; machine: string | null }

const rows = (page: Page): Promise<Row[]> => page.locator(".mode-inbox .inbox-item").evaluateAll((items) => items.map((item) => {
  const mark = item.querySelector(".inbox-state.is-drawn .sidebar-status");
  return {
    pane: item.getAttribute("data-pane"), machine: item.getAttribute("data-machine"), state: item.getAttribute("data-state"),
    name: item.querySelector(".inbox-name")?.textContent ?? "", words: item.querySelector(".inbox-words")?.textContent ?? null,
    mark: mark?.getAttribute("data-status") ?? null, markLabel: mark?.getAttribute("aria-label") ?? null, asking: item.classList.contains("is-asking"),
    time: item.querySelector("time.inbox-time")?.textContent ?? null, datetime: item.querySelector("time.inbox-time")?.getAttribute("datetime") ?? null,
    buttons: item.querySelectorAll("button").length, current: item.querySelector(".inbox-row")?.getAttribute("aria-current") ?? null,
  };
}));
const box = (page: Page, selector: string): Promise<Box> => page.locator(selector).first().evaluate((node) => {
  const r = node.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
});
/** the done row's last words and its time, read from the demo's own chat after the list is drawn */
const summaryShown = (page: Page) => page.waitForFunction((pane) => {
  const item = document.querySelector(`.mode-inbox .inbox-item[data-pane="${pane}"]`);
  return Boolean(item?.querySelector(".inbox-words")?.textContent?.trim()) && item?.querySelector("time.inbox-time") !== null;
}, DONE, { timeout: 15_000 });
const rowCount = (page: Page, count: number) => page.waitForFunction((n) => document.querySelectorAll(".mode-inbox .inbox-item").length === n, count, { timeout: 30_000 });
const questionShown = (page: Page) => page.waitForFunction((pane) =>
  /Allow command\?/.test(document.querySelector(`.mode-inbox .inbox-item[data-machine="local"][data-pane="${pane}"] .inbox-words`)?.textContent ?? ""), BLOCKED, { timeout: 15_000 });
const address = (page: Page): Promise<Address> => page.evaluate(() => {
  const query = new URL(location.href).searchParams;
  return { app: query.get("app"), pane: query.get("pane"), machine: query.get("machine") };
});
/** The address says `want`, for each parameter given. The app writes its address after it has drawn, so this waits for it. */
async function addressIs(page: Page, want: Partial<Address>, what: string): Promise<void> {
  const said = await page.waitForFunction((fields) => {
    const query = new URL(location.href).searchParams;
    return Object.entries(fields).every(([name, value]) => query.get(name) === value);
  }, want, { timeout: 5_000 }).then(() => true, () => false);
  if (!said) assert.fail(`${what}: the address says ${JSON.stringify(await address(page))}, wanted ${JSON.stringify(want)}`);
}
const historyLength = (page: Page): Promise<number> => page.evaluate(() => history.length);
const frames = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
const row = (page: Page, pane: string, machine = "local") => page.locator(`.mode-inbox .inbox-item[data-machine="${machine}"][data-pane="${pane}"] .inbox-row`);
const near = (got: number, want: number, by: number, what: string): void => assert.ok(Math.abs(got - want) <= by, `${what}: ${got}, wanted ${want} within ${by}`);
/** the same box, to half a pixel on each side */
const sameBox = (got: Box, want: Box, what: string): void => {
  for (const side of ["x", "y", "w", "h"] as const) near(got[side], want[side], 0.5, `${what} (${side})`);
};
/** the list as a phone's screen: no header over it, and the mode's mark in the address */
async function listScreen(page: Page): Promise<void> {
  await page.locator(".mode-inbox").waitFor();
  await page.locator(".app-header").waitFor({ state: "detached" });
  await addressIs(page, { app: "inbox", pane: null }, "the list's address says the mode and names no pane");
}
/** opens a row's thread on a phone: the list leaves, and the header has Back and the thread's title */
async function openThread(page: Page, pane: string, machine = "local"): Promise<void> {
  await row(page, pane, machine).tap();
  await page.locator(".mode-inbox").waitFor({ state: "detached" });
  await page.locator("#inbox-back").waitFor();
  await page.locator(".thread-title").waitFor();
  await addressIs(page, { app: "inbox", pane }, "a thread's address names its pane and keeps the mode");
}
async function backToList(page: Page): Promise<void> {
  await page.locator("#inbox-back").tap();
  await page.locator(".mode-inbox").waitFor();
}
/** a phone's sheet, from the header's More, the list's own or the filter's button */
async function openSheet(page: Page, button: string): Promise<void> {
  await page.locator(button).tap();
  await page.locator(".row-sheet").waitFor();
}
/**
 * A sheet that closed is gone from the page and from the history: one closed by an item that went nowhere, or by
 * Cancel, steps back off its own entry a moment later (lib/sheetHistory.ts). A press that pushed an entry before
 * that step landed would put it after the sheet's, and the step would land back on the sheet's. The next press
 * comes after the step.
 */
async function sheetClosed(page: Page): Promise<void> {
  await page.locator(".row-sheet").waitFor({ state: "detached" });
  await page.waitForFunction((key) => (history.state as Record<string, unknown> | null)?.[key] === undefined, SHEET_HISTORY_KEY, { timeout: 5_000 });
}
/** picks one of the state filter's four choices from its sheet */
async function pickFilter(page: Page, choice: "all" | "blocked" | "working" | "done"): Promise<void> {
  await openSheet(page, ".inbox-filter-toggle");
  await page.locator(`.row-sheet [data-item="${choice}"]`).tap();
  await sheetClosed(page);
}
/** enters the mode as a user does on a phone: More, then Open agent inbox */
async function enterFromMore(page: Page): Promise<void> {
  await openSheet(page, ".header-more-button");
  await page.locator('.row-sheet [data-item="enter-inbox"]').tap();
  await sheetClosed(page);
  await listScreen(page);
}
/** the visible terminal mount's box, once the terminal lens shows */
async function terminalBox(page: Page): Promise<Box> {
  await page.waitForFunction(() => {
    const mount = document.querySelector(".terminal-stack:not(.is-chat) .pane-terminal .xterm-screen");
    return mount !== null && mount.getBoundingClientRect().width > 0;
  }, undefined, { timeout: 15_000 });
  await frames(page);
  return box(page, ".terminal-stack:not(.is-chat) .pane-terminal");
}
/** every pane mounted under the list is hidden, and at least one is mounted */
async function paneHiddenUnderList(page: Page, what: string): Promise<void> {
  const slots = await page.evaluate(() => [...document.querySelectorAll(".pane-slot")].map((node) => getComputedStyle(node).visibility));
  assert.ok(slots.length >= 1 && slots.every((visibility) => visibility === "hidden"), `${what}: ${slots.join()}`);
}
async function shot(page: Page, name: string): Promise<void> {
  if (!evidence) return;
  await appFaces(page);
  await page.screenshot({ path: join(evidence, name), animations: "disabled" });
}

/**
 * One block of the script in one tab of a fresh browser profile: the settings are seeded once, so a reload keeps what
 * the app stored since. Where a phone starts is this device's own choice, a JSON boolean of its own beside the
 * settings record: `phoneInbox` in a seed is stored there, and a seed without it leaves the device starting in the
 * classic app. A block that fails says where and is counted; the blocks after it still run.
 */
async function withPage(browser: Browser, base: string, settings: Settings, path: string, what: string, run: (page: Page) => Promise<void>, viewport: { width: number; height: number } = PHONE): Promise<void> {
  const wide = viewport.width >= 769;
  const context = await browser.newContext({ viewport, isMobile: !wide, hasTouch: !wide, locale: "en-US" });
  try {
    await context.addInitScript((seed) => {
      // the blank page the tab began on, which Back out of the app returns to, has no storage to seed
      if (location.protocol === "about:") return;
      if (sessionStorage.getItem("inbox-mode-regression:seeded")) return;
      sessionStorage.setItem("inbox-mode-regression:seeded", "1");
      const { phoneInbox, ...settings } = seed;
      localStorage.setItem("ovis:settings", JSON.stringify(settings));
      if (phoneInbox === true) localStorage.setItem("ovis:phone-inbox", JSON.stringify(true));
    }, settings);
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(`${what}: ${error.message}`));
    try {
      await page.goto(base + path);
      await run(page);
    } catch (error) {
      failures.push(what);
      console.log(`FAIL ${what}: ${error instanceof Error ? error.message : String(error)}`);
      if (evidence) await page.screenshot({ path: join(evidence, `inbox-mode-failure-${failures.length}.png`) }).catch(() => undefined);
    }
  } finally {
    await context.close();
  }
}

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(join(app, "inbox-fixture.js"), `(${installInboxFixture.toString()})();`);
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, '<script src="./demo-transport.js"></script>\n    <script src="./inbox-fixture.js"></script>\n    <script type="module"'));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    let file: string;
    try { file = decodeURIComponent(new URL(request.url).pathname.slice(1)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return await body.exists() ? new Response(body) : new Response("not found", { status: 404 });
  } });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      if (evidence) mkdirSync(evidence, { recursive: true });
      for (const theme of ["light", "dark"]) {
        const off: Settings = { language: "en", theme };
        const on: Settings = { language: "en", theme, phoneInbox: true };
        const pass = (step: number, what: string) => console.log(`PASS ${theme} (${step}) ${what}`);
        const block = (what: string): string => `${theme}: ${what}`;

        // ---- a phone: the entry, the list, a thread ----
        await withPage(browser, base, off, "/", block("the entry in More, the list, a thread, the way out"), async (page) => {
          await page.locator(".pane-slot").first().waitFor();
          await page.locator("#drawer-toggle").waitFor();
          assert.equal(await page.locator(".mode-inbox").count(), 0, "a fresh device opens the classic app");
          await page.waitForFunction(() => new URL(location.href).searchParams.get("pane") !== null);
          await addressIs(page, { app: null }, "the classic app's address has no mode");
          const entries = await historyLength(page);
          await openSheet(page, ".header-more-button");
          const last = page.locator(".row-sheet .row-sheet-item").last();
          assert.equal(await last.getAttribute("data-item"), "enter-inbox", "More's last item is the way in");
          assert.equal((await last.locator(".row-sheet-label").textContent())?.trim(), "Open agent inbox");
          await shot(page, `inbox-mode-entry-390-${theme}.png`);
          await last.tap();
          await sheetClosed(page);
          await listScreen(page);
          assert.equal(await historyLength(page), entries + 1, "entering is one entry: the sheet's own was taken over");
          await paneHiddenUnderList(page, "the pane stays mounted under the list, hidden");
          pass(1, "More's last item, Open agent inbox, opens the list as the screen by one history entry, the pane mounted and hidden under it");

          await rowCount(page, 6);
          await questionShown(page);
          await summaryShown(page);
          await appFaces(page);
          for (const selector of ABSENT) assert.equal(await page.locator(selector).count(), 0, `the mode draws no ${selector}`);
          assert.equal(await page.locator(".mode-inbox :is(h1, h2, h3, h4, h5, h6, [role='heading'])").count(), 0, "the list has no heading");
          assert.equal(await page.locator(".mode-inbox").getAttribute("aria-label"), "Agent inbox");
          assert.equal(await page.locator(".mode-inbox .inbox-top button").count(), 2, "exactly two controls at the top");
          const { width, height } = page.viewportSize()!;
          const [more, add, filter, search] = await Promise.all([box(page, ".inbox-more"), box(page, ".inbox-add"), box(page, ".inbox-filter-toggle"), box(page, ".inbox-search-input")]);
          for (const [name, control] of [["More", more], ["New workspace", add], ["the filter", filter]] as const) assert.deepEqual([control.w, control.h], [44, 44], `${name} is 44 by 44`);
          near(more.x, 18, 2, "More's inset"); near(width - add.right, 18, 2, "New workspace's inset");
          near(filter.x, 18, 2, "the filter's inset"); near(width - search.right, 18, 2, "the search field's inset");
          assert.equal(search.h, 44, "the search field is 44 tall");
          near(search.x - filter.right, 12, 2, "between the filter and the search field");
          near(height - filter.bottom, 12, 2, "under the foot");
          near(search.w, width - 92, 2, "the search field's width");
          const boxes = await page.locator(".mode-inbox .inbox-item").evaluateAll((items) => items.map((item) => {
            const r = item.querySelector(".inbox-row")!.getBoundingClientRect();
            const a = item.querySelector(".inbox-avatar")!.getBoundingClientRect();
            const b = item.querySelector(".inbox-body")!.getBoundingClientRect();
            const words = item.querySelector(".inbox-words")!;
            return { top: r.top, height: r.height, avatar: [a.left, a.width, a.height], text: b.left - a.right, wordsHeight: words.getBoundingClientRect().height, wordsSize: getComputedStyle(words).fontSize, nameSize: getComputedStyle(item.querySelector(".inbox-name")!).fontSize };
          }));
          near(boxes[0]!.top - more.bottom, 16, 4, "the first row under the top controls");
          for (const item of boxes) {
            near(item.height, 80, 2, "a row's height");
            assert.deepEqual(item.avatar, [22, 44, 44], "the mark is 44px, 22px in");
            near(item.text, 16, 2, "from the mark to the text");
            assert.deepEqual([item.nameSize, item.wordsSize], ["16px", "15px"]);
            assert.ok(item.wordsHeight < 30, `the words are one line: ${item.wordsHeight}px`);
          }
          const drawn = await rows(page);
          assert.deepEqual(drawn.map((item) => item.pane), [BLOCKED, WORKING, DONE, ...drawn.slice(3).map((item) => item.pane)]);
          assert.deepEqual(new Set(drawn.slice(3).map((item) => item.pane)), new Set(IDLE));
          assert.deepEqual(drawn.map((item) => item.mark), ["blocked", "working", "done", null, null, null], "each state its own mark, none for a ready agent");
          assert.deepEqual(drawn.slice(0, 3).map((item) => item.markLabel), ["Agent INPUT", "Agent RUN", "Agent DONE"]);
          assert.deepEqual(drawn.map((item) => item.asking), [true, false, true, false, false, false], "the rows that ask for a look draw their words stronger");
          assert.deepEqual(drawn.map((item) => item.buttons), [1, 1, 1, 1, 1, 1], "a row is one button and holds no other");
          assert.match(drawn[0]!.words ?? "", /Allow command\?/);
          assert.ok((drawn[2]!.words ?? "").trim() !== "", "the done row says what its agent last said");
          assert.match(drawn[2]!.time ?? "", /^(<1m|\d+[mhd])$/, "the done row says how long it has been done");
          assert.ok(drawn[2]!.datetime !== null && !Number.isNaN(Date.parse(drawn[2]!.datetime)), "the done row's time carries a datetime");
          await shot(page, `inbox-mode-list-390-${theme}.png`);
          pass(2, "the list: no title and nothing the mode leaves out, two 44px round controls at the top and a round filter and a search pill at the foot on their insets, six 80px rows with a 44px mark, a 16px name and one 15px line, the waiting row first with its question, each state's own mark and none on the ready rows");

          await openSheet(page, ".inbox-filter-toggle");
          assert.equal(await page.locator('.row-sheet [role="radiogroup"] [role="radio"]').count(), 4, "the four filters are one radio group");
          assert.equal(await page.locator('.row-sheet [role="radio"][aria-checked="true"]').getAttribute("data-item"), "all");
          await page.locator('.row-sheet [data-item="working"]').tap();
          await sheetClosed(page);
          await rowCount(page, 1);
          assert.equal((await rows(page))[0]!.pane, WORKING);
          assert.equal(await page.locator(".inbox-filter-toggle.is-on").getAttribute("aria-label"), "Filter by state: Working");
          await openSheet(page, ".inbox-filter-toggle");
          assert.equal(await page.locator('.row-sheet [role="radio"][aria-checked="true"]').getAttribute("data-item"), "working");
          await page.locator('.row-sheet [data-item="all"]').tap();
          await sheetClosed(page);
          await rowCount(page, 6);
          assert.equal(await page.locator(".inbox-filter-toggle").getAttribute("aria-label"), "Filter by state");
          pass(3, "the filter's button opens All, Needs you, Working and Done as a radio group; Working narrows the list to its row and fills the button, All draws the six again");

          const field = page.locator(".inbox-search-input");
          await field.fill("export");
          await rowCount(page, 1);
          assert.equal(await page.locator(".mode-inbox .inbox-item .inbox-name").textContent(), BLOCKED_TITLE);
          await page.locator(".inbox-search-clear").tap();
          await rowCount(page, 6);
          assert.equal(await field.inputValue(), "");
          await field.fill("zzqq no such agent");
          await page.locator(".inbox-empty").waitFor();
          assert.equal(await page.locator(".inbox-empty").textContent(), "No agents match");
          await page.locator(".inbox-search-clear").tap();
          await rowCount(page, 6);
          pass(4, "search: export leaves one row, clearing it draws six, a query with no match says No agents match");

          await pickFilter(page, "blocked");
          await rowCount(page, 1);
          await openThread(page, BLOCKED);
          await page.locator(".prompt-card").first().waitFor();
          assert.equal((await page.locator(".thread-name").textContent())?.replace(/^Codex: /, ""), BLOCKED_TITLE);
          assert.equal(await page.locator(".thread-state").textContent(), "Needs you");
          for (const selector of ABSENT) assert.equal(await page.locator(selector).count(), 0, `a thread draws no ${selector}`);
          const dock = await page.evaluate(() => {
            const card = document.querySelector(".prompt-dock .prompt-card")!.getBoundingClientRect();
            const composer = document.querySelector(".composer-surface")!.getBoundingClientRect();
            return { above: card.bottom <= composer.top + 1, left: card.left - composer.left, right: card.right - composer.right };
          });
          assert.ok(dock.above && Math.abs(dock.left) <= 1 && Math.abs(dock.right) <= 1, `the prompt card is docked above the composer on its column: ${JSON.stringify(dock)}`);
          // the header's three controls are one family: a finger's size each, and none in a box of its own
          for (const selector of ["#inbox-back", ".lens-toggle", ".header-more-button"]) {
            const control = await box(page, selector);
            assert.ok(control.w >= 44 && control.h >= 44, `${selector} is a finger's size: ${control.w} by ${control.h}`);
            assert.equal(await page.locator(selector).evaluate((node) => node.classList.contains("is-outlined")), false, `${selector} has no box of its own`);
          }
          // the one agent that waits is this thread's, its question on the screen: More counts none
          assert.equal(await page.locator(".header-more-dot.is-waiting").count(), 0, "More counts no waiting agent but the others");
          assert.doesNotMatch(await page.locator(".header-more-button").getAttribute("aria-label") ?? "", /waiting for you/);
          await shot(page, `inbox-mode-thread-390-${theme}.png`);
          pass(5, "a tap on the waiting row opens its chat under Back, the agent's name over Needs you, the monitor button and More as one family of plain buttons, the prompt card docked above the composer, and no count on More for the thread's own question");

          const lens = page.locator(".lens-toggle");
          assert.equal(await lens.getAttribute("aria-label"), "Show the terminal");
          await lens.tap();
          await page.locator('.lens-toggle[data-view="terminal"]').waitFor();
          assert.equal(await lens.getAttribute("aria-label"), "Show the chat");
          const inMode = await terminalBox(page);
          await shot(page, `inbox-mode-terminal-390-${theme}.png`);
          await lens.tap();
          await page.locator('.lens-toggle[data-view="chat"]').waitFor();
          await page.locator(".prompt-card").first().waitFor();

          await backToList(page);
          assert.equal(await page.locator(".inbox-filter-toggle.is-on").getAttribute("aria-label"), "Filter by state: Needs you");
          await rowCount(page, 1);
          await paneHiddenUnderList(page, "the opened pane stays mounted under the list, hidden");
          // six rows barely scroll on an 844px phone: the scroll is kept on a shorter one, where it has room to
          await pickFilter(page, "all");
          await rowCount(page, 6);
          await page.setViewportSize({ width: 390, height: 560 });
          const scroller = page.locator(".inbox-scroll");
          await scroller.evaluate((node) => { node.scrollTop = node.scrollHeight; });
          await page.waitForFunction(() => (document.querySelector(".inbox-scroll")?.scrollTop ?? 0) > 0);
          const top = await scroller.evaluate((node) => node.scrollTop);
          const end = await page.evaluate(() => ({ row: [...document.querySelectorAll(".mode-inbox .inbox-item")].at(-1)!.getBoundingClientRect().bottom, foot: document.querySelector(".inbox-filter-toggle")!.getBoundingClientRect().top }));
          assert.ok(end.row <= end.foot, `at the list's end the last row ends above the foot's controls: row ${end.row}, foot ${end.foot}`);
          const lastPane = await page.locator(".mode-inbox .inbox-item").last().getAttribute("data-pane");
          assert.ok(lastPane !== null);
          await openThread(page, lastPane);
          await backToList(page);
          await questionShown(page);
          const kept = await page.waitForFunction((at) => Math.abs((document.querySelector(".inbox-scroll")?.scrollTop ?? -9) - at) <= 1, top, { timeout: 5_000 }).then(() => true, () => false);
          const now = await scroller.evaluate((node) => ({ top: node.scrollTop, range: node.scrollHeight - node.clientHeight }));
          assert.ok(kept, `the list scrolled to its end (${Math.round(top)}px) came back at ${Math.round(now.top)}px of ${Math.round(now.range)}px`);
          pass(6, `the monitor button shows the terminal in the thread's place and gives the chat back; Back returns to the list with its filter and its scroll (${Math.round(top)}px) kept, the pane mounted and hidden, the last row clear of the foot`);

          await page.setViewportSize(PHONE);
          await openSheet(page, ".inbox-more");
          assert.deepEqual(await page.locator(".row-sheet .row-sheet-item").evaluateAll((items) => items.map((item) => item.getAttribute("data-item"))), ["exit-inbox", "palette", "alerts", "settings"], "the list's More begins with the way out and the palette, and holds the app's items");
          assert.equal((await page.locator('.row-sheet [data-item="exit-inbox"] .row-sheet-label').textContent())?.trim(), "Back to Ovis");
          await shot(page, `inbox-mode-more-390-${theme}.png`);
          const inModeEntries = await historyLength(page);
          await page.locator('.row-sheet [data-item="exit-inbox"]').tap();
          await page.locator(".mode-inbox").waitFor({ state: "detached" });
          await page.locator("#drawer-toggle").waitFor();
          await sheetClosed(page);
          await addressIs(page, { app: null, pane: lastPane }, "Back to Ovis from the list leaves the mode's address and opens the pane under the list");
          assert.equal(await historyLength(page), inModeEntries, "leaving is one entry: the sheet's own was taken over");
          await page.goBack();
          await listScreen(page);
          await page.goForward();
          await page.locator("#drawer-toggle").waitFor();
          await addressIs(page, { app: null, pane: lastPane }, "Forward returns to the classic app on that pane");
          // the terminal is the size it has in the classic app: entering the mode refits nothing
          await page.goto(`${base}/?pane=${encodeURIComponent(BLOCKED)}&view=terminal`);
          const classic = await terminalBox(page);
          near(inMode.w, classic.w, 1, "the terminal's width in the mode against classic's");
          near(inMode.h, classic.h, 1, "the terminal's height in the mode against classic's");
          pass(7, `Back to Ovis, first in the list's More, opens the classic app on the pane under the list by one entry that Back undoes; a thread's terminal is the size classic's is (${Math.round(classic.w)} by ${Math.round(classic.h)})`);
        });

        // ---- a phone: the history ----
        await withPage(browser, base, off, "/?app=inbox", block("Back, Forward and reloads from the list's own address"), async (page) => {
          await listScreen(page);
          assert.equal(await page.locator(".pane-slot").count(), 0, "nothing is mounted for a pane under a cold list");
          await rowCount(page, 6);
          await openThread(page, WORKING);
          await page.goBack();
          await listScreen(page);
          await page.goForward();
          await page.locator("#inbox-back").waitFor();
          await page.locator(".mode-inbox").waitFor({ state: "detached" });
          await addressIs(page, { app: "inbox", pane: WORKING }, "Forward shows the thread again");
          pass(8, "the system Back shows the list and Forward the thread again");

          await page.reload();
          await page.locator("#inbox-back").waitFor();
          await page.locator(".thread-title").waitFor();
          assert.equal(await page.locator(".mode-inbox").count(), 0);
          await addressIs(page, { app: "inbox", pane: WORKING }, "a reload in a thread keeps the thread");
          await backToList(page);
          await page.reload();
          await listScreen(page);
          await rowCount(page, 6);
          pass(9, "a reload in a thread keeps the thread, and on the list the list");
        });

        await withPage(browser, base, off, "/?app=inbox", block("Back on a list opened by its own address"), async (page) => {
          await listScreen(page);
          await rowCount(page, 6);
          // the page's first entry is the list's: nothing of the app lies under it
          await page.goBack({ waitUntil: "commit" });
          await page.waitForURL("about:blank");
          pass(10, "opened by its own address, Back on the list leaves the app");
        });

        await withPage(browser, base, off, `/?app=inbox&pane=${encodeURIComponent(BLOCKED)}`, block("a thread opened by its own address"), async (page) => {
          await page.locator("#inbox-back").waitFor();
          await page.locator(".thread-title").waitFor();
          await page.locator(".pane-slot").first().waitFor();
          assert.equal(await page.locator(".mode-inbox").count(), 0, "an address naming a pane opens its thread");
          const entries = await historyLength(page);
          await backToList(page);
          await rowCount(page, 6);
          await addressIs(page, { app: "inbox", pane: null }, "the header's Back opens the list in the thread's place");
          assert.equal(await historyLength(page), entries, "the header's Back adds no entry");
          pass(11, "a cold address of a thread shows the thread, and the header's Back opens the list in its place, adding no entry");
        });

        await withPage(browser, base, off, `/?pane=${encodeURIComponent(BLOCKED)}`, block("the way out from a thread, and Back through the mode to where it was entered"), async (page) => {
          await page.locator(".pane-slot").first().waitFor();
          await enterFromMore(page);
          await rowCount(page, 6);
          await openThread(page, WORKING);
          // another agent waits, and this thread is not its: More counts it, and offers to open it
          assert.equal(await page.locator('.header-more-dot.is-waiting[data-count="1"]').count(), 1, "More counts the other agent that waits");
          assert.match(await page.locator(".header-more-button").getAttribute("aria-label") ?? "", /1 waiting for you/);
          await openSheet(page, ".header-more-button");
          const items = await page.locator(".row-sheet .row-sheet-item").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-item")));
          assert.deepEqual(items.slice(0, 2), ["exit-inbox", "palette"], `a thread's More begins with the way out and the palette: ${items.join()}`);
          assert.equal(items[2], "next-waiting", `then the next agent that waits: ${items.join()}`);
          assert.ok(!items.includes("open-drawer"), `the mode has no drawer to open: ${items.join()}`);
          assert.deepEqual(items.slice(-2), ["alerts", "settings"], `the app's items end a thread's More: ${items.join()}`);
          await shot(page, `inbox-mode-thread-more-390-${theme}.png`);
          await page.locator('.row-sheet [data-item="exit-inbox"]').tap();
          await page.locator("#drawer-toggle").waitFor();
          await page.locator(".context-title-text").waitFor();
          await sheetClosed(page);
          await addressIs(page, { app: null, pane: WORKING }, "left from a thread, the classic app opens on that thread's pane");
          await page.goBack();
          await page.locator(".thread-title").waitFor();
          await addressIs(page, { app: "inbox", pane: WORKING }, "Back returns to the thread");
          await page.goBack();
          await listScreen(page);
          await page.goBack();
          await page.locator("#drawer-toggle").waitFor();
          await addressIs(page, { app: null, pane: BLOCKED }, "Back on the list returns to the pane the mode was entered from");
          pass(12, "over a thread More counts the other agent that waits and offers it after Back to Ovis; Back to Ovis from a thread opens that thread's pane in the classic app; Back then returns to the thread, to the list, and to the pane the mode was entered from");
        });

        await withPage(browser, base, off, "/", block("the entry at the drawer's foot, and no drawer in the mode"), async (page) => {
          await page.locator(".pane-slot").first().waitFor();
          await page.locator("#drawer-toggle").tap();
          const entry = page.locator(".sidebar.is-open .inbox-foot-entry");
          await entry.waitFor();
          assert.equal((await entry.textContent())?.trim(), "Open agent inbox");
          await shot(page, `inbox-mode-drawer-entry-390-${theme}.png`);
          await entry.tap();
          await listScreen(page);
          await rowCount(page, 6);
          // no drawer in the mode: a swipe in from the left edge opens nothing
          const cdp = await page.context().newCDPSession(page);
          await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 4, y: 420 }] });
          for (let x = 24; x <= 304; x += 40) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: 422 }] });
          await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          await frames(page);
          assert.equal(await page.locator("#workspace-drawer, .scrim.is-open").count(), 0, "a swipe from the edge opens no drawer in the mode");
          await page.locator(".mode-inbox").waitFor();
          pass(13, "the drawer's foot has Open agent inbox, which opens the list; in the mode a swipe from the left edge opens no drawer");
        });

        await withPage(browser, base, off, "/?app=inbox", block("New workspace from the list"), async (page) => {
          await rowCount(page, 6);
          await page.locator(".inbox-add").tap();
          const dialog = page.getByRole("dialog").filter({ hasText: "New workspace" }).first();
          await dialog.waitFor();
          await page.goBack();
          await dialog.waitFor({ state: "detached" });
          await listScreen(page);
          await rowCount(page, 6);
          pass(14, "New workspace opens its dialog from the list, and the system Back closes it onto the list");
        });

        await withPage(browser, base, off, "/?demo_devices=watch&app=inbox", block("a watching device"), async (page) => {
          await rowCount(page, 6);
          assert.equal(await page.locator(".inbox-add").count(), 0);
          assert.equal(await page.locator(".mode-inbox .inbox-top button").count(), 1, "a watching device keeps More alone at the top");
          pass(15, "a device that only watches may use the mode and is offered no New workspace");
        });

        // ---- where a phone starts ----
        await withPage(browser, base, on, "/", block("a phone that starts in the inbox"), async (page) => {
          await listScreen(page);
          await rowCount(page, 6);
          assert.equal(await page.locator(".pane-slot").count(), 0);
          await page.goBack({ waitUntil: "commit" });
          await page.waitForURL("about:blank");
          pass(16, "with Agent inbox on a phone on, a phone's cold start is the mode's list, and Back leaves the app");
        });

        await withPage(browser, base, on, `/?pane=${encodeURIComponent(BLOCKED)}`, block("a phone that starts in the inbox, on an address naming a pane"), async (page) => {
          await page.locator("#inbox-back").waitFor();
          await page.locator(".thread-title").waitFor();
          await addressIs(page, { app: "inbox", pane: BLOCKED }, "the pane's address opens its thread in the mode");
          await backToList(page);
          await rowCount(page, 6);
          pass(17, "with the setting on, an address naming a pane opens that pane's thread in the mode, the list behind its Back");
        });

        await withPage(browser, base, on, "/", block("the setting on a wide window"), async (page) => {
          await page.locator(".pane-slot").first().waitFor();
          await page.locator(".agents-sidebar .agent-item").first().waitFor();
          assert.equal(await page.locator(".mode-inbox").count(), 0);
          await addressIs(page, { app: null }, "a wide window with the setting on starts in the classic app");
          pass(18, "at 1280x900 with the setting on the app starts in the classic shell");
        }, { width: 1280, height: 900 });

        await withPage(browser, base, off, "/", block("the Settings row"), async (page) => {
          await page.locator(".context-title-text").waitFor();
          await page.locator("#drawer-toggle").tap();
          await page.locator(".sidebar").getByRole("button", { name: /^Settings/ }).first().tap();
          const settings = page.locator(".settings-dialog");
          await settings.waitFor();
          await settings.locator(".settings-search-input").first().fill("Agent inbox");
          const toggle = settings.getByRole("switch", { name: "Agent inbox on a phone" });
          await toggle.tap();
          await page.waitForFunction(() => document.querySelector('.settings-dialog [role="switch"][aria-label="Agent inbox on a phone"]')?.getAttribute("aria-checked") === "true");
          await page.getByRole("button", { name: "Close settings" }).tap();
          await settings.waitFor({ state: "detached" });
          assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("ovis:phone-inbox") ?? "null")), true);
          assert.equal(await page.locator(".mode-inbox").count(), 0, "the setting says where the device starts: the page it was turned on in stays as it is");
          await page.goto(`${base}/`);
          await listScreen(page);
          await rowCount(page, 6);
          pass(19, "the Settings row stores the device's choice and leaves the page as it is; the next cold start is the mode's list");
        });

        // ---- what the shell withholds, and what it keeps ----
        await withPage(browser, base, { ...off, shortcutOverrides: { "close-pane": "ctrl+alt+x", "new-tab": "ctrl+alt+u" } }, "/?app=inbox", block("the keys the mode withholds"), async (page) => {
          await rowCount(page, 6);
          await openThread(page, WORKING);
          await page.locator(".pane-slot").first().waitFor();
          const blur = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
          const newTab = page.locator(".new-session-modal");
          const confirm = page.locator(".confirm-dialog");
          // the mode has no tab row and no pane menu: in a thread, as on the list, the keys ask for nothing
          await blur();
          await page.keyboard.press("Control+Alt+u");
          await page.keyboard.press("Control+Alt+x");
          await frames(page);
          assert.deepEqual([await newTab.count(), await confirm.count()], [0, 0], "in a thread the keys make no tab and ask to close no pane");
          await backToList(page);
          await blur();
          await page.keyboard.press("Control+Alt+u");
          await page.keyboard.press("Control+Alt+x");
          await frames(page);
          assert.deepEqual([await newTab.count(), await confirm.count()], [0, 0], "on the list the keys do nothing");
          assert.equal(await page.locator(`.mode-inbox .inbox-item[data-pane="${WORKING}"]`).count(), 1, "the pane under the list is still in the roster");
          // back in the classic app the same key asks to close the pane shown
          await openSheet(page, ".inbox-more");
          await page.locator('.row-sheet [data-item="exit-inbox"]').tap();
          await page.locator("#drawer-toggle").waitFor();
          await sheetClosed(page);
          await blur();
          await page.keyboard.press("Control+Alt+x");
          await confirm.waitFor();
          await page.keyboard.press("Escape");
          await confirm.waitFor({ state: "detached" });
          pass(20, "keys bound to Close pane and New tab do nothing in the mode, in a thread as on the list, and act again once the classic app is back");
        });

        await withPage(browser, base, { ...off, keepScreenOn: true }, "/?app=inbox", block("Keep screen on"), async (page) => {
          // a wake lock that counts the locks held, from the next load on
          await page.context().addInitScript(() => {
            const lock = { held: 0 };
            Object.defineProperty(window, "wakeLockHeld", { get: () => lock.held });
            Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request: async () => {
              lock.held += 1;
              let released = false;
              return { release: async () => { if (!released) { released = true; lock.held -= 1; } } };
            } } });
          });
          await page.reload();
          await rowCount(page, 6);
          const held = (count: number) => page.waitForFunction((n) => (window as unknown as { wakeLockHeld: number }).wakeLockHeld === n, count, { timeout: 5_000 });
          await frames(page);
          assert.equal(await page.evaluate(() => (window as unknown as { wakeLockHeld: number }).wakeLockHeld), 0, "a cold list holds no lock");
          await openThread(page, WORKING);
          await held(1);
          await backToList(page);
          await held(0);
          pass(21, "Keep screen on holds a lock in a thread and lets it go on the list");
        });

        await withPage(browser, base, off, "/?app=inbox", block("finishes under the list"), async (page) => {
          await rowCount(page, 6);
          // the working agent's pane is opened, then covered by the list: it finishes there, unread
          await openThread(page, WORKING);
          await page.locator(".pane-slot").first().waitFor();
          await backToList(page);
          await page.evaluate((pane) => window.inboxFixture.set(pane, "done", 2), WORKING);
          await page.waitForFunction((pane) => document.querySelector(`.mode-inbox .inbox-item[data-pane="${pane}"]`)?.getAttribute("data-state") === "done", WORKING);
          const seen = await page.evaluate(() => window.inboxFixture.rosters);
          await page.evaluate(() => window.inboxFixture.publish());
          await page.waitForFunction((count) => window.inboxFixture.rosters > count, seen);
          await frames(page);
          const after = await rows(page);
          for (const pane of [WORKING, DONE]) {
            const item = after.find((candidate) => candidate.pane === pane);
            assert.equal(item?.mark, "done", `${pane} still draws the done mark after the roster came again: ${JSON.stringify(item)}`);
          }
          pass(22, "a finish under the list, of the pane it covers and of one never opened, is still marked done after a roster republish");
        });

        await withPage(browser, base, off, "/?app=inbox", block("two PCs, and a list that scrolls"), async (page) => {
          await rowCount(page, 6);
          // the demo's second PC holds the same pane ids as the first
          await page.evaluate(() => (window as unknown as { __herdrDemoOrder: { addPc: () => string } }).__herdrDemoOrder.addPc());
          await rowCount(page, 12);
          const names: Record<string, string> = await page.evaluate(async () => Object.fromEntries((await (await fetch("/api/machines")).json()).machines.map((machine: Machine) => [machine.id, machine.name])));
          for (const item of await rows(page)) assert.ok((item.words ?? "").startsWith(`${names[item.machine!]} \u00b7 `), `a row of ${item.machine} leads its words with its PC: ${item.words}`);
          // twelve rows scroll: the four floating controls keep their place from the list's top to its end
          const places = () => page.evaluate(() => Object.fromEntries([".inbox-more", ".inbox-add", ".inbox-filter-toggle", ".inbox-search-input"].map((selector) => {
            const r = document.querySelector(selector)!.getBoundingClientRect();
            return [selector, [r.left, r.top, r.right, r.bottom]];
          })));
          const scroller = page.locator(".inbox-scroll");
          const atTop = await places();
          const range = await scroller.evaluate((node) => node.scrollHeight - node.clientHeight);
          assert.ok(range > 0, `twelve rows scroll: ${range}`);
          await scroller.evaluate((node) => { node.scrollTop = node.scrollHeight; });
          await page.waitForFunction(() => { const node = document.querySelector(".inbox-scroll")!; return Math.abs(node.scrollTop - (node.scrollHeight - node.clientHeight)) <= 1; });
          await frames(page);
          assert.deepEqual(await places(), atTop, "the floating controls stay put while the list scrolls");
          const end = await page.evaluate(() => ({ row: [...document.querySelectorAll(".mode-inbox .inbox-item")].at(-1)!.getBoundingClientRect().bottom, foot: document.querySelector(".inbox-filter-toggle")!.getBoundingClientRect().top }));
          assert.ok(end.row <= end.foot, `at the list's end the last row ends above the foot's controls: row ${end.row}, foot ${end.foot}`);
          await scroller.evaluate((node) => { node.scrollTop = 0; });
          await openThread(page, WORKING, "laptop");
          await addressIs(page, { machine: "laptop", pane: WORKING, app: "inbox" }, "the other PC's row opens that PC's pane");
          assert.match(await page.locator(".thread-state").textContent() ?? "", new RegExp(`^${names["laptop"]} \u00b7 `), "with several PCs a thread says which PC before its state");
          pass(23, `with two PCs holding the same pane ids each row leads its words with its PC, and the other PC's row opens that PC's pane; over twelve rows (${Math.round(range)}px of scroll) the floating controls stay put and the last row ends ${Math.round(end.foot - end.row)}px above the foot`);
        });

        // ---- a wide window: the list beside the thread ----
        for (const viewport of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
          const at = `${viewport.width}`;
          await withPage(browser, base, off, `/?pane=${encodeURIComponent(WORKING)}&view=terminal`, block(`the list beside the thread at ${at}`), async (page) => {
            await page.locator(".app-header.is-zoned").waitFor();
            const classic = { sidebar: await box(page, "#workspace-drawer"), pane: await box(page, ".pane-column"), terminal: await terminalBox(page) };
            const entries = await historyLength(page);
            await page.locator(".header-more-button").click();
            const entry = page.locator('.row-menu [data-item="enter-inbox"]');
            await entry.waitFor();
            assert.equal((await entry.textContent())?.trim(), "Open agent inbox");
            await entry.click();
            await page.locator(".inbox-column .mode-inbox").waitFor();
            await page.locator(".app-header").waitFor({ state: "detached" });
            await rowCount(page, 6);
            await questionShown(page);
            await appFaces(page);
            await addressIs(page, { app: "inbox", pane: null }, "the wide list's address says the mode and names no pane");
            assert.equal(await historyLength(page), entries + 1, "entering is one entry");
            assert.equal(await page.locator(".inbox-unchosen").textContent(), "Choose one from the list to open its chat here.");
            assert.equal(await page.locator('.mode-inbox .inbox-row[aria-current="true"]').count(), 0, "no row is open while no agent is chosen");
            for (const selector of [".tab-strip", ".view-switch", ".status-bar", "#drawer-toggle", "#workspace-drawer", ".sidebar-toggle", ".header-files-button", ".pane-split.is-split", ".mode-inbox time.inbox-time", ".header-more-dot"]) {
              assert.equal(await page.locator(selector).count(), 0, `the wide mode draws no ${selector}`);
            }
            const column = await box(page, ".inbox-column");
            const pane = await box(page, ".pane-column");
            assert.deepEqual([column.x, column.w], [classic.sidebar.x, classic.sidebar.w], "the column is as wide as classic's sidebar");
            assert.deepEqual([pane.x, pane.w], [classic.pane.x, classic.pane.w], "the pane is as wide as in classic");
            const [search, add, filter, more, exit] = await Promise.all([box(page, ".inbox-search-toggle"), box(page, ".inbox-add"), box(page, ".inbox-filter-toggle"), box(page, ".inbox-more"), box(page, ".inbox-exit")]);
            for (const control of [search, add, filter, more]) assert.deepEqual([control.w, control.h], [34, 34], "a round control is 34px under a fine pointer");
            near(add.x - search.right, 10, 2, "between the column's top controls"); near(column.right - add.right, 16, 1, "the top controls from the column's edge"); near(add.y, 12, 2, "from the top");
            near(viewport.height - filter.bottom, 12, 2, "under the column's foot"); near(column.right - more.right, 16, 1, "the foot's controls from the column's edge"); near(more.x - filter.right, 8, 2, "between the foot's controls");
            near(exit.x, 8, 2, "Back to Ovis at the foot's start");
            const wideRows = await page.locator(".mode-inbox .inbox-item").evaluateAll((items) => items.map((item) => {
              const r = item.querySelector(".inbox-row")!.getBoundingClientRect();
              const a = item.querySelector(".inbox-avatar")!.getBoundingClientRect();
              return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, radius: getComputedStyle(item.querySelector(".inbox-row")!).borderRadius, avatar: [a.width, a.height, a.left - r.left], nameSize: getComputedStyle(item.querySelector(".inbox-name")!).fontSize, wordsSize: getComputedStyle(item.querySelector(".inbox-words")!).fontSize };
            }));
            near(wideRows[0]!.top - add.bottom, 16, 2, "the first row under the top controls");
            wideRows.forEach((item, index) => {
              near(item.bottom - item.top, 56, 2, "a wide row's height");
              near(item.left - column.x, 12, 1, "a row's inset at the column's start"); near(column.right - item.right, 12, 1, "a row's inset at the column's end");
              assert.equal(item.radius, "12px");
              assert.deepEqual(item.avatar, [32, 32, 8], "the mark is 32px, 8px inside the row");
              assert.deepEqual([item.nameSize, item.wordsSize], ["14px", "13px"]);
              if (index > 0) near(item.top - wideRows[index - 1]!.bottom, 4, 1, "between two rows");
            });

            await row(page, BLOCKED).click();
            await page.locator(".thread-chip").waitFor();
            await page.locator(".prompt-card").first().waitFor();
            await appFaces(page);
            await addressIs(page, { app: "inbox", pane: BLOCKED }, "a row opens its thread beside the list");
            assert.deepEqual((await rows(page)).filter((item) => item.current === "true").map((item) => item.pane), [BLOCKED], "exactly the open thread's row is current");
            assert.equal(await page.locator(".mode-inbox .inbox-item.is-current .inbox-name").evaluate((node) => getComputedStyle(node).fontWeight), "600");
            assert.equal(await page.locator(".thread-chip-state").textContent(), "Needs you");
            const threadEntries = await historyLength(page);
            const [chip, lens, paneMore] = await Promise.all([box(page, ".thread-chip"), box(page, ".thread-top .lens-toggle"), box(page, ".thread-top .header-more-button")]);
            const middle = (control: Box): number => control.y + control.h / 2;
            for (const control of [add, chip, lens, paneMore]) near(middle(control), middle(search), 1, "the top controls and the chip on one centre line");
            near(chip.x + chip.w / 2, pane.x + pane.w / 2, 2, "the chip on the pane's middle");
            near(lens.y, 12, 2, "the pane's controls from its top"); near(pane.right - paneMore.right, 12, 2, "the pane's controls from its end");
            const lane = await page.evaluate(() => {
              const transcript = document.querySelector(".chat-transcript")!.getBoundingClientRect();
              const composer = document.querySelector(".composer-surface")!.getBoundingClientRect();
              const card = document.querySelector(".prompt-dock .prompt-card")!.getBoundingClientRect();
              return { left: transcript.left, right: transcript.right, composer: [composer.left, composer.right], card: [card.left, card.right], above: card.bottom <= composer.top + 1 };
            });
            near(lane.left - pane.x, pane.right - lane.right, 1, "the transcript's lane centred in the pane");
            near(lane.composer[0]!, lane.left, 1, "the composer on the transcript's column"); near(lane.composer[1]!, lane.right, 1, "the composer on the transcript's column");
            near(lane.card[0]!, lane.composer[0]!, 1, "the prompt card on the composer's column"); near(lane.card[1]!, lane.composer[1]!, 1, "the prompt card on the composer's column");
            assert.ok(lane.above, "the prompt card is docked above the composer");
            await shot(page, `inbox-mode-two-pane-${at}-${theme}.png`);

            // another row takes the thread's entry
            await row(page, WORKING).click();
            await page.waitForFunction((title) => (document.querySelector(".thread-chip-name")?.textContent ?? "").endsWith(title), WORKING_TITLE);
            await addressIs(page, { app: "inbox", pane: WORKING }, "another row opens in the thread's place");
            assert.equal(await historyLength(page), threadEntries, "a second row adds no entry");
            assert.deepEqual((await rows(page)).filter((item) => item.current === "true").map((item) => item.pane), [WORKING]);

            // the terminal behind the monitor button is the size classic's is
            const monitor = page.locator(".thread-top .lens-toggle");
            assert.equal(await monitor.getAttribute("aria-label"), "Show the terminal");
            await monitor.click();
            await page.locator('.thread-top .lens-toggle[data-view="terminal"]').waitFor();
            const terminal = await terminalBox(page);
            near(terminal.w, classic.terminal.w, 1, "the terminal's width against classic's"); near(terminal.h, classic.terminal.h, 1, "the terminal's height against classic's");
            await monitor.click();
            await page.locator('.thread-top .lens-toggle[data-view="chat"]').waitFor();

            // each side has a More of its own, and neither counts who waits: the list beside the thread shows it
            assert.equal(await page.locator(".header-more-dot").count(), 0, "beside the list More carries no count");
            assert.equal(await page.locator(".thread-top .header-more-button").getAttribute("aria-label"), "More");
            await page.locator(".thread-top .header-more-button").click();
            await page.locator(".row-menu").waitFor();
            const threadItems = await page.locator(".row-menu [data-item]").evaluateAll((items) => items.map((item) => item.getAttribute("data-item")));
            assert.ok(threadItems.includes("copy-link") && threadItems.includes("files"), `the pane's More holds the thread's items: ${threadItems.join()}`);
            for (const item of ["exit-inbox", "palette", "settings", "alerts", "next-waiting"]) assert.ok(!threadItems.includes(item), `the pane's More has no ${item}: ${threadItems.join()}`);
            await page.keyboard.press("Escape");
            await page.locator(".row-menu").waitFor({ state: "detached" });
            await page.locator(".inbox-column .inbox-more").click();
            await page.locator(".row-menu").waitFor();
            assert.deepEqual(await page.locator(".row-menu [data-item]").evaluateAll((items) => items.map((item) => item.getAttribute("data-item"))), ["exit-inbox", "palette", "alerts", "settings"], "the column's More holds the app's items");
            await page.keyboard.press("Escape");
            await page.locator(".row-menu").waitFor({ state: "detached" });

            // the search field opens on request, takes the focus, and Escape puts it away once it is empty
            await page.locator(".inbox-search-toggle").click();
            await page.waitForFunction(() => document.activeElement?.classList.contains("inbox-search-input") === true);
            await page.keyboard.type("export");
            await rowCount(page, 1);
            await page.keyboard.press("Escape");
            await rowCount(page, 6);
            await page.locator(".inbox-search-input").waitFor();
            await page.keyboard.press("Escape");
            await page.locator(".inbox-search-input").waitFor({ state: "detached" });

            // a narrowed window is the phone layout with the thread kept, and back: the column's list, drawn again for
            // the wider window, leaves the focus in the composer the reader is typing in
            await page.setViewportSize({ width: 600, height: viewport.height });
            await page.locator("#inbox-back").waitFor();
            assert.equal((await page.locator(".thread-name").textContent())?.replace(/^Claude Code: /, ""), WORKING_TITLE);
            assert.equal(await page.locator(".mode-inbox").count(), 0);
            await page.locator("textarea.composer-text").click();
            await page.waitForFunction(() => document.activeElement?.classList.contains("composer-text") === true);
            await page.setViewportSize(viewport);
            await page.locator(".thread-chip").waitFor();
            await page.locator(".inbox-column .mode-inbox").waitFor();
            assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("composer-text") === true), true, "a list drawn again for a wider window takes no focus from the composer");
            await addressIs(page, { app: "inbox", pane: WORKING }, "a window narrowed and widened keeps the thread");

            // Back from a thread is the list with no agent chosen; Back to Ovis at the foot opens the thread's pane in classic
            await page.goBack();
            await page.locator(".inbox-unchosen").waitFor();
            assert.equal(await page.locator('.mode-inbox .inbox-row[aria-current="true"]').count(), 0);
            await page.goForward();
            await page.locator(".thread-chip").waitFor();
            assert.equal((await page.locator(".inbox-exit").textContent())?.trim(), "Back to Ovis");
            await page.locator(".inbox-exit").click();
            await page.locator(".app-header.is-zoned").waitFor();
            await page.locator("#workspace-drawer").waitFor();
            assert.equal(await page.locator(".mode-inbox").count(), 0);
            await addressIs(page, { app: null, pane: WORKING }, "Back to Ovis at the column's foot opens the thread's pane in the classic app");
            await page.locator("#workspace-drawer .inbox-foot-entry").click();
            await page.locator(".inbox-column .mode-inbox").waitFor();
            pass(viewport.width === 1440 ? 24 : 25, `at ${at}: entered from More, the column is classic's sidebar (${column.w}px) and the pane classic's (${pane.w}px); 34px round controls on one centre line with the chip, 56px rows 4px apart with the open one current, the lane and the composer on one column; another row takes the thread's entry; the terminal is classic's size (${Math.round(terminal.w)} by ${Math.round(terminal.h)}); each side has its own More and neither counts who waits; a narrowed window keeps the thread; Back to Ovis at the foot and the sidebar's foot row lead out and in`);
          }, viewport);
        }

        if (errors.length > 0) {
          failures.push(block("page errors"));
          console.log(`FAIL ${block("page errors")}: ${errors.join("; ")}`);
          errors.length = 0;
        } else pass(26, "no page error");
      }
      // ---- no terminal is sized by the mode ----
      // A pane that shows its terminal is covered by the mode's list and shown again: nothing is sent to its pty and
      // its terminal keeps its box. On a wide window whose classic sidebar is collapsed the list's column would
      // narrow the pane, and on every one the list takes the shell's bars away.
      const terminalAt = `/?pane=${encodeURIComponent(BLOCKED)}&view=terminal`;
      for (const setup of [
        { name: "a phone", viewport: PHONE, path: terminalAt },
        { name: "a wide window", viewport: { width: 1440, height: 900 }, path: terminalAt },
        { name: "a wide window with the classic sidebar collapsed", viewport: { width: 1440, height: 900 }, path: `${terminalAt}&sidebar=hidden` },
      ]) {
        await withPage(browser, base, { language: "en", theme: "light" }, setup.path, `the mode sizes no terminal on ${setup.name}`, async (page) => {
          const wide = setup.viewport.width >= 769;
          const terminal = ".terminal-stack:not(.is-chat) .pane-terminal";
          const sized = (): Promise<Window["inboxFixture"]["resizes"]> => page.evaluate(() => window.inboxFixture.resizes.slice());
          await page.locator(".app-header.is-zoned").waitFor();
          const classic = await terminalBox(page);
          if (setup.path.endsWith("sidebar=hidden")) assert.equal(classic.x, 0, "the classic sidebar is collapsed: the pane begins at the window's edge");
          // fixed wait: the page's own first sizing of the pane has gone out
          await page.waitForTimeout(NO_RESIZE_WAIT_MS);
          const before = (await sized()).length;

          // into the mode: its list covers the pane
          if (wide) {
            await page.locator(".header-more-button").click();
            await page.locator('.row-menu [data-item="enter-inbox"]').click();
            await page.locator(".inbox-column .mode-inbox").waitFor();
          } else await enterFromMore(page);
          await rowCount(page, 6);
          await paneHiddenUnderList(page, "the pane is mounted under the list, hidden");
          // fixed wait: no size may be sent for the pane under the list
          await page.waitForTimeout(NO_RESIZE_WAIT_MS);
          assert.deepEqual((await sized()).slice(before), [], "the list over the pane sends its pty no size");
          sameBox(await box(page, terminal), classic, "under the list the terminal keeps the box it had");

          // out again from the list: the pane is shown as it was
          if (wide) await page.locator(".inbox-exit").click();
          else {
            await openSheet(page, ".inbox-more");
            await page.locator('.row-sheet [data-item="exit-inbox"]').tap();
          }
          await page.locator(".mode-inbox").waitFor({ state: "detached" });
          await page.locator(".app-header.is-zoned").waitFor();
          if (!wide) await sheetClosed(page);
          // fixed wait: no size may be sent for the pane shown again in the box it had
          await page.waitForTimeout(NO_RESIZE_WAIT_MS);
          assert.deepEqual((await sized()).slice(before), [], "leaving the mode sends the pane's pty no size");
          sameBox(await terminalBox(page), classic, "back in the classic app the terminal has the box it had");
          console.log(`PASS the mode sizes no terminal on ${setup.name}: entered and left with the pane showing its terminal (${Math.round(classic.w)} by ${Math.round(classic.h)}), its pty is sent no size and its box stays`);
        }, setup.viewport);
      }

      // ---- where a phone that starts in the inbox stays ----
      const phoneOn: Settings = { language: "en", theme: "light", phoneInbox: true };
      await withPage(browser, base, phoneOn, "/", "a phone that starts in the inbox and went back to Ovis", async (page) => {
        await listScreen(page);
        await openSheet(page, ".inbox-more");
        await page.locator('.row-sheet [data-item="exit-inbox"]').tap();
        await page.locator(".mode-inbox").waitFor({ state: "detached" });
        await page.locator("#drawer-toggle").waitFor();
        await sheetClosed(page);
        await addressIs(page, { app: null }, "Back to Ovis leaves the mode's address");
        // the list's More went with the mode: the focus is on the classic header's drawer toggle, not nowhere
        await page.waitForFunction(() => document.activeElement?.id === "drawer-toggle", undefined, { timeout: 5_000 });
        await page.reload();
        await page.locator("#drawer-toggle").waitFor();
        await page.locator(".context-title-text").waitFor();
        assert.equal(await page.locator(".mode-inbox").count(), 0, "a reload of the classic app the phone went back to does not start the mode again");
        await addressIs(page, { app: null }, "the reloaded address is still the classic app's");
        console.log("PASS with Agent inbox on a phone on, a phone that went Back to Ovis is still in the classic app after a reload");
      });

      // ---- the focus after Back to Ovis ----
      const light: Settings = { language: "en", theme: "light" };
      const desktop = { width: 1440, height: 900 };
      await withPage(browser, base, light, "/?app=inbox", "the focus after Back to Ovis on a wide window", async (page) => {
        await page.locator(".inbox-column .mode-inbox").waitFor();
        await rowCount(page, 6);
        await row(page, WORKING).click();
        await page.locator(".thread-chip").waitFor();
        await page.locator(".inbox-exit").click();
        await page.locator(".mode-inbox").waitFor({ state: "detached" });
        await page.locator(".app-header.is-zoned").waitFor();
        // the foot's button went with the column: the focus is on the classic header's sidebar toggle
        await page.waitForFunction(() => document.activeElement?.classList.contains("sidebar-toggle") === true, undefined, { timeout: 5_000 });
        console.log("PASS Back to Ovis leaves the focus on the classic header's toggle: the drawer's on a phone, the sidebar's on a wide window");
      }, desktop);

      // ---- the command palette from the mode's More ----
      await withPage(browser, base, light, "/?app=inbox", "the command palette from the list's More", async (page) => {
        await listScreen(page);
        await rowCount(page, 6);
        await openSheet(page, ".inbox-more");
        assert.equal((await page.locator('.row-sheet [data-item="palette"] .row-sheet-label').textContent())?.trim(), "Search panes and actions");
        await page.locator('.row-sheet [data-item="palette"]').tap();
        await page.locator(".command-palette").waitFor();
        await page.locator(".row-sheet").waitFor({ state: "detached" });
        assert.equal(await page.locator(".mode-inbox").count(), 1, "the palette opens over the list");
        // the system Back puts the palette away and the list is the screen again
        await page.goBack();
        await page.locator(".command-palette").waitFor({ state: "detached" });
        await listScreen(page);
        console.log("PASS Search panes and actions in the list's More opens the command palette over the list on a phone, and Back closes it");
      });

      // ---- the system Back with the pane's More open ----
      await withPage(browser, base, light, "/?app=inbox", "the system Back with the pane's More open in a wide thread", async (page) => {
        await page.locator(".inbox-column .mode-inbox").waitFor();
        await rowCount(page, 6);
        await row(page, WORKING).click();
        await page.locator(".thread-chip").waitFor();
        await page.locator(".thread-top .header-more-button").click();
        await page.locator(".row-menu").waitFor();
        await page.goBack();
        // the thread closed under its More: the list with no agent chosen, and no menu left over it
        await page.locator(".inbox-unchosen").waitFor();
        await page.locator(".row-menu").waitFor({ state: "detached" });
        assert.equal(await page.locator(".inbox-column .inbox-more").getAttribute("aria-expanded"), "false", "the column's More does not claim the menu the pane's More left");
        await addressIs(page, { app: "inbox", pane: null }, "Back from the thread is the list's address");
        console.log("PASS the system Back from a wide thread with the pane's More open closes the menu with its button, and shows the list with no agent chosen");
      }, desktop);

      // ---- an address of the mode whose pane is gone ----
      // A pane that closed in a workspace still open (the classic app opens that workspace's pane in its place), and
      // one whose workspace is gone too (the classic app opens its usual pane): the mode opens the list under the
      // note, never another agent's thread.
      for (const gone of [
        { what: "its workspace still open", path: `/?app=inbox&ws=w1C-checkout-api&pane=${encodeURIComponent("w1C:p9")}&view=chat`, note: "That link's chat is closed" },
        { what: "its workspace closed too", path: `/?app=inbox&pane=${encodeURIComponent("w9Z:p9")}&view=chat`, note: "That link's workspace is closed" },
      ]) {
        for (const viewport of [PHONE, desktop]) {
          const at = viewport.width >= 769 ? "a wide window" : "a phone";
          await withPage(browser, base, light, gone.path, `a thread's address whose pane is gone, ${gone.what}, on ${at}`, async (page) => {
            await page.locator(".header-note").getByText(gone.note).waitFor();
            await page.locator(".mode-inbox").waitFor();
            await rowCount(page, 6);
            if (viewport.width >= 769) {
              await page.locator(".inbox-unchosen").waitFor();
              assert.equal(await page.locator('.mode-inbox .inbox-row[aria-current="true"]').count(), 0, "no row is the open one");
            } else assert.equal(await page.locator(".app-header").count(), 0, "the list is the screen: no thread's header");
            await addressIs(page, { app: "inbox", pane: null }, "the address is the list's");
            console.log(`PASS an address of the mode whose pane is gone (${gone.what}) opens the list on ${at}, under the note "${gone.note}"`);
          }, viewport);
        }
      }

      if (errors.length > 0) {
        failures.push("page errors after the themes");
        console.log(`FAIL page errors after the themes: ${errors.join("; ")}`);
      }
      assert.deepEqual(failures, [], "every block passes");
    } finally { await browser.close(); }
  } finally { server.stop(true); }
} finally { rmSync(app, { recursive: true, force: true }); }
