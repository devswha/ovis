import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

// Settings → Appearance → File text size on the unmodified app over the demo's fixture transport,
// at a phone's and a desktop's width, light and dark (#2005): with nothing chosen a Markdown preview
// keeps the chat's size and a plain-text source the interface's; a chosen size draws both at it while
// the chat and the viewer's header stay put; Follow chat gives the old sizes back. All files and HTTP
// traffic stay in this disposable, loopback-only app; no herdr session is opened. Screenshots go to
// UI_EVIDENCE_DIR when it is set.
const app = mkdtempSync(join(tmpdir(), "ovis-file-text-size-demo-"));
const evidence = process.env.UI_EVIDENCE_DIR;

// the demo has no files: a Markdown and a plain-text one, with Korean, emoji and a long line
const FILES_SCRIPT = `<script>(${(() => {
  const demoFetch = window.fetch;
  const body = "한국어 문장과 English words, 이모지 🙂🚀, and a long line: " + "word ".repeat(80);
  const files: Record<string, { text: string; mime: string; kind: string }> = {
    "notes.md": { text: `# Plan\n\n${body}\n\n- 첫째 항목\n- second item\n\n\`\`\`ts\nconst size = 18;\n\`\`\`\n`, mime: "text/markdown", kind: "text" },
    "notes.txt": { text: `${body}\n둘째 줄\n`, mime: "text/plain", kind: "text" },
  };
  window.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    const path = url.searchParams.get("path") ?? "";
    const name = path.split("/").pop() ?? "";
    const file = files[name];
    if (file !== undefined) {
      if (url.pathname.endsWith("/fs/stat")) return Promise.resolve(Response.json({ path, name, kind: file.kind, mime: file.mime, size: file.text.length }));
      if (url.pathname.endsWith("/fs/file")) return Promise.resolve(new Response(file.text, { headers: { "content-type": file.mime } }));
    }
    return demoFetch(input, init);
  };
}).toString()})();</script>`;

const px = (page: Page, selector: string): Promise<number> =>
  page.locator(selector).first().evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize));

async function open(browser: Browser, width: number, settings: Record<string, unknown>, query: string): Promise<{ page: Page; errors: string[]; close: () => Promise<void> }> {
  const phone = width <= 480;
  const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, locale: "en-US", hasTouch: phone, isMobile: phone });
  await context.addInitScript((value) => {
    if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", value);
  }, JSON.stringify({ language: "en", ...settings }));
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(panes.web)}${query}`);
  await page.locator(".conn-live").waitFor({ state: "attached" });
  return { page, errors, close: () => context.close() };
}

interface Sizes { preview: number; source: number; title: number; chat: number }

async function sizes(browser: Browser, width: number, settings: Record<string, unknown>, shot: string | null): Promise<Sizes> {
  const read = async (file: string, selector: string): Promise<{ size: number; title: number }> => {
    const { page, errors, close } = await open(browser, width, settings, `&file=${file}`);
    try {
      await page.locator(selector).first().waitFor();
      const size = await px(page, selector);
      const title = await px(page, ".file-viewer .file-viewer-name, .file-viewer .modal-title");
      if (evidence && shot !== null) await page.screenshot({ path: join(evidence, `${shot}-${file.replace(".", "-")}-${width}.png`) });
      assert.deepEqual(errors, []);
      return { size, title };
    } finally { await close(); }
  };
  const preview = await read("notes.md", ".file-viewer-markdown p");
  const source = await read("notes.txt", ".file-viewer-text");
  const { page, close } = await open(browser, width, settings, "&view=chat");
  try {
    await page.locator(".chat-transcript").first().waitFor({ state: "attached" });
    const chat = await page.evaluate(() => {
      const probe = document.createElement("p");
      document.querySelector(".chat-transcript")!.append(probe);
      const size = Number.parseFloat(getComputedStyle(probe).fontSize);
      probe.remove();
      return size;
    });
    return { preview: preview.size, source: source.size, title: preview.title, chat };
  } finally { await close(); }
}

let origin = "";
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>${FILES_SCRIPT}\n    <script type="module"`));
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
  origin = `http://127.0.0.1:${server.port}`;
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      if (evidence) mkdirSync(evidence, { recursive: true });
      for (const width of [390, 1280]) {
        for (const theme of ["light", "dark"] as const) {
          const base = await sizes(browser, width, { theme }, null);
          // a chat size of its own moves the preview with it, as today, and leaves the source at the interface's
          const chat = await sizes(browser, width, { theme, chatFontSize: 21 }, `follow-${theme}`);
          assert.ok(Math.abs(chat.preview - base.preview * 1.5) < 0.1, `${width}px ${theme}: the preview follows the chat (${chat.preview} vs ${base.preview})`);
          assert.equal(chat.source, base.source, `${width}px ${theme}: the source keeps the interface's size until a file size is chosen`);
          assert.equal(chat.title, base.title);
          assert.ok(Math.abs(chat.chat - base.chat * 1.5) < 0.1, `${width}px ${theme}: the chat takes its own size (${chat.chat} vs ${base.chat})`);
          // a file size of its own: preview and source at it, the chat and the header where they were
          const own = await sizes(browser, width, { theme, chatFontSize: 21, fileFontSize: 18 }, `own-${theme}`);
          assert.ok(Math.abs(own.preview - base.preview * 18 / 14) < 0.1, `${width}px ${theme}: the preview takes the file size (${own.preview})`);
          assert.ok(Math.abs(own.source - base.source * 18 / 14) < 0.1, `${width}px ${theme}: the source scales with it (${own.source})`);
          assert.equal(own.chat, chat.chat, `${width}px ${theme}: the chat keeps its own size`);
          assert.equal(own.title, base.title, `${width}px ${theme}: the viewer's header keeps the interface's size`);
          console.log(`PASS ${width}px ${theme}: preview ${base.preview}→${own.preview}px, source ${base.source}→${own.source}px, chat ${own.chat}px, title ${own.title}px`);
        }

        // the control: a step sets a size of its own, kept for the device; Follow chat drops it
        const { page, errors, close } = await open(browser, width, { chatFontSize: 16 }, "&settings=appearance&section=typography");
        try {
          const dialog = page.locator(".settings-dialog");
          const stepper = dialog.getByRole("group", { name: "File text size", exact: true });
          await stepper.waitFor();
          assert.equal(await stepper.locator("output").textContent(), "16px", "it shows the chat's size while it follows it");
          assert.equal(await dialog.getByRole("button", { name: "Follow chat", exact: true }).count(), 0, "nothing to reset while it follows");
          await stepper.getByRole("button", { name: "Increase file text size", exact: true }).click();
          assert.equal(await stepper.locator("output").textContent(), "17px");
          assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("ovis:settings") ?? "{}").fileFontSize), 17, "kept on this device");
          if (evidence) await page.screenshot({ path: join(evidence, `settings-file-text-size-${width}.png`) });
          await dialog.getByRole("button", { name: "Follow chat", exact: true }).click();
          assert.equal(await stepper.locator("output").textContent(), "16px", "Follow chat gives the chat's size back");
          assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("ovis:settings") ?? "{}").fileFontSize), null);
          assert.deepEqual(errors, []);
          console.log(`PASS ${width}px: File text size steps from the chat's size, is kept, and Follow chat drops it`);
        } finally { await close(); }
      }
    } finally { await browser.close(); }
  } finally { await server.stop(true); }
} finally {
  rmSync(app, { recursive: true, force: true });
}
