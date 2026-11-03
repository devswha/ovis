/** Twenty real browser tabs share their terminal socket with machine events; tests use isolated app state. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { chromePath } from "./chrome-path.ts";
import { createServer } from "../server/index.ts";

const stateDir = mkdtempSync(join(tmpdir(), "ovis-machine-browser-"));
const previous = process.env["OVIS_MACHINE_EVENTS_WS"];
const server = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", tailscaleOwner: null, sidecar: false });
const base = `http://127.0.0.1:${server.port}`;
const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
const report: Record<string, unknown> = {};
try {
  delete process.env["OVIS_MACHINE_EVENTS_WS"];
  const context = await browser.newContext();
  let sse = 0;
  context.on("request", (request) => { if (new URL(request.url()).pathname === "/api/machines/events") sse++; });
  await context.addInitScript(() => {
    const status = { documents: 0, preference: -1 };
    Object.assign(window, { machineEventTest: status });
    const NativeSocket = window.WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener("message", (event) => {
          const frame = JSON.parse(String(event.data));
          if (frame.type !== "machine-event") return;
          if (frame.event.type === "machines") status.documents++;
          if (frame.event.type === "preferences") status.preference = frame.event.preferences.revision;
        });
      }
    };
  });
  const pages = [];
  for (let i = 0; i < 20; i++) {
    const page = await context.newPage(); pages.push(page);
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => (window as unknown as { machineEventTest: { documents: number } }).machineEventTest.documents > 0);
  }
  assert.equal(sse, 0, "new transport must not open any HTTP event streams");
  const latencies = await Promise.all(pages.map((page) => page.evaluate(async () => {
    const start = performance.now();
    const response = await fetch("/api/health", { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) throw new Error("health unavailable with twenty tabs");
    return performance.now() - start;
  })));
  const change = await context.request.put(base + "/api/preferences", { data: { settings: { language: "ko" } }, headers: { origin: base } });
  assert.equal(change.status(), 200);
  const revision = (await change.json()).revision;
  await Promise.all(pages.map((page) => page.waitForFunction((revision) =>
    (window as unknown as { machineEventTest: { preference: number } }).machineEventTest.preference === revision, revision)));
  report.websocket = { tabs: pages.length, sseRequests: sse, preferenceRevisionDeliveredToAll: revision, healthMaxMs: Math.max(...latencies) };
  await context.close();

  // Reproduce the actual HTTP/1.1 failure on the same Chromium and server with the rollback transport.
  process.env["OVIS_MACHINE_EVENTS_WS"] = "0";
  const legacy = await browser.newContext();
  const legacyPages = [];
  for (let i = 0; i < 6; i++) {
    const page = await legacy.newPage(); legacyPages.push(page);
    const opened = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/machines/events" && response.status() === 200);
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await opened;
  }
  const blocked = await legacyPages[0]!.evaluate(async () => {
    try { await fetch("/api/health", { signal: AbortSignal.timeout(2_000) }); return false; }
    catch (error) { return error instanceof DOMException && error.name === "TimeoutError"; }
  });
  assert.equal(blocked, true, "six legacy streams should reproduce HTTP request starvation");
  await legacyPages.pop()!.close();
  const recovered = await legacyPages[0]!.evaluate(async () => (await fetch("/api/health", { signal: AbortSignal.timeout(3_000) })).status);
  assert.equal(recovered, 200, "ending one stream frees an HTTP request slot");
  report.legacy = { tabs: 6, healthTimedOut: blocked, healthAfterClosingOneTab: recovered };
  await legacy.close();
  console.log(JSON.stringify(report));
  writeFileSync(process.env["MACHINE_EVENTS_REPORT"] ?? join(tmpdir(), "ovis-machine-events-browser-report.json"), JSON.stringify(report, null, 2));
} finally {
  await browser.close(); server.stop(); rmSync(stateDir, { recursive: true, force: true });
  if (previous === undefined) delete process.env["OVIS_MACHINE_EVENTS_WS"]; else process.env["OVIS_MACHINE_EVENTS_WS"] = previous;
}
