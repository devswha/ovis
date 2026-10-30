/**
 * The relay end to end, cross-origin as in production: the hosted shell (dist-shell/, served as
 * Cloudflare Pages serves it by scripts/pages-static.ts, under its real _headers and _redirects)
 * on one loopback origin, two PCs (`createServer`, each with its own mkdtemp state dir, on the
 * isolated herdr test session) on others, and one Bun relay (relay/bun.ts) between them. The page
 * never reaches a PC except through the relay WebSocket. Run after `bun run build:shell`.
 *
 * The shell accepts only a wss: relay and a PC only a wss: relay origin, so both name
 * `wss://relay.test`: the PCs' outbound sockets reach the local relay through RelayService's
 * `connect` seam, the browser's through Playwright's WebSocket routing (relay-browser-bridge.ts).
 * Every page runs on a frozen clock; a deadline is reached by advancing it, never by waiting.
 *
 *   bun scripts/relay-e2e-regression.ts                  this checkout's shell against this checkout's server
 *   RELAY_E2E_SERVER_DIR=<tree> bun scripts/relay-e2e-regression.ts
 *                                                        this shell against the server in <tree>
 *   bun scripts/relay-e2e-regression.ts --skew <tag>     the same against a worktree of <tag>, removed afterwards
 *
 * UI_EVIDENCE_DIR=<dir> keeps the trace, screenshots, network log and report there (task-23-*).
 */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { $ } from "bun";
import { chromium } from "playwright-core";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { startBunRelay } from "../relay/bun.ts";
import type { BunRelay } from "../relay/bun.ts";
import { herdrRpc, paneRead, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { startFakePushService } from "../server/push.fake.ts";
import type { FakePushService } from "../server/push.fake.ts";
import { exportPublicKey, generateKeyPair, openDaemonSecureChannel } from "../shared/relay-e2ee.ts";
import type { SecureChannel, Transport } from "../shared/relay-e2ee.ts";
import { encodeFrame, FrameType, relayResourcePath } from "../shared/relay-mux.ts";
import { decodeOffer, encodeOffer } from "../shared/relay-offer.ts";
import type { RelayOffer } from "../shared/relay-offer.ts";
import { fileUrl } from "../src/lib/api.ts";
import { readerHref } from "../src/lib/fileReader.ts";
import { ADMISSION_MS, PC_ANSWER_MS } from "../src/lib/relay/channel.ts";
import { chromePath } from "./chrome-path.ts";
import { assertCspClean, watchCsp } from "./csp-violations.ts";
import type { CspWatch } from "./csp-violations.ts";
import { servePagesSite } from "./pages-static.ts";
import { relayBrowserSocket } from "./relay-browser-bridge.ts";

const repo = join(import.meta.dir, "..");

// ---- --skew <tag>: this run again, against a worktree of the tag's server ----

const skewAt = process.argv.indexOf("--skew");
if (skewAt !== -1) {
  const tag = process.argv[skewAt + 1];
  if (!tag) throw new Error("--skew needs a tag");
  const tree = mkdtempSync(join(tmpdir(), "ovis-relay-e2e-skew-"));
  await $`git worktree add --detach ${tree} ${tag}`.cwd(repo);
  try {
    await $`bun install --frozen-lockfile`.cwd(tree);
    const run = await $`bun ${import.meta.path}`.cwd(repo).env({ ...process.env, RELAY_E2E_SERVER_DIR: tree }).nothrow();
    process.exitCode = run.exitCode;
  } finally {
    await $`git worktree remove --force ${tree}`.cwd(repo).quiet().nothrow();
  }
} else {
  await main();
}

async function main(): Promise<void> {
  const serverDir = process.env["RELAY_E2E_SERVER_DIR"] ? resolve(process.env["RELAY_E2E_SERVER_DIR"]) : repo;
  if (!existsSync(join(serverDir, "server/relay/service.ts"))) throw new Error(`${serverDir} holds no server/relay/: not a relay-capable server tree`);
  if (!existsSync(join(repo, "dist-shell/index.html"))) throw new Error("dist-shell/ is missing: run `bun run build:shell` first");
  // the server under test: this checkout's, or the older tree's (todo 19); the shell and relay are always this checkout's
  const { createServer } = await import(join(serverDir, "server/index.ts")) as typeof import("../server/index.ts");
  const { RelayService } = await import(join(serverDir, "server/relay/service.ts")) as typeof import("../server/relay/service.ts");

  const evidence = process.env["UI_EVIDENCE_DIR"] || null;
  if (evidence) mkdirSync(evidence, { recursive: true });
  const keep = (name: string, text: string): void => { if (evidence) writeFileSync(join(evidence, `task-23-${name}`), text); };
  const shot = async (page: Page, name: string): Promise<void> => { if (evidence) await page.screenshot({ path: join(evidence, `task-23-${name}.png`), animations: "disabled" }); };
  const report: string[] = [`server tree: ${serverDir}${serverDir === repo ? " (this checkout)" : ""}`];
  const note = (line: string): void => { report.push(line); console.log(line); };

  const RELAY = "wss://relay.test";
  /** The page's fake time: fixed, so nothing in the page runs on the wall clock. */
  const T0 = new Date("2026-10-30T00:00:00Z");

  async function bounded<T>(promise: Promise<T>, what: string, ms = 30_000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: not within ${ms} ms`)), ms); })]); }
    finally { clearTimeout(timer); }
  }

  const root = mkdtempSync(join(tmpdir(), "ovis-relay-e2e-"));
  let relay: BunRelay | null = startBunRelay({ port: 0 });
  let relayPort = relay.port;
  const relayAddress = (url: string): string => { const target = new URL(url); return `ws://127.0.0.1:${relayPort}${target.pathname}${target.search}`; };

  const pcs: Awaited<ReturnType<typeof startPc>>[] = [];
  const workspaces: string[] = [];
  const fakes: FakePushService[] = [];
  const csp: CspWatch[] = [];
  const contexts: BrowserContext[] = [];
  const network: string[] = [];
  let browser: Browser | undefined;
  const site = servePagesSite(join(repo, "dist-shell"), 0);
  const origin = `http://127.0.0.1:${site.port}`;

  /** A PC: its own state dir and files, its relay through the seam, a sync event per (re)connection. */
  async function startPc(name: string) {
    const stateDir = mkdtempSync(join(root, `${name}-state-`));
    const dir = mkdtempSync(join(root, `${name}-files-`));
    let synced = Promise.withResolvers<void>();
    const service = new RelayService({ stateDir, relay: RELAY, connect: (url) => {
      const socket = new WebSocket(relayAddress(url));
      socket.addEventListener("message", (event) => { if (typeof event.data === "string" && event.data.includes('"sync"')) synced.resolve(); });
      return socket;
    } });
    const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", tailscaleOwner: null, relay: service, pushLoopbackHttp: true });
    const base = `http://127.0.0.1:${app.port}`;
    const post = (path: string) => fetch(`${base}/api/relay${path}`, { method: "POST", headers: { origin: base, "x-herdr-update": "1" } });
    const pc = {
      name, stateDir, dir, service, app, base,
      devices: app.context.services.devices,
      push: app.context.services.core.push,
      /** turns its relay on through the API and resolves once its control socket synced */
      async start(): Promise<void> {
        synced = Promise.withResolvers<void>();
        const response = await post("/start");
        assert.equal(response.status, 200, `${name} relay start: ${await response.text()}`);
        await bounded(synced.promise, `${name} synced with the relay`);
      },
      async stop(): Promise<void> { assert.equal((await post("/stop")).status, 200); },
      /** the next sync: the PC's link reconnecting to a restarted relay by itself */
      resynced(): Promise<void> { synced = Promise.withResolvers<void>(); return synced.promise; },
      /** a pairing offer through the API, re-based onto the shell host */
      async offer(): Promise<RelayOffer> {
        const response = await post("/offer");
        const body = await response.text();
        assert.equal(response.status, 200, `${name} offer: ${body}`);
        const offer = decodeOffer((JSON.parse(body) as { url: string }).url);
        assert.ok(offer, `${name} gave no offer`);
        return { ...offer, name };
      },
    };
    return pc;
  }

  /** Writes the files a PC's resource scenario opens: an image, a real PDF, a page and an SVG that try to escape, a video. */
  async function fixtures(pc: Awaited<ReturnType<typeof startPc>>, id: string): Promise<void> {
    copyFileSync(join(repo, "public/icons/icon-192.png"), join(pc.dir, "picture.png"));
    copyFileSync(join(repo, "scripts/fixtures/file-preview.webm"), join(pc.dir, "clip.webm"));
    const pdfPage = await browser!.newPage();
    await pdfPage.setContent(`<h1>${pc.name}</h1>`);
    await pdfPage.pdf({ path: join(pc.dir, "document.pdf") });
    await pdfPage.close();
    // three independent escapes, reported to the parent after the attempted fetch settles
    const attack = `(async () => {
      if (document.body) document.body.dataset.ran = "1";
      const result = {};
      try { indexedDB.open("ovis-relay"); result.indexedDB = "allowed"; } catch (e) { result.indexedDB = e.name; }
      try { void parent.document.body; result.parent = "allowed"; } catch (e) { result.parent = e.name; }
      try { await fetch(${JSON.stringify(`/s/${id}/~/api/fs/file?path=/etc/hostname`)}); result.fetch = "allowed"; } catch (e) { result.fetch = e.name; }
      parent.postMessage({ type: "isolation", result }, "*");
    })();`;
    writeFileSync(join(pc.dir, "page.html"), `<!doctype html><body><h1>${pc.name} rendered</h1><script>${attack}</script></body>`);
    writeFileSync(join(pc.dir, "evil.svg"), `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="green"/><script><![CDATA[${attack}]]></script></svg>`);
  }

  // ---- the browser side ----

  interface Socket { url: string; sent: number; heard: (() => void)[] }
  interface Opened { context: BrowserContext; page: Page; sockets: Socket[]; nextSocket(): Promise<Socket> }

  /**
   * A fresh context on a frozen clock: its own storage, relay sockets carried to the relay, every
   * request logged. `blob` takes the service worker away, as a
   * native WebView has none, so resources load as blobs.
   */
  async function open(options: { width?: number; blob?: boolean; trace?: boolean } = {}): Promise<Opened> {
    assert.ok(browser);
    const width = options.width ?? 1440;
    const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, colorScheme: "dark" });
    contexts.push(context);
    if (options.trace && evidence) await context.tracing.start({ screenshots: true, snapshots: true });
    const sockets: Socket[] = [];
    const waiting: ((socket: Socket) => void)[] = [];
    let taken = 0;
    await context.routeWebSocket(/^wss:\/\/relay\.test\//, (ws) => {
      const socket: Socket = { url: ws.url(), sent: 0, heard: [] };
      sockets.push(socket);
      network.push(`WS ${ws.url()}`);
      relayBrowserSocket(ws, () => relayAddress(ws.url()), undefined, undefined, () => { socket.sent += 1; for (const heard of socket.heard.splice(0)) heard(); });
      waiting.shift()?.(socket);
    });
    context.on("request", (request) => network.push(`${request.method()} ${request.url()}`));
    await context.addInitScript(({ blob }) => {
      if (window !== window.top) return;
      localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "dark", ...JSON.parse(localStorage.getItem("ovis:settings") ?? "{}") as object }));
      if (blob) Reflect.deleteProperty(Navigator.prototype, "serviceWorker");
      const results: unknown[] = [];
      Object.defineProperty(window, "isolationResults", { value: results });
      addEventListener("message", (event) => {
        if ((event.data as { type?: string } | null)?.type === "isolation") { results.push((event.data as { result: unknown }).result); dispatchEvent(new Event("isolation-result")); }
      });
    }, { blob: options.blob === true });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    page.on("pageerror", (error) => console.error("page error", error.stack));
    page.on("console", (message) => { if (message.type() === "error" || message.type() === "warning") console.error(`page ${message.type()}: ${message.text()}`); });
    await page.clock.install({ time: T0 });
    await page.clock.pauseAt(new Date(T0.getTime() + 1000));
    csp.push(await watchCsp(page));
    return { context, page, sockets, nextSocket: () => {
      const ready = sockets[taken];
      taken += 1;
      return ready ? Promise.resolve(ready) : new Promise((resolve) => waiting.push(resolve));
    } };
  }
  /** Another page of a context, on the same frozen clock and policy watch. */
  async function tab(context: BrowserContext): Promise<Page> {
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    await page.clock.install({ time: T0 });
    await page.clock.pauseAt(new Date(T0.getTime() + 1000));
    csp.push(await watchCsp(page));
    return page;
  }
  /**
   * Until the page sent its `count`th frame on `socket`. The shell sends its first handshake message
   * right after it armed PC_ANSWER_MS on the relay's assignment, and its second right after it armed
   * ADMISSION_MS on the PC's first frame (lib/relay/channel.ts), so a send proves the deadline is set.
   */
  const pageSent = (socket: Socket, count: number): Promise<void> => bounded(new Promise<void>((resolve) => {
    const check = (): void => { if (socket.sent >= count) resolve(); else socket.heard.push(check); };
    check();
  }), `the page's frame ${count} on its relay socket`);
  /** Runs the page's frozen clock a frame at a time until `check` holds: paint and the app's own timers, in page time only. */
  async function frames(page: Page, what: string, check: () => Promise<boolean>, limitMs = 20_000): Promise<void> {
    for (let ran = 0; !(await check()); ran += 16) {
      if (ran >= limitMs) throw new Error(`${what}: not within ${limitMs} ms of page time`);
      await page.clock.runFor(16);
    }
  }
  const state = (page: Page, name: string) => page.locator(`main[data-relay-state="${name}"]`);
  const inApp = async (page: Page): Promise<void> => {
    await page.locator(".app").waitFor();
    assert.equal(await page.locator("main[data-relay-state]").count(), 0, "the shell's screen is gone once the app is up");
  };
  const scopeOf = (id: string): string => `${origin}/s/${id}/`;
  /** Opens a pairing link as the PC's QR code gives it, confirms, and lands in the app. */
  async function pair(page: Page, offer: RelayOffer): Promise<void> {
    await page.goto(encodeOffer(offer, origin));
    await state(page, "confirm").waitFor();
    await page.getByRole("heading", { name: `Pair with ${offer.name}?` }).waitFor();
    assert.ok(!page.url().includes("#offer"), "the offer left the address before the question");
    await page.getByRole("button", { name: "Pair", exact: true }).click();
    await inApp(page);
  }
  /** The phone's saved record for a PC, or null. */
  const saved = (page: Page, serverId: string): Promise<{ device_id: string; extractable: boolean } | null> => page.evaluate(async (serverId) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("ovis-relay", 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<{ device_id: string; extractable: boolean } | null>((resolve, reject) => {
        const request = db.transaction("devices", "readonly").objectStore("devices").get(serverId);
        request.onsuccess = () => resolve(request.result ? { device_id: request.result.device_id, extractable: (request.result.private_key as CryptoKey).extractable } : null);
        request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
  }, serverId);
  const terminalText = (page: Page, pane: string): Promise<string> => page.evaluate((pane) => [...document.querySelectorAll(`.terminal-stack[data-pane-owner="${pane}"] .xterm-rows > div`)].map((row) => (row.textContent ?? "").replaceAll("\u00a0", " ")).join("\n"), pane);

  try {
    browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    pcs.push(await startPc("Desk PC"), await startPc("Laptop"));
    const [desk, laptop] = pcs as [Awaited<ReturnType<typeof startPc>>, Awaited<ReturnType<typeof startPc>>];
    for (const pc of pcs) {
      const status = await (await fetch(`${pc.base}/api/relay`)).json() as { phase: string };
      assert.equal(status.phase, "off", `${pc.name}: the relay is off until turned on`);
      await pc.start();
    }
    const deskOffer = await desk.offer();
    const laptopOffer = await laptop.offer();
    assert.notEqual(deskOffer.server_id, laptopOffer.server_id);
    assert.notEqual(new URL(origin).origin, new URL(desk.base).origin, "the shell is not on the PC's origin");
    note(`shell ${origin}; PCs ${desk.base} and ${laptop.base}; relay ws://127.0.0.1:${relayPort} as ${RELAY}; both relays turned on through POST /api/relay/start`);

    // ---- pairing, the terminal, the roster, a reload ----
    const main = await open({ trace: true });
    const { page } = main;
    const deskScope = scopeOf(deskOffer.server_id);
    const workspace = await workspaceCreate({ cwd: desk.dir, label: "relay-e2e" });
    workspaces.push(workspace.workspace.workspace_id);
    const pane = workspace.root_pane.pane_id;
    await pair(page, deskOffer);
    const deskDevice = await saved(page, deskOffer.server_id);
    assert.ok(deskDevice, "the phone saved the pairing");
    assert.equal(deskDevice.extractable, false, "the device key cannot be exported");
    assert.ok(desk.devices.list(null).some((device) => device.id === deskDevice.device_id && device.via_relay), "the PC enrolled the phone via the relay");
    await shot(page, "paired");
    note(`paired: ${deskScope}#offer=… -> confirm -> app; device ${deskDevice.device_id} enrolled via the relay, key not extractable`);

    await page.locator(`.workspace-group[data-workspace=${JSON.stringify(workspace.workspace.workspace_id)}] .workspace-select`).first().click();
    const screen = page.locator(`.terminal-stack[data-pane-owner=${JSON.stringify(pane)}] .xterm-screen`);
    await screen.waitFor({ state: "attached" });
    const live = async (): Promise<boolean> => await page.locator(".terminal-banner-warning").count() === 0 && (await terminalText(page, pane)).trim() !== "";
    await frames(page, "the pane's terminal attached and drew its prompt", live);
    await screen.click();
    await page.keyboard.type("echo relay-ok");
    await page.keyboard.press("Enter");
    await frames(page, "relay-ok in the terminal", async () => /^relay-ok\s*$/m.test(await terminalText(page, pane)));
    const herdrSaw = (await paneRead({ paneId: pane })).text;
    assert.match(herdrSaw, /^relay-ok\s*$/m, "herdr's own pane printed it");
    await shot(page, "terminal");
    note(`terminal: workspace opened from the sidebar, pane ${pane} attached, typed "echo relay-ok" + Enter -> relay-ok in xterm and in herdr's pane.read`);

    const roster = await workspaceCreate({ cwd: desk.dir, label: "relay-e2e-roster" });
    workspaces.push(roster.workspace.workspace_id);
    await page.locator(`.workspace-group[data-workspace=${JSON.stringify(roster.workspace.workspace_id)}]`).waitFor();
    note(`roster: workspace ${roster.workspace.workspace_id} created in herdr -> its sidebar row arrived over the relay's event stream`);

    const enrolled = desk.devices.list(null).length;
    await page.reload();
    await inApp(page);
    assert.equal(await page.locator('main[data-relay-state="confirm"]').count(), 0);
    assert.equal(desk.devices.list(null).length, enrolled, "a reload pairs nothing new");
    assert.equal((await saved(page, deskOffer.server_id))?.device_id, deskDevice.device_id, "the same saved device after the reload");
    note(`reload: ${page.url()} -> app from IndexedDB, no pairing question, PC still lists ${enrolled} device(s)`);

    // ---- the relay goes down mid-session: typed input is held, never sent; the relay returns and the app recovers ----
    const marker = `held-${randomBytes(3).toString("hex")}`;
    await page.locator(`.workspace-group[data-workspace=${JSON.stringify(workspace.workspace.workspace_id)}] .workspace-select`).first().click();
    await screen.waitFor({ state: "attached" });
    await frames(page, "the terminal reattached after the reload", live);
    const back = desk.resynced();
    const laptopBack = laptop.resynced();
    await relay.stop();
    relay = null;
    await page.locator(".terminal-banner-warning", { hasText: "Reconnecting to Ovis" }).waitFor();
    await screen.click();
    await page.keyboard.type(marker);
    await page.locator(".terminal-banner-warning .draft-held", { hasText: marker }).waitFor();
    await shot(page, "relay-down");
    const fresh = await tab(main.context);
    await fresh.goto(deskScope);
    await state(fresh, "relay-unreachable").waitFor();
    await fresh.getByRole("heading", { name: "The relay could not be reached" }).waitFor();
    if (evidence) await fresh.screenshot({ path: join(evidence, "task-23-relay-down.png"), animations: "disabled" });
    note(`relay down: relay stopped mid-session -> "Reconnecting to Ovis…" with "${marker}" held; a second tab opening the paired PC shows relay-unreachable`);
    relay = startBunRelay({ port: 0 });
    relayPort = relay.port;
    await bounded(back, "Desk PC reconnected to the restarted relay by itself", 45_000);
    await bounded(laptopBack, "Laptop reconnected to the restarted relay by itself", 45_000);
    // the app's retry is a page timer: the frozen clock runs it
    await frames(page, "the app reconnected through the restarted relay", async () => await page.locator(".terminal-banner-draft .draft-text", { hasText: marker }).count() === 1, 60_000);
    assert.ok(!(await paneRead({ paneId: pane })).text.includes(marker), "the held input never reached the pane");
    assert.ok(!(await terminalText(page, pane)).includes(marker), "the held input is not on the terminal");
    await shot(page, "relay-back");
    await page.getByRole("button", { name: "Discard held input" }).click();
    await page.locator(".terminal-banner-draft").waitFor({ state: "detached" });
    await fresh.getByRole("button", { name: "Try again" }).click();
    await inApp(fresh);
    await fresh.close();
    note(`relay back: relay restarted on a new port, both PCs resynced by themselves, the app reconnected; "${marker}" waits in the draft, not in the pane; Try again on the second tab -> app`);

    // ---- two PCs in one shell origin: files and media through each PC's own channel ----
    await fixtures(desk, deskOffer.server_id);
    await fixtures(laptop, laptopOffer.server_id);
    const laptopPage = await tab(main.context);
    await pair(laptopPage, laptopOffer);
    const tabs: [Page, Awaited<ReturnType<typeof startPc>>, RelayOffer][] = [[page, desk, deskOffer], [laptopPage, laptop, laptopOffer]];
    const read = async (tab: Page, pc: Awaited<ReturnType<typeof startPc>>, id: string, name: string): Promise<void> => {
      await tab.goto(origin + readerHref("local", join(pc.dir, name), `/s/${id}/`));
      await tab.locator(".file-reader").waitFor();
    };
    const isolation = (tab: Page): Promise<Record<string, string>> => bounded(tab.evaluate(async () => {
      const results = Reflect.get(window, "isolationResults") as Record<string, string>[];
      if (results.length === 0) await new Promise<void>((resolve) => addEventListener("isolation-result", () => resolve(), { once: true }));
      return results.at(-1)!;
    }), "the rendered page reported its escape attempts");
    const isolated = (result: Record<string, string>, what: string): void => {
      assert.deepEqual(result, { indexedDB: "SecurityError", parent: "SecurityError", fetch: "TypeError" }, `${what}: every escape is blocked`);
    };
    for (const [tab, pc, offer] of tabs) {
      const id = offer.server_id;
      await tab.evaluate(async () => {
        await navigator.serviceWorker.ready;
        if (!navigator.serviceWorker.controller) await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }));
      });
      await read(tab, pc, id, "picture.png");
      const picture = tab.locator("img.file-viewer-media[src]");
      assert.ok((await picture.getAttribute("src"))?.startsWith(`/s/${id}/~/api/`), "the image loads through the PC's scoped resource route");
      assert.ok(await picture.evaluate(async (image: HTMLImageElement) => { await image.decode(); return image.naturalWidth; }) > 0);
      const pdf = tab.waitForResponse((response) => new URL(response.url()).searchParams.get("path")?.endsWith("document.pdf") === true && response.request().isNavigationRequest());
      await read(tab, pc, id, "document.pdf");
      const navigation = await pdf;
      assert.equal(navigation.status(), 200);
      assert.equal(navigation.headers()["content-type"], "application/pdf");
      assert.ok(navigation.fromServiceWorker(), "the PDF navigation was answered by the shell's worker");
      await tab.locator("iframe.file-viewer-pdf").waitFor();
      await read(tab, pc, id, "page.html");
      isolated(await isolation(tab), `${pc.name} rendered page`);
      assert.equal(await tab.frameLocator("iframe.file-viewer-page").locator("h1").textContent(), `${pc.name} rendered`);
      await shot(tab, `render-${pc.name === "Desk PC" ? "desk" : "laptop"}`);
      await read(tab, pc, id, "evil.svg");
      assert.equal(await tab.locator("img.file-viewer-media").evaluate(async (image: HTMLImageElement) => { await image.decode(); return (Reflect.get(window, "isolationResults") as unknown[]).length; }), 0, "the SVG's script never ran as an image");
      await read(tab, pc, id, "clip.webm");
      const sought = await tab.locator("video").evaluate(async (video: HTMLVideoElement) => {
        if (video.readyState < 1) await new Promise<void>((resolve, reject) => {
          video.addEventListener("loadedmetadata", () => resolve(), { once: true });
          video.addEventListener("error", () => reject(new Error(`media error ${video.error?.code}`)), { once: true });
        });
        const seeked = new Promise<void>((resolve) => video.addEventListener("seeked", () => resolve(), { once: true }));
        video.currentTime = video.duration / 2;
        await seeked;
        return { duration: video.duration, at: video.currentTime };
      });
      assert.ok(sought.at > 0, `${pc.name}: the video sought`);
      const video = join(pc.dir, "clip.webm");
      const ranged = await tab.evaluate(async (src) => {
        const response = await fetch(src, { headers: { range: "bytes=100-199" } });
        return { status: response.status, range: response.headers.get("content-range"), bytes: [...new Uint8Array(await response.arrayBuffer())] };
      }, relayResourcePath(id, fileUrl(video, null)));
      const size = readFileSync(video).length;
      assert.deepEqual(ranged, { status: 206, range: `bytes 100-199/${size}`, bytes: [...readFileSync(video).subarray(100, 200)] }, `${pc.name}: a positive Range through the relay`);
      note(`${pc.name} files: image decoded via /s/${id}/~/api/, PDF navigation answered by the worker, rendered page isolated, SVG script inert, video sought to ${sought.at.toFixed(2)}s of ${sought.duration.toFixed(2)}s, Range bytes=100-199 -> 206 ${ranged.range}`);
    }
    // blob mode (no service worker, as in the native app): the same page and SVG stay isolated
    {
      const blob = await open({ blob: true });
      await pair(blob.page, await desk.offer());
      await read(blob.page, desk, deskOffer.server_id, "page.html");
      isolated(await isolation(blob.page), "blob mode rendered page");
      await read(blob.page, desk, deskOffer.server_id, "evil.svg");
      const src = await blob.page.locator("img.file-viewer-media[src]").getAttribute("src");
      assert.ok(src?.startsWith("blob:"), "blob mode loads the image as a blob");
      assert.equal(await blob.page.locator("img.file-viewer-media").evaluate(async (image: HTMLImageElement) => { await image.decode(); return (Reflect.get(window, "isolationResults") as unknown[]).length; }), 0, "blob mode: the SVG's script never ran");
      await shot(blob.page, "blob-mode");
      await blob.context.close();
      note("blob mode: no service worker -> resources as blob:, rendered page isolated, SVG script inert");
    }

    // ---- push: each PC's test alert reaches only its own subscription (M9) ----
    {
      const fakeDesk = await startFakePushService();
      const fakeLaptop = await startFakePushService();
      fakes.push(fakeDesk, fakeLaptop);
      const subscriptions: Record<string, FakePushService["subscription"]> = { [deskOffer.server_id]: fakeDesk.subscription, [laptopOffer.server_id]: fakeLaptop.subscription };
      const alerts = await open();
      await alerts.context.grantPermissions(["notifications"], { origin });
      await alerts.context.addInitScript((subscriptions) => {
        const id = /^\/s\/([0-9a-f]{32})\//.exec(location.pathname)?.[1];
        if (id === undefined || subscriptions[id] === undefined) return;
        const json = subscriptions[id];
        const made = (key: number[]) => ({ endpoint: json.endpoint, expirationTime: null, options: { userVisibleOnly: true, applicationServerKey: new Uint8Array(key).buffer },
          toJSON: () => ({ endpoint: json.endpoint, expirationTime: null, keys: json.keys }), unsubscribe: async () => { localStorage.removeItem(`qa-push:${id}`); return true; } });
        PushManager.prototype.getSubscription = async function () {
          const key = localStorage.getItem(`qa-push:${id}`);
          return (key === null ? null : made(JSON.parse(key) as number[])) as unknown as PushSubscription;
        };
        PushManager.prototype.subscribe = async function (options?: PushSubscriptionOptionsInit) {
          const raw = options!.applicationServerKey as BufferSource;
          const key = [...new Uint8Array(ArrayBuffer.isView(raw) ? raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) : raw)];
          localStorage.setItem(`qa-push:${id}`, JSON.stringify(key));
          return made(key) as unknown as PushSubscription;
        };
        localStorage.setItem("ovis:settings", JSON.stringify({ ...JSON.parse(localStorage.getItem("ovis:settings") ?? "{}") as object, alertsOn: true }));
      }, subscriptions);
      const alertTabs: [Page, Awaited<ReturnType<typeof startPc>>, RelayOffer, FakePushService, FakePushService][] = [];
      for (const [pc, offer, fake, other] of [[desk, deskOffer, fakeDesk, fakeLaptop], [laptop, laptopOffer, fakeLaptop, fakeDesk]] as const) {
        const registered = Promise.withResolvers<void>();
        const subscribe = pc.push.subscribe.bind(pc.push);
        pc.push.subscribe = (subscription, ...rest) => { if (subscription.endpoint === fake.subscription.endpoint) registered.resolve(); subscribe(subscription, ...rest); };
        const alertTab = alertTabs.length === 0 ? alerts.page : await tab(alerts.context);
        await pair(alertTab, await pc.offer());
        await bounded(registered.promise, `${pc.name} registered the phone's subscription over the relay`);
        alertTabs.push([alertTab, pc, offer, fake, other]);
      }
      for (const [tab, pc, offer, fake, other] of alertTabs) {
        const before = other.received.length;
        await tab.goto(`${scopeOf(offer.server_id)}?settings=alerts`);
        await tab.locator(".app").waitFor();
        await tab.getByRole("button", { name: "Send test", exact: true }).click();
        const received = await fake.waitFor((push) => push.payload.body === "Alerts are on for this device", `${pc.name}'s test push`, 30_000);
        assert.ok(received.vapidValid, `${pc.name}'s push carries a valid VAPID signature`);
        assert.equal(received.vapidKey, pc.push.publicKey(), `${pc.name}'s push is signed with its own key`);
        assert.equal(other.received.length, before, `${pc.name}'s test push reached no other subscription`);
        note(`push ${pc.name}: Send test over the relay -> its own fake push service decrypted ${JSON.stringify(received.payload.body)}, VAPID valid with its own key; the other PC's received nothing`);
      }
      await shot(alertTabs[1]![0], "push");
      await alerts.context.close();
    }

    // ---- the shell's states on the way in (M6), each on its exact deadline ----
    {
      const damaged = await open({ width: 390 });
      await damaged.page.goto(`${deskScope}#offer=abc`);
      await state(damaged.page, "bad-offer").waitFor();
      assert.equal(damaged.page.url(), deskScope, "the fragment left the address bar");
      assert.deepEqual(damaged.sockets, [], "no relay socket for a damaged offer");
      await shot(damaged.page, "bad-offer");
      await damaged.context.close();

      const expired = await open({ width: 390 });
      const count = desk.devices.list(null).length;
      await expired.page.goto(encodeOffer({ ...(await desk.offer()), code: desk.devices.startPairing(Date.now() - 11 * 60_000).code }, origin));
      await expired.page.getByRole("button", { name: "Pair", exact: true }).click();
      await state(expired.page, "code-expired").waitFor();
      assert.equal(desk.devices.list(null).length, count, "an expired code enrolls nothing");
      await shot(expired.page, "code-expired");
      await expired.context.close();

      const changed = await open({ width: 390 });
      await changed.page.goto(deskScope);
      await state(changed.page, "empty").waitFor();
      await changed.page.evaluate(async (id) => {
        const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open("ovis-relay", 2);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction("devices", "readwrite");
          tx.objectStore("devices").put({ server_id: id, server_public_key: "not-the-offer's-key", name: "Desk PC", relay: "wss://relay.test", device_id: "stale-device", private_key: keys.privateKey, public_spki: "spki", label: "QA phone" });
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(tx.error);
        });
        db.close();
      }, deskOffer.server_id);
      await changed.page.goto(encodeOffer(await desk.offer(), origin));
      await changed.page.getByRole("button", { name: "Pair", exact: true }).click();
      await state(changed.page, "identity-changed").waitFor();
      assert.deepEqual(changed.sockets, [], "a changed identity is refused before any socket opens");
      await shot(changed.page, "identity-changed");
      await changed.page.getByRole("button", { name: "Forget this PC" }).click();
      await inApp(changed.page);
      await changed.context.close();

      // the PC away: the relay assigns, nobody answers; pc-offline exactly at PC_ANSWER_MS of page time
      const away = await open({ width: 390 });
      await pair(away.page, await laptop.offer());
      await away.nextSocket();
      await laptop.stop();
      await away.page.goto(scopeOf(laptopOffer.server_id));
      await state(away.page, "connecting").waitFor();
      await pageSent(await away.nextSocket(), 1);
      await away.page.clock.runFor(PC_ANSWER_MS - 1);
      assert.equal(await state(away.page, "connecting").count(), 1, "still connecting 1 ms before the PC's deadline");
      await away.page.clock.runFor(1);
      await state(away.page, "pc-offline").waitFor();
      await shot(away.page, "pc-offline");
      await laptop.start();
      await away.page.getByRole("button", { name: "Try again" }).click();
      await inApp(away.page);
      await away.context.close();

      // a PC from another relay protocol generation, and one that stalls after its handshake
      for (const behaviour of ["refuse", "stall"] as const) {
        const pc = await scriptedPc(behaviour);
        try {
          const opened = await open({ width: 390 });
          await opened.page.goto(encodeOffer(pc.offer, origin));
          await opened.page.getByRole("button", { name: "Pair", exact: true }).click();
          if (behaviour === "refuse") await state(opened.page, "needs-update").waitFor();
          else {
            await pageSent(await opened.nextSocket(), 2);
            await opened.page.clock.runFor(ADMISSION_MS - 1);
            assert.equal(await state(opened.page, "connecting").count(), 1, "still connecting 1 ms before the admission deadline");
            await opened.page.clock.runFor(1);
            await state(opened.page, "pc-unresponsive").waitFor();
          }
          await shot(opened.page, behaviour === "refuse" ? "needs-update" : "pc-unresponsive");
          await opened.context.close();
        } finally { pc.stop(); }
      }
      note(`states: bad-offer (0 sockets, fragment gone), code-expired (nothing enrolled), identity-changed (0 sockets; Forget -> app), pc-offline at exactly ${PC_ANSWER_MS} ms of page time (Try again -> app), needs-update, pc-unresponsive at exactly ${ADMISSION_MS} ms`);
    }

    // ---- what the shell keeps and where it went ----
    {
      const storage = await page.evaluate(() => [...Object.entries(localStorage), ...Object.entries(sessionStorage)]);
      const secrets = [deskOffer.code, deskOffer.server_public_key, deskDevice.device_id, laptopOffer.code];
      const leaked = storage.filter(([key, value]) => /relay|private|secret|offer/i.test(key) || secrets.some((secret) => secret !== undefined && value.includes(secret)));
      assert.deepEqual(leaked, [], "localStorage and sessionStorage hold no relay key, code or device id");
      keep("storage.txt", `# localStorage + sessionStorage of the shell page (${storage.length} entries); none holds a relay secret\n${storage.map(([key, value]) => `${key} = ${value.slice(0, 160)}`).join("\n")}\n`);
      const pcOrigins = pcs.map((pc) => pc.base);
      const direct = network.filter((line) => pcOrigins.some((base) => line.includes(` ${base}`)));
      assert.deepEqual(direct, [], "the shell never reached a PC except through the relay");
      // blob:, data: and the browser's own chrome:// and PDF viewer pages are not network requests
      const foreign = network.filter((line) => / (https?|wss?):\/\//.test(line) && !line.includes(` ${origin}/`) && !line.startsWith(`WS ${RELAY}/`));
      assert.deepEqual(foreign, [], "every request stayed on the shell's origin or the relay socket");
      keep("network.txt", `# every request of every page (${network.length}); shell ${origin}; PCs ${pcOrigins.join(", ")} (never reached); relay ${RELAY}\n${network.join("\n")}\n`);
      note(`storage: ${storage.length} entries, no relay secret; network: ${network.length} requests, all on ${origin} or ${RELAY}, none to ${pcOrigins.join(" or ")}`);
    }

    // ---- revoked from the PC's side ----
    {
      const removed = await fetch(`${desk.base}/api/devices/${deskDevice.device_id}`, { method: "DELETE", headers: { origin: desk.base, "x-herdr-machine": "1" } });
      assert.equal(removed.status, 204, await removed.text());
      // the session ends; the app's next sign-in, a page timer away, is refused for good
      await frames(page, "the revoked screen", async () => await state(page, "revoked").count() === 1, 60_000);
      await page.getByRole("heading", { name: "This phone was removed from Desk PC" }).waitFor();
      assert.equal(await page.locator(".app").count(), 0, "the app is gone once the PC turned the phone away");
      assert.equal(await saved(page, deskOffer.server_id), null, "the revoked phone forgot its key");
      await shot(page, "revoked");
      note(`revoked: DELETE ${desk.base}/api/devices/${deskDevice.device_id} -> revoked screen, app unmounted, key deleted`);
    }

    // the rendered pages' own escape attempts are the isolation working: blocked by the page policy, and nothing else
    const escape = (violation: { blockedURI: string }): boolean => violation.blockedURI.includes("/~/api/fs/file?path=/etc/hostname");
    const escapes = csp.flatMap((watch) => watch.violations()).filter(escape).length;
    assert.ok(escapes > 0, "the rendered pages' escape fetches were blocked by their policy");
    assertCspClean(csp.map((watch) => ({ servedPolicy: watch.servedPolicy, violations: () => watch.violations().filter((violation) => !escape(violation)) })), "the hosted shell, cross-origin through the relay");
    note(`csp: ${csp.length} pages watched under the shell policy; no violation besides the ${escapes} blocked escape fetches of the rendered pages`);
    if (evidence) await main.context.tracing.stop({ path: join(evidence, "task-23-trace.zip") });
    keep("report.txt", `${report.join("\n")}\n`);
    console.log("PASS relay end to end");
  } catch (error) {
    keep("failure.txt", `${error instanceof Error ? error.stack : String(error)}\n\n${report.join("\n")}\n\n${network.join("\n")}\n`);
    if (evidence) for (const [index, context] of contexts.entries()) for (const [tab, page] of context.pages().entries()) {
      await page.screenshot({ path: join(evidence, `task-23-failure-${index}-${tab}.png`) }).catch(() => undefined);
      keep(`failure-${index}-${tab}.html`, await page.content().catch(() => ""));
    }
    throw error;
  } finally {
    for (const context of contexts) await context.close().catch(() => undefined);
    await browser?.close();
    site.stop(true);
    for (const pc of pcs) { await pc.service.shutdown(); pc.app.stop(); }
    for (const fake of fakes) fake.stop();
    await relay?.stop();
    for (const id of workspaces) await workspaceClose(id).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }

  /**
   * A PC on the relay that completes the real handshake and then refuses the shell's HELLO with
   * `unsupported_version` (a PC of another protocol generation) or never answers it (a PC that
   * hung): the real server never does either to a current shell.
   */
  async function scriptedPc(behaviour: "refuse" | "stall") {
    const keys = generateKeyPair();
    const serverId = randomBytes(16).toString("hex");
    const sockets: WebSocket[] = [];
    const dataFor = (connectionId: string): void => {
      const socket = new WebSocket(`ws://127.0.0.1:${relayPort}/v1/ws?server_id=${serverId}&role=server&connection_id=${connectionId}&v=1`);
      socket.binaryType = "arraybuffer";
      sockets.push(socket);
      const transport: Transport = { onmessage: null, onclose: null, onerror: null, send: (data) => { socket.send(data); }, close: (code, reason) => socket.close(code, reason) };
      socket.onmessage = (event) => transport.onmessage?.({ data: event.data as string | ArrayBuffer, isBinary: typeof event.data !== "string" });
      socket.onclose = (event) => transport.onclose?.(event.code, event.reason);
      let channel: SecureChannel | undefined;
      let incoming = Promise.resolve();
      const opening = openDaemonSecureChannel(transport, { daemonKeyPair: keys, minimumMode: "protected", events: {
        onmessage: () => {
          if (behaviour === "stall") return;
          incoming = incoming.then(async () => {
            await opening;
            await channel?.send(encodeFrame({ type: FrameType.SESSION_ERROR, flags: 0, stream_id: 0, payload: { code: "unsupported_version", message: "This PC speaks another relay protocol" } }).slice().buffer);
          }).catch(() => socket.close());
        },
      } }).then((opened) => { channel = opened; return opened; });
      opening.catch(() => socket.close());
    };
    const control = new WebSocket(`ws://127.0.0.1:${relayPort}/v1/ws?server_id=${serverId}&role=server&v=1`);
    sockets.push(control);
    control.onmessage = (event) => {
      const value = JSON.parse(String(event.data)) as { type: string; connection_id?: string; connection_ids?: string[] };
      if (value.type === "sync") for (const id of value.connection_ids ?? []) dataFor(id);
      else if (value.type === "connected" && value.connection_id) dataFor(value.connection_id);
    };
    await bounded(new Promise<void>((resolve, reject) => { control.onopen = () => resolve(); control.onerror = () => reject(new Error("scripted PC: relay refused")); }), "scripted PC control socket");
    const offer: RelayOffer = { v: 1, server_id: serverId, server_public_key: exportPublicKey(keys.publicKey), relay: RELAY, code: "123456", name: behaviour === "refuse" ? "Old PC" : "Busy PC" };
    return { offer, stop: () => { for (const socket of sockets) socket.close(); } };
  }
}
