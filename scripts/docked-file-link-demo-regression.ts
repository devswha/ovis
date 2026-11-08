import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

// A file link in a pane that is not the selected one, pressed while a file is docked beside the
// panes (#3368): the press selects that pane, which closes the docked file and widens the panes
// under the pointer before the button is released. The file the link names must still open in the
// panel, and the pane it was pressed in must be the selected one. Runs the unmodified app over the
// demo's fixture transport at a desktop's width; no herdr session is opened.
// Screenshots go to UI_EVIDENCE_DIR when it is set.
const app = mkdtempSync(join(tmpdir(), "ovis-docked-file-link-demo-"));
const evidence = process.env.UI_EVIDENCE_DIR;

// the demo has no files: its folders list README.md, and every path reads as a short text file
const FILES_SCRIPT = `<script>(${(() => {
  const demoFetch = window.fetch;
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    if (url.pathname.endsWith("/workspace/directories") && (init?.method ?? "GET") === "GET") {
      const listing = await (await demoFetch(input, init)).json();
      return Response.json({ ...listing, files: [{ name: "README.md", size: 64 }] });
    }
    const path = url.searchParams.get("path") ?? "";
    const text = `# ${path}\n\nShown for ${path}.\n`;
    const name = path.split("/").pop() ?? path;
    if (url.pathname.endsWith("/fs/stat")) return Response.json({ path, name, kind: "text", mime: "text/markdown", size: text.length });
    if (url.pathname.endsWith("/fs/file")) return new Response(text, { headers: { "content-type": "text/markdown" } });
    return demoFetch(input, init);
  };
}).toString()})();</script>`;

const server = await (async () => {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>${FILES_SCRIPT}\n    <script type="module"`));
  return Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
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
})();

try {
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  try {
    if (evidence) mkdirSync(evidence, { recursive: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
    await context.addInitScript(() => {
      if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", fileOpen: "panel" }));
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const chatPane = panes.api;
    await page.goto(`http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(chatPane)}&view=chat`);
    await page.locator(".conn-live").waitFor({ state: "attached" });
    const chatFrame = page.locator(`section.pane-frame[data-layout-pane=${JSON.stringify(chatPane)}]`);
    const link = chatFrame.locator("button.markdown-file", { hasText: "src/lib/idempotency.ts" });
    await link.waitFor();

    // the chat's tab split in two: the new pane beside it is selected and opens a file from Files,
    // which docks beside the panes
    const shellPane = await page.evaluate(async (pane_id) => {
      const response = await window.fetch("/api/pane/split", { method: "POST", body: JSON.stringify({ pane_id, direction: "right" }) });
      return ((await response.json()) as { pane: { pane_id: string } }).pane.pane_id;
    }, chatPane);
    const shellFrame = page.locator(`section.pane-frame[data-layout-pane=${JSON.stringify(shellPane)}]`);
    await shellFrame.locator(".pane-frame-head").click();
    await page.waitForFunction((pane) => new URLSearchParams(location.search).get("pane") === pane, shellPane);
    await page.locator(".header-files-button").click();
    await page.locator(".files-dialog").getByText("README.md", { exact: true }).click();
    const panel = page.locator("aside.file-panel:not(.files-panel)");
    await panel.getByText("Shown for", { exact: false }).waitFor();
    assert.match((await panel.getAttribute("aria-label")) ?? "", /README\.md$/, "the shell pane's file docks beside the panes");

    // a real press and release on the chat's file link, as a mouse makes them
    await link.click();
    await page.waitForFunction((pane) => new URLSearchParams(location.search).get("pane") === pane, chatPane);
    await panel.getByText("Shown for src/lib/idempotency.ts", { exact: false }).waitFor({ timeout: 5_000 }).catch(() => {});
    if (evidence) await page.screenshot({ path: join(evidence, "docked-file-link-other-pane-1280.png") });
    assert.equal(await panel.count(), 1, "the file the link names opens in the panel");
    assert.match((await panel.getAttribute("aria-label")) ?? "", /idempotency\.ts$/, "the panel shows the file of the pressed link");
    assert.equal(new URLSearchParams(new URL(page.url()).search).get("pane"), chatPane, "the pressed pane is the selected one");
    console.log("PASS a file link pressed in a pane that is not selected opens its file in the panel while another file is docked");

    // a press on the link dragged off it before the release is no click, as on a link that stayed put
    await shellFrame.locator(".pane-frame-head").click();
    await page.waitForFunction((pane) => new URLSearchParams(location.search).get("pane") === pane, shellPane);
    await panel.waitFor({ state: "detached" });
    await page.locator(".header-files-button").click();
    await page.locator(".files-dialog").getByText("README.md", { exact: true }).click();
    await panel.getByText("Shown for", { exact: false }).waitFor();
    await link.scrollIntoViewIfNeeded();
    const box = await link.boundingBox();
    const shellBox = await shellFrame.boundingBox();
    assert.ok(box && shellBox, "the link and the shell pane are laid out");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForFunction((pane) => new URLSearchParams(location.search).get("pane") === pane, chatPane);
    await page.mouse.move(shellBox.x + shellBox.width / 2, shellBox.y + shellBox.height / 2, { steps: 4 });
    await page.mouse.up();
    await panel.waitFor({ state: "attached", timeout: 1_000 }).catch(() => {});
    assert.equal(await panel.count(), 0, "a press dragged off the link opens nothing");
    assert.deepEqual(errors, []);
    console.log("PASS a press on that link dragged off it before the release opens nothing");
  } finally { await browser.close(); }
} finally {
  await server.stop(true);
  rmSync(app, { recursive: true, force: true });
}
