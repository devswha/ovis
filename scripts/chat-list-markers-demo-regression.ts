import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { appFaces } from "./app-faces.ts";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { serveDemo } from "./demo-server.ts";

// A list's markers sit outside its items, in the list's indent, and are drawn in the Chat font: in
// a monospace face each digit and the ". " after it take a whole cell, so "1. " outgrew the old
// fixed 20px and was cut off at the transcript's left edge (#1993), and "10." or "100." need more.
// A sent message's markers start at its text's edge instead, where a number typed as plain text would.
// All files and HTTP traffic stay in this disposable, loopback-only app and no herdr session is opened.
const app = mkdtempSync(join(tmpdir(), "herdr-chat-list-markers-demo-"));
const evidence = process.env["UI_EVIDENCE_DIR"] || null;
if (evidence !== null) mkdirSync(evidence, { recursive: true });

const PANE = panes.omp;
const REPLY = [
  "Short:", "", "1. one", "2. two", "3. three", "",
  "Past ten:", "", "8. eight", "9. nine", "10. ten", "11. eleven", "12. twelve", "",
  "Past a hundred:", "", "99. ninety-nine", "100. a hundred", "",
  "Bullets:", "", "- a bullet", "- another", "  - nested under it",
].join("\n");
const COUNTED = [
  "Count past ten:", "",
  ...Array.from({ length: 11 }, (_, at) => `${at + 1}. ${at === 1 ? "a second item long enough to wrap onto another line inside the bubble at a phone's width" : `item ${at + 1}`}`), "",
  "And bullets:", "", "- a bullet", "  1. numbered under it",
].join("\n");
const TURNS = [
  { role: "user", ts: "2026-10-28T10:00:00.000Z", parts: [{ kind: "text", text: "Number them\n\n1. Let's try the first\n4. The fourth would be nice too" }] },
  { role: "user", ts: "2026-10-28T10:00:01.000Z", parts: [{ kind: "text", text: COUNTED }] },
  { role: "assistant", ts: "2026-10-28T10:00:05.000Z", parts: [{ kind: "text", text: REPLY }] },
];

const CASES = [
  { name: "default", settings: {}, defaultFace: true },
  { name: "monospace", settings: { chatFontFamily: "monospace" }, defaultFace: false },
  { name: "monospace-24px", settings: { chatFontFamily: "monospace", chatFontSize: 24 }, defaultFace: false },
] as const;

interface Marker { list: number; text: string; width: number; indent: number; font: string }
/**
 * Every marker of the transcript's lists: the text the browser draws for it, as its accessibility
 * tree names the marker (so an item's own `value`, or the count from the list's `start`, is read as
 * drawn, not worked out here), its width in its own font, and its list's indent.
 */
async function markers(page: Page, lists: Locator): Promise<Marker[]> {
  const count = await lists.evaluateAll((lists) => {
    let at = 0;
    for (const list of lists) for (const item of list.children) item.setAttribute("data-marker-at", String(at++));
    return at;
  });
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
    const { nodeIds } = await cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: "[data-marker-at]" });
    const at = new Map<number, number>();
    for (const nodeId of nodeIds) {
      const { node } = await cdp.send("DOM.describeNode", { nodeId });
      const attributes = node.attributes ?? [];
      at.set(node.backendNodeId, Number(attributes[attributes.indexOf("data-marker-at") + 1]));
    }
    const { nodes } = await cdp.send("Accessibility.getFullAXTree");
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    const texts: string[] = Array.from({ length: count }, () => "");
    for (const node of nodes) {
      if (node.role?.value !== "ListMarker") continue;
      const item = node.parentId === undefined ? undefined : byId.get(node.parentId);
      const index = item?.backendDOMNodeId === undefined ? undefined : at.get(item.backendDOMNodeId);
      if (index !== undefined) texts[index] = String(node.name?.value ?? "");
    }
    assert.ok(texts.every((text) => text !== ""), "every item's marker is named in the accessibility tree");
    return await lists.evaluateAll((lists, drawn) => {
      const found: Marker[] = [];
      lists.forEach((list, index) => {
        const indent = parseFloat(getComputedStyle(list).paddingLeft);
        for (const item of list.children) {
          const marker = getComputedStyle(item, "::marker");
          const text = drawn[Number(item.getAttribute("data-marker-at"))]!;
          const probe = document.createElement("span");
          probe.style.cssText = "position: absolute; visibility: hidden; white-space: pre";
          for (const property of ["font-family", "font-size", "font-weight", "font-style", "font-stretch", "font-variant-numeric", "letter-spacing"]) {
            probe.style.setProperty(property, marker.getPropertyValue(property));
          }
          probe.textContent = text;
          document.body.append(probe);
          found.push({ list: index, text, width: probe.getBoundingClientRect().width, indent, font: `${marker.fontSize} ${marker.fontFamily}` });
          probe.remove();
        }
      });
      return found;
    }, texts);
  } finally { await cdp.detach(); }
}

interface BubbleMarker { text: string; left: number; right: number; edge: number; itemLeft: number; lines: number[] }
/**
 * Every marker of the sent bubbles' lists as the browser lays it out (a `::before` or the `::marker`):
 * its drawn text and box, the edge it should start at (the bubble's text edge, or for a nested list
 * its parent item's text) and the left of each line of its item's own text.
 */
async function bubbleMarkers(page: Page, scope: Locator): Promise<BubbleMarker[]> {
  const items = await scope.locator(".chat-bubble .markdown-list > li").evaluateAll((items) => items.map((item, at) => {
    item.setAttribute("data-bubble-item", String(at));
    const list = item.parentElement!;
    const body = item.closest(".chat-bubble-body")!;
    const style = getComputedStyle(body);
    const range = document.createRange();
    const lines: number[] = [];
    const texts = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
    for (let node = texts.nextNode(); node !== null; node = texts.nextNode()) {
      if (node.parentElement!.closest(".markdown-list") !== list) continue;
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) lines.push(rect.left);
    }
    return {
      edge: list.parentElement!.closest(".markdown-list") !== null ? list.getBoundingClientRect().left
        : body.getBoundingClientRect().left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft),
      itemLeft: item.getBoundingClientRect().left + parseFloat(getComputedStyle(item).paddingLeft),
      lines,
    };
  }));
  const cdp = await page.context().newCDPSession(page);
  try {
    const { documents, strings } = await cdp.send("DOMSnapshot.captureSnapshot", { computedStyles: [] });
    const { nodes, layout } = documents[0]!;
    const pseudo = (node: number): boolean => /^::(?:before|marker)$/.test(strings[nodes.nodeName![node]!] ?? "");
    const itemAt = new Map<number, number>();
    nodes.attributes!.forEach((attributes, node) => {
      for (let at = 0; at < attributes.length; at += 2) {
        if (strings[attributes[at]!] === "data-bubble-item") itemAt.set(node, Number(strings[attributes[at + 1]!]));
      }
    });
    const drawn = items.map(() => ({ text: "", left: Infinity, right: -Infinity }));
    layout.nodeIndex.forEach((node, at) => {
      const owner = pseudo(node) ? node : nodes.parentIndex![node]!;
      if (owner < 0 || !pseudo(owner)) return;
      const item = itemAt.get(nodes.parentIndex![owner]!);
      if (item === undefined) return;
      const [x, , width, height] = layout.bounds[at]!;
      if (width === 0 && height === 0) return;
      drawn[item]!.left = Math.min(drawn[item]!.left, x!);
      drawn[item]!.right = Math.max(drawn[item]!.right, x! + width!);
      if (layout.text[at]! >= 0) drawn[item]!.text += strings[layout.text[at]!];
    });
    return items.map((item, at) => ({ ...item, ...drawn[at]! }));
  } finally { await cdp.detach(); }
}

async function prepareDemo(): Promise<void> {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  const override = `<script>(() => {
    const demo = window.fetch;
    const turns = ${JSON.stringify(TURNS)};
    window.fetch = (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
      if (url.pathname === "/api/pane/conversation" && url.searchParams.get("pane_id") === ${JSON.stringify(PANE)}) {
        const body = { source: "claude-transcript", history_id: "list-markers", cursor: null, turns: url.searchParams.has("before") ? [] : turns };
        return Promise.resolve(new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }));
      }
      return demo(input, init);
    };
  })();</script>`;
  writeFileSync(index, html.replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    ${override}\n    <script type="module"`));
}

async function check(browser: Browser, origin: string, width: number, testCase: (typeof CASES)[number]): Promise<void> {
  const phone = width <= 480;
  const context = await browser.newContext(phone
    ? { viewport: { width, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: "en-US" }
    : { viewport: { width, height: 900 }, locale: "en-US" });
  try {
    // the demo's other agents finish turns now and then: their in-app alerts stay off over the transcript
    await context.addInitScript(([settings, pane]) => {
      localStorage.setItem("ovis:settings", settings!);
      localStorage.setItem(`ovis:view:${pane}`, "chat");
    }, [JSON.stringify({ language: "en", alertsOn: false, ...testCase.settings }), PANE]);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(PANE)}`);
    await page.locator(".conn-live").waitFor({ state: "attached" });
    const scope = page.locator(`[data-layout-pane=${JSON.stringify(PANE)}].is-current`);
    await scope.locator(".terminal-stack.is-chat").waitFor();
    await scope.getByText("a hundred", { exact: true }).waitFor();
    await appFaces(page);

    const label = `${testCase.name} ${width}px`;
    const bubble = await bubbleMarkers(page, scope);
    assert.equal(bubble.length, 2 + 11 + 1 + 1, `${label}: every item of the sent messages' lists is drawn`);
    assert.deepEqual(bubble.filter((marker) => Math.abs(marker.left - marker.edge) > 1).map((marker) => `${marker.text.trim()} starts ${(marker.left - marker.edge).toFixed(1)}px from its edge`), [],
      `${label}: every marker of a sent message starts at the edge of its text, as a paragraph's first letter does`);
    assert.deepEqual(bubble.map((marker) => marker.text.trim()), ["1.", "4.", ...Array.from({ length: 11 }, (_, at) => `${at + 1}.`), "", "1."],
      `${label}: a sent message's lists keep the numbers typed`);
    assert.deepEqual(bubble.filter((marker) => marker.right > marker.itemLeft + 0.5).map((marker) => marker.text), [], `${label}: no marker of a sent message runs into its item's text`);
    assert.ok(width > 480 || bubble.some((marker) => marker.lines.length > 1), `${label}: an item of a sent message wraps at a phone's width`);
    assert.deepEqual(bubble.filter((marker) => marker.lines.some((left) => Math.abs(left - marker.itemLeft) > 0.5)).map((marker) => marker.text), [],
      `${label}: an item's wrapped lines start under its text, not under its marker`);

    const found = await markers(page, scope.locator(".chat-turn-agent .markdown-list"));
    assert.equal(found.length, 3 + 5 + 2 + 3, `${label}: every item of the reply's lists is drawn`);
    if (testCase.name !== "default") assert.match(found[0]!.font, /monospace/, `${label}: the markers are drawn in the Chat font`);
    const indents = await scope.locator(".chat-turn-agent .markdown-list").evaluateAll((lists) => lists.map((list) => {
      const probe = document.createElement("div");
      probe.style.paddingLeft = list.tagName === "OL" ? "max(var(--space-5), calc((var(--markdown-list-digits) + 2) * 1ch))" : "max(var(--space-5), 2ch)";
      list.append(probe);
      const sized = parseFloat(getComputedStyle(probe).paddingLeft);
      probe.remove();
      return { indent: parseFloat(getComputedStyle(list).paddingLeft), sized };
    }));
    assert.deepEqual(indents.filter(({ indent, sized }) => Math.abs(indent - sized) > 0.5), [], `${label}: an answer's list keeps the indent of its widest marker`);
    const clipped = found.filter((marker) => marker.width > marker.indent + 0.5);
    assert.deepEqual(clipped, [], `${testCase.name} ${width}px: every marker fits inside its list's indent`);
    if (testCase.defaultFace) {
      const bulletIndents = [...new Set(found.filter((marker) => !/\d/.test(marker.text)).map((marker) => marker.indent))];
      assert.deepEqual(bulletIndents, [20], `${width}px: in the default face a bullet list keeps its 20px indent`);
    }
    assert.deepEqual(errors, []);
    if (evidence !== null) {
      await scope.locator(".markdown-list").first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(evidence, `chat-list-markers-${testCase.name}-${width}.png`) });
    }
    const widest = found.reduce((most, marker) => marker.width > most.width ? marker : most);
    console.log(`PASS ${width}px ${testCase.name}: ${found.length} markers fit their indents (widest "${widest.text.trim()}" ${widest.width.toFixed(1)}px in ${widest.indent.toFixed(1)}px), ${bubble.length} of sent messages start at their text's edge`);
  } finally { await context.close(); }
}

try {
  await prepareDemo();
  const server = serveDemo(app);
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      for (const width of [390, 1440]) {
        for (const testCase of CASES) await check(browser, `http://127.0.0.1:${server.port}`, width, testCase);
      }
    } finally { await browser.close(); }
  } finally { await server.stop(true); }
} finally {
  rmSync(app, { recursive: true, force: true });
}
