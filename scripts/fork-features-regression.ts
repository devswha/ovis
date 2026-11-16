/** Exercise fork opt-ins over the demo, never a live session. Audio/desktop services are fixtures;
 * Pi uses a fake Chromium microphone and a local protocol peer, not OpenAI or the user's devices. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { encodePiVoiceFrame, parsePhoneFrame, type PhoneToPiFrame } from "../shared/pi-voice.ts";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

type RequestRecord = { path: string; body: Record<string, unknown> };

/** Loaded after the demo transport: only replace external services, leaving app state and UI real. */
function installServices() {
  const demoFetch = window.fetch.bind(window);
  const requests: RequestRecord[] = [];
  const record = (path: string, init?: RequestInit) => {
    requests.push({ path, body: typeof init?.body === "string" ? JSON.parse(init.body) : {} });
    document.documentElement.dataset["forkRequests"] = JSON.stringify(requests);
  };
  // A long silent WAV gives the user controls time to pause/resume/stop without a timing race.
  const wav = new ArrayBuffer(44 + 16_000 * 2 * 30);
  const view = new DataView(wav);
  const word = (offset: number, text: string) => [...text].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
  word(0, "RIFF"); view.setUint32(4, wav.byteLength - 8, true); word(8, "WAVE"); word(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true); view.setUint32(28, 32_000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  word(36, "data"); view.setUint32(40, wav.byteLength - 44, true);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(input instanceof Request ? input.url : String(input), location.href).pathname;
    if (["/api/fork/github/pulls", "/api/speech", "/api/screen", "/api/pane/pi-voice", "/api/worktree/pull-requests", "/api/worktree/pull-request-fetch", "/api/worktree/create", "/api/worktree/open"].includes(path)) record(path, init);
    if (path === "/api/fork/github/pulls") {
      const pr = { number: 18, title: "Improve inbox", url: "https://github.com/demo/ovis/pull/18", branch: "docs/release-steps", repository: "demo/ovis", workspace_id: "w1C", checks: "failing", review: "review_required", updated_at: "2026-01-02", draft: false, fork: false };
      return Response.json({ accounts: ["demo"], review: [pr], yours: [{ ...pr, number: 19, title: "Remote PR", url: "https://github.com/other/tools/pull/19", repository: "other/tools", workspace_id: undefined, checks: "pending" }], team: [] });
    }
    if (path === "/api/speech") return new Response(wav, { headers: { "content-type": "audio/wav" } });
    if (path === "/api/screen") return Response.json({ path: "/fork-desktop.html" });
    if (path === "/api/pane/pi-voice") return Response.json({ available: true, busy: false });
    return demoFetch(input, init);
  }) as typeof window.fetch;
}

const desktop = `<!doctype html><html lang="en"><body><h1>Fixture desktop</h1><script>
const received = [];
addEventListener("message", ({origin, data}) => {
  if (origin !== location.origin) return;
  received.push(data); document.body.dataset.messages = JSON.stringify(received);
});
parent.postMessage({screen: "ready", resizes: true}, location.origin);
</script></body></html>`;

const requests = (page: Page): Promise<RequestRecord[]> => page.evaluate(() => JSON.parse(document.documentElement.dataset["forkRequests"] ?? "[]"));
const openDrawer = async (page: Page) => {
  await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
  await page.locator("#workspace-drawer.is-open").waitFor();
};
const openMenu = async (page: Page) => {
  await openDrawer(page);
  await page.locator('.workspace-group[data-workspace="w1C"] .row-menu-toggle').first().click();
  await page.locator(".row-sheet").waitFor();
};

async function checkReadAloud(page: Page) {
  await page.getByRole("button", { name: "Read aloud", exact: true }).first().click();
  await page.getByRole("button", { name: "Pause reading", exact: true }).waitFor();
  const speech = (await requests(page)).filter((request) => request.path === "/api/speech");
  assert.ok(speech.length > 0);
  assert.ok(speech.every(({ body }) => typeof body["text"] === "string" && body["text"].length > 0 && typeof body["voice"] === "string"));
  await page.getByRole("button", { name: "Pause reading", exact: true }).click();
  await page.getByRole("button", { name: "Resume reading", exact: true }).waitFor();
  await page.getByRole("button", { name: "Resume reading", exact: true }).click();
  await page.getByRole("button", { name: "Pause reading", exact: true }).waitFor();
  await page.getByRole("button", { name: "Stop reading", exact: true }).click();
  await page.getByRole("button", { name: "Stop reading", exact: true }).waitFor({ state: "detached" });
}

async function checkComputer(page: Page) {
  await openDrawer(page);
  await page.locator(".machine-screen").first().click();
  const frame = page.frameLocator(".computer-view iframe");
  await frame.getByRole("heading", { name: "Fixture desktop" }).waitFor();
  assert.deepEqual((await requests(page)).find(({ path }) => path === "/api/screen")?.body, { machine_id: "local" });
  await page.getByRole("button", { name: "View settings", exact: true }).click();
  const tuning = page.getByRole("dialog", { name: "View settings", exact: true });
  await tuning.getByRole("group", { name: "Quality", exact: true }).getByRole("button", { name: "Low", exact: true }).click();
  await page.waitForFunction(() => {
    const body = document.querySelector<HTMLIFrameElement>(".computer-view iframe")?.contentDocument?.body;
    return JSON.parse(body?.dataset["messages"] ?? "[]").some((message: { screen: string; options?: { quality: string } }) => message.screen === "options" && message.options?.quality === "low");
  });
  await page.keyboard.press("Escape");
  await page.locator(".computer-view-field").press("ArrowLeft");
  await page.waitForFunction(() => {
    const body = document.querySelector<HTMLIFrameElement>(".computer-view iframe")?.contentDocument?.body;
    return JSON.parse(body?.dataset["messages"] ?? "[]").some((message: { screen: string; key?: string }) => message.screen === "key" && message.key === "ArrowLeft");
  });
  await openDrawer(page);
  await page.locator(".machine-screen").first().click();
  await page.locator(".chat-turn-agent").first().waitFor();
}

async function checkPullRequests(page: Page) {
  await openMenu(page);
  await page.locator(".row-sheet").getByRole("button", { name: "Pull requests…", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: /^Pull requests ·/ });
  await dialog.getByRole("searchbox", { name: "Search pull requests…", exact: true }).fill("Document the release steps");
  await dialog.getByRole("button", { name: "Checkout", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  const calls = await requests(page);
  const fetched = calls.find(({ path }) => path === "/api/worktree/pull-request-fetch");
  const created = calls.find(({ path }) => path === "/api/worktree/create");
  assert.deepEqual(fetched?.body, { workspace_id: "w1C", branch: "docs/release-steps" });
  assert.deepEqual(created?.body, { workspace_id: "w1C", branch: "docs/release-steps", base: "origin/docs/release-steps" });
  await openMenu(page);
  await page.locator(".row-sheet").getByRole("button", { name: "Pull requests…", exact: true }).click();
  dialog = page.getByRole("dialog", { name: /^Pull requests ·/ });
  await dialog.getByRole("searchbox", { name: "Search pull requests…", exact: true }).fill("Document the release steps");
  await dialog.getByRole("button", { name: "Go to workspace", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  const after = await requests(page);
  assert.equal(after.filter(({ path }) => path === "/api/worktree/create").length, 1, "an existing checkout is not created twice");
  assert.equal(after.filter(({ path }) => path === "/api/worktree/open").length, 1);
}

async function checkGithub(page: Page, url: string, enabled: boolean) {
  await page.evaluate(() => localStorage.setItem("ovis:phone-inbox", "true"));
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto(`${url}?app=inbox`);
  await page.locator(".mode-inbox .inbox-item").first().waitFor();
  const inboxColumn = page.locator(".inbox-column");
  const github = inboxColumn.getByRole("button", { name: "Pull requests", exact: true });
  assert.equal(await github.count(), enabled ? 1 : 0);
  if (!enabled) return;
  await github.click();
  await page.getByRole("region", { name: "Review requested", exact: true }).waitFor();
  assert.equal(await github.getAttribute("aria-current"), "page");
  const view = page.locator(".fork-github");
  await view.locator(".fork-github-summary").filter({ hasText: "Remote PR" }).click();
  let detail = page.locator(".fork-github-pull");
  assert.equal(await detail.getByRole("button", { name: "Checkout", exact: true }).count(), 0, "unknown repo has no checkout action");
  assert.equal(await detail.getByRole("link", { name: "Open on GitHub", exact: true }).getAttribute("href"), "https://github.com/other/tools/pull/19");
  await view.getByRole("button", { name: "Repositories", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "ovis", exact: true }).click();
  assert.equal(await view.getByText("Remote PR", { exact: true }).count(), 0);
  await view.locator(".fork-github-summary").filter({ hasText: "Improve inbox" }).click();
  await detail.getByRole("button", { name: "Checkout", exact: true }).waitFor();
  assert.equal(await detail.getByRole("link", { name: "Open on GitHub", exact: true }).count(), 1);
  const before = (await requests(page)).filter(({ path }) => path === "/api/fork/github/pulls").length;
  await view.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.waitForFunction((before) => JSON.parse(document.documentElement.dataset["forkRequests"] ?? "[]").filter((request: RequestRecord) => request.path === "/api/fork/github/pulls").length === before + 1, before);
  await inboxColumn.getByRole("button", { name: "Agent inbox", exact: true }).click();
  await page.locator(".mode-inbox .inbox-item").first().waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Pull requests", exact: true }).click();
  await page.locator(".fork-github-pull").getByRole("button", { name: "Back", exact: true }).click();
  await view.locator(".fork-github-summary").filter({ hasText: "Improve inbox" }).waitFor();
  assert.equal(await view.getByText("Remote PR", { exact: true }).count(), 0, "repo choice survives reopening on the phone");
  assert.ok(await view.evaluate((node) => node.getBoundingClientRect().width <= window.innerWidth), "phone list stays inside viewport");
  await view.locator(".fork-github-summary").filter({ hasText: "Improve inbox" }).click();
  detail = page.locator(".fork-github-pull");
  await detail.getByRole("button", { name: "Checkout", exact: true }).click();
  await detail.waitFor({ state: "detached" });
  const calls = await requests(page);
  assert.deepEqual(calls.find(({ path }) => path === "/api/worktree/pull-request-fetch")?.body, { workspace_id: "w1C", branch: "docs/release-steps" });
  assert.deepEqual(calls.find(({ path }) => path === "/api/worktree/create")?.body, { workspace_id: "w1C", branch: "docs/release-steps", base: "origin/docs/release-steps" });
}

const app = mkdtempSync(join(tmpdir(), "ovis-fork-features-"));
const voiceFrames: PhoneToPiFrame[] = [];
try {
  await buildDemoApp(app);
  writeFileSync(join(app, "fork-services.js"), `(${installServices.toString()})();`);
  writeFileSync(join(app, "fork-desktop.html"), desktop);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, '<script src="./demo-transport.js"></script><script src="./fork-services.js"></script><script type="module"'));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === "/ws/pi-voice" && server.upgrade(request)) return;
    const path = url.pathname.replace(/^\/herdr-web-ui\/demo\/app\//, "");
    if (path.split("/").includes("..") || path.includes("\\")) return new Response(null, { status: 400 });
    const file = Bun.file(join(app, !path || path.endsWith("/") ? `${path}index.html` : path));
    return await file.exists() ? new Response(file) : new Response(null, { status: 404 });
  }, websocket: { message(socket, message) {
    const frame = parsePhoneFrame(String(message));
    voiceFrames.push(frame);
    if (frame.type === "hello") {
      socket.send(encodePiVoiceFrame({ type: "phase", phase: "listening" }));
      socket.send(encodePiVoiceFrame({ type: "usage", seconds: 12 }));
    }
    if (frame.type === "set-muted") socket.send(encodePiVoiceFrame({ type: "mute", muted: frame.muted }));
  } } });
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true,
      args: ["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
    try {
      for (const legacy of [false, true]) {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" });
        try {
          await context.addInitScript((legacy) => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", alertsOn: false, ...(legacy ? { contextCircle: true } : {}) })), legacy);
          const page = await context.newPage();
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          const url = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/`;
          await page.goto(`${url}?pane=${encodeURIComponent(panes.omp)}&view=chat`);
          await page.locator(".conn-live").waitFor({ state: "attached" });
          await page.locator(".chat-turn-agent").first().waitFor();
          if (!legacy) {
            assert.equal(await page.locator(".chat-speak").count(), 0);
            await openMenu(page);
            assert.equal(await page.locator(".machine-screen").count(), 0);
            assert.equal(await page.locator(".row-sheet").getByRole("button", { name: "Pull requests…", exact: true }).count(), 0);
            await page.keyboard.press("Escape");
            await page.keyboard.press("Escape");
            assert.deepEqual(await requests(page), [], "disabled features make no service requests");
          } else {
            await checkReadAloud(page);
            await checkComputer(page);
            await checkPullRequests(page);
          }
          await page.goto(`${url}?pane=${encodeURIComponent(panes.cli)}&view=chat`);
          await page.locator(".conn-live").waitFor({ state: "attached" });
          const start = page.getByRole("button", { name: "Start live voice", exact: true });
          if (!legacy) {
            await page.getByRole("button", { name: "Send message", exact: true }).waitFor();
            assert.equal(await start.count(), 0);
            assert.equal(voiceFrames.length, 0);
            assert.deepEqual(await requests(page), [], "disabled features make no service requests");
          } else {
            await start.click();
            const live = page.getByRole("group", { name: "Live voice", exact: true });
            await live.getByRole("button", { name: /^Call controls/ }).click();
            await live.getByRole("timer", { name: "Voice time used", exact: true }).waitFor();
            await live.getByRole("button", { name: "Mute", exact: true }).click();
            await live.getByRole("button", { name: "Unmute", exact: true }).click();
            await live.getByRole("button", { name: "Mute", exact: true }).waitFor();
            await live.getByRole("button", { name: "End call", exact: true }).click();
            await live.waitFor({ state: "detached" });
            assert.ok(voiceFrames.some((frame) => frame.type === "hello"));
            assert.deepEqual(voiceFrames.filter((frame) => frame.type === "set-muted"), [{ type: "set-muted", muted: true }, { type: "set-muted", muted: false }]);
            assert.ok(voiceFrames.some((frame) => frame.type === "stop"));
          }
          await checkGithub(page, url, legacy);
          if (legacy) {
            await page.evaluate(() => {
              localStorage.setItem("ovis:fork-settings", JSON.stringify({ inboxFooter: false }));
              localStorage.removeItem("ovis:fork-github-repo");
            });
            await checkGithub(page, url, true);
          }
          assert.deepEqual(errors, []);
          console.log(`PASS ${legacy ? "migrated fork" : "upstream defaults"}: read aloud, Computer, pull requests, GitHub inbox and Pi voice`);
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  } finally { await server.stop(true); }
} finally { rmSync(app, { recursive: true, force: true }); }
